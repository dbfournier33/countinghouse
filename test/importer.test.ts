import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { listBills, listInvoices, payBill, recordInvoicePayment } from '../src/finance.js'
import { analyze, commit, detectKind, parseCsv, suggestMapping } from '../src/importer.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

const MESSY_ITEMS = `Part #,Description,Type,QOH,Std Cost ($),Unit,Min Stock
OATS-ROLL,"Rolled oats, 25lb sacks",Raw Material,"1,240",2.38,kg,400
HNY-WF,Wildflower honey drums,RM,310,$6.42,kg,60
WRAP-PRT,Printed wrapper film rolls,raw,"22,500",0.058,ea,"5,000"
BAR-OG,Original granola bar 45g,Finished Good,850,,ea,200
BOX-12,12-pack retail carton,packaging,4100,0.31,ea,1000
OATS-ROLL,duplicate row,raw,10,2.40,kg,0`

const PARTIES = `Company,Relationship
Cascade Farm Supply,Supplier
"Blue Heron Packaging, Inc.",vendor
Ridgeline Market,Customer
Bay Organics Co-op,Wholesale customer`

const BOM = `Assembly,Ingredient,Qty Per Unit
BAR-OG,OATS-ROLL,0.05
BAR-OG,HNY-WF,0.0166667
BAR-OG,WRAP-PRT,1
BAR-XX,OATS-ROLL,0.05`

async function makeTenant(): Promise<string> {
  return provisionTenant(db, `Imp Tenant ${++seq}`, `imp-${seq}`)
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

describe('csv parsing', () => {
  it('handles quoted commas, escaped quotes, currency, and blank lines', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n\n"1,240",$6.42\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['1,240', '$6.42'],
    ])
  })
})

describe('column mapping', () => {
  it('maps messy real-world headers with confidence and reasons', () => {
    const grid = parseCsv(MESSY_ITEMS)
    const m = suggestMapping('items', grid[0], grid.slice(1))
    expect(m.sku.header).toBe('Part #')
    expect(m.name.header).toBe('Description')
    expect(m.kind.header).toBe('Type')
    expect(m.qty_on_hand.header).toBe('QOH')
    expect(m.unit_cost.header).toBe('Std Cost ($)')
    expect(m.uom.header).toBe('Unit')
    expect(m.reorder_point.header).toBe('Min Stock')
    expect(m.sku.confidence).toBeGreaterThanOrEqual(0.75)
  })

  it('detects the entity kind from the columns', () => {
    const items = parseCsv(MESSY_ITEMS)
    expect(detectKind(items[0], items.slice(1)).kind).toBe('items')
    const bom = parseCsv(BOM)
    expect(detectKind(bom[0], bom.slice(1)).kind).toBe('bom')
    const parties = parseCsv(PARTIES)
    expect(detectKind(parties[0], parties.slice(1)).kind).toBe('parties')
  })
})

describe('items import', () => {
  it('analyze flags duplicates and unknown types; commit creates items + opening stock', async () => {
    const t = await makeTenant()
    const a = await analyze(db, t, MESSY_ITEMS)
    expect(a.kind).toBe('items')
    expect(a.total).toBe(6)
    expect(a.ready).toBe(5) // duplicate OATS-ROLL row skipped
    expect(a.issues.some((i) => i.message.includes('duplicate SKU'))).toBe(true)
    expect(a.issues.some((i) => i.message.includes('unrecognized type "packaging"'))).toBe(true)

    const r = await commit(db, t, MESSY_ITEMS, 'items')
    expect(r.created).toBe(5)
    expect(r.skipped).toBe(0)
    // 1240×2.38 + 310×6.42 + 22500×0.058 + 4100×0.31 (BAR-OG has no cost → $0)
    expect(r.opening_stock_value).toBe(7517.4)
    expect(r.opening_stock_events).toBe(5)
    expect(await balance(t, '3900')).toBe(7517.4)
    expect(await balance(t, '1310')).toBe(7517.4) // raw + defaulted-raw carton
    const bars = await db.query<{ qty_on_hand: string }>(
      `select ic.qty_on_hand from item_costs ic
       join items i on i.id = ic.item_id
       where ic.tenant_id = $1 and i.sku = 'BAR-OG'`,
      [t],
    )
    expect(num(bars.rows[0].qty_on_hand)).toBe(850) // stock at zero cost still counts
  })

  it('re-running the same file is a no-op that reports skips', async () => {
    const t = await makeTenant()
    await commit(db, t, MESSY_ITEMS, 'items')
    const again = await commit(db, t, MESSY_ITEMS, 'items')
    expect(again.created).toBe(0)
    expect(again.skipped).toBe(5)
    expect(again.opening_stock_events).toBe(0)
    expect(await balance(t, '3900')).toBe(7517.4) // unchanged
  })

  it('respects a user mapping override', async () => {
    const t = await makeTenant()
    const csv = 'colA,colB\nSKU-1,Widget\nSKU-2,Gadget'
    const a = await analyze(db, t, csv, 'items', { sku: 0, name: 1 })
    expect(a.ready).toBe(2)
    expect(a.mapping.sku.reason).toBe('set by user')
    const r = await commit(db, t, csv, 'items', { sku: 0, name: 1 })
    expect(r.created).toBe(2)
  })
})

