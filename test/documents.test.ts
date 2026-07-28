import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import {
  applySuggestion, cancelPurchaseOrder, capacity, completeWorkOrder, confirmSalesOrder,
  createPurchaseOrder, createSalesOrder, createWorkOrder, issueMaterials, issuePurchaseOrder,
  logWorkOrderTime, planning, receivePurchaseOrder, releaseWorkOrder, rescheduleWorkOrder,
  shipSalesOrder,
} from '../src/documents.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `Doc Tenant ${++seq}`, `doc-${seq}`)
  for (const [sku, name, kind, uom, reorder] of [
    ['OATS', 'Rolled oats', 'raw', 'kg', 400],
    ['HONEY', 'Wildflower honey', 'raw', 'kg', 60],
    ['WRAP', 'Wrapper film', 'raw', 'ea', 5000],
    ['BAR', 'Granola bar', 'finished', 'ea', 200],
  ] as Array<[string, string, string, string, number]>) {
    await db.query(
      'insert into items (tenant_id, sku, name, kind, uom, reorder_point) values ($1, $2, $3, $4, $5, $6)',
      [t, sku, name, kind, uom, reorder],
    )
  }
  await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Vendor Co', '{vendor}')", [t])
  await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Customer Co', '{customer}')", [t])
  await db.query(
    "insert into work_centers (tenant_id, code, name, daily_hours) values ($1, 'LINE-1', 'Line', 8)",
    [t],
  )
  const bar = await db.query<{ id: string }>(
    "select id from items where tenant_id = $1 and sku = 'BAR'", [t])
  for (const [sku, qtyPer] of [
    ['OATS', 0.05],
    ['HONEY', 0.0166666667],
    ['WRAP', 1],
  ] as Array<[string, number]>) {
    const comp = await db.query<{ id: string }>(
      'select id from items where tenant_id = $1 and sku = $2', [t, sku])
    await db.query(
      'insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per) values ($1, $2, $3, $4)',
      [t, bar.rows[0].id, comp.rows[0].id, qtyPer],
    )
  }
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

async function stock(t: string, sku: string): Promise<number> {
  const r = await db.query<{ q: string }>(
    `select coalesce(ic.qty_on_hand, 0) as q
     from items i left join item_costs ic on ic.item_id = i.id and ic.tenant_id = i.tenant_id
     where i.tenant_id = $1 and i.sku = $2`,
    [t, sku],
  )
  return num(r.rows[0].q)
}

beforeAll(async () => {
  db = await openDb()
})

describe('purchase orders', () => {
  it('drafts, issues, receives — stock and GRNI move only on receipt', async () => {
    const t = await setupTenant()
    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [
        { sku: 'OATS', qty: 500, unit_cost: 2.4 },
        { sku: 'HONEY', qty: 200, unit_cost: 6.5 },
      ],
    })
    expect(po.number).toBe('PO-1001')
    expect(await stock(t, 'OATS')).toBe(0)
    await expect(receivePurchaseOrder(db, t, po.id)).rejects.toThrow(/cannot receive against a draft/)

    await issuePurchaseOrder(db, t, po.id)
    const rec = await receivePurchaseOrder(db, t, po.id)
    expect(rec.status).toBe('received')
    expect(await stock(t, 'OATS')).toBe(500)
    expect(await balance(t, '1310')).toBe(2500) // 500 × 2.40 + 200 × 6.50
    expect(await balance(t, '2110')).toBe(2500)
    await expect(cancelPurchaseOrder(db, t, po.id)).rejects.toThrow(/cannot cancel/)
  })

  it('partial receipt tracks line remainders and blocks over-receiving', async () => {
    const t = await setupTenant()
    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [{ sku: 'OATS', qty: 100, unit_cost: 2 }],
    })
    await issuePurchaseOrder(db, t, po.id)
    const lines = await db.query<{ id: string }>(
      'select id from po_lines where tenant_id = $1 and po_id = $2', [t, po.id])
    const lineId = lines.rows[0].id
    const rec = await receivePurchaseOrder(db, t, po.id, [{ line_id: lineId, qty: 60 }])
    expect(rec.status).toBe('partially_received')
    expect(await stock(t, 'OATS')).toBe(60)
    await expect(
      receivePurchaseOrder(db, t, po.id, [{ line_id: lineId, qty: 41 }]),
    ).rejects.toThrow(/40 remaining/)
  })
})

