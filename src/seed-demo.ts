// Seeds .data/kernel with the Big Sur Provisions demo — Phase 1 edition: the
// whole story now runs through DOCUMENTS (POs, SOs, WOs), which emit the same
// spine events underneath. Run BEFORE starting the server: npm run seed && npm run dev
import { rmSync } from 'node:fs'
import { openDb, provisionTenant } from './bootstrap.js'
import {
  completeWorkOrder, confirmSalesOrder, createPurchaseOrder, createSalesOrder, createWorkOrder,
  issueMaterials, issuePurchaseOrder, receivePurchaseOrder, releaseWorkOrder,
  shipSalesOrder,
} from './documents.js'
import { createBill, payBill, recordInvoicePayment } from './finance.js'
import { createEmployee, recordTime } from './people.js'
import { ingest } from './events.js'
import { num } from './money.js'

rmSync('.data', { recursive: true, force: true })

const db = await openDb('.data/kernel')
const tenantId = await provisionTenant(db, 'Big Sur Provisions', 'dev-bigsur')
const log = (s: string) => console.log(s)

// --- masters ---------------------------------------------------------------
const items: Array<[string, string, 'raw' | 'finished', string, number]> = [
  ['OATS', 'Rolled oats', 'raw', 'kg', 400],
  ['HONEY', 'Wildflower honey', 'raw', 'kg', 60],
  ['WRAP', 'Printed wrapper film', 'raw', 'ea', 5000],
  ['BAR-OG', 'Original granola bar 45g', 'finished', 'ea', 200],
]
for (const [sku, name, kind, uom, reorder] of items) {
  await db.query(
    'insert into items (tenant_id, sku, name, kind, uom, reorder_point) values ($1, $2, $3, $4, $5, $6)',
    [tenantId, sku, name, kind, uom, reorder],
  )
}
for (const [name, roles] of [
  ['Cascade Farm Supply', ['vendor']],
  ['Harbor Property Mgmt', ['vendor']],
  ['Ridgeline Market', ['customer']],
  ['Summit Outfitters', ['customer']],
  ['Maya Torres', ['employee']],
] as Array<[string, string[]]>) {
  await db.query('insert into parties (tenant_id, name, roles) values ($1, $2, $3)', [tenantId, name, roles])
}
for (const [code, name, hours] of [
  ['LINE-1', 'Bar line', 8],
  ['PACK-1', 'Packing', 8],
] as Array<[string, string, number]>) {
  await db.query('insert into work_centers (tenant_id, code, name, daily_hours) values ($1, $2, $3, $4)', [
    tenantId, code, name, hours,
  ])
}
await createEmployee(db, tenantId, {
  name: 'Maya Torres', cost_rate: 38, skills: ['line lead', 'mixing'], daily_hours: 8,
})
await createEmployee(db, tenantId, {
  name: 'Diego Ruiz', cost_rate: 32, skills: ['packing'], daily_hours: 8,
})

// BOM for one bar: 50 g oats, 16.67 g honey, 1 wrapper
const barId = (await db.query<{ id: string }>(
  "select id from items where tenant_id = $1 and sku = 'BAR-OG'", [tenantId])).rows[0].id
for (const [sku, qtyPer] of [
  ['OATS', 0.05],
  ['HONEY', 0.0166666667],
  ['WRAP', 1],
] as Array<[string, number]>) {
  const comp = await db.query<{ id: string }>(
    'select id from items where tenant_id = $1 and sku = $2', [tenantId, sku])
  await db.query(
    'insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per) values ($1, $2, $3, $4)',
    [tenantId, barId, comp.rows[0].id, qtyPer],
  )
}
log('masters: 4 items, 3 parties, 2 work centers, BOM for BAR-OG')

// --- the story, through documents -----------------------------------------
const today = new Date()
const dstr = (offset: number) =>
  new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10)

const po1 = await createPurchaseOrder(db, tenantId, {
  vendor: 'Cascade Farm Supply',
  lines: [
    { sku: 'OATS', qty: 500, unit_cost: 2.4 },
    { sku: 'HONEY', qty: 200, unit_cost: 6.5 },
  ],
})
await issuePurchaseOrder(db, tenantId, po1.id)
await receivePurchaseOrder(db, tenantId, po1.id)
log(`${po1.number}: issued + received (oats, honey)`)

const po2 = await createPurchaseOrder(db, tenantId, {
  vendor: 'Cascade Farm Supply',
  lines: [{ sku: 'WRAP', qty: 10000, unit_cost: 0.06 }],
})
await issuePurchaseOrder(db, tenantId, po2.id)
await receivePurchaseOrder(db, tenantId, po2.id)
log(`${po2.number}: issued + received (wrappers)`)

