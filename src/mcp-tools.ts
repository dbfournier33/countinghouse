// MCP tool definitions — transport-agnostic and testable. Each tool runs
// against an injected `api` function (the same HTTP contract the UI uses), so
// tests can wire them straight to the Hono app and the stdio server wires them
// to fetch. Architecture §2.7: the agent gets the same door as everyone else.
import { z } from 'zod'
import { num, round2 } from './money.js'

export type ApiFn = (path: string, init?: { method?: string; body?: string }) => Promise<any>

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodRawShape
  run: (args: any, api: ApiFn) => Promise<string>
}

const j = (v: unknown) => JSON.stringify(v)

export const TOOLS: ToolDef[] = [
  {
    name: 'get_company_snapshot',
    description:
      'Headline state of the company in one call: trial balance status, cash, AR/AP, inventory value, open WIP, and open document counts. Use this first to orient.',
    schema: {},
    run: async (_a, api) => {
      const [tb, inv, pos, sos, wos] = await Promise.all([
        api('/api/trial-balance'), api('/api/inventory'),
        api('/api/purchase-orders'), api('/api/sales-orders'), api('/api/work-orders'),
      ])
      const bal = (code: string) => tb.accounts.find((a: any) => a.code === code)?.balance ?? 0
      const revenue = tb.accounts
        .filter((a: any) => a.kind === 'revenue')
        .reduce((s: number, a: any) => s + (a.normal_side === 'credit' ? a.balance : -a.balance), 0)
      return j({
        trial_balance: { balanced: tb.balanced, total: tb.total_debits },
        cash: bal('1110'),
        accounts_receivable: bal('1200'),
        accounts_payable: round2(bal('2100') + bal('2110')),
        inventory_value: inv.total_value,
        open_wip: inv.open_wip,
        net_revenue_to_date: round2(revenue),
        cogs_to_date: bal('5110'),
        open_documents: {
          purchase_orders: pos.filter((p: any) => !['received', 'cancelled'].includes(p.status)).length,
          sales_orders: sos.filter((s: any) => !['shipped', 'cancelled'].includes(s.status)).length,
          work_orders: wos.filter((w: any) => !['completed', 'cancelled'].includes(w.status)).length,
        },
      })
    },
  },
  {
    name: 'get_planning',
    description:
      'The demand/supply position for every item: on hand, on order, in production, order + forecast demand, projected position, and buy/make suggestions. THE answer to "what should we make or buy?"',
    schema: {},
    run: async (_a, api) => j(await api('/api/planning')),
  },
  {
    name: 'apply_planning_suggestion',
    description:
      'Act on a planning suggestion for a SKU: creates a DRAFT purchase order (buy) or DRAFT work order (make). Drafts still need a human to issue/release — this never commits spend on its own. Errors if the SKU has no open suggestion.',
    schema: { sku: z.string().describe('the item SKU with an open suggestion, e.g. BAR-OG') },
    run: async (a, api) =>
      j(await api('/api/planning/apply', { method: 'POST', body: j({ sku: a.sku }) })),
  },
  {
    name: 'get_financials',
    description:
      'Income statement (optionally for a from/to period, YYYY-MM-DD) and balance sheet (always as-of the end date). Live off the ledger.',
    schema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('period start YYYY-MM-DD'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('period end YYYY-MM-DD'),
    },
    run: async (a, api) => {
      const qs = new URLSearchParams()
      if (a.from) qs.set('from', a.from)
      if (a.to) qs.set('to', a.to)
      return j(await api('/api/financials' + (qs.size ? `?${qs}` : '')))
    },
  },
  {
    name: 'get_close_checklist',
    description:
      'The month-end checklist the system fills in itself: trial balance, ledger↔operations reconciliation, goods received not billed, open WIP, bank reconciliation, open AR/AP.',
    schema: {},
    run: async (_a, api) => j(await api('/api/close-checks')),
  },
  {
    name: 'get_inventory',
    description: 'On-hand quantity, moving-average cost, and value per item, plus open WIP jobs and lots on hand.',
    schema: {},
    run: async (_a, api) => {
      const [inv, lots] = await Promise.all([api('/api/inventory'), api('/api/lots')])
      return j({ ...inv, lots_on_hand: lots })
    },
  },
  {
    name: 'list_open_orders',
    description: 'Open purchase orders, sales orders, and work orders with their lines and statuses, compact.',
    schema: {},
    run: async (_a, api) => {
      const [pos, sos, wos] = await Promise.all([
        api('/api/purchase-orders'), api('/api/sales-orders'), api('/api/work-orders'),
      ])
      return j({
        purchase_orders: pos
          .filter((p: any) => !['received', 'cancelled'].includes(p.status))
          .map((p: any) => ({
            number: p.number, vendor: p.vendor, status: p.status,
            lines: p.lines.map((l: any) => `${l.sku} ${l.received_qty}/${l.qty} @ $${l.unit_cost}`),
          })),
        sales_orders: sos
          .filter((s: any) => !['shipped', 'cancelled'].includes(s.status))
          .map((s: any) => ({
            number: s.number, customer: s.customer, status: s.status,
            lines: s.lines.map((l: any) => `${l.sku} ${l.shipped_qty}/${l.qty} @ $${l.unit_price}`),
          })),
        work_orders: wos
          .filter((w: any) => !['completed', 'cancelled'].includes(w.status))
          .map((w: any) => ({
            number: w.number, make: `${w.qty} × ${w.sku}`, status: w.status,
            scheduled: w.scheduled_date, work_center: w.work_center, est_hours: w.est_hours,
            wip_cost: w.wip_cost,
          })),
      })
    },
  },
  {
    name: 'get_capacity',
    description:
      'Work-center load vs daily hours for the next N days (default 14), plus the people row (roster hours vs committed hours) and unscheduled work orders.',
    schema: { days: z.number().int().min(1).max(60).optional().describe('horizon in days, default 14') },
    run: async (a, api) => j(await api(`/api/capacity${a.days ? `?days=${a.days}` : ''}`)),
  },
  {
    name: 'trace_lot',
    description:
      'Recall trace for a lot number, both directions: which customers/channels received it (forward through work-order batches), and which vendor lots went into it (backward). A work order number IS its batch lot.',
    schema: { lot_no: z.string().describe('lot number, e.g. HNY-2207 or WO-1001') },
    run: async (a, api) => j(await api(`/api/trace?lot=${encodeURIComponent(a.lot_no)}`)),
  },
  {
    name: 'record_time_entry',
    description:
      'Log labor time against a released/in-progress work order. With an employee name the roster rate applies automatically; labor cost posts into the job WIP immediately.',
    schema: {
      work_order: z.string().describe('work order number, e.g. WO-1002'),
      employee: z.string().describe('roster employee name, e.g. Maya Torres'),
      hours: z.number().positive().max(24),
      rate: z.number().positive().optional().describe('override $/h; omit to use the roster rate'),
    },
    run: async (a, api) =>
      j(await api('/api/time-entries', { method: 'POST', body: j(a) })),
  },
]
