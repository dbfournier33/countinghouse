// D2C channels (decision #3): settlements are summarized financial events —
// one row per payout period per channel, posting cash/fees/refunds/revenue in
// a single balanced entry. Inventory for channel shipments flows through
// ordinary GoodsShipped events (aggregate per day/period), keeping COGS true.
// A live Shopify API connector lands later; the data contract is this exact
// shape, so manual entry today = connector payload tomorrow.
import type { PGlite } from '@electric-sql/pglite'
import { ingestTx, KernelError, type IngestResult } from './events.js'
import { num, round2 } from './money.js'

export async function createChannelSettlement(
  db: PGlite,
  tenantId: string,
  input: {
    channel: string
    period_start: string
    period_end: string
    gross_sales: number
    refunds?: number
    fees?: number
  },
) {
  return db.transaction(async (tx) => {
    const refunds = round2(input.refunds ?? 0)
    const fees = round2(input.fees ?? 0)
    const gross = round2(input.gross_sales)
    const payout = round2(gross - refunds - fees)

    const overlapping = await tx.query<{ id: string }>(
      `select id from channel_settlements
       where tenant_id = $1 and channel = $2
         and period_start <= $4 and period_end >= $3`,
      [tenantId, input.channel, input.period_start, input.period_end],
    )
    if (overlapping.rows[0])
      throw new KernelError(
        `a ${input.channel} settlement already covers part of ${input.period_start} → ${input.period_end}`,
      )

    const event = await ingestTx(tx, tenantId, {
      type: 'ChannelSettlement',
      payload: {
        channel: input.channel,
        period_start: input.period_start,
        period_end: input.period_end,
        gross_sales: gross,
        refunds,
        fees,
      },
      // Date the journal entry on the period end, not the entry moment.
      occurred_at: `${input.period_end}T12:00:00.000Z`,
    })
    const row = await tx.query<{ id: string }>(
      `insert into channel_settlements
         (tenant_id, channel, period_start, period_end, gross_sales, refunds, fees, payout, event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [tenantId, input.channel, input.period_start, input.period_end, gross, refunds, fees, payout, event.event.id],
    )
    return { id: row.rows[0].id, channel: input.channel, payout, event }
  })
}

export async function listChannelSettlements(db: PGlite, tenantId: string) {
  const r = await db.query<{
    id: string
    channel: string
    period_start: string
    period_end: string
    gross_sales: string
    refunds: string
    fees: string
    payout: string
  }>(
    `select id, channel, period_start::text as period_start, period_end::text as period_end,
            gross_sales, refunds, fees, payout
     from channel_settlements
     where tenant_id = $1
     order by period_end desc, channel`,
    [tenantId],
  )
  return r.rows.map((s) => ({
    ...s,
    gross_sales: num(s.gross_sales),
    refunds: num(s.refunds),
    fees: num(s.fees),
    payout: num(s.payout),
  }))
}

// Aggregate channel shipments: one GoodsShipped per SKU for a period — this is
// how channel COGS stays true without per-order records.
export async function recordChannelShipments(
  db: PGlite,
  tenantId: string,
  input: { channel: string; period_end: string; lines: Array<{ sku: string; qty: number }> },
) {
  if (input.lines.length === 0) throw new KernelError('at least one shipment line required')
  return db.transaction(async (tx) => {
    const events: IngestResult[] = []
    for (const l of input.lines) {
      if (l.qty <= 0) throw new KernelError('shipment qty must be positive')
      events.push(
        await ingestTx(tx, tenantId, {
          type: 'GoodsShipped',
          payload: { sku: l.sku, qty: l.qty, ref: `${input.channel} ${input.period_end}` },
          occurred_at: `${input.period_end}T12:00:00.000Z`,
        }),
      )
    }
    const cogs = round2(events.reduce((s, e) => s + (e.moves[0]?.value ?? 0), 0))
    return { shipped_lines: events.length, cogs, events }
  })
}
