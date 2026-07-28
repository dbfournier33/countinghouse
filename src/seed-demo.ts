// Seeds .data/kernel with the golden-path demo story for Big Sur Provisions,
// a small granola-bar manufacturer. Run BEFORE starting the server (the dev
// database is single-process): npm run seed && npm run dev
import { rmSync } from 'node:fs'
import { openDb, provisionTenant } from './bootstrap.js'
import { ingest, type EventType } from './events.js'
import { num } from './money.js'

rmSync('.data', { recursive: true, force: true })

const db = await openDb('.data/kernel')
const tenantId = await provisionTenant(db, 'Big Sur Provisions', 'dev-bigsur')

const items: Array<[string, string, 'raw' | 'finished', string]> = [
  ['OATS', 'Rolled oats', 'raw', 'kg'],
  ['HONEY', 'Wildflower honey', 'raw', 'kg'],
  ['WRAP', 'Printed wrapper film', 'raw', 'ea'],
  ['BAR-OG', 'Original granola bar 45g', 'finished', 'ea'],
]
for (const [sku, name, kind, uom] of items) {
  await db.query('insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $3, $4, $5)', [
    tenantId, sku, name, kind, uom,
  ])
}

const parties: Array<[string, string[]]> = [
  ['Cascade Farm Supply', ['vendor']],
  ['Ridgeline Market', ['customer']],
  ['Maya Torres', ['employee']],
]
for (const [name, roles] of parties) {
  await db.query('insert into parties (tenant_id, name, roles) values ($1, $2, $3)', [tenantId, name, roles])
}

// One week in the life: buy → make → ship → get paid. Every event below posts
// its own journal entry through the rules — no accounting steps anywhere.
const story: Array<[EventType, Record<string, unknown>]> = [
  ['GoodsReceived', { sku: 'OATS', qty: 500, unit_cost: 2.4, ref: 'PO-1001' }],
  ['GoodsReceived', { sku: 'HONEY', qty: 200, unit_cost: 6.5, ref: 'PO-1001' }],
  ['GoodsReceived', { sku: 'WRAP', qty: 10000, unit_cost: 0.06, ref: 'PO-1002' }],
  ['BillPosted', { amount: 2500, vendor: 'Cascade Farm Supply', ref: 'BILL-8841' }],
  ['PaymentMade', { amount: 2500, ref: 'BILL-8841' }],
  ['MaterialIssued', { sku: 'OATS', qty: 120, work_order: 'WO-1001' }],
  ['MaterialIssued', { sku: 'HONEY', qty: 40, work_order: 'WO-1001' }],
  ['MaterialIssued', { sku: 'WRAP', qty: 2400, work_order: 'WO-1001' }],
  ['TimeLogged', { hours: 6, loaded_rate: 38, work_order: 'WO-1001', person: 'Maya Torres' }],
  ['ProductionCompleted', { sku: 'BAR-OG', qty: 2400, work_order: 'WO-1001' }],
  ['GoodsShipped', { sku: 'BAR-OG', qty: 2000, ref: 'SO-2001' }],
  ['InvoiceIssued', { amount: 3400, customer: 'Ridgeline Market', ref: 'INV-2001' }],
  ['PaymentReceived', { amount: 3400, ref: 'INV-2001' }],
  ['AdjustmentMade', { sku: 'WRAP', qty_delta: -15, reason: 'damaged roll end' }],
]

for (const [type, payload] of story) {
  const r = await ingest(db, tenantId, { type, payload })
  console.log(`#${String(r.event.seq).padStart(2)} ${type.padEnd(20)} ${r.journal?.memo ?? '(no posting)'}`)
}

const tb = await db.query<{ code: string; name: string; debits: string; credits: string }>(
  `select a.code, a.name,
          coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as debits,
          coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as credits
   from accounts a
   left join journal_lines jl on jl.account_id = a.id and jl.tenant_id = a.tenant_id
   where a.tenant_id = $1
   group by a.code, a.name
   having coalesce(sum(jl.amount), 0) <> 0
   order by a.code`,
  [tenantId],
)
console.log('\nTrial balance:')
let d = 0
let cr = 0
for (const row of tb.rows) {
  d += num(row.debits)
  cr += num(row.credits)
  console.log(
    `  ${row.code} ${row.name.padEnd(36)} ${num(row.debits).toFixed(2).padStart(10)} ${num(row.credits).toFixed(2).padStart(10)}`,
  )
}
console.log(`  ${''.padEnd(41)} ${d.toFixed(2).padStart(10)} ${cr.toFixed(2).padStart(10)}  ${Math.abs(d - cr) < 0.005 ? '✓ balanced' : '✗ OUT OF BALANCE'}`)

await db.close()
