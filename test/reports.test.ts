import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import {
  completeWorkOrder, createPurchaseOrder, createWorkOrder, issueMaterials, issuePurchaseOrder,
  receivePurchaseOrder, releaseWorkOrder,
} from '../src/documents.js'
import { ingest } from '../src/events.js'
import { createEmployee, recordTime } from '../src/people.js'
import { jobCostDetail, jobCostList } from '../src/reports.js'

let db: PGlite
let seq = 0

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `Rpt Tenant ${++seq}`, `rpt-${seq}`)
  for (const [sku, kind] of [
    ['OATS', 'raw'],
    ['BAR', 'finished'],
  ] as Array<[string, string]>) {
    await db.query("insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $2, $3, 'ea')", [
      t, sku, kind,
    ])
  }
  await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Vendor Co', '{vendor}')", [t])
  await db.query(
    "insert into work_centers (tenant_id, code, name, daily_hours) values ($1, 'LINE-1', 'Line', 8)", [t])
  const bar = await db.query<{ id: string }>("select id from items where tenant_id = $1 and sku = 'BAR'", [t])
  const oats = await db.query<{ id: string }>("select id from items where tenant_id = $1 and sku = 'OATS'", [t])
  await db.query(
    'insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per) values ($1, $2, $3, 0.1)',
    [t, bar.rows[0].id, oats.rows[0].id],
  )
  await createEmployee(db, t, { name: 'Maya', cost_rate: 30 })
  const po = await createPurchaseOrder(db, t, {
    vendor: 'Vendor Co',
    lines: [{ sku: 'OATS', qty: 200, unit_cost: 2 }],
  })
  await issuePurchaseOrder(db, t, po.id)
  await receivePurchaseOrder(db, t, po.id)
  return t
}

beforeAll(async () => {
  db = await openDb()
})

describe('job cost report', () => {
  it('on-plan job: plan equals actual, yield 100%, unit cost exact', async () => {
    const t = await setupTenant()
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 500, work_center: 'LINE-1', est_hours: 2 })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id) // 50 oats @ 2 = 100
    await recordTime(db, t, { work_order: wo.number, hours: 2, employee: 'Maya' }) // 60
    await completeWorkOrder(db, t, wo.id)

    const [row] = await jobCostList(db, t)
    expect(row).toMatchObject({
      number: wo.number,
      qty_ordered: 500,
      qty_completed: 500,
      yield_pct: 100,
      planned_materials: 100,
      actual_materials: 100,
      materials_variance: 0,
      planned_hours: 2,
      actual_hours: 2,
      actual_labor: 60,
      wip_open: 0,
      actual_unit_cost: 0.32, // (100 + 60) / 500
      planned_unit_materials: 0.2,
    })
  })

  it('over-issue and short yield show up as variance and scrap', async () => {
    const t = await setupTenant()
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 500, work_center: 'LINE-1', est_hours: 2 })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id) // plan 100
    // Spillage: 10 extra oats beyond the BOM.
    await ingest(db, t, { type: 'MaterialIssued', payload: { sku: 'OATS', qty: 10, work_order: wo.number } })
    await recordTime(db, t, { work_order: wo.number, hours: 3, employee: 'Maya' }) // over est
    await completeWorkOrder(db, t, wo.id, 450) // 90% yield

    const [row] = await jobCostList(db, t)
    expect(row.actual_materials).toBe(120) // 60 oats @ 2
    expect(row.materials_variance).toBe(20)
    expect(row.yield_pct).toBe(90)
    expect(row.actual_hours).toBe(3)
    expect(row.actual_unit_cost).toBeCloseTo((120 + 90) / 450, 4)

    const detail = (await jobCostDetail(db, t, wo.number))!
    expect(detail.components).toHaveLength(1)
    expect(detail.components[0]).toMatchObject({
      sku: 'OATS', qty_required: 50, qty_issued: 60, planned_cost: 100, actual_cost: 120, variance: 20,
    })
    expect(detail.time_entries).toHaveLength(1)
    expect(detail.time_entries[0]).toMatchObject({ person: 'Maya', hours: 3, cost: 90 })
  })

  it('open jobs show WIP and no unit cost yet; unknown WO detail is null', async () => {
    const t = await setupTenant()
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 100, work_center: 'LINE-1', est_hours: 1 })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id) // 10 oats @ 2 = 20 in WIP
    const [row] = await jobCostList(db, t)
    expect(row.wip_open).toBe(20)
    expect(row.qty_completed).toBe(0)
    expect(row.actual_unit_cost).toBeNull()
    expect(row.yield_pct).toBeNull()
    expect(await jobCostDetail(db, t, 'WO-9999')).toBeNull()
  })
})
