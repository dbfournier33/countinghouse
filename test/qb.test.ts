import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { ingest } from '../src/events.js'
import { compareTrialBalance, getMapping, qbSummary, updateMapping } from '../src/qb-bridge.js'

let db: PGlite
let seq = 0

const TODAY = new Date().toISOString().slice(0, 10)

async function setupTenant(): Promise<string> {
  const t = await provisionTenant(db, `QB Tenant ${++seq}`, `qb-${seq}`)
  for (const [sku, kind] of [
    ['OATS', 'raw'],
    ['BAR', 'finished'],
  ] as Array<[string, string]>) {
    await db.query(
      "insert into items (tenant_id, sku, name, kind, uom) values ($1, $2, $2, $3, 'ea')",
      [t, sku, kind],
    )
  }
  return t
}

// A small day of activity: receive raw, make, ship, invoice, collect, pay rent.
async function postStory(t: string) {
  const post = (type: string, payload: Record<string, unknown>) =>
    ingest(db, t, { type: type as never, payload })
  await post('GoodsReceived', { sku: 'OATS', qty: 100, unit_cost: 2 }) // raw +200, GRNI 200
  await post('MaterialIssued', { sku: 'OATS', qty: 10, work_order: 'WO-1' }) // WIP 20
  await post('TimeLogged', { hours: 1, loaded_rate: 30, work_order: 'WO-1' }) // WIP 50
  await post('ProductionCompleted', { sku: 'BAR', qty: 100, work_order: 'WO-1' }) // FG 50
  await post('GoodsShipped', { sku: 'BAR', qty: 80 }) // COGS 40
  await post('InvoiceIssued', { amount: 160 })
  await post('PaymentReceived', { amount: 160 })
  await post('ExpenseBillPosted', { amount: 25, ref: 'RENT' })
}

beforeAll(async () => {
  db = await openDb()
})

describe('summary journal entry', () => {
  it('collapses our accounts through the mapping and balances by construction', async () => {
    const t = await setupTenant()
    await postStory(t)
    const s = await qbSummary(db, t, TODAY, TODAY)
    expect(s.balanced).toBe(true)
    expect(s.total_debits).toBe(s.total_credits)

    const byAccount = Object.fromEntries(s.lines.map((l) => [l.qb_account, l]))
    // 1310 (+180) + 1330 (0) + 1350 (+10) collapse into one Inventory Asset line.
    expect(byAccount['Inventory Asset']).toEqual({ qb_account: 'Inventory Asset', debit: 190, credit: 0 })
    expect(byAccount['Checking']).toEqual({ qb_account: 'Checking', debit: 160, credit: 0 })
    expect(byAccount['Sales of Product Income'].credit).toBe(160)
    expect(byAccount['Cost of Goods Sold'].debit).toBe(40)
    expect(byAccount['Payroll Expenses'].credit).toBe(30) // absorbed labor contra
    expect(byAccount['Operating Expenses'].debit).toBe(25)
    // AR netted to zero (invoiced 160, collected 160) → no line at all.
    expect(byAccount['Accounts Receivable (A/R)']).toBeUndefined()
  })

  it('rejects bad date ranges', async () => {
    const t = await setupTenant()
    await expect(qbSummary(db, t, 'nope', TODAY)).rejects.toThrow(/YYYY-MM-DD/)
    await expect(qbSummary(db, t, '2026-02-01', '2026-01-01')).rejects.toThrow(/on or before/)
  })
})

describe('mapping', () => {
  it('is seeded with defaults, editable, and drives the summary', async () => {
    const t = await setupTenant()
    await postStory(t)
    const mapping = await getMapping(db, t)
    expect(mapping.find((m) => m.code === '1310')!.qb_account).toBe('Inventory Asset')

    await updateMapping(db, t, [{ code: '6100', qb_account: 'Rent & Lease' }])
    const s = await qbSummary(db, t, TODAY, TODAY)
    const names = s.lines.map((l) => l.qb_account)
    expect(names).toContain('Rent & Lease')
    expect(names).not.toContain('Operating Expenses')
    await expect(updateMapping(db, t, [{ code: '9999', qb_account: 'X' }])).rejects.toThrow(/unknown account/)
  })
})

describe('trial balance comparison', () => {
  it('matches a QB trial balance built from our own numbers, and flags a perturbation', async () => {
    const t = await setupTenant()
    await postStory(t)
    const s = await qbSummary(db, t, '1970-01-01', TODAY)
    const qbRows = s.lines.map((l) => ({
      account: l.qb_account,
      debit: l.debit || undefined,
      credit: l.credit || undefined,
    }))

    const perfect = await compareTrialBalance(db, t, TODAY, qbRows)
    expect(perfect.all_match).toBe(true)
    expect(perfect.matched).toBe(perfect.total)

    const perturbed = qbRows.map((r) =>
      r.account === 'Operating Expenses' ? { ...r, debit: (r.debit ?? 0) + 50 } : r,
    )
    perturbed.push({ account: 'Meals & Entertainment', debit: 12, credit: undefined })
    const diff = await compareTrialBalance(db, t, TODAY, perturbed)
    expect(diff.all_match).toBe(false)
    const opex = diff.rows.find((r) => r.account === 'Operating Expenses')!
    expect(opex.match).toBe(false)
    expect(opex.diff).toBe(-50)
    const meals = diff.rows.find((r) => r.account === 'Meals & Entertainment')!
    expect(meals.only_in).toBe('quickbooks')
    expect(diff.matched).toBe(diff.total - 2)
  })

  it('is case- and whitespace-insensitive on account names', async () => {
    const t = await setupTenant()
    await postStory(t)
    const result = await compareTrialBalance(db, t, TODAY, [
      { account: '  checking ', debit: 160 },
    ])
    const checking = result.rows.find((r) => r.account.toLowerCase().includes('checking'))!
    expect(checking.match).toBe(true)
  })
})
