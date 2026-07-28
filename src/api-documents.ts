import type { Context, Hono } from 'hono'
import type { PGlite } from '@electric-sql/pglite'
import { z } from 'zod'
import { KernelError } from './events.js'
import { num } from './money.js'
import {
  applySuggestion, cancelPurchaseOrder, capacity, completeWorkOrder, confirmSalesOrder,
  createPurchaseOrder, createSalesOrder, createWorkOrder, issueMaterials, issuePurchaseOrder,
  listPurchaseOrders, listSalesOrders, listWorkOrders, logWorkOrderTime, planning,
  receivePurchaseOrder, releaseWorkOrder, rescheduleWorkOrder, shipSalesOrder,
} from './documents.js'
import {
  closeChecks, createBill, financials, listBills, listInvoices, payBill, recordInvoicePayment,
} from './finance.js'
import { compareTrialBalance, getMapping, qbSummary, updateMapping } from './qb-bridge.js'
import { createEmployee, listEmployees, listTimeEntries, recordTime } from './people.js'
import { analyze, commit, type ImportKind } from './importer.js'
import { createChannelSettlement, listChannelSettlements, recordChannelShipments } from './channels.js'
import { autoMatch, importBankCsv, manualMatch, reconciliation, setTxnStatus } from './bank.js'

type Env = { Variables: { tenantId: string } }
type Ctx = Context<Env>

// Route params are guaranteed by the route patterns below; the generic Ctx
// type used by wrap() can't see them, hence the assertion.
const pid = (c: Ctx, key = 'id'): string => c.req.param(key) as string

