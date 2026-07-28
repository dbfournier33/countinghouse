// Onboarding importers (architecture sketch §8): paste the spreadsheet the
// shop already runs on; we propose a column mapping with confidence and show
// our work; the human confirms; the commit writes real entities and events
// through the same spine as the UI. Analyze never writes. Re-runs are safe:
// existing records are skipped and reported.
//
// The mapper is deliberately a deterministic heuristic engine (header synonyms
// + content inference) behind a clean suggestMapping() seam — an LLM call can
// slot into the same interface later for the ambiguous tail.
import type { PGlite } from '@electric-sql/pglite'
import type { Transaction } from '@electric-sql/pglite'
import { nextNumber } from './documents.js'
import { ingestTx, KernelError } from './events.js'
import { num, round2, round4 } from './money.js'

// ---------------------------------------------------------------------------
// CSV parsing — quotes, commas-in-quotes, blank lines, BOM
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()))
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()))
  return rows
}

const numeric = (s: string): number | null => {
  const cleaned = s.replaceAll(/[$,\s]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Field specs & header synonyms
// ---------------------------------------------------------------------------

export type ImportKind = 'items' | 'parties' | 'bom' | 'open_invoices' | 'open_bills'

// Accept the date shapes migration exports actually contain.
function parseDate(s: string): string | null {
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const us = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return null
}

interface FieldSpec {
  field: string
  required: boolean
  synonyms: string[]
  content?: (values: string[]) => number // 0..1 score from sample values
}

const norm = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]/g, '')

const mostlyNumeric = (values: string[]) => {
  const filled = values.filter((v) => v !== '')
  if (!filled.length) return 0
  return filled.filter((v) => numeric(v) !== null).length / filled.length
}
const mostlyText = (values: string[]) => 1 - mostlyNumeric(values)
const looksLikeCode = (values: string[]) => {
  const filled = values.filter((v) => v !== '')
  if (!filled.length) return 0
  const codeish = filled.filter((v) => /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,19}$/.test(v) && !v.includes(' ')).length
  const unique = new Set(filled.map((v) => v.toLowerCase())).size / filled.length
  return (codeish / filled.length) * unique
}

const FIELDS: Record<ImportKind, FieldSpec[]> = {
  items: [
    { field: 'sku', required: true, synonyms: ['sku', 'item', 'itemno', 'itemnumber', 'part', 'partno', 'partnumber', 'code', 'itemcode', 'productcode', 'id'], content: looksLikeCode },
    { field: 'name', required: true, synonyms: ['name', 'description', 'desc', 'itemname', 'itemdescription', 'product', 'productname', 'title'], content: mostlyText },
    { field: 'kind', required: false, synonyms: ['kind', 'type', 'itemtype', 'category'] },
    { field: 'uom', required: false, synonyms: ['uom', 'unit', 'units', 'unitofmeasure', 'measure'] },
    { field: 'qty_on_hand', required: false, synonyms: ['qty', 'quantity', 'onhand', 'qoh', 'stock', 'qtyonhand', 'currentstock', 'inventory', 'instock'], content: mostlyNumeric },
    { field: 'unit_cost', required: false, synonyms: ['cost', 'unitcost', 'stdcost', 'standardcost', 'avgcost', 'averagecost', 'costea', 'costperunit'], content: mostlyNumeric },
    { field: 'reorder_point', required: false, synonyms: ['reorder', 'reorderpoint', 'reorderlevel', 'min', 'minimum', 'minstock', 'minqty', 'par', 'parlevel'] },
  ],
  parties: [
    { field: 'name', required: true, synonyms: ['name', 'company', 'companyname', 'business', 'vendor', 'customer', 'supplier', 'account'], content: mostlyText },
    { field: 'roles', required: false, synonyms: ['role', 'roles', 'type', 'relationship'] },
  ],
  bom: [
    { field: 'parent_sku', required: true, synonyms: ['parent', 'parentsku', 'assembly', 'assemblysku', 'finished', 'finishedgood', 'product', 'makes', 'output'], content: looksLikeCode },
    { field: 'component_sku', required: true, synonyms: ['component', 'componentsku', 'material', 'rawmaterial', 'ingredient', 'input', 'part', 'partno'], content: looksLikeCode },
    { field: 'qty_per', required: true, synonyms: ['qtyper', 'quantityper', 'qty', 'quantity', 'usage', 'perunit', 'amount', 'qtyperunit'], content: mostlyNumeric },
  ],
  // Migration kit: QB/spreadsheet exports of what's outstanding on switch day.
  // Auto-detect needs an explicit customer/vendor header; generic files work
  // via the manual kind + mapping override.
  open_invoices: [
    { field: 'customer', required: true, synonyms: ['customer', 'client', 'billto', 'customername', 'account'] },
    { field: 'amount', required: true, synonyms: ['amount', 'balance', 'open', 'openbalance', 'amountdue', 'due', 'total', 'outstanding'], content: mostlyNumeric },
    { field: 'number', required: false, synonyms: ['invoice', 'invoiceno', 'invoicenumber', 'number', 'ref', 'no', 'num'] },
    { field: 'date', required: false, synonyms: ['date', 'invoicedate', 'issued', 'issuedate', 'txndate'] },
  ],
  open_bills: [
    { field: 'vendor', required: true, synonyms: ['vendor', 'supplier', 'payee', 'vendorname'] },
    { field: 'amount', required: true, synonyms: ['amount', 'balance', 'open', 'openbalance', 'amountdue', 'due', 'total', 'outstanding'], content: mostlyNumeric },
    { field: 'number', required: false, synonyms: ['bill', 'billno', 'billnumber', 'invoice', 'invoiceno', 'number', 'ref', 'no', 'num'] },
    { field: 'date', required: false, synonyms: ['date', 'billdate', 'duedate', 'txndate'] },
  ],
}

