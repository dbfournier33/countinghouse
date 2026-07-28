import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import {
  completeWorkOrder, confirmSalesOrder, createPurchaseOrder, createSalesOrder, createWorkOrder,
  issueMaterials, issuePurchaseOrder, logWorkOrderTime, receivePurchaseOrder, releaseWorkOrder,
  shipSalesOrder,
} from '../src/documents.js'
import {
  closeChecks, createBill, financials, listBills, listInvoices, payBill, recordInvoicePayment,
} from '../src/finance.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `Fin Tenant ${++seq}`, `fin-${seq}`)
  for (const [sku, name, kind] of [
    ['OATS', 'Oats', 'raw'],
    ['BAR', 'Bar', 'finished'],
  ] as Array<[string, string, string]>) {
    await db.query("insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $3, $4, 'ea')", [
      t, sku, name, kind,
    ])
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
  return t
}

async function balance(t: string, code: string): Promise<number> {
  const r = await db.query<{ d: string; c: string; normal_side: string }>(
    `select coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as d,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as c,
            a.normal_side
     from accounts a
     left join journal_lines jl on jl.account_id = a.id and jl.tenant_id = a.tenant_id
     where a.tenant_id = $1 and a.code = $2
     group by a.normal_side`,
    [t, code],
  )
  const row = r.rows[0]
  const net = row.normal_side === 'debit' ? num(row.d) - num(row.c) : num(row.c) - num(row.d)
  return Math.round(net * 100) / 100
}

async function receiveOats(t: string, qty: number, cost: number) {
  const po = await createPurchaseOrder(db, t, {
    vendor: 'Vendor Co',
    lines: [{ sku: 'OATS', qty, unit_cost: cost }],
  })
  await issuePurchaseOrder(db, t, po.id)
  await receivePurchaseOrder(db, t, po.id)
  return po
}

beforeAll(async () => {
  db = await openDb()
})

describe('bills', () => {
  it('inventory bill relieves GRNI; paying it moves cash; no double-pay', async () => {
    const t = await setupTenant()
    const po = await receiveOats(t, 100, 2)
    expect(await balance(t, '2110')).toBe(200)

    const bill = await createBill(db, t, { vendor: 'Vendor Co', amount: 200, po_number: po.number })
    expect(bill.kind).toBe('inventory')
    expect(await balance(t, '2110')).toBe(0)
    expect(await balance(t, '2100')).toBe(200)

    await payBill(db, t, bill.id)
    expect(await balance(t, '2100')).toBe(0)
    expect(await balance(t, '1110')).toBe(-200)
    await expect(payBill(db, t, bill.id)).rejects.toThrow(/cannot pay a paid/)
    expect((await listBills(db, t))[0].status).toBe('paid')
  })

  it('a bill with no PO posts to operating expenses', async () => {
    const t = await setupTenant()
    const bill = await createBill(db, t, { vendor: 'Vendor Co', amount: 150, ref: 'RENT-1' })
    expect(bill.kind).toBe('expense')
    expect(bill.number).toBe('RENT-1')
    expect(await balance(t, '6100')).toBe(150)
    expect(await balance(t, '2100')).toBe(150)
    expect(await balance(t, '2110')).toBe(0)
  })

  it('rejects bills against unknown POs and unknown vendors', async () => {
    const t = await setupTenant()
    await expect(
      createBill(db, t, { vendor: 'Vendor Co', amount: 10, po_number: 'PO-9999' }),
    ).rejects.toThrow(/unknown purchase order/)
    await expect(createBill(db, t, { vendor: 'Nobody', amount: 10 })).rejects.toThrow(/unknown vendor/)
  })
})

describe('invoices', () => {
  it('shipping persists an open invoice; recording payment closes it', async () => {
    const t = await setupTenant()
    await receiveOats(t, 100, 2)
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 100, work_center: 'LINE-1' })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id)
    await logWorkOrderTime(db, t, wo.id, { hours: 1, loaded_rate: 30 })
    await completeWorkOrder(db, t, wo.id)

    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 80, unit_price: 2 }],
    })
    await confirmSalesOrder(db, t, so.id)
    const shipped = await shipSalesOrder(db, t, so.id)

    const invoices = await listInvoices(db, t)
    expect(invoices).toHaveLength(1)
    expect(invoices[0].number).toBe(shipped.invoice!.number)
    expect(invoices[0].amount).toBe(160)
    expect(invoices[0].status).toBe('open')
    expect(await balance(t, '1200')).toBe(160)

    await recordInvoicePayment(db, t, invoices[0].id)
    expect(await balance(t, '1200')).toBe(0)
    expect(await balance(t, '1110')).toBe(160) // collected; the PO was never billed/paid here
    await expect(recordInvoicePayment(db, t, invoices[0].id)).rejects.toThrow(/cannot record/)
  })
})

describe('financials & close', () => {
  let t: string

  beforeAll(async () => {
    t = await setupTenant()
    await receiveOats(t, 100, 2) // billed below
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 100, work_center: 'LINE-1' })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id) // 10 oats @ 2 = 20 into WIP
    await logWorkOrderTime(db, t, wo.id, { hours: 1, loaded_rate: 30 }) // +30 labor
    await completeWorkOrder(db, t, wo.id) // 100 bars @ 0.50
    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 80, unit_price: 2 }],
    })
    await confirmSalesOrder(db, t, so.id)
    await shipSalesOrder(db, t, so.id) // revenue 160, COGS 40
    const invs = await listInvoices(db, t)
    await recordInvoicePayment(db, t, invs[0].id)
    await createBill(db, t, { vendor: 'Vendor Co', amount: 25, ref: 'RENT-X' }) // open expense
  })

  it('income statement: revenue − COGS − opex, with labor absorption contra', async () => {
    const fin = await financials(db, t)
    const is = fin.income_statement
    expect(is.revenue_total).toBe(160)
    expect(is.cogs_total).toBe(40)
    expect(is.gross_profit).toBe(120)
    // opex: 6100 = 25, labor absorbed 5290 shown as −30 → total −5
    expect(is.operating_expenses_total).toBe(-5)
    expect(is.net_income).toBe(125)
  })

  it('balance sheet balances: assets = liabilities + equity + net income', async () => {
    const fin = await financials(db, t)
    const bs = fin.balance_sheet
    expect(bs.balanced).toBe(true)
    expect(bs.assets_total).toBe(350) // cash 160 + raw 180 + finished 10
    expect(bs.liabilities_total).toBe(225) // GRNI 200 (PO not yet billed) + open rent bill 25
  })

  it('close checks: reconciliation holds; GRNI flags unbilled receipts until billed', async () => {
    const checks = await closeChecks(db, t)
    const byLabel = Object.fromEntries(checks.map((c) => [c.label, c]))
    expect(byLabel['Trial balance'].status).toBe('ok')
    expect(byLabel['Ledger ↔ operations reconciliation'].status).toBe('ok')
    expect(byLabel['Goods received, not yet billed'].status).toBe('attention') // oats PO never billed
    expect(byLabel['Open payables'].status).toBe('info')

    const pos = await db.query<{ number: string }>(
      'select number from purchase_orders where tenant_id = $1', [t])
    await createBill(db, t, { vendor: 'Vendor Co', amount: 200, po_number: pos.rows[0].number })
    const after = await closeChecks(db, t)
    expect(after.find((c) => c.label === 'Goods received, not yet billed')!.status).toBe('ok')
  })
})