const wrap = (fn: (c: Ctx) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  try {
    return await fn(c)
  } catch (e) {
    if (e instanceof z.ZodError)
      return c.json({ error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 422)
    if (e instanceof KernelError) return c.json({ error: e.message }, e.status === 404 ? 404 : 422)
    throw e
  }
}

const partialLines = z.array(z.object({ line_id: z.string(), qty: z.number().positive() })).optional()

export function mountDocumentRoutes(app: Hono<Env>, db: PGlite) {
  // --- purchase orders -----------------------------------------------------
  const poSchema = z.object({
    vendor: z.string().min(1),
    lines: z
      .array(z.object({ sku: z.string(), qty: z.number().positive(), unit_cost: z.number().nonnegative() }))
      .min(1),
  })
  app.post('/api/purchase-orders', wrap(async (c) =>
    c.json(await createPurchaseOrder(db, c.var.tenantId, poSchema.parse(await c.req.json())), 201)))
  app.get('/api/purchase-orders', async (c) => c.json(await listPurchaseOrders(db, c.var.tenantId)))
  app.post('/api/purchase-orders/:id/issue', wrap(async (c) =>
    c.json(await issuePurchaseOrder(db, c.var.tenantId, pid(c)))))
  app.post('/api/purchase-orders/:id/receive', wrap(async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await receivePurchaseOrder(db, c.var.tenantId, pid(c), partialLines.parse(body.lines)))
  }))
  app.post('/api/purchase-orders/:id/cancel', wrap(async (c) =>
    c.json(await cancelPurchaseOrder(db, c.var.tenantId, pid(c)))))

  // --- sales orders --------------------------------------------------------
  const soSchema = z.object({
    customer: z.string().min(1),
    lines: z
      .array(z.object({ sku: z.string(), qty: z.number().positive(), unit_price: z.number().nonnegative() }))
      .min(1),
  })
  app.post('/api/sales-orders', wrap(async (c) =>
    c.json(await createSalesOrder(db, c.var.tenantId, soSchema.parse(await c.req.json())), 201)))
  app.get('/api/sales-orders', async (c) => c.json(await listSalesOrders(db, c.var.tenantId)))
  app.post('/api/sales-orders/:id/confirm', wrap(async (c) =>
    c.json(await confirmSalesOrder(db, c.var.tenantId, pid(c)))))
  app.post('/api/sales-orders/:id/ship', wrap(async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await shipSalesOrder(db, c.var.tenantId, pid(c), partialLines.parse(body.lines)))
  }))

  // --- work orders ---------------------------------------------------------
  const woSchema = z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    work_center: z.string().optional(),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    est_hours: z.number().nonnegative().optional(),
  })
  app.post('/api/work-orders', wrap(async (c) =>
    c.json(await createWorkOrder(db, c.var.tenantId, woSchema.parse(await c.req.json())), 201)))
  app.get('/api/work-orders', async (c) => c.json(await listWorkOrders(db, c.var.tenantId)))
  app.post('/api/work-orders/:id/release', wrap(async (c) =>
    c.json(await releaseWorkOrder(db, c.var.tenantId, pid(c)))))
  app.post('/api/work-orders/:id/issue-materials', wrap(async (c) =>
    c.json(await issueMaterials(db, c.var.tenantId, pid(c)))))
  app.post('/api/work-orders/:id/log-time', wrap(async (c) => {
    const body = z
      .object({ hours: z.number().positive(), loaded_rate: z.number().positive(), person: z.string().optional() })
      .parse(await c.req.json())
    return c.json(await logWorkOrderTime(db, c.var.tenantId, pid(c), body))
  }))
  app.post('/api/work-orders/:id/complete', wrap(async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const qtyGood = body.qty_good === undefined ? undefined : z.number().positive().parse(body.qty_good)
    return c.json(await completeWorkOrder(db, c.var.tenantId, pid(c), qtyGood))
  }))
  app.patch('/api/work-orders/:id', wrap(async (c) => {
    const body = z
      .object({
        scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        work_center: z.string().optional(),
        est_hours: z.number().nonnegative().optional(),
      })
      .parse(await c.req.json())
    return c.json(await rescheduleWorkOrder(db, c.var.tenantId, pid(c), body))
  }))

  // --- planning & capacity -------------------------------------------------
  app.get('/api/planning', async (c) => c.json(await planning(db, c.var.tenantId)))
  app.post('/api/planning/apply', wrap(async (c) => {
    const body = z.object({ sku: z.string().min(1), vendor: z.string().optional() }).parse(await c.req.json())
    return c.json(await applySuggestion(db, c.var.tenantId, body), 201)
  }))
  app.get('/api/capacity', async (c) =>
    c.json(await capacity(db, c.var.tenantId, Math.min(Number(c.req.query('days') ?? 14), 60))))

  // --- finance: bills, invoices, statements, close -------------------------
  const billSchema = z.object({
    vendor: z.string().min(1),
    amount: z.number().positive(),
    ref: z.string().optional(),
    po_number: z.string().optional(),
  })
  app.post('/api/bills', wrap(async (c) =>
    c.json(await createBill(db, c.var.tenantId, billSchema.parse(await c.req.json())), 201)))
  app.get('/api/bills', async (c) => c.json(await listBills(db, c.var.tenantId)))
  app.post('/api/bills/:id/pay', wrap(async (c) =>
    c.json(await payBill(db, c.var.tenantId, pid(c)))))
  app.get('/api/invoices', async (c) => c.json(await listInvoices(db, c.var.tenantId)))
  app.post('/api/invoices/:id/record-payment', wrap(async (c) =>
    c.json(await recordInvoicePayment(db, c.var.tenantId, pid(c)))))
  app.get('/api/financials', wrap(async (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    const dv = /^\d{4}-\d{2}-\d{2}$/
    const period: { from?: string; to?: string } = {}
    if (from) {
      if (!dv.test(from)) return c.json({ error: 'from must be YYYY-MM-DD' }, 422)
      period.from = from
    }
    if (to) {
      if (!dv.test(to)) return c.json({ error: 'to must be YYYY-MM-DD' }, 422)
      period.to = to
    }
    return c.json(await financials(db, c.var.tenantId, period))
  }))
  app.get('/api/close-checks', async (c) => c.json(await closeChecks(db, c.var.tenantId)))

  // --- QuickBooks bridge ---------------------------------------------------
  app.get('/api/qb/summary', wrap(async (c) => {
    const from = c.req.query('from') ?? ''
    const to = c.req.query('to') ?? ''
    return c.json(await qbSummary(db, c.var.tenantId, from, to))
  }))
  app.get('/api/qb/mapping', async (c) => c.json(await getMapping(db, c.var.tenantId)))
  app.put('/api/qb/mapping', wrap(async (c) => {
    const body = z
      .object({ entries: z.array(z.object({ code: z.string().min(1), qb_account: z.string().min(1) })).min(1) })
      .parse(await c.req.json())
    return c.json(await updateMapping(db, c.var.tenantId, body.entries))
  }))
  app.post('/api/qb/compare', wrap(async (c) => {
    const body = z
      .object({
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rows: z
          .array(z.object({
            account: z.string(),
            debit: z.number().nonnegative().optional(),
            credit: z.number().nonnegative().optional(),
          }))
          .min(1),
      })
      .parse(await c.req.json())
    return c.json(await compareTrialBalance(db, c.var.tenantId, body.to, body.rows))
  }))

  // --- bank reconciliation -------------------------------------------------
  app.post('/api/bank/import', wrap(async (c) => {
    const body = z.object({ csv: z.string().min(1) }).parse(await c.req.json())
    const imported = await importBankCsv(db, c.var.tenantId, body.csv)
    const matched = await autoMatch(db, c.var.tenantId)
    return c.json({ ...imported, auto_matched: matched.matched }, 201)
  }))
  app.post('/api/bank/auto-match', wrap(async (c) => c.json(await autoMatch(db, c.var.tenantId))))
  app.post('/api/bank/match', wrap(async (c) => {
    const body = z.object({ txn_id: z.string().min(1), line_id: z.string().min(1) }).parse(await c.req.json())
    return c.json(await manualMatch(db, c.var.tenantId, body.txn_id, body.line_id))
  }))
  app.post('/api/bank/txn-status', wrap(async (c) => {
    const body = z
      .object({ txn_id: z.string().min(1), status: z.enum(['unmatched', 'excluded']) })
      .parse(await c.req.json())
    return c.json(await setTxnStatus(db, c.var.tenantId, body.txn_id, body.status))
  }))
  app.get('/api/bank/reconciliation', async (c) => c.json(await reconciliation(db, c.var.tenantId)))

  // --- D2C channel settlements ---------------------------------------------
  const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  app.post('/api/channel-settlements', wrap(async (c) => {
    const body = z
      .object({
        channel: z.string().min(1),
        period_start: dateStr,
        period_end: dateStr,
        gross_sales: z.number().nonnegative(),
        refunds: z.number().nonnegative().optional(),
        fees: z.number().nonnegative().optional(),
      })
      .parse(await c.req.json())
    return c.json(await createChannelSettlement(db, c.var.tenantId, body), 201)
  }))
  app.get('/api/channel-settlements', async (c) =>
    c.json(await listChannelSettlements(db, c.var.tenantId)))
  app.post('/api/channel-shipments', wrap(async (c) => {
    const body = z
      .object({
        channel: z.string().min(1),
        period_end: dateStr,
        lines: z.array(z.object({ sku: z.string().min(1), qty: z.number().positive() })).min(1),
      })
      .parse(await c.req.json())
    return c.json(await recordChannelShipments(db, c.var.tenantId, body), 201)
  }))

  // --- onboarding importers ------------------------------------------------
  const importKind = z.enum(['items', 'parties', 'bom', 'open_invoices', 'open_bills'])
  const mappingOverride = z.record(z.string(), z.number().int().nonnegative().nullable()).optional()
  app.post('/api/import/analyze', wrap(async (c) => {
    const body = z
      .object({ csv: z.string().min(1), kind: importKind.optional(), mapping: mappingOverride })
      .parse(await c.req.json())
    return c.json(await analyze(db, c.var.tenantId, body.csv, body.kind as ImportKind | undefined, body.mapping))
  }))
  app.post('/api/import/commit', wrap(async (c) => {
    const body = z
      .object({
        csv: z.string().min(1),
        kind: importKind,
        mapping: mappingOverride,
        post_opening_stock: z.boolean().optional(),
      })
      .parse(await c.req.json())
    return c.json(
      await commit(db, c.var.tenantId, body.csv, body.kind as ImportKind, body.mapping, {
        post_opening_stock: body.post_opening_stock,
      }),
      201,
    )
  }))

  // --- people & time -------------------------------------------------------
  app.post('/api/employees', wrap(async (c) => {
    const body = z
      .object({
        name: z.string().min(1),
        cost_rate: z.number().positive(),
        skills: z.array(z.string().min(1)).optional(),
        daily_hours: z.number().positive().max(24).optional(),
      })
      .parse(await c.req.json())
    return c.json(await createEmployee(db, c.var.tenantId, body), 201)
  }))
  app.get('/api/employees', async (c) => c.json(await listEmployees(db, c.var.tenantId)))
  app.post('/api/time-entries', wrap(async (c) => {
    const body = z
      .object({
        work_order: z.string().min(1),
        hours: z.number().positive().max(24),
        employee: z.string().optional(),
        person: z.string().optional(),
        rate: z.number().positive().optional(),
        entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(await c.req.json())
    return c.json(await recordTime(db, c.var.tenantId, body), 201)
  }))
  app.get('/api/time-entries', async (c) =>
    c.json(await listTimeEntries(db, c.var.tenantId, Math.min(Number(c.req.query('days') ?? 14), 90))))

  // --- masters: work centers, BOM, reorder points --------------------------
  app.get('/api/work-centers', async (c) => {
    const r = await db.query<{ code: string; name: string; daily_hours: string }>(
      'select code, name, daily_hours from work_centers where tenant_id = $1 order by code',
      [c.var.tenantId],
    )
    return c.json(r.rows.map((w) => ({ ...w, daily_hours: num(w.daily_hours) })))
  })
  app.post('/api/work-centers', wrap(async (c) => {
    const body = z
      .object({ code: z.string().min(1), name: z.string().min(1), daily_hours: z.number().positive().default(8) })
      .parse(await c.req.json())
    await db.query('insert into work_centers (tenant_id, code, name, daily_hours) values ($1, $2, $3, $4)', [
      c.var.tenantId, body.code, body.name, body.daily_hours,
    ])
    return c.json(body, 201)
  }))
  app.get('/api/items/:sku/bom', wrap(async (c) => {
    const r = await db.query<{ sku: string; qty_per: string }>(
      `select ci.sku, b.qty_per
       from bom_lines b
       join items pi on pi.id = b.parent_item_id
       join items ci on ci.id = b.component_item_id
       where b.tenant_id = $1 and pi.sku = $2`,
      [c.var.tenantId, pid(c, 'sku')],
    )
    return c.json(r.rows.map((row) => ({ sku: row.sku, qty_per: num(row.qty_per) })))
  }))
  app.put('/api/items/:sku/bom', wrap(async (c) => {
    const body = z
      .object({ lines: z.array(z.object({ sku: z.string().min(1), qty_per: z.number().positive() })).min(1) })
      .parse(await c.req.json())
    const parentSku = pid(c, 'sku')
    await db.transaction(async (tx) => {
      const parent = await tx.query<{ id: string }>(
        'select id from items where tenant_id = $1 and sku = $2',
        [c.var.tenantId, parentSku],
      )
      if (!parent.rows[0]) throw new KernelError(`unknown item sku "${parentSku}"`)
      await tx.query('delete from bom_lines where tenant_id = $1 and parent_item_id = $2', [
        c.var.tenantId, parent.rows[0].id,
      ])
      for (const l of body.lines) {
        const comp = await tx.query<{ id: string }>(
          'select id from items where tenant_id = $1 and sku = $2',
          [c.var.tenantId, l.sku],
        )
        if (!comp.rows[0]) throw new KernelError(`unknown component sku "${l.sku}"`)
        await tx.query(
          'insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per) values ($1, $2, $3, $4)',
          [c.var.tenantId, parent.rows[0].id, comp.rows[0].id, l.qty_per],
        )
      }
    })
    return c.json({ sku: parentSku, lines: body.lines })
  }))
  app.patch('/api/items/:sku', wrap(async (c) => {
    const body = z
      .object({
        reorder_point: z.number().nonnegative().optional(),
        weekly_forecast: z.number().nonnegative().optional(),
      })
      .refine((v) => v.reorder_point !== undefined || v.weekly_forecast !== undefined, 'nothing to update')
      .parse(await c.req.json())
    const r = await db.query(
      `update items set
         reorder_point = coalesce($3, reorder_point),
         weekly_forecast = coalesce($4, weekly_forecast)
       where tenant_id = $1 and sku = $2 returning sku`,
      [c.var.tenantId, pid(c, 'sku'), body.reorder_point ?? null, body.weekly_forecast ?? null],
    )
    if (r.rows.length === 0) return c.json({ error: `unknown item sku "${pid(c, 'sku')}"` }, 404)
    return c.json({ sku: pid(c, 'sku'), ...body })
  }))
}
