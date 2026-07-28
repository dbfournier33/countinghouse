import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { autoMatch, importBankCsv, manualMatch, parseBankCsv, reconciliation, setTxnStatus } from '../src/bank.js'
import { openDb, provisionTenant } from '../src/bootstrap.js'
import { ingest } from '../src/events.js'

let db: PGlite
let seq = 0

const TODAY = new Date().toISOString().slice(0, 10)

async function makeTenant(): Promise<string> {
  return provisionTenant(db, `Bank Tenant ${++seq}`, `bank-${seq}`)
}

beforeAll(async () => {
  db = await openDb()
})

describe('bank csv parsing', () => {
  it('detects date/description/amount and handles $, commas, parens', () => {
    const { rows, skipped } = parseBankCsv(
      'Posted Date,Payee,Amount\n07/28/2026,ACH VENDOR,"($2,500.00)"\n2026-07-27,DEPOSIT,3400.00\nbad-date,X,5\n',
    )
    expect(rows).toEqual([
      { txn_date: '2026-07-28', description: 'ACH VENDOR', amount: -2500 },
      { txn_date: '2026-07-27', description: 'DEPOSIT', amount: 3400 },
    ])
    expect(skipped).toHaveLength(1)
  })

  it('handles debit/credit column pairs', () => {
    const { rows } = parseBankCsv('Date,Memo,Debit,Credit\n7/1/2026,FEE,15.00,\n7/2/2026,DEP,,900.00\n')
    expect(rows[0].amount).toBe(-15)
    expect(rows[1].amount).toBe(900)
  })

  it('rejects files without recognizable columns', () => {
    expect(() => parseBankCsv('a,b\n1,2\n')).toThrow(/no date column/)
  })
})

describe('import + auto-match', () => {
  it('imports idempotently and auto-matches unambiguous pairs both directions', async () => {
    const t = await makeTenant()
    await ingest(db, t, { type: 'PaymentReceived', payload: { amount: 3400, ref: 'INV-1' } })
    await ingest(db, t, { type: 'PaymentMade', payload: { amount: 2500, ref: 'BILL-1' } })

    const csv = `Date,Description,Amount\n${TODAY},ACH CUSTOMER,3400.00\n${TODAY},CHECK 1041,-2500.00\n${TODAY},SERVICE FEE,-15.00`
    const first = await importBankCsv(db, t, csv)
    expect(first.imported).toBe(3)
    const again = await importBankCsv(db, t, csv)
    expect(again.imported).toBe(0)
    expect(again.duplicates).toBe(3)

    const m = await autoMatch(db, t)
    expect(m.matched).toBe(2) // deposit↔debit, withdrawal↔credit; fee has no book side

    const rec = await reconciliation(db, t)
    expect(rec.unmatched_bank_count).toBe(1)
    expect(rec.book_cash).toBe(900)
    expect(rec.bank_total).toBe(885) // includes the fee
    expect(rec.difference).toBe(15)
    expect(rec.fully_reconciled).toBe(false)

    const fee = rec.transactions.find((x) => x.description === 'SERVICE FEE')!
    await setTxnStatus(db, t, fee.id, 'excluded')
    const rec2 = await reconciliation(db, t)
    expect(rec2.bank_total).toBe(900)
    expect(rec2.fully_reconciled).toBe(true)
  })

  it('leaves ambiguous pairs for a human, then manual match enforces the rules', async () => {
    const t = await makeTenant()
    await ingest(db, t, { type: 'PaymentReceived', payload: { amount: 100 } })
    await ingest(db, t, { type: 'PaymentReceived', payload: { amount: 100 } })
    await importBankCsv(db, t, `Date,Description,Amount\n${TODAY},DEP A,100.00\n${TODAY},DEP B,100.00`)
    const m = await autoMatch(db, t)
    expect(m.matched).toBe(0) // two identical candidates each — ambiguous, untouched

    const rec = await reconciliation(db, t)
    const [txnA, txnB] = rec.transactions
    const [lineA, lineB] = rec.unmatched_book_lines
    await manualMatch(db, t, txnA.id, lineA.line_id)
    await expect(manualMatch(db, t, txnB.id, lineA.line_id)).rejects.toThrow(/already matched/)
    await manualMatch(db, t, txnB.id, lineB.line_id)
    expect((await reconciliation(db, t)).fully_reconciled).toBe(true)
  })

  it('rejects matching against non-cash journal lines', async () => {
    const t = await makeTenant()
    await ingest(db, t, { type: 'InvoiceIssued', payload: { amount: 200 } })
    await importBankCsv(db, t, `Date,Description,Amount\n${TODAY},DEP,200.00`)
    const rec = await reconciliation(db, t)
    const arLine = await db.query<{ id: string }>(
      `select jl.id from journal_lines jl
       join accounts a on a.id = jl.account_id
       where jl.tenant_id = $1 and a.code = '1200'`,
      [t],
    )
    await expect(manualMatch(db, t, rec.transactions[0].id, arLine.rows[0].id)).rejects.toThrow(
      /not a cash line/,
    )
  })
})
