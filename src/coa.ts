// The segment chart-of-accounts template. Opinionated: customers add leaf
// accounts under these; they do not design a chart from scratch.
export interface CoaAccount {
  code: string
  name: string
  kind: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  normal: 'debit' | 'credit'
}

export const COA: CoaAccount[] = [
  { code: '1110', name: 'Cash', kind: 'asset', normal: 'debit' },
  { code: '1200', name: 'Accounts receivable', kind: 'asset', normal: 'debit' },
  { code: '1310', name: 'Inventory — raw materials', kind: 'asset', normal: 'debit' },
  { code: '1330', name: 'Work in process', kind: 'asset', normal: 'debit' },
  { code: '1350', name: 'Inventory — finished goods', kind: 'asset', normal: 'debit' },
  { code: '2100', name: 'Accounts payable', kind: 'liability', normal: 'credit' },
  { code: '2110', name: 'Goods received, not invoiced', kind: 'liability', normal: 'credit' },
  { code: '3100', name: "Owner's equity", kind: 'equity', normal: 'credit' },
  { code: '4100', name: 'Revenue — product sales', kind: 'revenue', normal: 'credit' },
  { code: '5110', name: 'Cost of goods sold', kind: 'expense', normal: 'debit' },
  { code: '5150', name: 'Inventory shrinkage & adjustments', kind: 'expense', normal: 'debit' },
  { code: '5290', name: 'Direct labor absorbed', kind: 'expense', normal: 'credit' },
  { code: '6100', name: 'Operating expenses', kind: 'expense', normal: 'debit' },
]

// '@inventory' resolves to 1310 or 1350 from the item's kind at posting time.
export const INVENTORY_ACCOUNT_SENTINEL = '@inventory'

export function inventoryAccountFor(itemKind: string): string {
  return itemKind === 'finished' ? '1350' : '1310'
}
