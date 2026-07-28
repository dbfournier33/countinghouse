// QuickBooks bridge — stage 1 of the QB road (architecture sketch §7):
// shadow books. We generate ONE summary journal entry per period that a
// bookkeeper posts (or imports) into QuickBooks, and we diff QuickBooks'
// trial balance against ours. Zero trust required; the books prove themselves.
// A live QBO API connection is a later slice — the data contract is identical.
import type { PGlite } from '@electric-sql/pglite'
import { KernelError } from './events.js'
import { num, round2 } from './money.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDate(s: string, label: string): void {
  if (!DATE_RE.test(s)) throw new KernelError(`${label} must be YYYY-MM-DD`)
}

// Net movement per QB account over [from, to] — collapsed through the mapping.
// Because per-account nets are taken from a balanced ledger, the summary
// journal entry is balanced by construction.
export async function qbSummary(db: PGlite, tenantId: string, from: string, to: string) {
  assertDate(from, 'from')
  assertDate(to, 'to')
  if (from > to) throw new KernelError('from must be on or before to')
  const r = await db.query<{ qb_account: string; d: string; c: string }>(
    `select coalesce(a.qb_account, a.name) as qb_account,
            coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as d,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as c
     from journal_lines jl
     join journal_entries je on je.id = jl.entry_id
     join accounts a on a.id = jl.account_id
     where jl.tenant_id = $1 and je.entry_date between $2 and $3
     group by coalesce(a.qb_account, a.name)
     order by qb_account`,
    [tenantId, from, to],
  )
  const lines = r.rows
    .map((row) => ({ qb_account: row.qb_account, net: round2(num(row.d) - num(row.c)) }))
    .filter((row) => Math.abs(row.net) >= 0.005)
    .map((row) => ({
      qb_account: row.qb_account,
      debit: row.net > 0 ? row.net : 0,
      credit: row.net < 0 ? round2(-row.net) : 0,
    }))
  const totalDebits = round2(lines.reduce((s, l) => s + l.debit, 0))
  const totalCredits = round2(lines.reduce((s, l) => s + l.credit, 0))
  return {
    journal_no: `SERP-${to.replaceAll('-', '').slice(0, 6)}`,
    journal_date: to,
    memo: `Simple ERP summary ${from} → ${to}`,
    lines,
    total_debits: totalDebits,
    total_credits: totalCredits,
    balanced: Math.abs(totalDebits - totalCredits) < 0.005,
  }
}

export async function getMapping(db: PGlite, tenantId: string) {
  const r = await db.query<{ code: string; name: string; qb_account: string | null }>(
    'select code, name, qb_account from accounts where tenant_id = $1 order by code',
    [tenantId],
  )
  return r.rows.map((a) => ({ code: a.code, name: a.name, qb_account: a.qb_account ?? a.name }))
}

export async function updateMapping(
  db: PGlite,
  tenantId: string,
  entries: Array<{ code: string; qb_account: string }>,
) {
  return db.transaction(async (tx) => {
    for (const e of entries) {
      const r = await tx.query(
        'update accounts set qb_account = $3 where tenant_id = $1 and code = $2 returning code',
        [tenantId, e.code, e.qb_account.trim()],
      )
      if (r.rows.length === 0) throw new KernelError(`unknown account code ${e.code}`)
    }
    return { updated: entries.length }
  })
}

// Compare QuickBooks' trial balance (as exported from QBO's Trial Balance
// report: Account, Debit, Credit) against our cumulative balances through
// `to`, collapsed through the same mapping. This is the trust loop.
export async function compareTrialBalance(
  db: PGlite,
  tenantId: string,
  to: string,
  qbRows: Array<{ account: string; debit?: number; credit?: number }>,
) {
  assertDate(to, 'to')
  const r = await db.query<{ qb_account: string; d: string; c: string }>(
    `select coalesce(a.qb_account, a.name) as qb_account,
            coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as d,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as c
     from journal_lines jl
     join journal_entries je on je.id = jl.entry_id
     join accounts a on a.id = jl.account_id
     where jl.tenant_id = $1 and je.entry_date <= $2
     group by coalesce(a.qb_account, a.name)`,
    [tenantId, to],
  )
  const ours = new Map<string, number>()
  for (const row of r.rows) {
    const net = round2(num(row.d) - num(row.c))
    if (Math.abs(net) >= 0.005) ours.set(row.qb_account.trim().toLowerCase(), net)
  }
  const theirs = new Map<string, { label: string; net: number }>()
  for (const row of qbRows) {
    const key = row.account.trim().toLowerCase()
    if (!key) continue
    const net = round2((row.debit ?? 0) - (row.credit ?? 0))
    const existing = theirs.get(key)
    theirs.set(key, { label: row.account.trim(), net: round2((existing?.net ?? 0) + net) })
  }

  const keys = [...new Set([...ours.keys(), ...theirs.keys()])].sort()
  const rows = keys.map((key) => {
    const ourNet = ours.get(key) ?? 0
    const their = theirs.get(key)
    const theirNet = their?.net ?? 0
    const diff = round2(ourNet - theirNet)
    return {
      account: their?.label ?? [...r.rows].find((x) => x.qb_account.trim().toLowerCase() === key)?.qb_account ?? key,
      ours: ourNet,
      quickbooks: theirNet,
      diff,
      match: Math.abs(diff) < 0.01,
      only_in: ours.has(key) && !theirs.has(key) ? 'ours' : !ours.has(key) && theirs.has(key) ? 'quickbooks' : null,
    }
  })
  const matched = rows.filter((row) => row.match).length
  return {
    as_of: to,
    rows,
    matched,
    total: rows.length,
    all_match: matched === rows.length,
  }
}
