// Phase 1 document layer: purchase orders, sales orders, work orders.
// Documents track commitments (open quantities) and drive planning/capacity.
// Every physical or financial effect is emitted as an EVENT through ingestTx —
// the spine remains the single source of truth for inventory and the ledger.
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { ingestTx, KernelError, type IngestResult } from './events.js'
import { num, round2, round4 } from './money.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const COUNTERS: Record<string, { prefix: string; start: number }> = {
  PO: { prefix: 'PO', start: 1001 },
  SO: { prefix: 'SO', start: 2001 },
  WO: { prefix: 'WO', start: 1001 },
  INV: { prefix: 'INV', start: 2001 },
  BILL: { prefix: 'BILL', start: 8001 },
}

export { nextNumber, itemBySku, partyByName, assertStatus }

async function nextNumber(tx: Transaction, tenantId: string, kind: keyof typeof COUNTERS): Promise<string> {
  const { prefix, start } = COUNTERS[kind]
  const r = await tx.query<{ next_no: number }>(
    `insert into doc_counters (tenant_id, kind, next_no) values ($1, $2, $3)
     on conflict (tenant_id, kind) do update set next_no = doc_counters.next_no + 1
     returning next_no`,
    [tenantId, kind, start],
  )
  return `${prefix}-${r.rows[0].next_no}`
}

interface ItemRow {
  id: string
  sku: string
  name: string
  kind: string
  uom: string
}

async function itemBySku(tx: Transaction, tenantId: string, sku: string): Promise<ItemRow> {
  const r = await tx.query<ItemRow>(
    'select id, sku, name, kind, uom from items where tenant_id = $1 and sku = $2',
    [tenantId, sku],
  )
  if (!r.rows[0]) throw new KernelError(`unknown item sku "${sku}"`)
  return r.rows[0]
}

async function partyByName(tx: Transaction, tenantId: string, name: string, role: string): Promise<{ id: string; name: string }> {
  const r = await tx.query<{ id: string; name: string }>(
    'select id, name from parties where tenant_id = $1 and name = $2',
    [tenantId, name],
  )
  if (!r.rows[0]) throw new KernelError(`unknown ${role} "${name}"`)
  return r.rows[0]
}

function assertStatus(current: string, allowed: string[], action: string): void {
  if (!allowed.includes(current))
    throw new KernelError(`cannot ${action} a ${current} document (needs: ${allowed.join(' or ')})`)
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  db: PGlite,
  tenantId: string,
  input: { vendor: string; lines: Array<{ sku: string; qty: number; unit_cost: number }> },
) {
  if (input.lines.length === 0) throw new KernelError('a purchase order needs at least one line')
  return db.transaction(async (tx) => {
    const vendor = await partyByName(tx, tenantId, input.vendor, 'vendor')
    const number = await nextNumber(tx, tenantId, 'PO')
    const po = await tx.query<{ id: string }>(
      'insert into purchase_orders (tenant_id, number, vendor_id) values ($1, $2, $3) returning id',
      [tenantId, number, vendor.id],
    )
    for (const l of input.lines) {
      if (l.qty <= 0) throw new KernelError('line qty must be positive')
      const item = await itemBySku(tx, tenantId, l.sku)
      await tx.query(
        'insert into po_lines (tenant_id, po_id, item_id, qty, unit_cost) values ($1, $2, $3, $4, $5)',
        [tenantId, po.rows[0].id, item.id, l.qty, l.unit_cost],
      )
    }
    return { id: po.rows[0].id, number, status: 'draft' }
  })
}

export async function issuePurchaseOrder(db: PGlite, tenantId: string, poId: string) {
  return db.transaction(async (tx) => {
    const po = await getPO(tx, tenantId, poId)
    assertStatus(po.status, ['draft'], 'issue')
    await tx.query('update purchase_orders set status = $3 where tenant_id = $1 and id = $2', [
      tenantId, poId, 'issued',
    ])
    return { number: po.number, status: 'issued' }
  })
}

