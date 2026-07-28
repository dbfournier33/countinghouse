import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { recordChannelShipments } from '../src/channels.js'
import {
  completeWorkOrder, confirmSalesOrder, createPurchaseOrder, createSalesOrder, createWorkOrder,
  issueMaterials, issuePurchaseOrder, receivePurchaseOrder, releaseWorkOrder, shipSalesOrder,
} from '../src/documents.js'
import { ingest } from '../src/events.js'
import { lotsOnHand, trace } from '../src/lots.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `Lot Tenant ${++seq}`, `lot-${seq}`)
  for (const [sku, kind] of [
    ['OATS', 'raw'],
    ['BAR', 'finished'],
  ] as Array<[string, string]>) {
    await db.query("insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $2, $3, 'ea')", [
      t, sku, kind,
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

beforeAll(async () => {
  db = await openDb()
})

describe('lot identity', () => {
  it('receipts create lots (given or auto), and costing is untouched', async () => {
    const t = await setupTenant()
    const named = await ingest(db, t, {
      type: 'GoodsReceived', payload: { sku: 'OATS', qty: 100, unit_cost: 2, lot_no: 'OAT-A' },
    })
    expect(named.moves[0].lots).toEqual([{ lot_no: 'OAT-A', qty: 100 }])
    const auto = await ingest(db, t, {
      type: 'GoodsReceived', payload: { sku: 'OATS', qty: 50, unit_cost: 3 },
    })
    expect(auto.moves[0].lots[0].lot_no).toMatch(/^RCV-\d+$/)
    const cost = await db.query<{ avg_cost: string }>(
      `select avg_cost from item_costs ic join items i on i.id = ic.item_id
       where ic.tenant_id = $1 and i.sku = 'OATS'`,
      [t],
    )
    expect(num(cost.rows[0].avg_cost)).toBeCloseTo(2.333333, 5) // moving average unchanged by lots
  })

  it('consumption is FIFO across lots', async () => {
    const t = await setupTenant()
    await ingest(db, t, { type: 'GoodsReceived', payload: { sku: 'OATS', qty: 100, unit_cost: 2, lot_no: 'L1' } })
    await ingest(db, t, { type: 'GoodsReceived', payload: { sku: 'OATS', qty: 100, unit_cost: 2, lot_no: 'L2' } })
    const issue = await ingest(db, t, {
      type: 'MaterialIssued', payload: { sku: 'OATS', qty: 150, work_order: 'WO-X' },
    })
    expect(issue.moves[0].lots).toEqual([
      { lot_no: 'L1', qty: 100 },
      { lot_no: 'L2', qty: 50 },
    ])
    const onHand = await lotsOnHand(db, t)
    expect(onHand).toHaveLength(1)
    expect(onHand[0]).toMatchObject({ lot_no: 'L2', on_hand: 50 })
  })

  it('negative adjustments consume FIFO too', async () => {
    const t = await setupTenant()
    await ingest(db, t, { type: 'GoodsReceived', payload: { sku: 'OATS', qty: 10, unit_cost: 1, lot_no: 'L1' } })
    const adj = await ingest(db, t, { type: 'AdjustmentMade', payload: { sku: 'OATS', qty_delta: -4 } })
    expect(adj.moves[0].lots).toEqual([{ lot_no: 'L1', qty: 4 }])
  })
})

describe('recall trace: vendor lot → batch → customers', () => {
  it('answers both directions through the full documented loop', async () => {
    const t = await setupTenant()
    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [{ sku: 'OATS', qty: 100, unit_cost: 2 }],
    })
    await issuePurchaseOrder(db, t, po.id)
    const poLines = await db.query<{ id: string }>('select id from po_lines where po_id = $1', [po.id])
    await receivePurchaseOrder(db, t, po.id, [{ line_id: poLines.rows[0].id, qty: 100, lot_no: 'OAT-2207' }])

    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 500, work_center: 'LINE-1' })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id) // consumes 50 oats from OAT-2207
    await completeWorkOrder(db, t, wo.id) // batch lot = wo.number, 500 bars

    const so = await createSalesOrder(db, t, {
      customer: 'Customer Co',
      lines: [{ sku: 'BAR', qty: 300, unit_price: 2 }],
    })
    await confirmSalesOrder(db, t, so.id)
    await shipSalesOrder(db, t, so.id)
    await recordChannelShipments(db, t, {
      channel: 'Shopify', period_end: '2026-07-27', lines: [{ sku: 'BAR', qty: 100 }],
    })

    // Forward: the oat lot reaches the wholesale customer AND the channel.
    const [oat] = await trace(db, t, 'OAT-2207')
    expect(oat.on_hand).toBe(50)
    expect(oat.customers_affected).toEqual(['Customer Co'])
    const vias = oat.destinations.map((d) => d.via)
    expect(vias).toContain(`${wo.number} → ${so.number}`)
    expect(vias.some((v) => v.includes('Shopify'))).toBe(true)

    // Backward: the batch knows its inputs and their source PO.
    const [batch] = await trace(db, t, wo.number)
    expect(batch.sku).toBe('BAR')
    expect(batch.on_hand).toBe(100) // 500 made − 300 wholesale − 100 channel
    expect(batch.inputs).toHaveLength(1)
    expect(batch.inputs[0]).toMatchObject({ lot_no: 'OAT-2207', sku: 'OATS', qty: 50, source: po.number })
  })

  it('flags material consumed by a batch that has not shipped as still in stock', async () => {
    const t = await setupTenant()
    await ingest(db, t, { type: 'GoodsReceived', payload: { sku: 'OATS', qty: 100, unit_cost: 2, lot_no: 'OAT-B' } })
    const wo = await createWorkOrder(db, t, { sku: 'BAR', qty: 100, work_center: 'LINE-1' })
    await releaseWorkOrder(db, t, wo.id)
    await issueMaterials(db, t, wo.id)
    await completeWorkOrder(db, t, wo.id)
    const [oat] = await trace(db, t, 'OAT-B')
    expect(oat.customers_affected).toEqual([])
    expect(oat.destinations[0].detail).toContain('still in stock')
  })
})
