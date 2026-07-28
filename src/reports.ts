// Job cost: planned vs actual per work order. Plan = BOM requirements at
// CURRENT average costs (stated basis — no standard-cost maintenance burden)
// plus estimated hours; actual = issued materials at the costs they moved at,
// logged labor at logged rates, output at completed quantity. The variance
// column is the conversation every shop has at month end, minus the month end.
import type { PGlite } from '@electric-sql/pglite'
import { num, round2, round4 } from './money.js'

export interface JobCostRow {
  number: string
  sku: string
  item: string
  status: string
  qty_ordered: number
  qty_completed: number
  yield_pct: number | null
  planned_materials: number
  actual_materials: number
  materials_variance: number
  planned_hours: number
  actual_hours: number
  actual_labor: number
  wip_open: number
  actual_unit_cost: number | null
  planned_unit_materials: number | null
}

export async function jobCostList(db: PGlite, tenantId: string): Promise<JobCostRow[]> {
  const wos = await db.query<{
    id: string
    number: string
    status: string
    qty: string
    est_hours: string
    sku: string
    item: string
  }>(
    `select w.id, w.number, w.status, w.qty, w.est_hours, i.sku, i.name as item
     from work_orders w join items i on i.id = w.item_id
     where w.tenant_id = $1
     order by w.number desc`,
    [tenantId],
  )

  // Planned materials: component requirements × current average cost.
  const plans = await db.query<{ wo_id: string; planned: string }>(
    `select c.wo_id, coalesce(sum(c.qty_required * coalesce(ic.avg_cost, 0)), 0) as planned
     from wo_components c
     left join item_costs ic on ic.item_id = c.item_id and ic.tenant_id = c.tenant_id
     where c.tenant_id = $1
     group by c.wo_id`,
    [tenantId],
  )
  // Actual materials + completed output, from the moves the events produced.
  const actuals = await db.query<{ work_order: string; materials: string; completed: string }>(
    `select e.payload->>'work_order' as work_order,
            coalesce(sum(im.value) filter (where e.type = 'MaterialIssued'), 0) as materials,
            coalesce(sum(im.qty) filter (where e.type = 'ProductionCompleted'), 0) as completed
     from inventory_moves im
     join events e on e.id = im.event_id
     where im.tenant_id = $1 and e.payload->>'work_order' is not null
     group by e.payload->>'work_order'`,
    [tenantId],
  )
  const labor = await db.query<{ wo_id: string; hours: string; cost: string }>(
    `select wo_id, coalesce(sum(hours), 0) as hours, coalesce(sum(labor_cost), 0) as cost
     from time_entries where tenant_id = $1 group by wo_id`,
    [tenantId],
  )
  const wip = await db.query<{ work_order: string; open: string }>(
    'select work_order, accumulated_cost as open from wip_jobs where tenant_id = $1',
    [tenantId],
  )

  const planM = new Map(plans.rows.map((r) => [r.wo_id, num(r.planned)]))
  const actM = new Map(actuals.rows.map((r) => [r.work_order, r]))
  const laborM = new Map(labor.rows.map((r) => [r.wo_id, r]))
  const wipM = new Map(wip.rows.map((r) => [r.work_order, num(r.open)]))

  return wos.rows.map((w) => {
    const qtyOrdered = num(w.qty)
    const act = actM.get(w.number)
    const lab = laborM.get(w.id)
    const plannedMaterials = round2(planM.get(w.id) ?? 0)
    const actualMaterials = round2(num(act?.materials))
    const qtyCompleted = round4(num(act?.completed))
    const actualHours = round2(num(lab?.hours))
    const actualLabor = round2(num(lab?.cost))
    const totalActual = round2(actualMaterials + actualLabor)
    return {
      number: w.number,
      sku: w.sku,
      item: w.item,
      status: w.status,
      qty_ordered: qtyOrdered,
      qty_completed: qtyCompleted,
      yield_pct: qtyCompleted > 0 ? round2((qtyCompleted / qtyOrdered) * 100) : null,
      planned_materials: plannedMaterials,
      actual_materials: actualMaterials,
      materials_variance: round2(actualMaterials - plannedMaterials),
      planned_hours: num(w.est_hours),
      actual_hours: actualHours,
      actual_labor: actualLabor,
      wip_open: wipM.get(w.number) ?? 0,
      actual_unit_cost: qtyCompleted > 0 ? round4(totalActual / qtyCompleted) : null,
      planned_unit_materials: qtyOrdered > 0 ? round4(plannedMaterials / qtyOrdered) : null,
    }
  })
}

export async function jobCostDetail(db: PGlite, tenantId: string, number: string) {
  const list = await jobCostList(db, tenantId)
  const summary = list.find((r) => r.number === number)
  if (!summary) return null

  const components = await db.query<{
    sku: string
    name: string
    qty_required: string
    issued_qty: string
    avg_cost: string
  }>(
    `select i.sku, i.name, c.qty_required, c.issued_qty, coalesce(ic.avg_cost, 0) as avg_cost
     from wo_components c
     join work_orders w on w.id = c.wo_id
     join items i on i.id = c.item_id
     left join item_costs ic on ic.item_id = c.item_id and ic.tenant_id = c.tenant_id
     where c.tenant_id = $1 and w.number = $2
     order by i.sku`,
    [tenantId, number],
  )
  const actualByItem = await db.query<{ sku: string; value: string; qty: string }>(
    `select i.sku, coalesce(sum(im.value), 0) as value, coalesce(sum(im.qty), 0) as qty
     from inventory_moves im
     join events e on e.id = im.event_id
     join items i on i.id = im.item_id
     where im.tenant_id = $1 and e.type = 'MaterialIssued' and e.payload->>'work_order' = $2
     group by i.sku`,
    [tenantId, number],
  )
  const actualM = new Map(actualByItem.rows.map((r) => [r.sku, r]))
  const time = await db.query<{
    person_name: string
    hours: string
    rate: string
    labor_cost: string
    entry_date: string
  }>(
    `select te.person_name, te.hours, te.rate, te.labor_cost, te.entry_date::text as entry_date
     from time_entries te
     join work_orders w on w.id = te.wo_id
     where te.tenant_id = $1 and w.number = $2
     order by te.entry_date, te.created_at`,
    [tenantId, number],
  )

  return {
    ...summary,
    components: components.rows.map((c) => {
      const act = actualM.get(c.sku)
      const planned = round2(num(c.qty_required) * num(c.avg_cost))
      const actual = round2(num(act?.value))
      return {
        sku: c.sku,
        name: c.name,
        qty_required: num(c.qty_required),
        qty_issued: round4(num(act?.qty)),
        planned_cost: planned,
        actual_cost: actual,
        variance: round2(actual - planned),
      }
    }),
    time_entries: time.rows.map((t) => ({
      person: t.person_name,
      date: t.entry_date,
      hours: num(t.hours),
      rate: num(t.rate),
      cost: num(t.labor_cost),
    })),
  }
}