export async function receivePurchaseOrder(
  db: PGlite,
  tenantId: string,
  poId: string,
  lines?: Array<{ line_id: string; qty: number }>,
) {
  return db.transaction(async (tx) => {
    const po = await getPO(tx, tenantId, poId)
    assertStatus(po.status, ['issued', 'partially_received'], 'receive against')
    const poLines = await tx.query<{
      id: string
      qty: string
      unit_cost: string
      received_qty: string
      sku: string
    }>(
      `select pl.id, pl.qty, pl.unit_cost, pl.received_qty, i.sku
       from po_lines pl join items i on i.id = pl.item_id
       where pl.tenant_id = $1 and pl.po_id = $2`,
      [tenantId, poId],
    )
    const toReceive =
      lines ??
      poLines.rows
        .map((l) => ({ line_id: l.id, qty: round4(num(l.qty) - num(l.received_qty)) }))
        .filter((l) => l.qty > 0)
    if (toReceive.length === 0) throw new KernelError('nothing left to receive on this order')

    const events: IngestResult[] = []
    for (const r of toReceive) {
      const line = poLines.rows.find((l) => l.id === r.line_id)
      if (!line) throw new KernelError(`line ${r.line_id} is not on this order`)
      const remaining = round4(num(line.qty) - num(line.received_qty))
      if (r.qty <= 0 || r.qty > remaining)
        throw new KernelError(`cannot receive ${r.qty} of ${line.sku}: ${remaining} remaining on order`)
      events.push(
        await ingestTx(tx, tenantId, {
          type: 'GoodsReceived',
          payload: { sku: line.sku, qty: r.qty, unit_cost: num(line.unit_cost), ref: po.number },
        }),
      )
      await tx.query('update po_lines set received_qty = received_qty + $3 where tenant_id = $1 and id = $2', [
        tenantId, r.line_id, r.qty,
      ])
    }

    const after = await tx.query<{ open: string }>(
      'select coalesce(sum(qty - received_qty), 0) as open from po_lines where tenant_id = $1 and po_id = $2',
      [tenantId, poId],
    )
    const status = num(after.rows[0].open) <= 0 ? 'received' : 'partially_received'
    await tx.query('update purchase_orders set status = $3 where tenant_id = $1 and id = $2', [
      tenantId, poId, status,
    ])
    return { number: po.number, status, events }
  })
}

export async function cancelPurchaseOrder(db: PGlite, tenantId: string, poId: string) {
  return db.transaction(async (tx) => {
    const po = await getPO(tx, tenantId, poId)
    assertStatus(po.status, ['draft', 'issued'], 'cancel')
    const received = await tx.query<{ r: string }>(
      'select coalesce(sum(received_qty), 0) as r from po_lines where tenant_id = $1 and po_id = $2',
      [tenantId, poId],
    )
    if (num(received.rows[0].r) > 0) throw new KernelError('cannot cancel: goods already received')
    await tx.query("update purchase_orders set status = 'cancelled' where tenant_id = $1 and id = $2", [
      tenantId, poId,
    ])
    return { number: po.number, status: 'cancelled' }
  })
}

async function getPO(tx: Transaction, tenantId: string, poId: string) {
  const r = await tx.query<{ id: string; number: string; status: string }>(
    'select id, number, status from purchase_orders where tenant_id = $1 and id = $2',
    [tenantId, poId],
  )
  if (!r.rows[0]) throw new KernelError('unknown purchase order', 404)
  return r.rows[0]
}

// ---------------------------------------------------------------------------
// Sales orders — shipping auto-invoices at line prices (opinionated default)
// ---------------------------------------------------------------------------

export async function createSalesOrder(
  db: PGlite,
  tenantId: string,
  input: { customer: string; lines: Array<{ sku: string; qty: number; unit_price: number }> },
) {
  if (input.lines.length === 0) throw new KernelError('a sales order needs at least one line')
  return db.transaction(async (tx) => {
    const customer = await partyByName(tx, tenantId, input.customer, 'customer')
    const number = await nextNumber(tx, tenantId, 'SO')
    const so = await tx.query<{ id: string }>(
      'insert into sales_orders (tenant_id, number, customer_id) values ($1, $2, $3) returning id',
      [tenantId, number, customer.id],
    )
    for (const l of input.lines) {
      if (l.qty <= 0) throw new KernelError('line qty must be positive')
      const item = await itemBySku(tx, tenantId, l.sku)
      await tx.query(
        'insert into so_lines (tenant_id, so_id, item_id, qty, unit_price) values ($1, $2, $3, $4, $5)',
        [tenantId, so.rows[0].id, item.id, l.qty, l.unit_price],
      )
    }
    return { id: so.rows[0].id, number, status: 'draft' }
  })
}

