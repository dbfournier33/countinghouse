-- Simple ERP kernel schema (Postgres dialect; runs identically on PGlite in dev).
-- Spine: documents will come in Phase 1 — the kernel is events → moves + ledger.

create table if not exists tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  token      text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists parties (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  name       text not null,
  roles      text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists locations (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code      text not null,
  name      text not null,
  kind      text not null check (kind in ('warehouse', 'work_center')),
  unique (tenant_id, code)
);

create table if not exists items (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  sku        text not null,
  name       text not null,
  kind       text not null check (kind in ('raw', 'subassembly', 'finished', 'service')),
  uom        text not null default 'ea',
  created_at timestamptz not null default now(),
  unique (tenant_id, sku)
);

create table if not exists accounts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  kind        text not null check (kind in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_side text not null check (normal_side in ('debit', 'credit')),
  unique (tenant_id, code)
);

-- QuickBooks bridge: which QB account each of ours summarizes into.
-- Many-to-one is expected (our 1310/1330/1350 all roll into "Inventory Asset").
alter table accounts add column if not exists qb_account text;

-- The append-only operational event log. Corrections are new (reversing) events.
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  seq         bigint generated always as identity,
  type        text not null,
  occurred_at timestamptz not null default now(),
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

create or replace function forbid_event_mutation() returns trigger as $$
begin
  raise exception 'events are append-only; corrections are new (reversing) events';
end;
$$ language plpgsql;

drop trigger if exists events_immutable on events;
create trigger events_immutable
  before update or delete on events
  for each row execute function forbid_event_mutation();

-- Costed inventory movements, derived from events. Immutable by the same logic
-- (only ever written inside the event-ingest transaction).
create table if not exists inventory_moves (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  event_id      uuid not null references events(id),
  item_id       uuid not null references items(id),
  direction     text not null check (direction in ('in', 'out')),
  qty           numeric(18,4) not null check (qty > 0),
  unit_cost     numeric(18,6) not null,
  value         numeric(18,2) not null,
  location_code text not null default 'MAIN',
  created_at    timestamptz not null default now()
);

-- Moving-average cost projection, per item per location.
create table if not exists item_costs (
  tenant_id     uuid not null references tenants(id),
  item_id       uuid not null references items(id),
  location_code text not null default 'MAIN',
  qty_on_hand   numeric(18,4) not null default 0,
  avg_cost      numeric(18,6) not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, item_id, location_code)
);

-- Kernel-level WIP cost accumulation per work-order reference.
-- Real WorkOrder documents arrive in Phase 1; the cost flow is real today.
create table if not exists wip_jobs (
  tenant_id        uuid not null references tenants(id),
  work_order       text not null,
  accumulated_cost numeric(18,2) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, work_order)
);

-- Posting rules are data: versioned, seeded, readable in the UI.
create table if not exists posting_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  event_type text not null,
  version    int not null default 1,
  lines      jsonb not null,
  unique (tenant_id, event_type, version)
);

create table if not exists journal_entries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  event_id   uuid not null references events(id) unique,
  entry_date date not null default current_date,
  memo       text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists journal_lines (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  entry_id   uuid not null references journal_entries(id),
  account_id uuid not null references accounts(id),
  side       text not null check (side in ('debit', 'credit')),
  amount     numeric(18,2) not null check (amount > 0)
);

create index if not exists idx_events_tenant_seq on events (tenant_id, seq desc);
create index if not exists idx_moves_tenant_item on inventory_moves (tenant_id, item_id);
create index if not exists idx_jlines_tenant_account on journal_lines (tenant_id, account_id);

-- ===========================================================================
-- Phase 1: the document layer. Documents track commitments and drive planning;
-- they WRITE EVENTS for every physical/financial effect — the spine stays the
-- single source of truth for inventory and the ledger.
-- ===========================================================================

alter table items add column if not exists reorder_point numeric(18,4) not null default 0;

create table if not exists doc_counters (
  tenant_id uuid not null references tenants(id),
  kind      text not null,
  next_no   int  not null,
  primary key (tenant_id, kind)
);

create table if not exists bom_lines (
  tenant_id         uuid not null references tenants(id),
  parent_item_id    uuid not null references items(id),
  component_item_id uuid not null references items(id),
  qty_per           numeric(18,10) not null check (qty_per > 0),
  primary key (tenant_id, parent_item_id, component_item_id)
);

create table if not exists work_centers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  daily_hours numeric(6,2) not null default 8,
  unique (tenant_id, code)
);

