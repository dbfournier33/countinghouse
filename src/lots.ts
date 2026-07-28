// Lot traceability queries. Identity flows: vendor lot → work-order batch
// (the WO number IS the output lot) → shipments → customers/channels. Both
// directions answer the two recall questions: "where did it go?" and
// "what went into it?"
import type { PGlite } from '@electric-sql/pglite'
import { num, round4 } from './money.js'

export async function lotsOnHand(db: PGlite, tenantId: string) {
  const r = await db.query<{
    lot_no: string
    sku: string
    name: string
    uom: string
    on_hand: string
    created_at: string
  }>(
    `select l.lot_no, i.sku, i.name, i.uom,
            coalesce(sum(case when im.direction = 'in' then ml.qty else -ml.qty end), 0) as on_hand,
            l.created_at::text as created_at
     from lots l
     join items i on i.id = l.item_id
     join move_lots ml on ml.lot_id = l.id and ml.tenant_id = l.tenant_id
     join inventory_moves im on im.id = ml.move_id
     where l.tenant_id = $1
     group by l.lot_no, i.sku, i.name, i.uom, l.created_at
     having coalesce(sum(case when im.direction = 'in' then ml.qty else -ml.qty end), 0) > 0.0001
     order by i.sku, l.created_at`,
    [tenantId],
  )
  return r.rows.map((row) => ({ ...row, on_hand: round4(num(row.on_hand)) }))
}

interface LotAllocation {
  lot_id: string
  lot_no: string
  sku: string
  item_name: string
  direction: string
  qty: number
  event_type: string
  payload: Record<string, unknown>
  entry_seq: number
}

async function allocationsFor(db: PGlite, tenantId: string, lotIds: string[]): Promise<LotAllocation[]> {
  if (lotIds.length === 0) return []
  const r = await db.query<{
    lot_id: string
    lot_no: string
    sku: string
    item_name: string
    direction: string
    qty: string
    event_type: string
    payload: Record<string, unknown>
    entry_seq: string
  }>(
    `select ml.lot_id, l.lot_no, i.sku, i.name as item_name, im.direction, ml.qty,
            e.type as event_type, e.payload, e.seq as entry_seq
     from move_lots ml
     join lots l on l.id = ml.lot_id
     join items i on i.id = l.item_id
     join inventory_moves im on im.id = ml.move_id
     join events e on e.id = im.event_id
     where ml.tenant_id = $1 and ml.lot_id = any($2)
     order by e.seq`,
    [tenantId, lotIds],
  )
  return r.rows.map((row) => ({ ...row, qty: num(row.qty), entry_seq: Number(row.entry_seq) }))
}

async function customerForRef(db: PGlite, tenantId: string, ref: string): Promise<string | null> {
  const so = ref.match(/SO-\d+/)?.[0]
  if (!so) return null
  const r = await db.query<{ customer: string }>(
    `select p.name as customer from sales_orders s
     join parties p on p.id = s.customer_id
     where s.tenant_id = $1 and s.number = $2`,
    [tenantId, so],
  )
  return r.rows[0]?.customer ?? null
}

export interface TraceDestination {
  via: string // e.g. "SO-2001", "Shopify 2026-07-27", "WO-1001 → SO-2002"
  kind: 'shipment' | 'production' | 'adjustment'
  qty: number
  customer: string | null
  detail: string
}