export async function confirmSalesOrder(db: PGlite, tenantId: string, soId: string) {
  return db.transaction(async (tx) => {
    const so = await getSO(tx, tenantId, soId)
    assertStatus(so.status, ['draft'], 'confirm')
    await tx.query("update sales_orders set status = 'confirmed' where tenant_id = $1 and id = $2", [
      tenantId, soId,
    ])
    return { number: so.number, status: 'confirmed' }
  })
}

export async function shipSalesOrder(
  db: PGlite,
  tenantId: string,
  soId: string,
  lines?: Array<{ line_id: string; qty: number }>,
) {
  return db.transaction(async (tx) => {
    const so = await getSO(tx, tenantId, soId)
    assertStatus(so.status, ['confirmed', 'partially_shipped'], 'ship against')
    const soLines = await tx.query<{
      id: string
      qty: string
      unit_price: string
      shipped_qty: string
      sku: string
    }>(
      `select sl.id, sl.qty, sl.unit_price, sl.shipped_qty, i.sku
       from so_lines sl join items i on i.id = sl.item_id
       where sl.tenant_id = $1 and sl.so_id = $2`,
      [tenantId, soId],
    )
    const toShip =
      lines ??
      soLines.rows
        .map((l) => ({ line_id: l.id, qty: round4(num(l.qty) - num(l.shipped_qty)) }))
        .filter((l) => l.qty > 0)
    if (toShip.length === 0) throw new KernelError('nothing left to ship on this order')

    const events: IngestResult[] = []
    let invoiceAmount = 0
    for (const s of toShip) {
      const line = soLines.rows.find((l) => l.id === s.line_id)
      if (!line) throw new KernelError(`line ${s.line_id} is not on this order`)
      const remaining = round4(num(line.qty) - num(line.shipped_qty))
      if (s.qty <= 0 || s.qty > remaining)
        throw new KernelError(`cannot ship ${s.qty} of ${line.sku}: ${remaining} remaining on order`)
      events.push(
        await ingestTx(tx, tenantId, {
          type: 'GoodsShipped',
          payload: { sku: line.sku, qty: s.qty, ref: so.number },
        }),
      )
      invoiceAmount = round2(invoiceAmount + s.qty * num(line.unit_price))
      await tx.query('update so_lines set shipped_qty = shipped_qty + $3 where tenant_id = $1 and id = $2', [
        tenantId, s.line_id, s.qty,
      ])
    }

    let invoice: { number: string; amount: number } | null = null
    if (invoiceAmount > 0) {
      const invNumber = await nextNumber(tx, tenantId, 'INV')
      events.push(
        await ingestTx(tx, tenantId, {
          type: 'InvoiceIssued',
          payload: { amount: invoiceAmount, customer: so.customer_name, ref: `${invNumber} · ${so.number}` },
        }),
      )
      await tx.query(
        `insert into invoices (tenant_id, number, customer_id, so_id, amount)
         values ($1, $2, $3, $4, $5)`,
        [tenantId, invNumber, so.customer_id, soId, invoiceAmount],
      )
      invoice = { number: invNumber, amount: invoiceAmount }
    }

    const after = await tx.query<{ open: string }>(
      'select coalesce(sum(qty - shipped_qty), 0) as open from so_lines where tenant_id = $1 and so_id = $2',
      [tenantId, soId],
    )
    const status = num(after.rows[0].open) <= 0 ? 'shipped' : 'partially_shipped'
    await tx.query('update sales_orders set status = $3 where tenant_id = $1 and id = $2', [
      tenantId, soId, status,
    ])
    return { number: so.number, status, invoice, events }
  })
}

async function getSO(tx: Transaction, tenantId: string, soId: string) {
  const r = await tx.query<{
    id: string
    number: string
    status: string
    customer_id: string
    customer_name: string
  }>(
    `select so.id, so.number, so.status, so.customer_id, p.name as customer_name
     from sales_orders so join parties p on p.id = so.customer_id
     where so.tenant_id = $1 and so.id = $2`,
    [tenantId, soId],
  )
  if (!r.rows[0]) throw new KernelError('unknown sales order', 404)
  return r.rows[0]
}

