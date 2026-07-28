import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { ingest, KernelError, type EventType } from '../src/events.js'
import { num } from '../src/money.js'

let db: PGlite

async function makeTenant(token: string): Promise<string> {
  return provisionTenant(db, `Tenant ${token}`, token)
}

async function makeItem(tenantId: string, sku: string, kind: 'raw' | 'finished', uom = 'ea') {
  await db.query('insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $3, $4, $5)', [
    tenantId, sku, `${sku} item`, kind, uom,
  ])
}

async function post(tenantId: string, type: EventType, payload: Record<string, unknown>) {
  return ingest(db, tenantId, { type, payload })
}

async function balances(tenantId: string): Promise<Map<string, { debits: number; credits: number; net: number }>> {
  const r = await db.query<{ code: string; normal_side: string; debits: string; credits: string }>(
    `select a.code, a.normal_side,
            coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as debits,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as credits
     from accounts a
     left join journal_lines jl on jl.account_id = a.id and jl.tenant_id = a.tenant_id
     where a.tenant_id = $1
     group by a.code, a.normal_side`,
    [tenantId],
  )
  const map = new Map()
  for (const row of r.rows) {
    const debits = num(row.debits)
    const credits = num(row.credits)
    const net = row.normal_side === 'debit' ? debits - credits : credits - debits
    map.set(row.code, { debits, credits, net: Math.round(net * 100) / 100 })
  }
  return map
}

beforeAll(async () => {
  db = await openDb() // in-memory PGlite
})

describe('kernel golden path: buy → make → ship → get paid', () => {
  let t: string

  beforeAll(async () => {
    t = await makeTenant('golden')
    await makeItem(t, 'OATS', 'raw', 'kg')
    await makeItem(t, 'HONEY', 'raw', 'kg')
    await makeItem(t, 'WRAP', 'raw')
    await makeItem(t, 'BAR', 'finished')

    const story: Array<[EventType, Record<string, unknown>]> = [
      ['GoodsReceived', { sku: 'OATS', qty: 500, unit_cost: 2.4, ref: 'PO-1001' }],
      ['GoodsReceived', { sku: 'HONEY', qty: 200, unit_cost: 6.5, ref: 'PO-1001' }],
      ['GoodsReceived', { sku: 'WRAP', qty: 10000, unit_cost: 0.06, ref: 'PO-1002' }],
      ['BillPosted', { amount: 2500, ref: 'BILL-8841' }],
      ['PaymentMade', { amount: 2500, ref: 'BILL-8841' }],
      ['MaterialIssued', { sku: 'OATS', qty: 120, work_order: 'WO-1' }],
      ['MaterialIssued', { sku: 'HONEY', qty: 40, work_order: 'WO-1' }],
      ['MaterialIssued', { sku: 'WRAP', qty: 2400, work_order: 'WO-1' }],
      ['TimeLogged', { hours: 6, loaded_rate: 38, work_order: 'WO-1' }],
      ['ProductionCompleted', { sku: 'BAR', qty: 2400, work_order: 'WO-1' }],
      ['GoodsShipped', { sku: 'BAR', qty: 2000, ref: 'SO-2001' }],
      ['InvoiceIssued', { amount: 3400, ref: 'INV-2001' }],
      ['PaymentReceived', { amount: 3400, ref: 'INV-2001' }],
      ['AdjustmentMade', { sku: 'WRAP', qty_delta: -15, reason: 'damaged' }],
    ]
    for (const [type, payload] of story) await post(t, type, payload)
  })

  it('trial balance balances to the cent', async () => {
    const b = await balances(t)
    let debits = 0
    let credits = 0
    for (const { debits: d, credits: c } of b.values()) {
      debits += d
      credits += c
    }
    expect(Math.abs(debits - credits)).toBeLessThan(0.005)
    expect(debits).toBeGreaterThan(0)
  })

  it('costs flow: raw → WIP → finished → COGS, with nothing stranded', async () => {
    const b = await balances(t)
    expect(b.get('1330')!.net).toBe(0) // WIP fully drained by completion
    expect(b.get('1310')!.net).toBe(2407.1) // 3100 received − 692 issued − 0.90 shrink
    expect(b.get('1350')!.net).toBe(153.33) // 400 bars left @ 0.383333
    expect(b.get('5110')!.net).toBe(766.67) // 2000 bars shipped @ 0.383333
    expect(b.get('5290')!.net).toBe(228) // 6h × $38 absorbed into WIP
    expect(b.get('5150')!.net).toBe(0.9) // 15 wrappers @ $0.06
  })

  it('pure financial events post correctly', async () => {
    const b = await balances(t)
    expect(b.get('1110')!.net).toBe(900) // −2500 paid + 3400 received
    expect(b.get('1200')!.net).toBe(0) // invoiced 3400, collected 3400
    expect(b.get('2100')!.net).toBe(0) // billed 2500, paid 2500
    expect(b.get('2110')!.net).toBe(600) // 3100 received − 2500 billed (PO-1002 not yet billed)
    expect(b.get('4100')!.net).toBe(3400)
  })

  it('WIP job is fully drained after completion', async () => {
    const r = await db.query<{ accumulated_cost: string }>(
      "select accumulated_cost from wip_jobs where tenant_id = $1 and work_order = 'WO-1'",
      [t],
    )
    expect(num(r.rows[0].accumulated_cost)).toBe(0)
  })
})

