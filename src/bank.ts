// Bank reconciliation, CSV-first: import the statement, auto-match against
// cash journal lines, hand-match the stragglers, and the close checklist says
// whether the outside world agrees with the books. A Plaid-class live feed is
// a later slice — it lands in the same bank_transactions table.
import type { PGlite } from '@electric-sql/pglite'
import { KernelError } from './events.js'
import { parseCsv } from './importer.js'
import { num, round2 } from './money.js'

const norm = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]/g, '')

function toNumber(s: string): number | null {
  const cleaned = s.replaceAll(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function toDate(s: string): string | null {
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const us = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return null
}

// Bank exports are near-standard: Date, Description, Amount — or Debit/Credit
// columns. Column detection is by header synonym; no full mapper needed.
export function parseBankCsv(csv: string): {
  rows: Array<{ txn_date: string; description: string; amount: number }>
  skipped: Array<{ row: number; reason: string }>
} {
  const grid = parseCsv(csv)
  if (grid.length < 2) throw new KernelError('need a header row plus at least one transaction')
  const headers = grid[0].map(norm)
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h))
  const dateCol = col('date', 'txndate', 'transactiondate', 'posted', 'posteddate', 'postingdate')
  const descCol = col('description', 'desc', 'memo', 'payee', 'name', 'details', 'transaction')
  const amountCol = col('amount', 'amt')
  const debitCol = col('debit', 'withdrawal', 'withdrawals', 'moneyout', 'paidout')
  const creditCol = col('credit', 'deposit', 'deposits', 'moneyin', 'paidin')
  if (dateCol < 0) throw new KernelError('no date column found (looked for Date / Posted / Transaction Date)')
  if (amountCol < 0 && (debitCol < 0 || creditCol < 0))
    throw new KernelError('no amount column found (looked for Amount, or Debit + Credit)')

  const rows: Array<{ txn_date: string; description: string; amount: number }> = []
  const skipped: Array<{ row: number; reason: string }> = []
  grid.slice(1).forEach((r, i) => {
    const rowNo = i + 1
    const date = toDate(r[dateCol] ?? '')
    if (!date) {
      skipped.push({ row: rowNo, reason: `unreadable date "${r[dateCol] ?? ''}"` })
      return
    }
    let amount: number | null
    if (amountCol >= 0) {
      amount = toNumber(r[amountCol] ?? '')
    } else {
      const debit = toNumber(r[debitCol] ?? '') ?? 0
      const credit = toNumber(r[creditCol] ?? '') ?? 0
      amount = round2(credit - debit)
    }
    if (amount === null || amount === 0) {
      skipped.push({ row: rowNo, reason: 'zero or unreadable amount' })
      return
    }
    rows.push({ txn_date: date, description: (r[descCol] ?? '').slice(0, 200), amount: round2(amount) })
  })
  return { rows, skipped }
}

export async function importBankCsv(db: PGlite, tenantId: string, csv: string) {
  const { rows, skipped } = parseBankCsv(csv)
  return db.transaction(async (tx) => {
    let imported = 0
    let duplicates = 0
    for (const r of rows) {
      // Idempotent re-import: identical (date, amount, description) is a dupe.
      const existing = await tx.query<{ id: string }>(
        `select id from bank_transactions
         where tenant_id = $1 and txn_date = $2 and amount = $3 and description = $4`,
        [tenantId, r.txn_date, r.amount, r.description],
      )
      if (existing.rows[0]) {
        duplicates++
        continue
      }
      await tx.query(
        'insert into bank_transactions (tenant_id, txn_date, description, amount) values ($1, $2, $3, $4)',
        [tenantId, r.txn_date, r.description, r.amount],
      )
      imported++
    }
    return { imported, duplicates, skipped }
  })
}

interface CashLine {
  line_id: string
  entry_date: string
  memo: string
  side: string
  amount: number
}

async function cashLines(db: PGlite, tenantId: string): Promise<CashLine[]> {
  const r = await db.query<{
    line_id: string
    entry_date: string
    memo: string
    side: string
    amount: string
  }>(
    `select jl.id as line_id, je.entry_date::text as entry_date, je.memo, jl.side, jl.amount
     from journal_lines jl
     join journal_entries je on je.id = jl.entry_id
     join accounts a on a.id = jl.account_id
     where jl.tenant_id = $1 and a.code = '1110'
     order by je.entry_date`,
    [tenantId],
  )
  return r.rows.map((l) => ({ ...l, amount: num(l.amount) }))
}