describe('the full documented loop: PO → WO → SO', () => {
  let t: string

  beforeAll(async () => {
    t = await setupTenant()
    const po1 = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [
        { sku: 'OATS', qty: 500, unit_cost: 2.4 },
        { sku: 'HONEY', qty: 200, unit_cost: 6.5 },
      ],
    })
    await issuePurchaseOrder(db, t, po1.id)
    await receivePurchaseOrder(db, t, po1.id)
    const po2 = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [{ sku: 'WRAP', qty: 10000, unit_cost: 0.06 }],
    })
    await issuePurchaseOrder(db, t, po2.id)
    await receivePurchaseOrder(db, t, po2.id)
  })

  it('explodes the BOM to exact requirements', async () => {
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 2400, work_center: 'LINE-1', est_hours: 6 })
    const req = Object.fromEntries(wo.components.map((c) => [c.sku, c.qty_required]))
    expect(req).toEqual({ OATS: 120, HONEY: 40, WRAP: 2400 })

    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id)
    expect(await balance(t, '1330')).toBe(692) // 288 + 260 + 144
    await logWorkOrderTime(db, t, wo.id, { hours: 6, loaded_rate: 38 })
    expect(await balance(t, '1330')).toBe(920)
    await completeWorkOrder(db, t, wo.id)
    expect(await balance(t, '1330')).toBe(0)
    expect(await stock(t, 'BAR')).toBe(2400)
    expect(await balance(t, '1350')).toBe(920)
  })

  it('ships against the SO and auto-invoices at line prices', async () => {
    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 2000, unit_price: 1.7 }],
    })
    await expect(shipSalesOrder(db, t, so.id)).rejects.toThrow(/cannot ship against a draft/)
    await confirmSalesOrder(db, t, so.id)
    const shipped = await shipSalesOrder(db, t, so.id)
    expect(shipped.status).toBe('shipped')
    expect(shipped.invoice).toEqual({ number: 'INV-2001', amount: 3400 })
    expect(await balance(t, '5110')).toBe(766.67)
    expect(await balance(t, '1350')).toBe(153.33)
    expect(await balance(t, '1200')).toBe(3400)
    expect(await balance(t, '4100')).toBe(3400)
  })

  it('blocks shipping more than the order allows', async () => {
    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 100, unit_price: 1.7 }],
    })
    await confirmSalesOrder(db, t, so.id)
    const lines = await db.query<{ id: string }>(
      'select id from so_lines where tenant_id = $1 and so_id = $2', [t, so.id])
    await expect(
      shipSalesOrder(db, t, so.id, [{ line_id: lines.rows[0].id, qty: 150 }]),
    ).rejects.toThrow(/100 remaining/)
  })
})