describe('parties import', () => {
  it('normalizes roles including phrase forms', async () => {
    const t = await makeTenant()
    const r = await commit(db, t, PARTIES, 'parties')
    expect(r.created).toBe(4)
    const rows = await db.query<{ name: string; roles: string[] }>(
      'select name, roles from parties where tenant_id = $1 order by name', [t])
    const byName = Object.fromEntries(rows.rows.map((p) => [p.name, p.roles]))
    expect(byName['Cascade Farm Supply']).toEqual(['vendor'])
    expect(byName['Blue Heron Packaging, Inc.']).toEqual(['vendor'])
    expect(byName['Ridgeline Market']).toEqual(['customer'])
    expect(byName['Bay Organics Co-op']).toEqual(['customer']) // "Wholesale customer"
  })
})

const OPEN_AR = `Customer,Invoice #,Invoice Date,Open Balance
Ridgeline Market,QB-10412,7/2/2026,"$1,240.00"
Bay Organics Co-op,QB-10428,7/11/2026,862.50
Summit Outfitters,QB-10433,7/19/2026,$418.20`

const OPEN_AP = `Vendor,Bill No,Bill Date,Amount Due
Cascade Farm Supply,CF-2291,7/8/2026,"$3,420.00"
Blue Heron Packaging,BH-118,7/15/2026,975.40`

describe('migration kit: open AR/AP', () => {
  it('detects QB-style AR exports, creates parties + open invoices, posts against 3900', async () => {
    const t = await makeTenant()
    const a = await analyze(db, t, OPEN_AR)
    expect(a.kind).toBe('open_invoices')
    expect(a.ready).toBe(3)
    expect(a.issues.filter((i) => i.message.includes('will be created'))).toHaveLength(3)

    const r = await commit(db, t, OPEN_AR, 'open_invoices')
    expect(r.created).toBe(3)
    expect(r.opening_ar_total).toBe(2520.7) // 1240 + 862.50 + 418.20
    expect(await balance(t, '1200')).toBe(2520.7)
    expect(await balance(t, '3900')).toBe(2520.7)

    const invoices = await listInvoices(db, t)
    expect(invoices).toHaveLength(3)
    expect(invoices.every((i) => i.status === 'open')).toBe(true)
    const qb = invoices.find((i) => i.number === 'QB-10412')!
    expect(qb.issued_date).toBe('2026-07-02') // US date parsed; JE dated same day

    // The migrated invoice is a first-class document: collect it.
    await recordInvoicePayment(db, t, qb.id)
    expect(await balance(t, '1200')).toBe(1280.7)
    expect(await balance(t, '1110')).toBe(1240)
  })

  it('creates open bills payable through the normal AP flow, and re-runs skip', async () => {
    const t = await makeTenant()
    const a = await analyze(db, t, OPEN_AP)
    expect(a.kind).toBe('open_bills')
    const r = await commit(db, t, OPEN_AP, 'open_bills')
    expect(r.created).toBe(2)
    expect(r.opening_ap_total).toBe(4395.4)
    expect(await balance(t, '2100')).toBe(4395.4)
    expect(await balance(t, '3900')).toBe(-4395.4) // payables reduce opening equity

    const bills = await listBills(db, t)
    expect(bills.every((b) => b.kind === 'opening' && b.status === 'open')).toBe(true)
    await payBill(db, t, bills.find((b) => b.number === 'BH-118')!.id)
    expect(await balance(t, '2100')).toBe(3420)

    const again = await commit(db, t, OPEN_AP, 'open_bills')
    expect(again.created).toBe(0)
    expect(again.skipped).toBe(2)
    expect(await balance(t, '2100')).toBe(3420) // unchanged
  })
})

describe('bom import', () => {
  it('requires items to exist, groups by parent, and skips unknown SKUs', async () => {
    const t = await makeTenant()
    await commit(db, t, MESSY_ITEMS, 'items')
    const a = await analyze(db, t, BOM)
    expect(a.kind).toBe('bom')
    expect(a.ready).toBe(3) // BAR-XX row skipped: unknown parent
    expect(a.issues.some((i) => i.message.includes('unknown parent SKU "BAR-XX"'))).toBe(true)

    const r = await commit(db, t, BOM, 'bom')
    expect(r.bom_parents).toBe(1)
    expect(r.created).toBe(3)
    const lines = await db.query<{ n: string }>(
      `select count(*) as n from bom_lines b
       join items p on p.id = b.parent_item_id
       where b.tenant_id = $1 and p.sku = 'BAR-OG'`,
      [t],
    )
    expect(num(lines.rows[0].n)).toBe(3)
  })
})