export interface MappedField {
  column: number | null
  header: string | null
  confidence: number
  reason: string
}

export function suggestMapping(
  kind: ImportKind,
  headers: string[],
  sampleRows: string[][],
): Record<string, MappedField> {
  const normedHeaders = headers.map(norm)
  const columnValues = headers.map((_, c) => sampleRows.map((r) => r[c] ?? ''))
  const taken = new Set<number>()
  const mapping: Record<string, MappedField> = {}

  // Header pass first (strongest signal), field order = spec order.
  for (const spec of FIELDS[kind]) {
    let best: MappedField = { column: null, header: null, confidence: 0, reason: 'no match' }
    for (let c = 0; c < headers.length; c++) {
      if (taken.has(c)) continue
      const h = normedHeaders[c]
      let confidence = 0
      let reason = ''
      if (h === norm(spec.field)) {
        confidence = 0.98
        reason = 'exact header match'
      } else if (spec.synonyms.includes(h)) {
        confidence = 0.9
        reason = `header "${headers[c]}" is a known synonym`
      } else if (spec.synonyms.some((s) => h.includes(s) && s.length >= 3)) {
        confidence = 0.75
        reason = `header "${headers[c]}" contains a known synonym`
      }
      if (confidence > best.confidence) best = { column: c, header: headers[c], confidence, reason }
    }
    // Content inference fallback for required fields with no header signal.
    if (best.confidence < 0.5 && spec.content) {
      for (let c = 0; c < headers.length; c++) {
        if (taken.has(c)) continue
        const score = spec.content(columnValues[c]) * 0.6
        if (score > best.confidence && score >= 0.35)
          best = { column: c, header: headers[c], confidence: round2(score), reason: 'inferred from column contents' }
      }
    }
    if (best.column !== null) taken.add(best.column)
    mapping[spec.field] = best
  }
  return mapping
}

export function detectKind(headers: string[], sampleRows: string[][]): { kind: ImportKind; scores: Record<ImportKind, number> } {
  const scores = {} as Record<ImportKind, number>
  for (const kind of ['items', 'parties', 'bom', 'open_invoices', 'open_bills'] as ImportKind[]) {
    const mapping = suggestMapping(kind, headers, sampleRows)
    const specs = FIELDS[kind]
    const required = specs.filter((s) => s.required)
    const requiredScore =
      required.reduce((s, spec) => s + (mapping[spec.field].confidence > 0.4 ? mapping[spec.field].confidence : 0), 0) /
      required.length
    const optional = specs.filter((s) => !s.required)
    const optionalScore = optional.length
      ? optional.reduce((s, spec) => s + (mapping[spec.field].confidence > 0.4 ? 1 : 0), 0) / optional.length
      : 0
    scores[kind] = round2(requiredScore * 0.8 + optionalScore * 0.2)
  }
  // Prefer the most specific interpretations on ties; parties is the
  // weakest-structured and goes last.
  const order: ImportKind[] = ['bom', 'open_invoices', 'open_bills', 'items', 'parties']
  const kind = order.reduce((best, k) => (scores[k] > scores[best] + 0.001 ? k : best), 'items' as ImportKind)
  return { kind, scores }
}

