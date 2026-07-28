import { Hono } from 'hono'
import type { PGlite } from '@electric-sql/pglite'
import { z } from 'zod'
import { mountDocumentRoutes } from './api-documents.js'
import { EventSchemas, ingest, KernelError, type EventType } from './events.js'
import { num, round2 } from './money.js'

type Env = { Variables: { tenantId: string } }

export function createApp(db: PGlite) {
  const app = new Hono<Env>()

  app.use('/api/*', async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return c.json({ error: 'missing bearer token' }, 401)
    const r = await db.query<{ id: string }>('select id from tenants where token = $1', [token])
    if (!r.rows[0]) return c.json({ error: 'invalid token' }, 401)
    c.set('tenantId', r.rows[0].id)
    await next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, kernel: '0.0.1' }))

  // The one write path: everything enters as an event.
  app.post('/api/events', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.type !== 'string')
      return c.json({ error: 'body must be { type, payload, occurred_at? }' }, 400)
    if (!(body.type in EventSchemas)) return c.json({ error: `unknown event type "${body.type}"` }, 400)
    try {
      const result = await ingest(db, c.var.tenantId, {
        type: body.type as EventType,
        payload: body.payload,
        occurred_at: body.occurred_at,
      })
      return c.json(result, 201)
    } catch (e) {
      if (e instanceof z.ZodError)
        return c.json({ error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 422)
      if (e instanceof KernelError) return c.json({ error: e.message }, e.status as 422)
      throw e
    }
  })

  app.get('/api/events', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
    const events = await db.query<{
      id: string
      seq: string
      type: string
      occurred_at: string
      payload: Record<string, unknown>
      memo: string | null
      journal_id: string | null
    }>(
      `select e.id, e.seq, e.type, e.occurred_at, e.payload, je.memo, je.id as journal_id
       from events e
       left join journal_entries je on je.event_id = e.id
       where e.tenant_id = $1
       order by e.seq desc
       limit $2`,
      [c.var.tenantId, limit],
    )
    const journalIds = events.rows.map((r) => r.journal_id).filter(Boolean)
    const lines =
      journalIds.length === 0
        ? { rows: [] as Array<{ entry_id: string; code: string; name: string; side: string; amount: string }> }
        : await db.query<{ entry_id: string; code: string; name: string; side: string; amount: string }>(
            `select jl.entry_id, a.code, a.name, jl.side, jl.amount
             from journal_lines jl
             join accounts a on a.id = jl.account_id
             where jl.tenant_id = $1 and jl.entry_id = any($2)
             order by jl.side`,
            [c.var.tenantId, journalIds],
          )
    const byEntry = new Map<string, Array<{ code: string; name: string; side: string; amount: number }>>()
    for (const l of lines.rows) {
      const list = byEntry.get(l.entry_id) ?? []
      list.push({ code: l.code, name: l.name, side: l.side, amount: num(l.amount) })
      byEntry.set(l.entry_id, list)
    }
    return c.json(
      events.rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        occurred_at: r.occurred_at,
        payload: r.payload,
        memo: r.memo,
        journal_lines: r.journal_id ? (byEntry.get(r.journal_id) ?? []) : [],
      })),
    )
  })

  app.get('/api/trial-balance', async (c) => {
    const r = await db.query<{
      code: string
      name: string
      kind: string
      normal_side: string
      debits: string
      credits: string
    }>(
      `select a.code, a.name, a.kind, a.normal_side,
              coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as debits,
              coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as credits
       from accounts a
       left join journal_lines jl on jl.account_id = a.id and jl.tenant_id = a.tenant_id
       where a.tenant_id = $1
       group by a.code, a.name, a.kind, a.normal_side
       order by a.code`,
      [c.var.tenantId],
    )
    let totalDebits = 0
    let totalCredits = 0
    const accounts = r.rows.map((row) => {
      const debits = num(row.debits)
      const credits = num(row.credits)
      totalDebits = round2(totalDebits + debits)
      totalCredits = round2(totalCredits + credits)
      const balance =
        row.normal_side === 'debit' ? round2(debits - credits) : round2(credits - debits)
      return { code: row.code, name: row.name, kind: row.kind, normal_side: row.normal_side, debits, credits, balance }
    })
    return c.json({
      accounts,
      total_debits: totalDebits,
      total_credits: totalCredits,
      balanced: Math.abs(totalDebits - totalCredits) < 0.005,
    })
  })

  app.get('/api/inventory', async (c) => {
    const items = await db.query<{
      sku: string
      name: string
      kind: string
      uom: string
      qty: string
      avg_cost: string
    }>(
      `select i.sku, i.name, i.kind, i.uom,
              coalesce(ic.qty_on_hand, 0) as qty, coalesce(ic.avg_cost, 0) as avg_cost
       from items i
       left join item_costs ic on ic.item_id = i.id and ic.tenant_id = i.tenant_id
       where i.tenant_id = $1 and i.kind <> 'service'
       order by i.kind, i.sku`,
      [c.var.tenantId],
    )
    const wip = await db.query<{ work_order: string; accumulated_cost: string }>(
      `select work_order, accumulated_cost from wip_jobs
       where tenant_id = $1 and accumulated_cost > 0
       order by work_order`,
      [c.var.tenantId],
    )
    const rows = items.rows.map((r) => {
      const qty = num(r.qty)
      const avg = num(r.avg_cost)
      return { sku: r.sku, name: r.name, kind: r.kind, uom: r.uom, qty, avg_cost: avg, value: round2(qty * avg) }
    })
    return c.json({
      items: rows,
      open_wip: wip.rows.map((r) => ({ work_order: r.work_order, accumulated_cost: num(r.accumulated_cost) })),
      total_value: round2(rows.reduce((s, r) => s + r.value, 0)),
    })
  })

  app.get('/api/ledger/:code', async (c) => {
    const code = c.req.param('code')
    const acct = await db.query<{ id: string; name: string; normal_side: string }>(
      'select id, name, normal_side from accounts where tenant_id = $1 and code = $2',
      [c.var.tenantId, code],
    )
    if (!acct.rows[0]) return c.json({ error: `unknown account ${code}` }, 404)
    const lines = await db.query<{
      entry_date: string
      memo: string
      side: string
      amount: string
      event_type: string
      seq: string
    }>(
      `select je.entry_date::text as entry_date, je.memo, jl.side, jl.amount, e.type as event_type, e.seq
       from journal_lines jl
       join journal_entries je on je.id = jl.entry_id
       join events e on e.id = je.event_id
       where jl.tenant_id = $1 and jl.account_id = $2
       order by e.seq`,
      [c.var.tenantId, acct.rows[0].id],
    )
    let running = 0
    const normal = acct.rows[0].normal_side
    const out = lines.rows.map((l) => {
      const amount = num(l.amount)
      const signed = (l.side === normal ? 1 : -1) * amount
      running = round2(running + signed)
      return { date: l.entry_date, memo: l.memo, event_type: l.event_type, side: l.side, amount, balance: running }
    })
    return c.json({ code, name: acct.rows[0].name, normal_side: normal, lines: out, balance: running })
  })

  app.get('/api/posting-rules', async (c) => {
    const r = await db.query<{ event_type: string; version: number; lines: unknown }>(
      'select event_type, version, lines from posting_rules where tenant_id = $1 order by event_type',
      [c.var.tenantId],
    )
    return c.json(
      r.rows.map((row) => ({
        event_type: row.event_type,
        version: row.version,
        lines: typeof row.lines === 'string' ? JSON.parse(row.lines) : row.lines,
      })),
    )
  })

  const itemSchema = z.object({
    sku: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['raw', 'subassembly', 'finished', 'service']),
    uom: z.string().min(1).default('ea'),
  })
  app.post('/api/items', async (c) => {
    const parsed = itemSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 422)
    const { sku, name, kind, uom } = parsed.data
    try {
      const r = await db.query<{ id: string }>(
        'insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $3, $4, $5) returning id',
        [c.var.tenantId, sku, name, kind, uom],
      )
      return c.json({ id: r.rows[0].id, sku, name, kind, uom }, 201)
    } catch {
      return c.json({ error: `item sku "${sku}" already exists` }, 409)
    }
  })
  app.get('/api/items', async (c) => {
    const r = await db.query(
      'select sku, name, kind, uom from items where tenant_id = $1 order by sku',
      [c.var.tenantId],
    )
    return c.json(r.rows)
  })

  const partySchema = z.object({
    name: z.string().min(1),
    roles: z.array(z.enum(['customer', 'vendor', 'employee'])).min(1),
  })
  app.post('/api/parties', async (c) => {
    const parsed = partySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 422)
    const r = await db.query<{ id: string }>(
      'insert into parties (tenant_id, name, roles) values ($1, $2, $3) returning id',
      [c.var.tenantId, parsed.data.name, parsed.data.roles],
    )
    return c.json({ id: r.rows[0].id, ...parsed.data }, 201)
  })
  app.get('/api/parties', async (c) => {
    const r = await db.query('select name, roles from parties where tenant_id = $1 order by name', [
      c.var.tenantId,
    ])
    return c.json(r.rows)
  })

  mountDocumentRoutes(app, db)

  return app
}
