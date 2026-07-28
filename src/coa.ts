// The segment chart-of-accounts template. Opinionated: customers add leaf
// accounts under these; they do not design a chart from scratch.
export interface CoaAccount {
  code: string
  name: string
  kind: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  normal: 'debit' | 'credit'
  qb: string // default QuickBooks account this one summarizes into (editable)
}

export const COA: CoaAccount[] = [
  { code: '1110', name: 'Cash', kind: 'asset', normal: 'debit', qb: 'Checking' },
  { code: '1200', name: 'Accounts receivable', kind: 'asset', normal: 'debit', qb: 'Accounts Receivable (A/R)' },
  { code: '1310', name: 'Inventory — raw materials', kind: 'asset', normal: 'debit', qb: 'Inventory Asset' },
  { code: '1330', name: 'Work in process', kind: 'asset', normal: 'debit', qb: 'Inventory Asset' },
  { code: '1350', name: 'Inventory — finished goods', kind: 'asset', normal: 'debit', qb: 'Inventory Asset' },
  { code: '2100', name: 'Accounts payable', kind: 'liability', normal: 'credit', qb: 'Accounts Payable (A/P)' },
  { code: '2110', name: 'Goods received, not invoiced', kind: 'liability', normal: 'credit', qb: 'Accrued Liabilities' },
  { code: '3100', name: "Owner's equity", kind: 'equity', normal: 'credit', qb: "Owner's Equity" },
  { code: '4100', name: 'Revenue — product sales', kind: 'revenue', normal: 'credit', qb: 'Sales of Product Income' },
  { code: '5110', name: 'Cost of goods sold', kind: 'expense', normal: 'debit', qb: 'Cost of Goods Sold' },
  { code: '5150', name: 'Inventory shrinkage & adjustments', kind: 'expense', normal: 'debit', qb: 'Inventory Shrinkage' },
  // Absorbed labor offsets the wages the customer pays through their payroll
  // provider — in QB-land that credit belongs against Payroll Expenses.
  { code: '5290', name: 'Direct labor absorbed', kind: 'expense', normal: 'credit', qb: 'Payroll Expenses' },
  { code: '6100', name: 'Operating expenses', kind: 'expense', normal: 'debit', qb: 'Operating Expenses' },
]

// '@inventory' resolves to 1310 or 1350 from the item's kind at posting time.
export const INVENTORY_ACCOUNT_SENTINEL = '@inventory'

export function inventoryAccountFor(itemKind: string): string {
  return itemKind === 'finished' ? '1350' : '1310'
}
