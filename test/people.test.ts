import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import {
  capacity, completeWorkOrder, createPurchaseOrder, createWorkOrder, issueMaterials,
  issuePurchaseOrder, receivePurchaseOrder, releaseWorkOrder,
} from '../src/documents.js'
import { createEmployee, listEmployees, listTimeEntries, recordTime } from '../src/people.js'
import { num } from '../src/money.js'

let db: PGlite
let seq = 0

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `Ppl Tenant ${++seq}`, `ppl-${seq}`)
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
  return t
}

async function openWorkOrder(t: string, qty = 100): Promise<{ id: string; number: string }> {
  const po = await createPurchaseOrder(db, t, {
    vendor: 'Vendor Co',
    lines: [{ sku: 'OATS', qty: 100, unit_cost: 2 }],
  })
  await issuePurchaseOrder(db, t, po.id)
  await receivePurchaseOrder(db, t, po.id)
  const wo = await createWorkOrder(db, t, { sku: 'BAR', qty, work_center: 'LINE-1' })
  await releaseWorkOrder(db, t, wo.id)
  return wo
}

async function wipBalance(t: string): Promise<number> {
  const r = await db.query<{ d: string; c: string }>(
    `select coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as d,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as c
     from journal_lines jl join accounts a on a.id = jl.account_id
     where jl.tenant_id = $1 and a.code = '1330'`,
    [t],
  )
  return Math.round((num(r.rows[0].d) - num(r.rows[0].c)) * 100) / 100
}

beforeAll(async () => {
  db = await openDb()
})

describe('roster', () => {
  it('creates an employee as a party with the employee role plus labor attributes', async () => {
    const t = await setupTenant()
    await createEmployee(db, t, { name: 'Maya', cost_rate: 38, skills: ['mixing'], daily_hours: 8 })
    const emps = await listEmployees(db, t)
    expect(emps).toEqual([{ name: 'Maya', cost_rate: 38, skills: ['mixing'], daily_hours: 8 }])
    const party = await db.query<{ roles: string[] }>(
      "select roles from parties where tenant_id = $1 and name = 'Maya'", [t])
    expect(party.rows[0].roles).toContain('employee')
  })

  it('re-adding an existing party upgrades roles and updates the rate', async () => {
    const t = await setupTenant()
    await db.query("insert into parties (tenant_id, name, roles) values ($1, 'Sam', '{customer}')", [t])
    await createEmployee(db, t, { name: 'Sam', cost_rate: 30 })
    await createEmployee(db, t, { name: 'Sam', cost_rate: 35 })
    const party = await db.query<{ roles: string[] }>(
      "select roles from parties where tenant_id = $1 and name = 'Sam'", [t])
    expect(party.rows[0].roles).toEqual(['customer', 'employee'])
    expect((await listEmployees(db, t))[0].cost_rate).toBe(35)
  })
})

describe('time entries', () => {
  it('uses the roster rate by default, allows override, and posts labor into WIP', async () => {
    const t = await setupTenant()
    await createEmployee(db, t, { name: 'Maya', cost_rate: 38 })
    const wo = await openWorkOrder(t)

    await recordTime(db, t, { work_order: wo.number, hours: 2, employee: 'Maya' })
    expect(await wipBalance(t)).toBe(76) // 2h × roster 38

    await recordTime(db, t, { work_order: wo.number, hours: 1, employee: 'Maya', rate: 50 })
    expect(await wipBalance(t)).toBe(126) // + 1h × override 50

    const entries = await listTimeEntries(db, t)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.person === 'Maya' && e.on_roster)).toBe(true)
    expect(entries.reduce((s, e) => s + e.labor_cost, 0)).toBe(126)
  })

  it('free-text time needs an explicit rate; roster-less names are flagged', async () => {
    const t = await setupTenant()
    const wo = await openWorkOrder(t)
    await expect(recordTime(db, t, { work_order: wo.number, hours: 1, person: 'Temp' })).rejects.toThrow(
      /rate is required/,
    )
    await recordTime(db, t, { work_order: wo.number, hours: 1, person: 'Temp', rate: 20 })
    const entries = await listTimeEntries(db, t)
    expect(entries[0].on_roster).toBe(false)
    expect(entries[0].labor_cost).toBe(20)
  })

  it('rejects unknown employees, unknown work orders, and time on completed orders', async () => {
    const t = await setupTenant()
    await createEmployee(db, t, { name: 'Maya', cost_rate: 38 })
    await expect(recordTime(db, t, { work_order: 'WO-9999', hours: 1, employee: 'Maya' })).rejects.toThrow(
      /unknown work order/,
    )
    const wo = await openWorkOrder(t)
    await expect(recordTime(db, t, { work_order: wo.number, hours: 1, employee: 'Ghost' })).rejects.toThrow(
      /not on the roster/,
    )
    await issueMaterials(db, t, wo.id)
    await completeWorkOrder(db, t, wo.id)
    await expect(recordTime(db, t, { work_order: wo.number, hours: 1, employee: 'Maya' })).rejects.toThrow(
      /cannot log time on a completed/,
    )
  })

  it('backdated entries date their journal entry to the entry date', async () => {
    const t = await setupTenant()
    await createEmployee(db, t, { name: 'Maya', cost_rate: 40 })
    const wo = await openWorkOrder(t)
    await recordTime(db, t, { work_order: wo.number, hours: 1, employee: 'Maya', entry_date: '2026-07-01' })
    const je = await db.query<{ entry_date: string }>(
      `select je.entry_date::text as entry_date
       from journal_entries je join events e on e.id = je.event_id
       where je.tenant_id = $1 and e.type = 'TimeLogged'`,
      [t],
    )
    expect(je.rows[0].entry_date).toBe('2026-07-01')
  })
})

describe('labor capacity', () => {
  it('exposes roster daily hours vs committed hours per day', async () => {
    const t = await setupTenant()
    await createEmployee(db, t, { name: 'Maya', cost_rate: 38, daily_hours: 8 })
    await createEmployee(db, t, { name: 'Diego', cost_rate: 32, daily_hours: 6 })

    const po = await createPurchaseOrder(db, t, {
      vendor: 'Vendor Co',
      lines: [{ sku: 'OATS', qty: 100, unit_cost: 2 }],
    })
    await issuePurchaseOrder(db, t, po.id)
    await receivePurchaseOrder(db, t, po.id)
    const today = new Date().toISOString().slice(0, 10)
    const wo = await createWorkOrder(db, t, {
      sku: 'BAR', qty: 100, work_center: 'LINE-1', scheduled_date: today, est_hours: 10,
    })
    await releaseWorkOrder(db, t, wo.id)

    const cap = await capacity(db, t)
    expect(cap.labor.daily_hours_available).toBe(14)
    expect(cap.labor.load[today]).toBe(10)
  })
})