// ---------------------------------------------------------------------------
// Work orders — created from the item's BOM; materials + labor accumulate into
// WIP through events; completion drains WIP into finished goods.
// ---------------------------------------------------------------------------

export async function createWorkOrder(
  db: PGlite,
  tenantId: string,
  input: { sku: string; qty: number; work_center?: string; scheduled_date?: string; est_hours?: number },
) {
  return db.transaction(async (tx) => {
    const item = await itemBySku(tx, tenantId, input.sku)
    if (item.kind !== 'finished' && item.kind !== 'subassembly')
      throw new KernelError(`work orders make finished goods or subassemblies, not ${item.kind} items`)
    const bom = await tx.query<{ component_item_id: string; qty_per: string; sku: string }>(
      `select b.component_item_id, b.qty_per, i.sku
       from bom_lines b join items i on i.id = b.component_item_id
       where b.tenant_id = $1 and b.parent_item_id = $2`,
      [tenantId, item.id],
    )
    if (bom.rows.length === 0) throw new KernelError(`item ${input.sku} has no bill of materials`)

    let workCenterId: string | null = null
    if (input.work_center) {
      const wc = await tx.query<{ id: string }>(
        'select id from work_centers where tenant_id = $1 and code = $2',
        [tenantId, input.work_center],
      )
      if (!wc.rows[0]) throw new KernelError(`unknown work center "${input.work_center}"`)
      workCenterId = wc.rows[0].id
    }

    const number = await nextNumber(tx, tenantId, 'WO')
    const wo = await tx.query<{ id: string }>(
      `insert into work_orders (tenant_id, number, item_id, qty, work_center_id, scheduled_date, est_hours)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [tenantId, number, item.id, input.qty, workCenterId, input.scheduled_date ?? null, input.est_hours ?? 0],
    )
    const components = []
    for (const b of bom.rows) {
      const required = round4(num(b.qty_per) * input.qty)
      await tx.query(
        'insert into wo_components (tenant_id, wo_id, item_id, qty_required) values ($1, $2, $3, $4)',
        [tenantId, wo.rows[0].id, b.component_item_id, required],
      )
      components.push({ sku: b.sku, qty_required: required })
    }
    return { id: wo.rows[0].id, number, status: 'draft', components }
  })
}

export async function releaseWorkOrder(db: PGlite, tenantId: string, woId: string) {
  return db.transaction(async (tx) => {
    const wo = await getWO(tx, tenantId, woId)
    assertStatus(wo.status, ['draft'], 'release')
    await tx.query("update work_orders set status = 'released' where tenant_id = $1 and id = $2", [
      tenantId, woId,
    ])
    return { number: wo.number, status: 'released' }
  })
}

export async function issueMaterials(db: PGlite, tenantId: string, woId: string) {
  return db.transaction(async (tx) => {
    const wo = await getWO(tx, tenantId, woId)
    assertStatus(wo.status, ['released', 'in_progress'], 'issue materials to')
    const comps = await tx.query<{ id: string; qty_required: string; issued_qty: string; sku: string }>(
      `select c.id, c.qty_required, c.issued_qty, i.sku
       from wo_components c join items i on i.id = c.item_id
       where c.tenant_id = $1 and c.wo_id = $2`,
      [tenantId, woId],
    )
    const events: IngestResult[] = []
    for (const cm of comps.rows) {
      const remaining = round4(num(cm.qty_required) - num(cm.issued_qty))
      if (remaining <= 0) continue
      events.push(
        await ingestTx(tx, tenantId, {
          type: 'MaterialIssued',
          payload: { sku: cm.sku, qty: remaining, work_order: wo.number },
        }),
      )
      await tx.query('update wo_components set issued_qty = qty_required where tenant_id = $1 and id = $2', [
        tenantId, cm.id,
      ])
    }
    if (events.length === 0) throw new KernelError('all materials already issued')
    await tx.query("update work_orders set status = 'in_progress' where tenant_id = $1 and id = $2", [
      tenantId, woId,
    ])
    return { number: wo.number, status: 'in_progress', events }
  })
}

export async function logWorkOrderTime(
  db: PGlite,
  tenantId: string,
  woId: string,
  input: { hours: number; loaded_rate: number; person?: string; party_id?: string; entry_date?: string },
) {
  return db.transaction(async (tx) => {
    const wo = await getWO(tx, tenantId, woId)
    assertStatus(wo.status, ['released', 'in_progress'], 'log time on')
    const event = await ingestTx(tx, tenantId, {
      type: 'TimeLogged',
      payload: { hours: input.hours, loaded_rate: input.loaded_rate, person: input.person, work_order: wo.number },
      // Backdated entries date their journal entry too.
      occurred_at: input.entry_date ? `${input.entry_date}T12:00:00.000Z` : undefined,
    })
    await tx.query(
      `insert into time_entries (tenant_id, wo_id, party_id, person_name, hours, rate, labor_cost, entry_date, event_id)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, current_date), $9)`,
      [
        tenantId, woId, input.party_id ?? null, input.person ?? 'direct labor',
        input.hours, input.loaded_rate, round2(input.hours * input.loaded_rate),
        input.entry_date ?? null, event.event.id,
      ],
    )
    await tx.query("update work_orders set status = 'in_progress' where tenant_id = $1 and id = $2", [
      tenantId, woId,
    ])
    return { number: wo.number, status: 'in_progress', event }
  })
}

export async function completeWorkOrder(db: PGlite, tenantId: string, woId: string, qtyGood?: number) {
  return db.transaction(async (tx) => {
    const wo = await getWO(tx, tenantId, woId)
    assertStatus(wo.status, ['in_progress'], 'complete')
    const event = await ingestTx(tx, tenantId, {
      type: 'ProductionCompleted',
      payload: { sku: wo.sku, qty: qtyGood ?? num(wo.qty), work_order: wo.number },
    })
    await tx.query("update work_orders set status = 'completed' where tenant_id = $1 and id = $2", [
      tenantId, woId,
    ])
    return { number: wo.number, status: 'completed', event }
  })
}

export async function rescheduleWorkOrder(
  db: PGlite,
  tenantId: string,
  woId: string,
  input: { scheduled_date?: string; work_center?: string; est_hours?: number },
) {
  return db.transaction(async (tx) => {
    const wo = await getWO(tx, tenantId, woId)
    assertStatus(wo.status, ['draft', 'released', 'in_progress'], 'reschedule')
    if (input.scheduled_date !== undefined)
      await tx.query('update work_orders set scheduled_date = $3 where tenant_id = $1 and id = $2', [
        tenantId, woId, input.scheduled_date,
      ])
    if (input.est_hours !== undefined)
      await tx.query('update work_orders set est_hours = $3 where tenant_id = $1 and id = $2', [
        tenantId, woId, input.est_hours,
      ])
    if (input.work_center !== undefined) {
      const wc = await tx.query<{ id: string }>(
        'select id from work_centers where tenant_id = $1 and code = $2',
        [tenantId, input.work_center],
      )
      if (!wc.rows[0]) throw new KernelError(`unknown work center "${input.work_center}"`)
      await tx.query('update work_orders set work_center_id = $3 where tenant_id = $1 and id = $2', [
        tenantId, woId, wc.rows[0].id,
      ])
    }
    return { number: wo.number, rescheduled: true }
  })
}

async function getWO(tx: Transaction, tenantId: string, woId: string) {
  const r = await tx.query<{ id: string; number: string; status: string; qty: string; sku: string }>(
    `select w.id, w.number, w.status, w.qty, i.sku
     from work_orders w join items i on i.id = w.item_id
     where w.tenant_id = $1 and w.id = $2`,
    [tenantId, woId],
  )
  if (!r.rows[0]) throw new KernelError('unknown work order', 404)
  return r.rows[0]
}

// ---------------------------------------------------------------------------
// Planning: one screen — demand vs supply per item, suggestions where the
// projected position falls below the reorder point. Single-level, no pegging.
// ---------------------------------------------------------------------------

export interface PlanningRow {
  sku: string
  name: string
  kind: string
  uom: string
  on_hand: number
  on_order: number
  in_production: number
  order_demand: number
  forecast_demand: number
  weekly_forecast: number
  demand: number
  projected: number
  reorder_point: number
  suggestion: null | { action: 'buy' | 'make'; qty: number }
}

// Forecast horizon: how many weeks of the weekly rate count as demand.
export const FORECAST_WEEKS = 2

export async function planning(db: PGlite, tenantId: string): Promise<PlanningRow[]> {
  const items = await db.query<{
    id: string
    sku: string
    name: string
    kind: string
    uom: string
    reorder_point: string
    weekly_forecast: string
    on_hand: string
  }>(
    `select i.id, i.sku, i.name, i.kind, i.uom, i.reorder_point, i.weekly_forecast,
            coalesce(ic.qty_on_hand, 0) as on_hand
     from items i
     left join item_costs ic on ic.item_id = i.id and ic.tenant_id = i.tenant_id
     where i.tenant_id = $1 and i.kind <> 'service'
     order by i.kind, i.sku`,
    [tenantId],
  )
  // Drafts count as planned supply/demand on purpose: the moment a suggestion
  // is applied (draft PO/WO created), the gap reads as covered — no double-apply.
  const onOrder = await db.query<{ item_id: string; qty: string }>(
    `select pl.item_id, sum(pl.qty - pl.received_qty) as qty
     from po_lines pl join purchase_orders po on po.id = pl.po_id
     where pl.tenant_id = $1 and po.status in ('draft', 'issued', 'partially_received')
     group by pl.item_id`,
    [tenantId],
  )
  const inProduction = await db.query<{ item_id: string; qty: string }>(
    `select item_id, sum(qty) as qty from work_orders
     where tenant_id = $1 and status in ('draft', 'released', 'in_progress')
     group by item_id`,
    [tenantId],
  )
  const soDemand = await db.query<{ item_id: string; qty: string }>(
    `select sl.item_id, sum(sl.qty - sl.shipped_qty) as qty
     from so_lines sl join sales_orders so on so.id = sl.so_id
     where sl.tenant_id = $1 and so.status in ('confirmed', 'partially_shipped')
     group by sl.item_id`,
    [tenantId],
  )
  const woDemand = await db.query<{ item_id: string; qty: string }>(
    `select c.item_id, sum(c.qty_required - c.issued_qty) as qty
     from wo_components c join work_orders w on w.id = c.wo_id
     where c.tenant_id = $1 and w.status in ('draft', 'released', 'in_progress')
     group by c.item_id`,
    [tenantId],
  )
  const toMap = (rows: Array<{ item_id: string; qty: string }>) =>
    new Map(rows.map((r) => [r.item_id, num(r.qty)]))
  const onOrderM = toMap(onOrder.rows)
  const inProdM = toMap(inProduction.rows)
  const soM = toMap(soDemand.rows)
  const woM = toMap(woDemand.rows)

  const rows = items.rows.map((i): PlanningRow => {
    const on_hand = num(i.on_hand)
    const on_order = onOrderM.get(i.id) ?? 0
    const in_production = i.kind === 'raw' ? 0 : (inProdM.get(i.id) ?? 0)
    const order_demand = round4((soM.get(i.id) ?? 0) + (woM.get(i.id) ?? 0))
    const weekly_forecast = num(i.weekly_forecast)
    const forecast_demand = round4(weekly_forecast * FORECAST_WEEKS)
    const demand = round4(order_demand + forecast_demand)
    const projected = round4(on_hand + on_order + in_production - demand)
    const reorder_point = num(i.reorder_point)
    const deficit = round4(reorder_point - projected)
    const suggestion =
      deficit > 0
        ? { action: (i.kind === 'raw' ? 'buy' : 'make') as 'buy' | 'make', qty: deficit }
        : null
    return {
      sku: i.sku, name: i.name, kind: i.kind, uom: i.uom,
      on_hand, on_order, in_production, order_demand, forecast_demand, weekly_forecast,
      demand, projected, reorder_point, suggestion,
    }
  })
  return rows.sort((a, b) => Number(!!b.suggestion) - Number(!!a.suggestion) || a.sku.localeCompare(b.sku))
}

// One-click apply: buy → draft PO (first vendor unless named); make → draft WO.
export async function applySuggestion(
  db: PGlite,
  tenantId: string,
  input: { sku: string; vendor?: string },
): Promise<{ created: string; kind: 'purchase_order' | 'work_order' }> {
  const rows = await planning(db, tenantId)
  const row = rows.find((r) => r.sku === input.sku)
  if (!row || !row.suggestion) throw new KernelError(`no open suggestion for ${input.sku}`)

  if (row.suggestion.action === 'buy') {
    let vendorName = input.vendor
    if (!vendorName) {
      const v = await db.query<{ name: string }>(
        "select name from parties where tenant_id = $1 and 'vendor' = any(roles) order by name limit 1",
        [tenantId],
      )
      if (!v.rows[0]) throw new KernelError('no vendor on file — add one first')
      vendorName = v.rows[0].name
    }
    const cost = await db.query<{ avg_cost: string }>(
      `select coalesce(ic.avg_cost, 0) as avg_cost
       from items i left join item_costs ic on ic.item_id = i.id and ic.tenant_id = i.tenant_id
       where i.tenant_id = $1 and i.sku = $2`,
      [tenantId, input.sku],
    )
    const po = await createPurchaseOrder(db, tenantId, {
      vendor: vendorName,
      lines: [{ sku: input.sku, qty: row.suggestion.qty, unit_cost: num(cost.rows[0]?.avg_cost) }],
    })
    return { created: po.number, kind: 'purchase_order' }
  }

  const wc = await db.query<{ code: string }>(
    'select code from work_centers where tenant_id = $1 order by code limit 1',
    [tenantId],
  )
  const wo = await createWorkOrder(db, tenantId, {
    sku: input.sku,
    qty: row.suggestion.qty,
    work_center: wc.rows[0]?.code,
  })
  return { created: wo.number, kind: 'work_order' }
}

// ---------------------------------------------------------------------------
// Capacity: load (est_hours of committed WOs) vs daily hours per work center.
// ---------------------------------------------------------------------------

export async function capacity(db: PGlite, tenantId: string, days = 14) {
  const centers = await db.query<{ id: string; code: string; name: string; daily_hours: string }>(
    'select id, code, name, daily_hours from work_centers where tenant_id = $1 order by code',
    [tenantId],
  )
  const wos = await db.query<{
    id: string
    number: string
    status: string
    qty: string
    est_hours: string
    scheduled_date: string | null
    wc_code: string | null
    sku: string
  }>(
    `select w.id, w.number, w.status, w.qty, w.est_hours,
            w.scheduled_date::text as scheduled_date, wc.code as wc_code, i.sku
     from work_orders w
     join items i on i.id = w.item_id
     left join work_centers wc on wc.id = w.work_center_id
     where w.tenant_id = $1 and w.status in ('draft', 'released', 'in_progress')
     order by w.scheduled_date nulls last, w.number`,
    [tenantId],
  )
  const start = new Date()
  const dates: string[] = []
  for (let d = 0; d < days; d++) {
    const dt = new Date(start.getTime() + d * 86_400_000)
    dates.push(dt.toISOString().slice(0, 10))
  }
  const load: Record<string, Record<string, { hours: number; wos: string[] }>> = {}
  for (const wc of centers.rows) load[wc.code] = {}
  const unscheduled: Array<Record<string, unknown>> = []
  for (const w of wos.rows) {
    const entry = {
      id: w.id, number: w.number, status: w.status, sku: w.sku,
      qty: num(w.qty), est_hours: num(w.est_hours), scheduled_date: w.scheduled_date, work_center: w.wc_code,
    }
    if (!w.wc_code || !w.scheduled_date || w.status === 'draft') {
      unscheduled.push(entry)
      continue
    }
    const cell = (load[w.wc_code][w.scheduled_date] ??= { hours: 0, wos: [] })
    cell.hours = round2(cell.hours + num(w.est_hours))
    cell.wos.push(w.number)
  }
  // People are the second capacity constraint: committed hours per day across
  // all work centers vs the roster's total daily hours.
  const roster = await db.query<{ h: string }>(
    'select coalesce(sum(daily_hours), 0) as h from employees where tenant_id = $1 and active',
    [tenantId],
  )
  const laborLoad: Record<string, number> = {}
  for (const w of wos.rows) {
    if (w.scheduled_date && w.status !== 'draft')
      laborLoad[w.scheduled_date] = round2((laborLoad[w.scheduled_date] ?? 0) + num(w.est_hours))
  }

  return {
    days: dates,
    work_centers: centers.rows.map((wc) => ({
      code: wc.code, name: wc.name, daily_hours: num(wc.daily_hours), load: load[wc.code],
    })),
    labor: { daily_hours_available: num(roster.rows[0].h), load: laborLoad },
    open_work_orders: wos.rows.map((w) => ({
      id: w.id, number: w.number, status: w.status, sku: w.sku, qty: num(w.qty),
      est_hours: num(w.est_hours), scheduled_date: w.scheduled_date, work_center: w.wc_code,
    })),
    unscheduled,
  }
}

// ---------------------------------------------------------------------------
// List queries for the UI
// ---------------------------------------------------------------------------

export async function listPurchaseOrders(db: PGlite, tenantId: string) {
  const pos = await db.query<{ id: string; number: string; status: string; vendor: string; created_at: string }>(
    `select po.id, po.number, po.status, p.name as vendor, po.created_at
     from purchase_orders po join parties p on p.id = po.vendor_id
     where po.tenant_id = $1 order by po.number desc`,
    [tenantId],
  )
  const lines = await db.query<{
    po_id: string; id: string; sku: string; name: string; qty: string; unit_cost: string; received_qty: string
  }>(
    `select pl.po_id, pl.id, i.sku, i.name, pl.qty, pl.unit_cost, pl.received_qty
     from po_lines pl join items i on i.id = pl.item_id
     where pl.tenant_id = $1`,
    [tenantId],
  )
  return pos.rows.map((po) => ({
    ...po,
    lines: lines.rows
      .filter((l) => l.po_id === po.id)
      .map((l) => ({
        line_id: l.id, sku: l.sku, name: l.name,
        qty: num(l.qty), unit_cost: num(l.unit_cost), received_qty: num(l.received_qty),
      })),
  }))
}

export async function listSalesOrders(db: PGlite, tenantId: string) {
  const sos = await db.query<{ id: string; number: string; status: string; customer: string; created_at: string }>(
    `select so.id, so.number, so.status, p.name as customer, so.created_at
     from sales_orders so join parties p on p.id = so.customer_id
     where so.tenant_id = $1 order by so.number desc`,
    [tenantId],
  )
  const lines = await db.query<{
    so_id: string; id: string; sku: string; name: string; qty: string; unit_price: string; shipped_qty: string
  }>(
    `select sl.so_id, sl.id, i.sku, i.name, sl.qty, sl.unit_price, sl.shipped_qty
     from so_lines sl join items i on i.id = sl.item_id
     where sl.tenant_id = $1`,
    [tenantId],
  )
  return sos.rows.map((so) => ({
    ...so,
    lines: lines.rows
      .filter((l) => l.so_id === so.id)
      .map((l) => ({
        line_id: l.id, sku: l.sku, name: l.name,
        qty: num(l.qty), unit_price: num(l.unit_price), shipped_qty: num(l.shipped_qty),
      })),
  }))
}

export async function listWorkOrders(db: PGlite, tenantId: string) {
  const wos = await db.query<{
    id: string; number: string; status: string; sku: string; name: string; qty: string
    est_hours: string; scheduled_date: string | null; work_center: string | null
  }>(
    `select w.id, w.number, w.status, i.sku, i.name, w.qty, w.est_hours,
            w.scheduled_date::text as scheduled_date, wc.code as work_center
     from work_orders w
     join items i on i.id = w.item_id
     left join work_centers wc on wc.id = w.work_center_id
     where w.tenant_id = $1 order by w.number desc`,
    [tenantId],
  )
  const comps = await db.query<{
    wo_id: string; sku: string; qty_required: string; issued_qty: string
  }>(
    `select c.wo_id, i.sku, c.qty_required, c.issued_qty
     from wo_components c join items i on i.id = c.item_id
     where c.tenant_id = $1`,
    [tenantId],
  )
  const wip = await db.query<{ work_order: string; accumulated_cost: string }>(
    'select work_order, accumulated_cost from wip_jobs where tenant_id = $1',
    [tenantId],
  )
  const wipM = new Map(wip.rows.map((w) => [w.work_order, num(w.accumulated_cost)]))
  return wos.rows.map((w) => ({
    ...w,
    qty: num(w.qty),
    est_hours: num(w.est_hours),
    wip_cost: wipM.get(w.number) ?? 0,
    components: comps.rows
      .filter((cm) => cm.wo_id === w.id)
      .map((cm) => ({ sku: cm.sku, qty_required: num(cm.qty_required), issued_qty: num(cm.issued_qty) })),
  }))
}