describe('planning', () => {
  it('computes projected position and suggests buy/make below reorder point', async () => {
    const t = await setupTenant()
    // Stock: 380 oats, 160 honey, 7585 wrap, 400 bars (receipts + adjustments)
    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [
        { sku: 'OATS', qty: 380, unit_cost: 2.4 },
        { sku: 'HONEY', qty: 160, unit_cost: 6.5 },
        { sku: 'WRAP', qty: 7585, unit_cost: 0.06 },
        { sku: 'BAR', qty: 400, unit_cost: 0.38 },
      ],
    })
    await issuePurchaseOrder(db, t, po.id)
    await receivePurchaseOrder(db, t, po.id)

    // Open demand: 3,000 bars. Open supply: WO for 2,400 bars (released).
    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 3000, unit_price: 1.7 }],
    })
    await confirmSalesOrder(db, t, so.id)
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 2400, work_center: 'LINE-1' })
    await releaseWorkOrder(db, t, wo.id)

    const rows = await planning(db, t)
    const bar = rows.find((r) => r.sku === 'BAR')!
    // 400 on hand + 2400 in production − 3000 demand = −200; reorder 200 → make 400
    expect(bar.projected).toBe(-200)
    expect(bar.suggestion).toEqual({ action: 'make', qty: 400 })
    const oats = rows.find((r) => r.sku === 'OATS')!
    // 380 − 120 WO demand = 260; reorder 400 → buy 140
    expect(oats.projected).toBe(260)
    expect(oats.suggestion).toEqual({ action: 'buy', qty: 140 })
    const honey = rows.find((r) => r.sku === 'HONEY')!
    expect(honey.suggestion).toBeNull() // 160 − 40 = 120 ≥ 60

    // Applying the buy suggestion creates a draft PO and clears the suggestion.
    const applied = await applySuggestion(db, t, { sku: 'OATS' })
    expect(applied.kind).toBe('purchase_order')
    const after = await planning(db, t)
    expect(after.find((r) => r.sku === 'OATS')!.suggestion).toBeNull()

    // Applying the make suggestion creates a draft WO (which itself demands raw).
    const made = await applySuggestion(db, t, { sku: 'BAR' })
    expect(made.kind).toBe('work_order')
    expect((await planning(db, t)).find((r) => r.sku === 'BAR')!.suggestion).toBeNull()
  })
})

describe('capacity', () => {
  it('sums committed hours per work center per day and reschedules', async () => {
    const t = await setupTenant()
    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [
        { sku: 'OATS', qty: 100, unit_cost: 2 },
        { sku: 'HONEY', qty: 50, unit_cost: 6 },
        { sku: 'WRAP', qty: 5000, unit_cost: 0.06 },
      ],
    })
    await issuePurchaseOrder(db, t, po.id)
    await receivePurchaseOrder(db, t, po.id)

    const today = new Date().toISOString().slice(0, 10)
    const wo1 = await createWorkOrder(db, t, { sku: 'BAR', qty: 500, work_center: 'LINE-1', scheduled_date: today, est_hours: 5 })
    await releaseWorkOrder(db, t, wo1.id)
    const wo2 = await createWorkOrder(db, t, { sku: 'BAR', qty: 400, work_center: 'LINE-1', scheduled_date: today, est_hours: 4 })
    await releaseWorkOrder(db, t, wo2.id)
    const draft = await createWorkOrder(db, t, { sku: 'BAR', qty: 100 })

    const cap = await capacity(db, t)
    const line = cap.work_centers.find((w) => w.code === 'LINE-1')!
    expect(line.load[today].hours).toBe(9) // 5 + 4 — over the 8h day
    expect(line.load[today].wos).toEqual([wo1.number, wo2.number])
    expect(cap.unscheduled.map((w) => w.number)).toContain(draft.number)

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    await rescheduleWorkOrder(db, t, wo2.id, { scheduled_date: tomorrow })
    const cap2 = await capacity(db, t)
    const line2 = cap2.work_centers.find((w) => w.code === 'LINE-1')!
    expect(line2.load[today].hours).toBe(5)
    expect(line2.load[tomorrow].hours).toBe(4)
  })
})

describe('work order guards', () => {
  it('requires a BOM and blocks making raw items', async () => {
    const t = await setupTenant()
    await expect(createWorkOrder(db, t, { sku: 'OATS', qty: 10 })).rejects.toThrow(/finished goods or subassemblies/)
    await db.query(
      "insert into items (tenant_id, sku, name, kind, uom) values ($1, 'NOBOM', 'No BOM item', 'finished', 'ea')",
      [t],
    )
    await expect(createWorkOrder(db, t, { sku: 'NOBOM', qty: 10 })).rejects.toThrow(/no bill of materials/)
  })

  it('blocks completing before any work happens', async () => {
    const t = await setupTenant()
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 10 })
    await expect(completeWorkOrder(db, t, wo.id)).rejects.toThrow(/cannot complete a draft/)
    await releaseWorkOrder(db, t, wo.id)
    await expect(completeWorkOrder(db, t, wo.id)).rejects.toThrow(/cannot complete a released/)
  })
})