export async function trace(db: PGlite, tenantId: string, lotNo: string) {
  const lots = await db.query<{ id: string; lot_no: string; sku: string; name: string; uom: string }>(
    `select l.id, l.lot_no, i.sku, i.name, i.uom
     from lots l join items i on i.id = l.item_id
     where l.tenant_id = $1 and lower(l.lot_no) = lower($2)`,
    [tenantId, lotNo],
  )
  const results = []
  for (const lot of lots.rows) {
    const allocs = await allocationsFor(db, tenantId, [lot.id])
    const received = allocs.filter((a) => a.direction === 'in')
    const consumed = allocs.filter((a) => a.direction === 'out')
    const onHand = round4(
      received.reduce((s, a) => s + a.qty, 0) - consumed.reduce((s, a) => s + a.qty, 0),
    )

    // Where did it go? Direct shipments, plus through batches to their shipments.
    const destinations: TraceDestination[] = []
    for (const c of consumed) {
      if (c.event_type === 'GoodsShipped') {
        const ref = String(c.payload.ref ?? 'shipment')
        destinations.push({
          via: ref, kind: 'shipment', qty: c.qty,
          customer: await customerForRef(db, tenantId, ref),
          detail: `${c.qty} ${lot.uom} shipped`,
        })
      } else if (c.event_type === 'MaterialIssued') {
        const wo = String(c.payload.work_order ?? '')
        // The batch lot carries the WO number — follow it to its shipments.
        const batch = await db.query<{ id: string; sku: string }>(
          `select l.id, i.sku from lots l join items i on i.id = l.item_id
           where l.tenant_id = $1 and l.lot_no = $2`,
          [tenantId, wo],
        )
        if (batch.rows.length === 0) {
          destinations.push({
            via: wo, kind: 'production', qty: c.qty, customer: null,
            detail: `${c.qty} ${lot.uom} consumed by ${wo} (batch not yet completed)`,
          })
          continue
        }
        for (const b of batch.rows) {
          const batchAllocs = await allocationsFor(db, tenantId, [b.id])
          const shipped = batchAllocs.filter(
            (a) => a.direction === 'out' && a.event_type === 'GoodsShipped',
          )
          if (shipped.length === 0) {
            destinations.push({
              via: wo, kind: 'production', qty: c.qty, customer: null,
              detail: `${c.qty} ${lot.uom} went into batch ${wo} (${b.sku}) — still in stock`,
            })
          }
          for (const s of shipped) {
            const ref = String(s.payload.ref ?? 'shipment')
            destinations.push({
              via: `${wo} → ${ref}`, kind: 'shipment', qty: s.qty,
              customer: await customerForRef(db, tenantId, ref),
              detail: `batch ${wo} (${b.sku}): ${s.qty} shipped`,
            })
          }
        }
      } else {
        destinations.push({
          via: c.event_type, kind: 'adjustment', qty: c.qty, customer: null,
          detail: `${c.qty} ${lot.uom} — ${c.event_type}`,
        })
      }
    }

    // What went into it? Only meaningful when this lot is a WO batch.
    const inputs: Array<{ lot_no: string; sku: string; name: string; qty: number; source: string }> = []
    const inputAllocs = await db.query<{
      lot_no: string
      sku: string
      name: string
      qty: string
    }>(
      `select il.lot_no, ii.sku, ii.name, ml.qty
       from move_lots ml
       join lots il on il.id = ml.lot_id
       join items ii on ii.id = il.item_id
       join inventory_moves im on im.id = ml.move_id
       join events e on e.id = im.event_id
       where ml.tenant_id = $1 and im.direction = 'out'
         and e.type = 'MaterialIssued' and e.payload->>'work_order' = $2
       order by ii.sku`,
      [tenantId, lot.lot_no],
    )
    for (const ia of inputAllocs.rows) {
      const origin = await db.query<{ ref: string | null }>(
        `select e.payload->>'ref' as ref
         from move_lots ml
         join lots l on l.id = ml.lot_id and l.lot_no = $2
         join inventory_moves im on im.id = ml.move_id and im.direction = 'in'
         join events e on e.id = im.event_id
         where ml.tenant_id = $1
         limit 1`,
        [tenantId, ia.lot_no],
      )
      inputs.push({
        lot_no: ia.lot_no, sku: ia.sku, name: ia.name, qty: num(ia.qty),
        source: origin.rows[0]?.ref ?? 'opening/adjustment',
      })
    }

    results.push({
      lot_no: lot.lot_no,
      sku: lot.sku,
      item: lot.name,
      uom: lot.uom,
      received: received.map((a) => ({
        qty: a.qty, via: String(a.payload.ref ?? a.event_type), event: a.event_type,
      })),
      on_hand: onHand,
      destinations,
      inputs,
      customers_affected: [
        ...new Set(destinations.map((d) => d.customer).filter((c): c is string => c !== null)),
      ],
    })
  }
  return results
}