// Phase 2: bills are documents now. PO-1001 gets billed and paid; the wrapper
// PO stays received-not-billed so the close checklist has something to say.
const bill1 = await createBill(db, tenantId, {
  vendor: 'Cascade Farm Supply', amount: 2500, ref: 'BILL-8841', po_number: po1.number,
})
await payBill(db, tenantId, bill1.id)
log(`${bill1.number}: posted against ${po1.number} (relieves GRNI) + paid`)

const rent = await createBill(db, tenantId, { vendor: 'Harbor Property Mgmt', amount: 1800, ref: 'RENT-JUL' })
log(`${rent.number}: expense bill posted (rent) — left open`)

const so1 = await createSalesOrder(db, tenantId, {
  customer: 'Ridgeline Market',
  lines: [{ sku: 'BAR-OG', qty: 2000, unit_price: 1.7 }],
})
await confirmSalesOrder(db, tenantId, so1.id)
log(`${so1.number}: confirmed (2,000 bars @ $1.70)`)

const wo1 = await createWorkOrder(db, tenantId, {
  sku: 'BAR-OG', qty: 2400, work_center: 'LINE-1', scheduled_date: dstr(0), est_hours: 6,
})
await releaseWorkOrder(db, tenantId, wo1.id)
await issueMaterials(db, tenantId, wo1.id)
await recordTime(db, tenantId, { work_order: wo1.number, hours: 6, employee: 'Maya Torres' })
await completeWorkOrder(db, tenantId, wo1.id)
log(`${wo1.number}: BOM exploded → ${wo1.components.map((c) => `${c.qty_required} ${c.sku}`).join(', ')} → completed 2,400 bars`)

const shipped = await shipSalesOrder(db, tenantId, so1.id)
log(`${so1.number}: shipped — auto-invoiced ${shipped.invoice?.number} $${shipped.invoice?.amount}`)
const inv1 = await db.query<{ id: string }>(
  'select id from invoices where tenant_id = $1 and number = $2', [tenantId, shipped.invoice!.number])
await recordInvoicePayment(db, tenantId, inv1.rows[0].id)
log(`${shipped.invoice!.number}: customer payment recorded`)
await ingest(db, tenantId, { type: 'AdjustmentMade', payload: { sku: 'WRAP', qty_delta: -15, reason: 'damaged roll end' } })

// A wholesale order shipped on terms — open AR for the finance page.
const so3 = await createSalesOrder(db, tenantId, {
  customer: 'Summit Outfitters',
  lines: [{ sku: 'BAR-OG', qty: 300, unit_price: 1.8 }],
})
await confirmSalesOrder(db, tenantId, so3.id)
const shipped3 = await shipSalesOrder(db, tenantId, so3.id)
log(`${so3.number}: shipped — ${shipped3.invoice?.number} $${shipped3.invoice?.amount} on terms (open AR)`)

// Open commitments so planning and capacity have something to say:
const so2 = await createSalesOrder(db, tenantId, {
  customer: 'Ridgeline Market',
  lines: [{ sku: 'BAR-OG', qty: 3000, unit_price: 1.7 }],
})
await confirmSalesOrder(db, tenantId, so2.id)
log(`${so2.number}: confirmed (open demand: 3,000 bars)`)

const wo2 = await createWorkOrder(db, tenantId, {
  sku: 'BAR-OG', qty: 600, work_center: 'LINE-1', scheduled_date: dstr(2), est_hours: 2.5,
})
await releaseWorkOrder(db, tenantId, wo2.id)
await recordTime(db, tenantId, { work_order: wo2.number, hours: 1.5, employee: 'Diego Ruiz' })
log(`${wo2.number}: released for ${dstr(2)} (600 bars, 2.5h on LINE-1); Diego logged 1.5h setup`)

const wo3 = await createWorkOrder(db, tenantId, {
  sku: 'BAR-OG', qty: 1800, work_center: 'LINE-1', scheduled_date: dstr(3), est_hours: 7,
})
await releaseWorkOrder(db, tenantId, wo3.id)
log(`${wo3.number}: released for ${dstr(3)} (1,800 bars, 7h on LINE-1 — near capacity)`)

// --- closing check ---------------------------------------------------------
const tb = await db.query<{ d: string; c: string }>(
  `select coalesce(sum(case when side = 'debit' then amount end), 0) as d,
          coalesce(sum(case when side = 'credit' then amount end), 0) as c
   from journal_lines where tenant_id = $1`,
  [tenantId],
)
const d = num(tb.rows[0].d)
const c = num(tb.rows[0].c)
log(`\ntrial balance: ${d.toFixed(2)} = ${c.toFixed(2)} ${Math.abs(d - c) < 0.005 ? '✓ balanced' : '✗ OUT OF BALANCE'}`)

await db.close()
