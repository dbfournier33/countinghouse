import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { createChannelSettlement, listChannelSettlements, recordChannelShipments } from '../src/channels.js'
import { ingest } from '../src/events.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

async function makeTenant(): Promise<string> {
  const t = await provisionTenant(db, `Chan Tenant ${++seq}`, `chan-${seq}`)
  await db.query(
    "insert into items (tenant_id, sku, name, kind, uom) values ($1, 'BAR', 'Bar', 'finished', 'ea')",
    [t],
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

beforeAll(async () => {
  db = await openDb()
})

describe('channel settlements', () => {
  it('posts one balanced multi-line entry: cash, fees, refunds, gross revenue', async () => {
    const t = await makeTenant()
    const r = await createChannelSettlement(db, t, {
      channel: 'Shopify',
      period_start: '2026-07-20',
      period_end: '2026-07-26',
      gross_sales: 1000,
      refunds: 50,
      fees: 120,
    })
    expect(r.payout).toBe(830)
    const lines = Object.fromEntries(r.event.journal!.lines.map((l) => [l.code, l]))
    expect(lines['1110']).toMatchObject({ side: 'debit', amount: 830 })
    expect(lines['6200']).toMatchObject({ side: 'debit', amount: 120 })
    expect(lines['4190']).toMatchObject({ side: 'debit', amount: 50 })
    expect(lines['4150']).toMatchObject({ side: 'credit', amount: 1000 })
    expect(await balance(t, '1110')).toBe(830)
    expect(await balance(t, '4150')).toBe(1000)
    expect(await balance(t, '4190')).toBe(50) // debit-normal contra revenue
  })

  it('drops zero-amount lines and dates the entry on period end', async () => {
    const t = await makeTenant()
    const r = await createChannelSettlement(db, t, {
      channel: 'Faire',
      period_start: '2026-07-01',
      period_end: '2026-07-07',
      gross_sales: 500,
      fees: 25,
    })
    expect(r.event.journal!.lines).toHaveLength(3) // no refunds line
    const je = await db.query<{ entry_date: string }>(
      `select je.entry_date::text as entry_date from journal_entries je
       join events e on e.id = je.event_id
       where je.tenant_id = $1 and e.type = 'ChannelSettlement'`,
      [t],
    )
    expect(je.rows[0].entry_date).toBe('2026-07-07')
  })

  it('rejects negative payouts and overlapping periods per channel', async () => {
    const t = await makeTenant()
    await expect(
      createChannelSettlement(db, t, {
        channel: 'Shopify', period_start: '2026-07-01', period_end: '2026-07-07',
        gross_sales: 100, refunds: 80, fees: 40,
      }),
    ).rejects.toThrow(/payout would be negative/)

    await createChannelSettlement(db, t, {
      channel: 'Shopify', period_start: '2026-07-01', period_end: '2026-07-07', gross_sales: 100,
    })
    await expect(
      createChannelSettlement(db, t, {
        channel: 'Shopify', period_start: '2026-07-05', period_end: '2026-07-12', gross_sales: 100,
      }),
    ).rejects.toThrow(/already covers/)
    // Same period on a DIFFERENT channel is fine; adjacent period on same channel is fine.
    await createChannelSettlement(db, t, {
      channel: 'Amazon', period_start: '2026-07-01', period_end: '2026-07-07', gross_sales: 50,
    })
    await createChannelSettlement(db, t, {
      channel: 'Shopify', period_start: '2026-07-08', period_end: '2026-07-14', gross_sales: 75,
    })
    expect(await listChannelSettlements(db, t)).toHaveLength(3)
  })
})

describe('channel shipments', () => {
  it('posts aggregate GoodsShipped per SKU so channel COGS stays true', async () => {
    const t = await makeTenant()
    await ingest(db, t, { type: 'OpeningStockSet', payload: { sku: 'BAR', qty: 100, unit_cost: 0.5 } })
    const r = await recordChannelShipments(db, t, {
      channel: 'Shopify',
      period_end: '2026-07-26',
      lines: [{ sku: 'BAR', qty: 60 }],
    })
    expect(r.cogs).toBe(30) // 60 × 0.50
    expect(await balance(t, '5110')).toBe(30)
    const stock = await db.query<{ q: string }>(
      `select ic.qty_on_hand as q from item_costs ic
       join items i on i.id = ic.item_id where ic.tenant_id = $1 and i.sku = 'BAR'`,
      [t],
    )
    expect(num(stock.rows[0].q)).toBe(40)
  })

  it('rejects overshipping stock', async () => {
    const t = await makeTenant()
    await ingest(db, t, { type: 'OpeningStockSet', payload: { sku: 'BAR', qty: 10, unit_cost: 1 } })
    await expect(
      recordChannelShipments(db, t, {
        channel: 'Shopify', period_end: '2026-07-26', lines: [{ sku: 'BAR', qty: 11 }],
      }),
    ).rejects.toThrow(/insufficient stock/)
  })
})
