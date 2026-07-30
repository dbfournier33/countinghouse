// Posting rules: event type → journal lines. Seeded into posting_rules as data
// (versioned); the engine reads them from the database, not from this file.
// Amount sources are resolved by the ingest pipeline:
//   move_value     — value of the inventory move produced by the event
//   payload_amount — payload.amount (pure financial events)
//   labor_value    — hours × loaded_rate
//   wip_drain      — the accumulated cost drained from the work order
// For AdjustmentMade the rule is written for the positive (found stock) case;
// the engine flips debit/credit when qty_delta is negative.

export type AmountSource =
  | 'move_value'
  | 'payload_amount'
  | 'labor_value'
  | 'wip_drain'
  | 'settlement_gross'
  | 'settlement_refunds'
  | 'settlement_fees'
  | 'settlement_taxes'
  | 'settlement_payout'

export interface RuleLine {
  account: string // account code, or '@inventory' (resolved from item kind)
  side: 'debit' | 'credit'
  source: AmountSource
}

export const POSTING_RULES: Record<string, RuleLine[]> = {
  GoodsReceived: [
    { account: '@inventory', side: 'debit', source: 'move_value' },
    { account: '2110', side: 'credit', source: 'move_value' },
  ],
  OpeningStockSet: [
    { account: '@inventory', side: 'debit', source: 'move_value' },
    { account: '3900', side: 'credit', source: 'move_value' },
  ],
  BillPosted: [
    { account: '2110', side: 'debit', source: 'payload_amount' },
    { account: '2100', side: 'credit', source: 'payload_amount' },
  ],
  ExpenseBillPosted: [
    { account: '6100', side: 'debit', source: 'payload_amount' },
    { account: '2100', side: 'credit', source: 'payload_amount' },
  ],
  PaymentMade: [
    { account: '2100', side: 'debit', source: 'payload_amount' },
    { account: '1110', side: 'credit', source: 'payload_amount' },
  ],
  MaterialIssued: [
    { account: '1330', side: 'debit', source: 'move_value' },
    { account: '@inventory', side: 'credit', source: 'move_value' },
  ],
  TimeLogged: [
    { account: '1330', side: 'debit', source: 'labor_value' },
    { account: '5290', side: 'credit', source: 'labor_value' },
  ],
  ProductionCompleted: [
    { account: '@inventory', side: 'debit', source: 'wip_drain' },
    { account: '1330', side: 'credit', source: 'wip_drain' },
  ],
  GoodsShipped: [
    { account: '5110', side: 'debit', source: 'move_value' },
    { account: '@inventory', side: 'credit', source: 'move_value' },
  ],
  InvoiceIssued: [
    { account: '1200', side: 'debit', source: 'payload_amount' },
    { account: '4100', side: 'credit', source: 'payload_amount' },
  ],
  PaymentReceived: [
    { account: '1110', side: 'debit', source: 'payload_amount' },
    { account: '1200', side: 'credit', source: 'payload_amount' },
  ],
  AdjustmentMade: [
    { account: '@inventory', side: 'debit', source: 'move_value' },
    { account: '5150', side: 'credit', source: 'move_value' },
  ],
  // One payout period, one entry: cash in, fees and refunds recognized, gross
  // revenue credited, collected sales tax parked as a liability (never
  // revenue). Zero-amount lines are dropped by the engine.
  ChannelSettlement: [
    { account: '1110', side: 'debit', source: 'settlement_payout' },
    { account: '6200', side: 'debit', source: 'settlement_fees' },
    { account: '4190', side: 'debit', source: 'settlement_refunds' },
    { account: '4150', side: 'credit', source: 'settlement_gross' },
    { account: '2250', side: 'credit', source: 'settlement_taxes' },
  ],
  OpeningCashSet: [
    { account: '1110', side: 'debit', source: 'payload_amount' },
    { account: '3900', side: 'credit', source: 'payload_amount' },
  ],
  OpeningReceivableSet: [
    { account: '1200', side: 'debit', source: 'payload_amount' },
    { account: '3900', side: 'credit', source: 'payload_amount' },
  ],
  OpeningPayableSet: [
    { account: '3900', side: 'debit', source: 'payload_amount' },
    { account: '2100', side: 'credit', source: 'payload_amount' },
  ],
}