// ---------------------------------------------------------------------------
// Analyze — pure: parse, map, coerce, validate. No writes.
// ---------------------------------------------------------------------------

const KIND_ALIASES: Record<string, string> = {
  raw: 'raw', rawmaterial: 'raw', material: 'raw', rm: 'raw', ingredient: 'raw',
  finished: 'finished', finishedgood: 'finished', finishedgoods: 'finished', fg: 'finished', product: 'finished',
  subassembly: 'subassembly', sub: 'subassembly', assembly: 'subassembly', wip: 'subassembly',
  service: 'service',
}
const ROLE_ALIASES: Record<string, string> = {
  vendor: 'vendor', supplier: 'vendor', seller: 'vendor',
  customer: 'customer', client: 'customer', buyer: 'customer', account: 'customer',
  employee: 'employee', staff: 'employee', worker: 'employee',
}

// "Wholesale customer", "Preferred supplier" etc. — substring rescue after
// the exact alias table misses.
function roleOf(raw: string): string | null {
  const n = norm(raw)
  if (!n) return null
  if (ROLE_ALIASES[n]) return ROLE_ALIASES[n]
  if (n.includes('customer') || n.includes('client')) return 'customer'
  if (n.includes('vendor') || n.includes('supplier')) return 'vendor'
  if (n.includes('employee') || n.includes('staff')) return 'employee'
  return null
}

export interface ImportIssue {
  row: number // 1-based data row (excluding header)
  severity: 'skip' | 'warning'
  message: string
}

export interface AnalyzeResult {
  kind: ImportKind
  kind_scores: Record<ImportKind, number>
  headers: string[]
  mapping: Record<string, MappedField>
  rows: Array<Record<string, unknown>>
  issues: ImportIssue[]
  ready: number
  total: number
}

