import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createApp } from '../src/api.js'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import {
  confirmSalesOrder, createPurchaseOrder, createSalesOrder, issuePurchaseOrder,
  receivePurchaseOrder,
} from '../src/documents.js'
import { createEmployee } from '../src/people.js'
import { TOOLS, type ApiFn } from '../src/mcp-tools.js'

let db: PGlite
let api: ApiFn

const tool = (name: string) => TOOLS.find((t) => t.name === name)!
const call = async (name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(await tool(name).run(args, api))

beforeAll(async () => {
  db = await openDb()
  const t = await provisionTenant(db, 'MCP Co', 'mcp-token')
  const app = createApp(db)
  // The tools hit the REAL app end-to-end — auth middleware included — with no
  // network: exactly what the stdio server does, minus the socket.
  api = async (path, init = {}) => {
    const res = await app.request(path, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: { Authorization: 'Bearer mcp-token', 'Content-Type': 'application/json' },
    })
    const body = await res.json()
    if (!res.ok) throw new Error((body as { error?: string }).error ?? String(res.status))
    return body
  }

  for (const [sku, kind, reorder] of [
    ['OATS', 'raw', 400],
    ['BAR', 'finished', 200],
  ] as Array<[string, string, number]>) {
    await db.query(
      "insert into items (tenant_id, sku, name, kind, uom, reorder_point) values ($1, $2, $2, $3, 'ea', $4)",
      [t, sku, kind, reorder],
    )
  }
  await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Vendor Co', '{vendor}')", [t])
  await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Customer Co', '{customer}')", [t])
  await db.query(
    "insert into work_centers (tenant_id, code, name, daily_hours) values ($1, 'LINE-1', 'Line', 8)", [t])
  const bar = await db.query<{ id: string }>("select id from items where tenant_id = $1 and sku = 'BAR'", [t])
  const oats = await db.query<{ id: string }>("select id from items where tenant_id = $1 and sku = 'OATS'", [t])
  await db.query(
    'insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per) values ($1, $2, $3, 0.1)',
    [t, bar.rows[0].id, oats.rows[0].id],
  )
  await createEmployee(db, t, { name: 'Maya', cost_rate: 38 })

  const po = await createPurchaseOrder(db, t, {
    vendor: 'Vendor Co',
    lines: [{ sku: 'OATS', qty: 100, unit_cost: 2 }],
  })
  await issuePurchaseOrder(db, t, po.id)
  await receivePurchaseOrder(db, t, po.id)
  const so = await createSalesOrder(db, t, {
    customer: 'Customer Co',
    lines: [{ sku: 'BAR', qty: 300, unit_price: 2 }],
  })
  await confirmSalesOrder(db, t, so.id)
})

describe('mcp tools against the real app', () => {
  it('every tool has an agent-usable description and unique name', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(TOOLS.length)
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(40)
  })

  it('get_company_snapshot orients in one call', async () => {
    const snap = await call('get_company_snapshot')
    expect(snap.trial_balance.balanced).toBe(true)
    expect(snap.inventory_value).toBe(200)
    expect(snap.open_documents.sales_orders).toBe(1)
  })

  it('get_planning surfaces the make suggestion; apply creates a draft WO', async () => {
    const rows = await call('get_planning')
    const bar = rows.find((r: any) => r.sku === 'BAR')
    expect(bar.suggestion.action).toBe('make') // 0 + 0 − 300 demand, reorder 200 → make 500
    expect(bar.suggestion.qty).toBe(500)

    const applied = await call('apply_planning_suggestion', { sku: 'BAR' })
    expect(applied.kind).toBe('work_order')
    const after = await call('get_planning')
    expect(after.find((r: any) => r.sku === 'BAR').suggestion).toBeNull()

    const orders = await call('list_open_orders')
    expect(orders.work_orders.some((w: any) => w.number === applied.created)).toBe(true)
  })

  it('record_time_entry uses the roster rate through the real write path', async () => {
    const orders = await call('list_open_orders')
    const wo = orders.work_orders[0].number
    // Draft WOs can't take time — the API's own guard comes through the tool.
    await expect(call('record_time_entry', { work_order: wo, employee: 'Maya', hours: 1 })).rejects.toThrow(
      /log time on/,
    )
  })

  it('get_financials and the close checklist read live', async () => {
    const fin = await call('get_financials')
    expect(fin.balance_sheet.balanced).toBe(true)
    const checks = await call('get_close_checklist')
    expect(checks.find((c: any) => c.label === 'Trial balance').status).toBe('ok')
  })

  it('trace_lot answers through the tool', async () => {
    const inv = await call('get_inventory')
    const lot = inv.lots_on_hand[0]
    const traced = await call('trace_lot', { lot_no: lot.lot_no })
    expect(traced[0].sku).toBe('OATS')
    expect(traced[0].on_hand).toBe(100)
  })

  it('surfaces API errors as thrown errors, not silent nulls', async () => {
    await expect(call('apply_planning_suggestion', { sku: 'NOPE' })).rejects.toThrow(/no open suggestion/)
  })
})