describe('costing', () => {
  it('moving average blends receipts', async () => {
    const t = await makeTenant('blend')
    await makeItem(t, 'X', 'raw')
    await post(t, 'GoodsReceived', { sku: 'X', qty: 10, unit_cost: 1 })
    await post(t, 'GoodsReceived', { sku: 'X', qty: 10, unit_cost: 2 })
    const r = await db.query<{ qty_on_hand: string; avg_cost: string }>(
      'select qty_on_hand, avg_cost from item_costs where tenant_id = $1',
      [t],
    )
    expect(num(r.rows[0].qty_on_hand)).toBe(20)
    expect(num(r.rows[0].avg_cost)).toBe(1.5)
  })

  it('issue and ship price at current average, not receipt price', async () => {
    const t = await makeTenant('avg-out')
    await makeItem(t, 'Y', 'raw')
    await post(t, 'GoodsReceived', { sku: 'Y', qty: 10, unit_cost: 1 })
    await post(t, 'GoodsReceived', { sku: 'Y', qty: 10, unit_cost: 2 })
    const r = await post(t, 'MaterialIssued', { sku: 'Y', qty: 4, work_order: 'WO-9' })
    expect(r.moves[0].value).toBe(6) // 4 × blended 1.50
  })
})

describe('guardrails', () => {
  it('rejects issuing more than on hand', async () => {
    const t = await makeTenant('guard-stock')
    await makeItem(t, 'Z', 'raw')
    await post(t, 'GoodsReceived', { sku: 'Z', qty: 5, unit_cost: 1 })
    await expect(post(t, 'MaterialIssued', { sku: 'Z', qty: 6, work_order: 'WO-2' })).rejects.toThrow(
      /insufficient stock/,
    )
  })

  it('rejects unknown SKUs', async () => {
    const t = await makeTenant('guard-sku')
    await expect(post(t, 'GoodsReceived', { sku: 'NOPE', qty: 1, unit_cost: 1 })).rejects.toThrow(
      /unknown item/,
    )
  })

  it('rejects invalid payloads via schema', async () => {
    const t = await makeTenant('guard-schema')
    await expect(post(t, 'InvoiceIssued', { amount: -5 })).rejects.toThrow()
  })

  it('events are append-only at the database level', async () => {
    const t = await makeTenant('guard-immutable')
    await makeItem(t, 'W', 'raw')
    await post(t, 'GoodsReceived', { sku: 'W', qty: 1, unit_cost: 1 })
    await expect(db.query("update events set type = 'Tampered' where tenant_id = $1", [t])).rejects.toThrow(
      /append-only/,
    )
    await expect(db.query('delete from events where tenant_id = $1', [t])).rejects.toThrow(/append-only/)
  })

  it('negative adjustment flips the posting to shrinkage expense', async () => {
    const t = await makeTenant('guard-adjust')
    await makeItem(t, 'V', 'raw')
    await post(t, 'GoodsReceived', { sku: 'V', qty: 10, unit_cost: 2 })
    const r = await post(t, 'AdjustmentMade', { sku: 'V', qty_delta: -3, reason: 'count' })
    const sides = Object.fromEntries(r.journal!.lines.map((l) => [l.code, l.side]))
    expect(sides['5150']).toBe('debit')
    expect(sides['1310']).toBe('credit')
    expect(r.journal!.lines[0].amount).toBe(6)
  })
})
