// Phase 2 finance surface: bills, invoice payments, statements, close checks.
// Bills and payments are documents over the same spine — posting a bill or
// recording a payment emits the event; the ledger does the rest.
import type { PGlite } from '@electric-sql/pglite'
import { assertStatus, nextNumber, partyByName } from './documents.js'
import { ingestTx, KernelError } from './events.js'
import { num, round2 } from './money.js'

// ---------------------------------------------------------------------------
// Bills (AP)
// ---------------------------------------------------------------------------

// A bill against a PO relieves GRNI (inventory bill); a bill with no PO is an
// operating expense. That one distinction is the whole config surface.
export async function createBill(
  db: PGlite,
  tenantId: string,
  input: { vendor: string; amount: number; ref?: string; po_number?: string },
) {
  if (input.amount <= 0) throw new KernelError('bill amount must be positive')
  return db.transaction(async (tx) => {
    const vendor = await partyByName(tx, tenantId, input.vendor, 'vendor')
    let poId: string | null = null
    if (input.po_number) {
      const po = await tx.query<{ id: string; status: string }>(
        'select id, status from purchase_orders where tenant_id = $1 and number = $2',
        [tenantId, input.po_number],
      )
      if (!po.rows[0]) throw new KernelError(`unknown purchase order "${input.po_number}"`)
      poId = po.rows[0].id
    }
    const number = input.ref ?? (await nextNumber(tx, tenantId, 'BILL'))
    const kind = poId ? 'inventory' : 'expense'
    const event = await ingestTx(tx, tenantId, {
      type: kind === 'inventory' ? 'BillPosted' : 'ExpenseBillPosted',
      payload: { amount: round2(input.amount), vendor: vendor.name, ref: number },
    })
    const bill = await tx.query<{ id: string }>(
      `insert into bills (tenant_id, number, vendor_id, po_id, kind, amount)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [tenantId, number, vendor.id, poId, kind, round2(input.amount)],
    )
    return { id: bill.rows[0].id, number, kind, status: 'open', event }
  })
}

export async function payBill(db: PGlite, tenantId: string, billId: string) {
  return db.transaction(async (tx) => {
    const bill = await tx.query<{ id: string; number: string; status: string; amount: string }>(
      'select id, number, status, amount from bills where tenant_id = $1 and id = $2',
      [tenantId, billId],
    )
    if (!bill.rows[0]) throw new KernelError('unknown bill', 404)
    assertStatus(bill.rows[0].status, ['open'], 'pay')
    const event = await ingestTx(tx, tenantId, {
      type: 'PaymentMade',
      payload: { amount: num(bill.rows[0].amount), ref: bill.rows[0].number },
    })
    await tx.query(
      "update bills set status = 'paid', paid_date = current_date where tenant_id = $1 and id = $2",
      [tenantId, billId],
    )
    return { number: bill.rows[0].number, status: 'paid', event }
  })
}

export async function listBills(db: PGlite, tenantId: string) {
  const r = await db.query<{
    id: string
    number: string
    vendor: string
    po_number: string | null
    kind: string
    amount: string
    status: string
    bill_date: string
    paid_date: string | null
  }>(
    `select b.id, b.number, p.name as vendor, po.number as po_number, b.kind,
            b.amount, b.status, b.bill_date::text as bill_date, b.paid_date::text as paid_date
     from bills b
     join parties p on p.id = b.vendor_id
     left join purchase_orders po on po.id = b.po_id
     where b.tenant_id = $1
     order by b.status, b.bill_date desc, b.number desc`,
    [tenantId],
  )
  return r.rows.map((b) => ({ ...b, amount: num(b.amount) }))
}

// ---------------------------------------------------------------------------
// Invoices (AR)
// ---------------------------------------------------------------------------

export async function recordInvoicePayment(db: PGlite, tenantId: string, invoiceId: string) {
  return db.transaction(async (tx) => {
    const inv = await tx.query<{ id: string; number: string; status: string; amount: string }>(
      'select id, number, status, amount from invoices where tenant_id = $1 and id = $2',
      [tenantId, invoiceId],
    )
    if (!inv.rows[0]) throw new KernelError('unknown invoice', 404)
    assertStatus(inv.rows[0].status, ['open'], 'record a payment against')
    const event = await ingestTx(tx, tenantId, {
      type: 'PaymentReceived',
      payload: { amount: num(inv.rows[0].amount), ref: inv.rows[0].number },
    })
    await tx.query(
      "update invoices set status = 'paid', paid_date = current_date where tenant_id = $1 and id = $2",
      [tenantId, invoiceId],
    )
    return { number: inv.rows[0].number, status: 'paid', event }
  })
}

export async function listInvoices(db: PGlite, tenantId: string) {
  const r = await db.query<{
    id: string
    number: string
    customer: string
    so_number: string | null
    amount: string
    status: string
    issued_date: string
    paid_date: string | null
  }>(
    `select i.id, i.number, p.name as customer, so.number as so_number,
            i.amount, i.status, i.issued_date::text as issued_date, i.paid_date::text as paid_date
     from invoices i
     join parties p on p.id = i.customer_id
     left join sales_orders so on so.id = i.so_id
     where i.tenant_id = $1
     order by i.status, i.issued_date desc, i.number desc`,
    [tenantId],
  )
  return r.rows.map((i) => ({ ...i, amount: num(i.amount) }))
}

// ---------------------------------------------------------------------------
// Statements — read straight off the ledger, grouped by the COA's shape.
// ---------------------------------------------------------------------------

interface AccountBalance {
  code: string
  name: string
  kind: string
  normal_side: string
  balance: number
}

async function accountBalances(
  db: PGlite,
  tenantId: string,
  period?: { from?: string; to?: string },
): Promise<AccountBalance[]> {
  const r = await db.query<{
    code: string
    name: string
    kind: string
    normal_side: string
    d: string
    c: string
  }>(
    `select a.code, a.name, a.kind, a.normal_side,
            coalesce(sum(case when jl.side = 'debit' then jl.amount end), 0) as d,
            coalesce(sum(case when jl.side = 'credit' then jl.amount end), 0) as c
     from accounts a
     left join journal_lines jl on jl.account_id = a.id and jl.tenant_id = a.tenant_id
     left join journal_entries je on je.id = jl.entry_id
     where a.tenant_id = $1
       and (jl.id is null or (
         (cast($2 as date) is null or je.entry_date >= $2)
         and (cast($3 as date) is null or je.entry_date <= $3)))
     group by a.code, a.name, a.kind, a.normal_side
     order by a.code`,
    [tenantId, period?.from ?? null, period?.to ?? null],
  )
  return r.rows.map((row) => ({
    code: row.code,
    name: row.name,
    kind: row.kind,
    normal_side: row.normal_side,
    balance:
      row.normal_side === 'debit' ? round2(num(row.d) - num(row.c)) : round2(num(row.c) - num(row.d)),
  }))
}

// The income statement respects the period; the balance sheet is always
// cumulative through `to` (a balance sheet has no "from"), with net income
// measured inception-to-date so it balances by construction.
export async function financials(db: PGlite, tenantId: string, period?: { from?: string; to?: string }) {
  const balances = await accountBalances(db, tenantId, period)
  const line = (a: AccountBalance) => ({ code: a.code, name: a.name, amount: a.balance })

  const revenue = balances.filter((a) => a.kind === 'revenue')
  const cogs = balances.filter((a) => a.code === '5110')
  const opex = balances.filter((a) => a.kind === 'expense' && a.code !== '5110')
  const revenueTotal = round2(revenue.reduce((s, a) => s + a.balance, 0))
  const cogsTotal = round2(cogs.reduce((s, a) => s + a.balance, 0))
  const grossProfit = round2(revenueTotal - cogsTotal)
  // Credit-normal expense accounts (labor absorbed) carry positive balances that
  // REDUCE expense — present them signed so the math shows on the page.
  const opexLines = opex.map((a) => ({
    code: a.code,
    name: a.name,
    amount: a.normal_side === 'credit' ? round2(-a.balance) : a.balance,
  }))
  const opexTotal = round2(opexLines.reduce((s, a) => s + a.amount, 0))
  const netIncome = round2(grossProfit - opexTotal)

  const bsBalances = period?.from
    ? await accountBalances(db, tenantId, { to: period?.to })
    : balances
  const bsNet = (kinds: string[]) =>
    round2(
      bsBalances
        .filter((a) => kinds.includes(a.kind))
        .reduce((s, a) => s + (a.normal_side === 'credit' ? a.balance : -a.balance), 0),
    )
  const assets = bsBalances.filter((a) => a.kind === 'asset')
  const liabilities = bsBalances.filter((a) => a.kind === 'liability')
  const equity = bsBalances.filter((a) => a.kind === 'equity')
  const assetsTotal = round2(assets.reduce((s, a) => s + a.balance, 0))
  const liabilitiesTotal = round2(liabilities.reduce((s, a) => s + a.balance, 0))
  const equityTotal = round2(equity.reduce((s, a) => s + a.balance, 0))
  // Inception-to-date net income = revenue − expenses over ALL time through `to`
  // (credit-normal accounts add, debit-normal subtract — contra accounts fall
  // out correctly on both sides).
  const cumulativeNetIncome = round2(bsNet(['revenue', 'expense']))

  return {
    period: { from: period?.from ?? null, to: period?.to ?? null },
    income_statement: {
      revenue: revenue.map(line),
      revenue_total: revenueTotal,
      cogs: cogs.map(line),
      cogs_total: cogsTotal,
      gross_profit: grossProfit,
      operating_expenses: opexLines,
      operating_expenses_total: opexTotal,
      net_income: netIncome,
    },
    balance_sheet: {
      assets: assets.map(line),
      assets_total: assetsTotal,
      liabilities: liabilities.map(line),
      liabilities_total: liabilitiesTotal,
      equity: equity.map(line),
      equity_total: equityTotal,
      net_income: cumulativeNetIncome,
      balanced: Math.abs(assetsTotal - (liabilitiesTotal + equityTotal + cumulativeNetIncome)) < 0.005,
    },
  }
}

// ---------------------------------------------------------------------------
// Close checks — the month-end checklist the system fills in itself.
// ---------------------------------------------------------------------------

export interface CloseCheck {
  label: string
  status: 'ok' | 'info' | 'attention'
  detail: string
}

export async function closeChecks(db: PGlite, tenantId: string): Promise<CloseCheck[]> {
  const checks: CloseCheck[] = []
  const balances = await accountBalances(db, tenantId)
  const bal = (code: string) => balances.find((a) => a.code === code)?.balance ?? 0

  const totals = await db.query<{ d: string; c: string }>(
    `select coalesce(sum(case when side = 'debit' then amount end), 0) as d,
            coalesce(sum(case when side = 'credit' then amount end), 0) as c
     from journal_lines where tenant_id = $1`,
    [tenantId],
  )
  const d = num(totals.rows[0].d)
  const c = num(totals.rows[0].c)
  checks.push({
    label: 'Trial balance',
    status: Math.abs(d - c) < 0.005 ? 'ok' : 'attention',
    detail: `debits ${d.toFixed(2)} = credits ${c.toFixed(2)}`,
  })

  // The thesis check: the ledger's inventory equals operational reality.
  const op = await db.query<{ v: string }>(
    'select coalesce(sum(qty_on_hand * avg_cost), 0) as v from item_costs where tenant_id = $1',
    [tenantId],
  )
  const wip = await db.query<{ v: string }>(
    'select coalesce(sum(accumulated_cost), 0) as v from wip_jobs where tenant_id = $1',
    [tenantId],
  )
  const operational = round2(num(op.rows[0].v) + num(wip.rows[0].v))
  const ledgerInventory = round2(bal('1310') + bal('1330') + bal('1350'))
  checks.push({
    label: 'Ledger ↔ operations reconciliation',
    status: Math.abs(operational - ledgerInventory) < 0.01 ? 'ok' : 'attention',
    detail: `ledger inventory+WIP ${ledgerInventory.toFixed(2)} vs operational ${operational.toFixed(2)} — nothing to reconcile, this is one system`,
  })

  const grni = bal('2110')
  const unbilled = await db.query<{ n: string }>(
    `select count(*) as n from purchase_orders po
     where po.tenant_id = $1 and po.status in ('partially_received', 'received')
       and not exists (select 1 from bills b where b.tenant_id = po.tenant_id and b.po_id = po.id)`,
    [tenantId],
  )
  checks.push({
    label: 'Goods received, not yet billed',
    status: grni > 0.005 ? 'attention' : 'ok',
    detail:
      grni > 0.005
        ? `$${grni.toFixed(2)} across ${unbilled.rows[0].n} received PO(s) awaiting vendor bills`
        : 'all receipts billed',
  })

  const openWip = await db.query<{ work_order: string; accumulated_cost: string }>(
    'select work_order, accumulated_cost from wip_jobs where tenant_id = $1 and accumulated_cost > 0 order by work_order',
    [tenantId],
  )
  checks.push({
    label: 'Open work in process',
    status: openWip.rows.length ? 'info' : 'ok',
    detail: openWip.rows.length
      ? openWip.rows.map((w) => `${w.work_order} $${num(w.accumulated_cost).toFixed(2)}`).join(', ')
      : 'no cost sitting in WIP',
  })

  const openAR = await db.query<{ n: string; total: string; oldest: string | null }>(
    `select count(*) as n, coalesce(sum(amount), 0) as total, min(issued_date)::text as oldest
     from invoices where tenant_id = $1 and status = 'open'`,
    [tenantId],
  )
  const ar = openAR.rows[0]
  checks.push({
    label: 'Open receivables',
    status: Number(ar.n) > 0 ? 'info' : 'ok',
    detail: Number(ar.n) > 0 ? `${ar.n} invoice(s), $${num(ar.total).toFixed(2)}, oldest ${ar.oldest}` : 'nothing outstanding',
  })

  const openAP = await db.query<{ n: string; total: string; oldest: string | null }>(
    `select count(*) as n, coalesce(sum(amount), 0) as total, min(bill_date)::text as oldest
     from bills where tenant_id = $1 and status = 'open'`,
    [tenantId],
  )
  const ap = openAP.rows[0]
  checks.push({
    label: 'Open payables',
    status: Number(ap.n) > 0 ? 'info' : 'ok',
    detail: Number(ap.n) > 0 ? `${ap.n} bill(s), $${num(ap.total).toFixed(2)}, oldest ${ap.oldest}` : 'nothing outstanding',
  })

  return checks
}