export async function analyze(
  db: PGlite,
  tenantId: string,
  csv: string,
  requestedKind?: ImportKind,
  mappingOverride?: Record<string, number | null>,
): Promise<AnalyzeResult> {
  const grid = parseCsv(csv)
  if (grid.length < 2) throw new KernelError('need a header row plus at least one data row')
  const headers = grid[0]
  const dataRows = grid.slice(1)
  const sample = dataRows.slice(0, 25)

  const detected = detectKind(headers, sample)
  const kind = requestedKind ?? detected.kind
  const mapping = suggestMapping(kind, headers, sample)
  if (mappingOverride) {
    for (const [field, column] of Object.entries(mappingOverride)) {
      if (!(field in mapping)) continue
      mapping[field] =
        column === null
          ? { column: null, header: null, confidence: 0, reason: 'unmapped by user' }
          : { column, header: headers[column] ?? `col ${column}`, confidence: 1, reason: 'set by user' }
    }
  }

  const existingSkus = new Set(
    (await db.query<{ sku: string }>('select sku from items where tenant_id = $1', [tenantId])).rows.map((r) =>
      r.sku.toLowerCase(),
    ),
  )
  const existingParties = new Set(
    (await db.query<{ name: string }>('select name from parties where tenant_id = $1', [tenantId])).rows.map((r) =>
      r.name.toLowerCase(),
    ),
  )
  const existingInvoiceNos = new Set(
    (await db.query<{ number: string }>('select number from invoices where tenant_id = $1', [tenantId])).rows.map(
      (r) => r.number.toLowerCase(),
    ),
  )
  const existingBillNos = new Set(
    (await db.query<{ number: string }>('select number from bills where tenant_id = $1', [tenantId])).rows.map((r) =>
      r.number.toLowerCase(),
    ),
  )

  const get = (row: string[], field: string): string => {
    const col = mapping[field]?.column
    return col === null || col === undefined ? '' : (row[col] ?? '')
  }

  const issues: ImportIssue[] = []
  const rows: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  dataRows.forEach((row, i) => {
    const rowNo = i + 1
    if (kind === 'items') {
      const sku = get(row, 'sku')
      const name = get(row, 'name') || sku
      if (!sku) {
        issues.push({ row: rowNo, severity: 'skip', message: 'missing SKU' })
        return
      }
      if (seen.has(sku.toLowerCase())) {
        issues.push({ row: rowNo, severity: 'skip', message: `duplicate SKU "${sku}" in file` })
        return
      }
      seen.add(sku.toLowerCase())
      const exists = existingSkus.has(sku.toLowerCase())
      if (exists) issues.push({ row: rowNo, severity: 'skip', message: `SKU "${sku}" already exists — will skip` })
      const rawKind = norm(get(row, 'kind'))
      let itemKind = KIND_ALIASES[rawKind]
      if (get(row, 'kind') && !itemKind) {
        issues.push({ row: rowNo, severity: 'warning', message: `unrecognized type "${get(row, 'kind')}" — defaulting to raw` })
      }
      itemKind ??= 'raw'
      const qty = numeric(get(row, 'qty_on_hand'))
      const cost = numeric(get(row, 'unit_cost'))
      if (get(row, 'qty_on_hand') && qty === null)
        issues.push({ row: rowNo, severity: 'warning', message: `unreadable quantity "${get(row, 'qty_on_hand')}" — treating as 0` })
      if (qty !== null && qty < 0) issues.push({ row: rowNo, severity: 'warning', message: 'negative on-hand — treating as 0' })
      if (qty && qty > 0 && (cost === null || cost < 0))
        issues.push({ row: rowNo, severity: 'warning', message: 'on-hand qty without a readable cost — opening stock will post at $0' })
      rows.push({
        _row: rowNo,
        _skip: exists,
        sku, name, kind: itemKind,
        uom: get(row, 'uom') || 'ea',
        qty_on_hand: qty && qty > 0 ? round4(qty) : 0,
        unit_cost: cost && cost > 0 ? round4(cost) : 0,
        reorder_point: Math.max(numeric(get(row, 'reorder_point')) ?? 0, 0),
      })
    } else if (kind === 'parties') {
      const name = get(row, 'name')
      if (!name) {
        issues.push({ row: rowNo, severity: 'skip', message: 'missing name' })
        return
      }
      if (seen.has(name.toLowerCase())) {
        issues.push({ row: rowNo, severity: 'skip', message: `duplicate "${name}" in file` })
        return
      }
      seen.add(name.toLowerCase())
      const exists = existingParties.has(name.toLowerCase())
      if (exists) issues.push({ row: rowNo, severity: 'skip', message: `"${name}" already exists — will skip` })
      const roles = get(row, 'roles')
        .split(/[,;/|]/)
        .map((r) => roleOf(r))
        .filter((r): r is string => r !== null)
      if (get(row, 'roles') && roles.length === 0)
        issues.push({ row: rowNo, severity: 'warning', message: `unrecognized role "${get(row, 'roles')}" — defaulting to vendor` })
      rows.push({ _row: rowNo, _skip: exists, name, roles: roles.length ? [...new Set(roles)] : ['vendor'] })
    } else if (kind === 'open_invoices' || kind === 'open_bills') {
      const isAR = kind === 'open_invoices'
      const party = get(row, isAR ? 'customer' : 'vendor')
      const amount = numeric(get(row, 'amount'))
      const number = get(row, 'number') || null
      const rawDate = get(row, 'date')
      const date = rawDate ? parseDate(rawDate) : null
      if (!party) {
        issues.push({ row: rowNo, severity: 'skip', message: `missing ${isAR ? 'customer' : 'vendor'}` })
        return
      }
      if (amount === null || amount <= 0) {
        issues.push({ row: rowNo, severity: 'skip', message: `unreadable or non-positive amount "${get(row, 'amount')}"` })
        return
      }
      if (number) {
        const key = number.toLowerCase()
        if (seen.has(key)) {
          issues.push({ row: rowNo, severity: 'skip', message: `duplicate number "${number}" in file` })
          return
        }
        seen.add(key)
        const exists = isAR ? existingInvoiceNos.has(key) : existingBillNos.has(key)
        if (exists) {
          issues.push({ row: rowNo, severity: 'skip', message: `"${number}" already exists — will skip` })
          rows.push({ _row: rowNo, _skip: true, [isAR ? 'customer' : 'vendor']: party, number, amount: round2(amount), date })
          return
        }
      }
      if (!existingParties.has(party.toLowerCase()))
        issues.push({ row: rowNo, severity: 'warning', message: `new ${isAR ? 'customer' : 'vendor'} "${party}" will be created` })
      if (rawDate && !date)
        issues.push({ row: rowNo, severity: 'warning', message: `unreadable date "${rawDate}" — using today` })
      rows.push({
        _row: rowNo, _skip: false,
        [isAR ? 'customer' : 'vendor']: party,
        number, amount: round2(amount), date,
      })
    } else {
      const parent = get(row, 'parent_sku')
      const component = get(row, 'component_sku')
      const qtyPer = numeric(get(row, 'qty_per'))
      if (!parent || !component) {
        issues.push({ row: rowNo, severity: 'skip', message: 'missing parent or component SKU' })
        return
      }
      let skip = false
      if (!existingSkus.has(parent.toLowerCase())) {
        issues.push({ row: rowNo, severity: 'skip', message: `unknown parent SKU "${parent}" — import items first` })
        skip = true
      }
      if (!existingSkus.has(component.toLowerCase())) {
        issues.push({ row: rowNo, severity: 'skip', message: `unknown component SKU "${component}" — import items first` })
        skip = true
      }
      if (qtyPer === null || qtyPer <= 0) {
        issues.push({ row: rowNo, severity: 'skip', message: `qty per unit must be a positive number (got "${get(row, 'qty_per')}")` })
        skip = true
      }
      if (skip) return
      rows.push({ _row: rowNo, _skip: false, parent_sku: parent, component_sku: component, qty_per: qtyPer })
    }
  })

  return {
    kind,
    kind_scores: detected.scores,
    headers,
    mapping,
    rows,
    issues,
    ready: rows.filter((r) => !r._skip).length,
    total: dataRows.length,
  }
}