// Auto-match: a bank deposit matches a cash DEBIT of the same amount within
// ±5 days (withdrawal ↔ credit). Only unambiguous single-candidate pairs are
// taken automatically; everything else stays for a human.
export async function autoMatch(db: PGlite, tenantId: string) {
  return db.transaction(async (tx) => {
    const txns = await tx.query<{ id: string; txn_date: string; amount: string }>(
      `select id, txn_date::text as txn_date, amount from bank_transactions
       where tenant_id = $1 and status = 'unmatched' order by txn_date`,
      [tenantId],
    )
    const matchedLines = new Set(
      (
        await tx.query<{ matched_line_id: string }>(
          `select matched_line_id from bank_transactions
           where tenant_id = $1 and matched_line_id is not null`,
          [tenantId],
        )
      ).rows.map((r) => r.matched_line_id),
    )
    const lines = await tx.query<{
      line_id: string
      entry_date: string
      side: string
      amount: string
    }>(
      `select jl.id as line_id, je.entry_date::text as entry_date, jl.side, jl.amount
       from journal_lines jl
       join journal_entries je on je.id = jl.entry_id
       join accounts a on a.id = jl.account_id
       where jl.tenant_id = $1 and a.code = '1110'`,
      [tenantId],
    )
    let matched = 0
    for (const t of txns.rows) {
      const amount = num(t.amount)
      const wantSide = amount > 0 ? 'debit' : 'credit'
      const target = Math.abs(amount)
      const candidates = lines.rows.filter((l) => {
        if (matchedLines.has(l.line_id) || l.side !== wantSide) return false
        if (Math.abs(num(l.amount) - target) > 0.005) return false
        const dayGap =
          Math.abs(new Date(l.entry_date + 'T00:00Z').getTime() - new Date(t.txn_date + 'T00:00Z').getTime()) /
          86_400_000
        return dayGap <= 5
      })
      if (candidates.length === 1) {
        await tx.query(
          "update bank_transactions set status = 'matched', matched_line_id = $3 where tenant_id = $1 and id = $2",
          [tenantId, t.id, candidates[0].line_id],
        )
        matchedLines.add(candidates[0].line_id)
        matched++
      }
    }
    return { matched }
  })
}

export async function manualMatch(db: PGlite, tenantId: string, txnId: string, lineId: string) {
  const line = await db.query<{ id: string }>(
    `select jl.id from journal_lines jl
     join accounts a on a.id = jl.account_id
     where jl.tenant_id = $1 and jl.id = $2 and a.code = '1110'`,
    [tenantId, lineId],
  )
  if (!line.rows[0]) throw new KernelError('that journal line is not a cash line')
  const taken = await db.query<{ id: string }>(
    'select id from bank_transactions where tenant_id = $1 and matched_line_id = $2',
    [tenantId, lineId],
  )
  if (taken.rows[0]) throw new KernelError('that cash line is already matched to another bank transaction')
  const r = await db.query(
    `update bank_transactions set status = 'matched', matched_line_id = $3
     where tenant_id = $1 and id = $2 and status <> 'matched' returning id`,
    [tenantId, txnId, lineId],
  )
  if (r.rows.length === 0) throw new KernelError('unknown or already-matched bank transaction')
  return { matched: true }
}

export async function setTxnStatus(db: PGlite, tenantId: string, txnId: string, status: 'unmatched' | 'excluded') {
  const r = await db.query(
    `update bank_transactions set status = $3, matched_line_id = null
     where tenant_id = $1 and id = $2 returning id`,
    [tenantId, txnId, status],
  )
  if (r.rows.length === 0) throw new KernelError('unknown bank transaction')
  return { status }
}

export async function reconciliation(db: PGlite, tenantId: string) {
  const txns = await db.query<{
    id: string
    txn_date: string
    description: string
    amount: string
    status: string
    matched_line_id: string | null
  }>(
    `select id, txn_date::text as txn_date, description, amount, status, matched_line_id
     from bank_transactions where tenant_id = $1 order by txn_date desc, created_at desc`,
    [tenantId],
  )
  const lines = await cashLines(db, tenantId)
  const matchedLineIds = new Set(txns.rows.map((t) => t.matched_line_id).filter(Boolean))

  const bankTotal = round2(txns.rows.filter((t) => t.status !== 'excluded').reduce((s, t) => s + num(t.amount), 0))
  const bookCash = round2(lines.reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0))
  const unmatchedBank = txns.rows.filter((t) => t.status === 'unmatched')
  const unmatchedBook = lines.filter((l) => !matchedLineIds.has(l.line_id))

  return {
    bank_total: bankTotal,
    book_cash: bookCash,
    difference: round2(bookCash - bankTotal),
    transactions: txns.rows.map((t) => ({ ...t, amount: num(t.amount) })),
    unmatched_bank_count: unmatchedBank.length,
    unmatched_book_lines: unmatchedBook,
    fully_reconciled: unmatchedBank.length === 0 && Math.abs(bookCash - bankTotal) < 0.005,
  }
}