create table if not exists purchase_orders (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  number     text not null,
  vendor_id  uuid not null references parties(id),
  status     text not null default 'draft'
             check (status in ('draft', 'issued', 'partially_received', 'received', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists po_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  po_id        uuid not null references purchase_orders(id),
  item_id      uuid not null references items(id),
  qty          numeric(18,4) not null check (qty > 0),
  unit_cost    numeric(18,6) not null,
  received_qty numeric(18,4) not null default 0
);

create table if not exists sales_orders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  number      text not null,
  customer_id uuid not null references parties(id),
  status      text not null default 'draft'
              check (status in ('draft', 'confirmed', 'partially_shipped', 'shipped', 'cancelled')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists so_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  so_id       uuid not null references sales_orders(id),
  item_id     uuid not null references items(id),
  qty         numeric(18,4) not null check (qty > 0),
  unit_price  numeric(18,6) not null,
  shipped_qty numeric(18,4) not null default 0
);

create table if not exists work_orders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  number         text not null,
  item_id        uuid not null references items(id),
  qty            numeric(18,4) not null check (qty > 0),
  status         text not null default 'draft'
                 check (status in ('draft', 'released', 'in_progress', 'completed', 'cancelled')),
  work_center_id uuid references work_centers(id),
  scheduled_date date,
  est_hours      numeric(8,2) not null default 0,
  created_at     timestamptz not null default now(),
  unique (tenant_id, number)
);

create table if not exists wo_components (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  wo_id        uuid not null references work_orders(id),
  item_id      uuid not null references items(id),
  qty_required numeric(18,4) not null check (qty_required > 0),
  issued_qty   numeric(18,4) not null default 0
);

-- ===========================================================================
-- Phase 2: AR/AP documents. Same rule as Phase 1 — documents track state,
-- every financial effect is an event through the posting engine.
-- ===========================================================================

create table if not exists invoices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  number      text not null,
  customer_id uuid not null references parties(id),
  so_id       uuid references sales_orders(id),
  amount      numeric(18,2) not null check (amount > 0),
  status      text not null default 'open' check (status in ('open', 'paid')),
  issued_date date not null default current_date,
  paid_date   date,
  created_at  timestamptz not null default now(),
  unique (tenant_id, number)
);

-- ===========================================================================
-- Phase 3: people & time. A person is a Party with the employee role plus
-- labor attributes; time entries are records whose cost effect flows through
-- the TimeLogged event into WIP. Payroll itself stays integrated-out, forever.
-- ===========================================================================

create table if not exists employees (
  tenant_id   uuid not null references tenants(id),
  party_id    uuid not null references parties(id),
  cost_rate   numeric(8,2) not null check (cost_rate > 0), -- loaded $/hour
  skills      text[] not null default '{}',
  daily_hours numeric(4,1) not null default 8,
  active      boolean not null default true,
  primary key (tenant_id, party_id)
);

create table if not exists time_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  wo_id       uuid not null references work_orders(id),
  party_id    uuid references parties(id), -- null when logged as a free-text name
  person_name text not null,
  hours       numeric(6,2) not null check (hours > 0),
  rate        numeric(8,2) not null check (rate > 0),
  labor_cost  numeric(18,2) not null,
  entry_date  date not null default current_date,
  event_id    uuid not null references events(id),
  created_at  timestamptz not null default now()
);

create index if not exists idx_time_entries_tenant_date on time_entries (tenant_id, entry_date desc);

create table if not exists bills (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number    text not null,
  vendor_id uuid not null references parties(id),
  po_id     uuid references purchase_orders(id),
  kind      text not null,
  amount    numeric(18,2) not null check (amount > 0),
  status    text not null default 'open' check (status in ('open', 'paid')),
  bill_date date not null default current_date,
  paid_date date,
  created_at timestamptz not null default now(),
  unique (tenant_id, number)
);
alter table bills drop constraint if exists bills_kind_check;
alter table bills add constraint bills_kind_check check (kind in ('inventory', 'expense', 'opening'));

-- ===========================================================================
-- D2C channels (decision #3): settlements are summarized financial events —
-- one row per payout period per channel. Never per-order.
-- ===========================================================================

-- ===========================================================================
-- Bank reconciliation: imported statement lines matched against cash (1110)
-- journal lines. The bank file is the outside world's version of events; the
-- match table is the proof they agree.
-- ===========================================================================

create table if not exists bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  txn_date        date not null,
  description     text not null default '',
  amount          numeric(18,2) not null, -- deposits positive, withdrawals negative
  status          text not null default 'unmatched' check (status in ('unmatched', 'matched', 'excluded')),
  matched_line_id uuid references journal_lines(id),
  created_at      timestamptz not null default now()
);

create index if not exists idx_bank_txn_tenant_date on bank_transactions (tenant_id, txn_date desc);

create table if not exists channel_settlements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  channel      text not null,
  period_start date not null,
  period_end   date not null,
  gross_sales  numeric(18,2) not null check (gross_sales >= 0),
  refunds      numeric(18,2) not null default 0 check (refunds >= 0),
  fees         numeric(18,2) not null default 0 check (fees >= 0),
  payout       numeric(18,2) not null,
  event_id     uuid not null references events(id),
  created_at   timestamptz not null default now()
);