// ---------------------------------------------------------------------------
// Commit — the human-confirmed step. One transaction; same spine as the UI.
// ---------------------------------------------------------------------------

export interface CommitResult {
  kind: ImportKind
  created: number
  skipped: number
  opening_stock_value: number
  opening_stock_events: number
  opening_ar_total: number
  opening_ap_total: number
  bom_parents: number
  issues: ImportIssue[]
}

// Find-or-create a party with the given role (case-insensitive on name).
async function ensureParty(tx: Transaction, tenantId: string, name: string, role: string): Promise<string> {
  const existing = await tx.query<{ id: string; roles: string[] }>(
    'select id, roles from parties where tenant_id = $1 and lower(name) = lower($2)',
    [tenantId, name],
  )
  if (existing.rows[0]) {
    if (!existing.rows[0].roles.includes(role)) {
      await tx.query('update parties set roles = array_append(roles, $3) where tenant_id = $1 and id = $2', [
        tenantId, existing.rows[0].id, role,
      ])
    }
    return existing.rows[0].id
  }
  const created = await tx.query<{ id: string }>(
    'insert into parties (tenant_id, name, roles) values ($1, $2, array[$3]) returning id',
    [tenantId, name, role],
  )
  return created.rows[0].id
}

export async function commit(
  db: PGlite,
  tenantId: string,
  csv: string,
  kind: ImportKind,
  mappingOverride?: Record<string, number | null>,
  options?: { post_opening_stock?: boolean },
): Promise<CommitResult> {
  const a = await analyze(db, tenantId, csv, kind, mappingOverride)
  const postStock = options?.post_opening_stock ?? true

  return db.transaction(async (tx) => {
    let created = 0
    let skipped = 0
    let openingValue = 0
    let openingEvents = 0
    let openingAR = 0
    let openingAP = 0
    let bomParents = 0

    if (a.kind === 'open_invoices') {
      for (const r of a.rows) {
        if (r._skip) {
          skipped++
          continue
        }
        const customerId = await ensureParty(tx, tenantId, r.customer as string, 'customer')
        const number = (r.number as string | null) ?? (await nextNumber(tx, tenantId, 'INV'))
        const date = (r.date as string | null) ?? null
        await ingestTx(tx, tenantId, {
          type: 'OpeningReceivableSet',
          payload: { amount: num(r.amount), customer: r.customer as string, ref: number },
          occurred_at: date ? `${date}T12:00:00.000Z` : undefined,
        })
        await tx.query(
          `insert into invoices (tenant_id, number, customer_id, amount, issued_date)
           values ($1, $2, $3, $4, coalesce($5::date, current_date))`,
          [tenantId, number, customerId, num(r.amount), date],
        )
        openingAR = round2(openingAR + num(r.amount))
        created++
      }
    } else if (a.kind === 'open_bills') {
      for (const r of a.rows) {
        if (r._skip) {
          skipped++
          continue
        }
        const vendorId = await ensureParty(tx, tenantId, r.vendor as string, 'vendor')
        const number = (r.number as string | null) ?? (await nextNumber(tx, tenantId, 'BILL'))
        const date = (r.date as string | null) ?? null
        await ingestTx(tx, tenantId, {
          type: 'OpeningPayableSet',
          payload: { amount: num(r.amount), vendor: r.vendor as string, ref: number },
          occurred_at: date ? `${date}T12:00:00.000Z` : undefined,
        })
        await tx.query(
          `insert into bills (tenant_id, number, vendor_id, kind, amount, bill_date)
           values ($1, $2, $3, 'opening', $4, coalesce($5::date, current_date))`,
          [tenantId, number, vendorId, num(r.amount), date],
        )
        openingAP = round2(openingAP + num(r.amount))
        created++
      }
    } else if (a.kind === 'items') {
      for (const r of a.rows) {
        if (r._skip) {
          skipped++
          continue
        }
        await tx.query(
          `insert into items (tenant_id, sku, name, kind, uom, reorder_point)
           values ($1, $2, $3, $4, $5, $6)`,
          [tenantId, r.sku, r.name, r.kind, r.uom, r.reorder_point],
        )
        created++
        const qty = num(r.qty_on_hand)
        if (postStock && qty > 0) {
          const result = await ingestTx(tx, tenantId, {
            type: 'OpeningStockSet',
            payload: { sku: r.sku as string, qty, unit_cost: num(r.unit_cost) },
          })
          openingEvents++
          openingValue = round2(openingValue + (result.moves[0]?.value ?? 0))
        }
      }
    } else if (a.kind === 'parties') {
      for (const r of a.rows) {
        if (r._skip) {
          skipped++
          continue
        }
        await tx.query('insert into parties (tenant_id, name, roles) values ($1, $2, $3)', [
          tenantId, r.name, r.roles,
        ])
        created++
      }
    } else {
      const byParent = new Map<string, Array<{ component_sku: string; qty_per: number }>>()
      for (const r of a.rows) {
        const list = byParent.get(r.parent_sku as string) ?? []
        list.push({ component_sku: r.component_sku as string, qty_per: num(r.qty_per) })
        byParent.set(r.parent_sku as string, list)
      }
      for (const [parent, lines] of byParent) {
        const p = await tx.query<{ id: string }>(
          'select id from items where tenant_id = $1 and lower(sku) = lower($2)', [tenantId, parent])
        await tx.query('delete from bom_lines where tenant_id = $1 and parent_item_id = $2', [
          tenantId, p.rows[0].id,
        ])
        const dedup = new Map<string, number>()
        for (const l of lines) dedup.set(l.component_sku.toLowerCase(), l.qty_per)
        for (const [componentSku, qtyPer] of dedup) {
          const comp = await tx.query<{ id: string }>(
            'select id from items where tenant_id = $1 and lower(sku) = lower($2)', [tenantId, componentSku])
          await tx.query(
            `insert into bom_lines (tenant_id, parent_item_id, component_item_id, qty_per)
             values ($1, $2, $3, $4)`,
            [tenantId, p.rows[0].id, comp.rows[0].id, qtyPer],
          )
          created++
        }
        bomParents++
      }
    }

    return {
      kind: a.kind,
      created,
      skipped,
      opening_stock_value: openingValue,
      opening_stock_events: openingEvents,
      opening_ar_total: openingAR,
      opening_ap_total: openingAP,
      bom_parents: bomParents,
      issues: a.issues,
    }
  })
}
