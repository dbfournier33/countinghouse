import type { PGlite, Transaction } from '@electric-sql/pglite'
import { z } from 'zod'
import { inventoryAccountFor } from './coa.js'
import { fmtUSD, num, round2, round4, round6 } from './money.js'
import type { RuleLine } from './rules.js'

// ---------------------------------------------------------------------------
// Event contracts
// ---------------------------------------------------------------------------

export const EventSchemas = {
  GoodsReceived: z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    unit_cost: z.number().nonnegative(),
    ref: z.string().optional(),
    lot_no: z.string().optional(),
  }),
  OpeningStockSet: z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    unit_cost: z.number().nonnegative(),
    lot_no: z.string().optional(),
  }),
  BillPosted: z.object({
    amount: z.number().positive(),
    vendor: z.string().optional(),
    ref: z.string().optional(),
  }),
  ExpenseBillPosted: z.object({
    amount: z.number().positive(),
    vendor: z.string().optional(),
    ref: z.string().optional(),
  }),
  PaymentMade: z.object({ amount: z.number().positive(), ref: z.string().optional() }),
  MaterialIssued: z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    work_order: z.string().min(1),
  }),
  TimeLogged: z.object({
    hours: z.number().positive(),
    loaded_rate: z.number().positive(),
    work_order: z.string().min(1),
    person: z.string().optional(),
  }),
  ProductionCompleted: z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    work_order: z.string().min(1),
  }),
  GoodsShipped: z.object({
    sku: z.string().min(1),
    qty: z.number().positive(),
    ref: z.string().optional(),
  }),
  InvoiceIssued: z.object({
    amount: z.number().positive(),
    customer: z.string().optional(),
    ref: z.string().optional(),
  }),
  PaymentReceived: z.object({ amount: z.number().positive(), ref: z.string().optional() }),
  AdjustmentMade: z.object({
    sku: z.string().min(1),
    qty_delta: z.number().refine((v) => v !== 0, 'qty_delta must be non-zero'),
    reason: z.string().optional(),
  }),
  ChannelSettlement: z
    .object({
      channel: z.string().min(1),
      period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      gross_sales: z.number().nonnegative(),
      refunds: z.number().nonnegative().default(0),
      fees: z.number().nonnegative().default(0),
      // Sales tax the channel collected on your behalf: rides the payout in,
      // parks in 2250 Sales tax payable, never touches revenue.
      taxes_collected: z.number().nonnegative().default(0),
    })
    .refine((v) => v.period_start <= v.period_end, 'period_start must be on or before period_end')
    .refine(
      (v) => v.gross_sales + v.taxes_collected - v.refunds - v.fees >= 0,
      'payout would be negative (refunds + fees exceed gross + taxes) — split the period or book a manual entry',
    ),
  OpeningCashSet: z.object({ amount: z.number().positive() }),
  OpeningReceivableSet: z.object({
    amount: z.number().positive(),
    customer: z.string().optional(),
    ref: z.string().optional(),
  }),
  OpeningPayableSet: z.object({
    amount: z.number().positive(),
    vendor: z.string().optional(),
    ref: z.string().optional(),
  }),
} as const

export type EventType = keyof typeof EventSchemas

export class KernelError extends Error {
  constructor(message: string, public status = 422) {
    super(message)
  }
}

export interface IngestResult {
  event: { id: string; seq: number; type: EventType; occurred_at: string; payload: Record<string, unknown> }
  moves: Array<{
    sku: string
    direction: 'in' | 'out'
    qty: number
    unit_cost: number
    value: number
    lots: Array<{ lot_no: string; qty: number }>
  }>
  journal: null | {
    id: string
    memo: string
    lines: Array<{ code: string; account: string; side: 'debit' | 'credit'; amount: number }>
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string
  sku: string
  name: string
  kind: string
  uom: string
}

interface PostingCtx {
  moveValue?: number
  laborValue?: number
  wipDrain?: number
  item?: ItemRow
  flipSides?: boolean
}

async function getItem(tx: Transaction, tenantId: string, sku: string): Promise<ItemRow> {
  const r = await tx.query<ItemRow>(
    'select id, sku, name, kind, uom from items where tenant_id = $1 and sku = $2',
    [tenantId, sku],
  )
  if (!r.rows[0]) throw new KernelError(`unknown item sku "${sku}"`)
  return r.rows[0]
}

async function getCost(tx: Transaction, tenantId: string, itemId: string) {
  const r = await tx.query<{ qty_on_hand: string; avg_cost: string }>(
    "select qty_on_hand, avg_cost from item_costs where tenant_id = $1 and item_id = $2 and location_code = 'MAIN'",
    [tenantId, itemId],
  )
  return r.rows[0]
    ? { qty: num(r.rows[0].qty_on_hand), avg: num(r.rows[0].avg_cost) }
    : { qty: 0, avg: 0 }
}

async function setCost(tx: Transaction, tenantId: string, itemId: string, qty: number, avg: number) {
  await tx.query(
    `insert into item_costs (tenant_id, item_id, location_code, qty_on_hand, avg_cost, updated_at)
     values ($1, $2, 'MAIN', $3, $4, now())
     on conflict (tenant_id, item_id, location_code)
     do update set qty_on_hand = $3, avg_cost = $4, updated_at = now()`,
    [tenantId, itemId, qty, avg],
  )
}

async function recordMove(
  tx: Transaction,
  tenantId: string,
  eventId: string,
  item: ItemRow,
  direction: 'in' | 'out',
  qty: number,
  unitCost: number,
  value: number,
): Promise<IngestResult['moves'][number] & { move_id: string }> {
  const r = await tx.query<{ id: string }>(
    `insert into inventory_moves (tenant_id, event_id, item_id, direction, qty, unit_cost, value)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [tenantId, eventId, item.id, direction, qty, unitCost, value],
  )
  return { sku: item.sku, direction, qty, unit_cost: unitCost, value, lots: [], move_id: r.rows[0].id }
}

// --- lot identity (never costing) ------------------------------------------

async function lotIn(
  tx: Transaction,
  tenantId: string,
  itemId: string,
  move: IngestResult['moves'][number] & { move_id: string },
  lotNo: string,
): Promise<void> {
  const existing = await tx.query<{ id: string }>(
    'select id from lots where tenant_id = $1 and item_id = $2 and lot_no = $3',
    [tenantId, itemId, lotNo],
  )
  const lotId = existing.rows[0]
    ? existing.rows[0].id
    : (
        await tx.query<{ id: string }>(
          'insert into lots (tenant_id, item_id, lot_no) values ($1, $2, $3) returning id',
          [tenantId, itemId, lotNo],
        )
      ).rows[0].id
  await tx.query('insert into move_lots (tenant_id, move_id, lot_id, qty) values ($1, $2, $3, $4)', [
    tenantId, move.move_id, lotId, move.qty,
  ])
  move.lots.push({ lot_no: lotNo, qty: move.qty })
}

// FIFO consumption by lot creation order. Stock predating lot tracking simply
// stays unallocated — identity is best-effort history, costing is untouched.
async function lotsOut(
  tx: Transaction,
  tenantId: string,
  itemId: string,
  move: IngestResult['moves'][number] & { move_id: string },
): Promise<void> {
  const available = await tx.query<{ id: string; lot_no: string; on_hand: string }>(
    `select l.id, l.lot_no,
            coalesce(sum(case when im.direction = 'in' then ml.qty else -ml.qty end), 0) as on_hand
     from lots l
     join move_lots ml on ml.lot_id = l.id and ml.tenant_id = l.tenant_id
     join inventory_moves im on im.id = ml.move_id
     where l.tenant_id = $1 and l.item_id = $2
     group by l.id, l.lot_no, l.created_at
     having coalesce(sum(case when im.direction = 'in' then ml.qty else -ml.qty end), 0) > 0
     order by l.created_at`,
    [tenantId, itemId],
  )
  let remaining = move.qty
  for (const lot of available.rows) {
    if (remaining <= 0) break
    const take = round4(Math.min(remaining, num(lot.on_hand)))
    if (take <= 0) continue
    await tx.query('insert into move_lots (tenant_id, move_id, lot_id, qty) values ($1, $2, $3, $4)', [
      tenantId, move.move_id, lot.id, take,
    ])
    move.lots.push({ lot_no: lot.lot_no, qty: take })
    remaining = round4(remaining - take)
  }
}

async function addToWip(tx: Transaction, tenantId: string, workOrder: string, value: number) {
  await tx.query(
    `insert into wip_jobs (tenant_id, work_order, accumulated_cost, updated_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id, work_order)
     do update set accumulated_cost = wip_jobs.accumulated_cost + $3, updated_at = now()`,
    [tenantId, workOrder, value],
  )
}

// ---------------------------------------------------------------------------
// The ingest pipeline: one transaction = event + inventory effect + posting.
// This function IS the kernel: everything else in the system is a view.
// ---------------------------------------------------------------------------

export async function ingest(
  db: PGlite,
  tenantId: string,
  input: { type: EventType; payload: unknown; occurred_at?: string },
): Promise<IngestResult> {
  return db.transaction((tx) => ingestTx(tx, tenantId, input))
}

// The same pipeline, callable inside an enclosing transaction — documents use
// this so "update the document + emit its events" is one atomic unit.
export async function ingestTx(
  tx: Transaction,
  tenantId: string,
  input: { type: EventType; payload: unknown; occurred_at?: string },
): Promise<IngestResult> {
  const schema = EventSchemas[input.type]
  if (!schema) throw new KernelError(`unknown event type "${input.type}"`, 400)
  const p = schema.parse(input.payload) as Record<string, unknown>
  {
    const ev = await tx.query<{ id: string; seq: string; occurred_at: string }>(
      `insert into events (tenant_id, type, occurred_at, payload)
       values ($1, $2, coalesce($3::timestamptz, now()), $4)
       returning id, seq, occurred_at`,
      [tenantId, input.type, input.occurred_at ?? null, JSON.stringify(p)],
    )
    const eventId = ev.rows[0].id

    const ctx: PostingCtx = {}
    const moves: IngestResult['moves'] = []
    let memo = ''

    switch (input.type) {
      case 'GoodsReceived': {
        const { sku, qty, unit_cost, ref, lot_no } = p as {
          sku: string; qty: number; unit_cost: number; ref?: string; lot_no?: string
        }
        const item = await getItem(tx, tenantId, sku)
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        const value = round2(qty * unit_cost)
        const newQty = q0 + qty
        const newAvg = round6((q0 * a0 + qty * unit_cost) / newQty)
        await setCost(tx, tenantId, item.id, newQty, newAvg)
        const mv = await recordMove(tx, tenantId, eventId, item, 'in', qty, unit_cost, value)
        await lotIn(tx, tenantId, item.id, mv, lot_no ?? `RCV-${ev.rows[0].seq}`)
        moves.push(mv)
        ctx.moveValue = value
        ctx.item = item
        memo = `Received ${qty} ${item.uom} ${item.name} @ ${fmtUSD(unit_cost)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'OpeningStockSet': {
        const { sku, qty, unit_cost, lot_no } = p as {
          sku: string; qty: number; unit_cost: number; lot_no?: string
        }
        const item = await getItem(tx, tenantId, sku)
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        const value = round2(qty * unit_cost)
        const newQty = q0 + qty
        const newAvg = round6((q0 * a0 + qty * unit_cost) / newQty)
        await setCost(tx, tenantId, item.id, newQty, newAvg)
        const mv = await recordMove(tx, tenantId, eventId, item, 'in', qty, unit_cost, value)
        await lotIn(tx, tenantId, item.id, mv, lot_no ?? `OPEN-${ev.rows[0].seq}`)
        moves.push(mv)
        ctx.moveValue = value
        ctx.item = item
        memo = `Opening stock: ${qty} ${item.uom} ${item.name} @ ${fmtUSD(unit_cost)}`
        break
      }
      case 'MaterialIssued': {
        const { sku, qty, work_order } = p as { sku: string; qty: number; work_order: string }
        const item = await getItem(tx, tenantId, sku)
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        if (qty > q0) throw new KernelError(`insufficient stock of ${sku}: on hand ${q0}, requested ${qty}`)
        const value = round2(qty * a0)
        await setCost(tx, tenantId, item.id, q0 - qty, a0)
        const mv = await recordMove(tx, tenantId, eventId, item, 'out', qty, a0, value)
        await lotsOut(tx, tenantId, item.id, mv)
        moves.push(mv)
        await addToWip(tx, tenantId, work_order, value)
        ctx.moveValue = value
        ctx.item = item
        memo = `Issued ${qty} ${item.uom} ${item.name} to ${work_order}`
        break
      }
      case 'TimeLogged': {
        const { hours, loaded_rate, work_order, person } = p as {
          hours: number
          loaded_rate: number
          work_order: string
          person?: string
        }
        const value = round2(hours * loaded_rate)
        await addToWip(tx, tenantId, work_order, value)
        ctx.laborValue = value
        memo = `${hours}h ${person ?? 'direct labor'} @ ${fmtUSD(loaded_rate)}/h on ${work_order}`
        break
      }
      case 'ProductionCompleted': {
        const { sku, qty, work_order } = p as { sku: string; qty: number; work_order: string }
        const item = await getItem(tx, tenantId, sku)
        const job = await tx.query<{ accumulated_cost: string }>(
          'select accumulated_cost from wip_jobs where tenant_id = $1 and work_order = $2',
          [tenantId, work_order],
        )
        const cost = job.rows[0] ? round2(num(job.rows[0].accumulated_cost)) : 0
        if (cost > 0) {
          await tx.query(
            'update wip_jobs set accumulated_cost = 0, updated_at = now() where tenant_id = $1 and work_order = $2',
            [tenantId, work_order],
          )
        }
        const unit = qty > 0 ? round6(cost / qty) : 0
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        const newQty = q0 + qty
        const newAvg = round6((q0 * a0 + cost) / newQty)
        await setCost(tx, tenantId, item.id, newQty, newAvg)
        const mv = await recordMove(tx, tenantId, eventId, item, 'in', qty, unit, cost)
        // The batch IS the work order: its number becomes the output lot.
        await lotIn(tx, tenantId, item.id, mv, work_order)
        moves.push(mv)
        ctx.wipDrain = cost
        ctx.item = item
        memo = `Completed ${qty} ${item.uom} ${item.name} on ${work_order} (unit cost ${fmtUSD(unit)})`
        break
      }
      case 'GoodsShipped': {
        const { sku, qty, ref } = p as { sku: string; qty: number; ref?: string }
        const item = await getItem(tx, tenantId, sku)
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        if (qty > q0) throw new KernelError(`insufficient stock of ${sku}: on hand ${q0}, requested ${qty}`)
        const value = round2(qty * a0)
        await setCost(tx, tenantId, item.id, q0 - qty, a0)
        const mv = await recordMove(tx, tenantId, eventId, item, 'out', qty, a0, value)
        await lotsOut(tx, tenantId, item.id, mv)
        moves.push(mv)
        ctx.moveValue = value
        ctx.item = item
        memo = `Shipped ${qty} ${item.uom} ${item.name}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'AdjustmentMade': {
        const { sku, qty_delta, reason } = p as { sku: string; qty_delta: number; reason?: string }
        const item = await getItem(tx, tenantId, sku)
        const { qty: q0, avg: a0 } = await getCost(tx, tenantId, item.id)
        const absQty = Math.abs(qty_delta)
        if (qty_delta < 0 && absQty > q0)
          throw new KernelError(`insufficient stock of ${sku}: on hand ${q0}, adjusting by ${qty_delta}`)
        const value = round2(absQty * a0)
        await setCost(tx, tenantId, item.id, q0 + qty_delta, a0)
        const mv = await recordMove(tx, tenantId, eventId, item, qty_delta > 0 ? 'in' : 'out', absQty, a0, value)
        if (qty_delta > 0) await lotIn(tx, tenantId, item.id, mv, `ADJ-${ev.rows[0].seq}`)
        else await lotsOut(tx, tenantId, item.id, mv)
        moves.push(mv)
        ctx.moveValue = value
        ctx.item = item
        ctx.flipSides = qty_delta < 0
        memo = `Adjusted ${item.name} by ${qty_delta} ${item.uom}${reason ? ` — ${reason}` : ''}`
        break
      }
      case 'BillPosted': {
        const { amount, vendor, ref } = p as { amount: number; vendor?: string; ref?: string }
        memo = `Vendor bill${vendor ? ` from ${vendor}` : ''} ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'ExpenseBillPosted': {
        const { amount, vendor, ref } = p as { amount: number; vendor?: string; ref?: string }
        memo = `Expense bill${vendor ? ` from ${vendor}` : ''} ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'PaymentMade': {
        const { amount, ref } = p as { amount: number; ref?: string }
        memo = `Payment made ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'InvoiceIssued': {
        const { amount, customer, ref } = p as { amount: number; customer?: string; ref?: string }
        memo = `Invoiced${customer ? ` ${customer}` : ''} ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'PaymentReceived': {
        const { amount, ref } = p as { amount: number; ref?: string }
        memo = `Payment received ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'ChannelSettlement': {
        const s = p as {
          channel: string
          period_start: string
          period_end: string
          gross_sales: number
          refunds: number
          fees: number
          taxes_collected: number
        }
        const payout = round2(s.gross_sales + s.taxes_collected - s.refunds - s.fees)
        const taxBit = s.taxes_collected ? ` + tax ${fmtUSD(s.taxes_collected)}` : ''
        memo = `${s.channel} settlement ${s.period_start} → ${s.period_end}: gross ${fmtUSD(s.gross_sales)}${taxBit} − fees ${fmtUSD(s.fees)} − refunds ${fmtUSD(s.refunds)} = payout ${fmtUSD(payout)}`
        break
      }
      case 'OpeningCashSet': {
        const { amount } = p as { amount: number }
        memo = `Opening cash balance ${fmtUSD(amount)}`
        break
      }
      case 'OpeningReceivableSet': {
        const { amount, customer, ref } = p as { amount: number; customer?: string; ref?: string }
        memo = `Opening receivable${customer ? ` — ${customer}` : ''} ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
      case 'OpeningPayableSet': {
        const { amount, vendor, ref } = p as { amount: number; vendor?: string; ref?: string }
        memo = `Opening payable${vendor ? ` — ${vendor}` : ''} ${fmtUSD(amount)}${ref ? ` (${ref})` : ''}`
        break
      }
    }

    // --- posting: rules are data ------------------------------------------
    const ruleRow = await tx.query<{ lines: RuleLine[] | string }>(
      `select lines from posting_rules
       where tenant_id = $1 and event_type = $2
       order by version desc limit 1`,
      [tenantId, input.type],
    )
    if (!ruleRow.rows[0]) throw new KernelError(`no posting rule for ${input.type}`, 500)
    const ruleLines: RuleLine[] =
      typeof ruleRow.rows[0].lines === 'string'
        ? JSON.parse(ruleRow.rows[0].lines)
        : ruleRow.rows[0].lines

    const amountFor = (source: RuleLine['source']): number => {
      const s = p as {
        amount?: number
        gross_sales?: number
        refunds?: number
        fees?: number
        taxes_collected?: number
      }
      switch (source) {
        case 'move_value':
          return ctx.moveValue ?? 0
        case 'payload_amount':
          return round2(num(s.amount))
        case 'labor_value':
          return ctx.laborValue ?? 0
        case 'wip_drain':
          return ctx.wipDrain ?? 0
        case 'settlement_gross':
          return round2(num(s.gross_sales))
        case 'settlement_refunds':
          return round2(num(s.refunds))
        case 'settlement_fees':
          return round2(num(s.fees))
        case 'settlement_taxes':
          return round2(num(s.taxes_collected))
        case 'settlement_payout':
          return round2(num(s.gross_sales) + num(s.taxes_collected) - num(s.refunds) - num(s.fees))
      }
    }

    let journal: IngestResult['journal'] = null
    const postable = ruleLines
      .map((l) => ({ ...l, amount: amountFor(l.source) }))
      .filter((l) => l.amount > 0)

    if (postable.length > 0) {
      const je = await tx.query<{ id: string }>(
        `insert into journal_entries (tenant_id, event_id, entry_date, memo)
         values ($1, $2, (coalesce($3::timestamptz, now()))::date, $4) returning id`,
        [tenantId, eventId, input.occurred_at ?? null, memo],
      )
      const entryId = je.rows[0].id
      const lines: NonNullable<IngestResult['journal']>['lines'] = []
      for (const l of postable) {
        const code = l.account === '@inventory' ? inventoryAccountFor(ctx.item?.kind ?? 'raw') : l.account
        const side = ctx.flipSides ? (l.side === 'debit' ? 'credit' : 'debit') : l.side
        const acct = await tx.query<{ id: string; name: string }>(
          'select id, name from accounts where tenant_id = $1 and code = $2',
          [tenantId, code],
        )
        if (!acct.rows[0]) throw new KernelError(`posting rule references unknown account ${code}`, 500)
        await tx.query(
          `insert into journal_lines (tenant_id, entry_id, account_id, side, amount)
           values ($1, $2, $3, $4, $5)`,
          [tenantId, entryId, acct.rows[0].id, side, l.amount],
        )
        lines.push({ code, account: acct.rows[0].name, side, amount: l.amount })
      }
      journal = { id: entryId, memo, lines }
    }

    return {
      event: {
        id: eventId,
        seq: Number(ev.rows[0].seq),
        type: input.type,
        occurred_at: String(ev.rows[0].occurred_at),
        payload: p,
      },
      moves,
      journal,
    }
  }
}
