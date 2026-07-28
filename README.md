# Simple ERP — Phase 0 kernel

The event spine of a radically simple all-in-one ERP for small-to-mid product
companies. **Operational documents produce events; events produce inventory moves and
journal entries; everything else is a view.** This repo is the kernel that proves it:
post an operational event through the API and a correct double-entry journal entry,
moving-average cost update, and WIP flow happen in one transaction — no accounting
steps anywhere.

Design docs live in the project folder:
`02-Architecture-Design/Simple-ERP_Architecture-Sketch_2026-07-28.md`.

## Quickstart

```bash
npm install
npm run seed   # rebuilds .data/ with the Big Sur Provisions demo story
npm run dev    # http://localhost:5310 — kernel dashboard
npm test       # golden path: buy → make → ship → paid; trial balance to the cent
```

Run `seed` before `dev` (the dev database is single-process PGlite).

## What's real here

- **Append-only event log** — updates/deletes rejected by a database trigger;
  corrections are reversing events.
- **Posting engine** — rules are versioned *data* (`posting_rules` table), not code:
  event type → debit/credit lines, amounts resolved from the event's effect
  (move value, labor value, WIP drain, payload amount).
- **Moving-average costing** per item; raw → WIP (materials + labor at loaded rate) →
  finished goods → COGS, all automatic.
- **Segment chart of accounts** seeded per tenant; `@inventory` posts resolve to raw
  vs finished from the item.
- **Multi-tenant** rows + bearer-token scoping on every query.
- **One write path**: `POST /api/events`. The UI, importers, and future MCP agents all
  use the same typed API.

## Kernel seams (deliberate, Phase 1+ fixes)

- Runs on **PGlite** (real Postgres in WASM) for zero-setup dev; deploys to managed
  Postgres unchanged. Row-level security is enforced at deploy time — dev scopes every
  query by tenant instead.
- Auth is a seeded bearer token — real identity comes with the SPA.
- Work orders/POs/SOs are string refs, not documents yet — Phase 1 adds the document
  layer on top of the same events; WIP cost accumulation per ref is already real.
- Single location (`MAIN`), single currency (USD), single entity — v1 scope fences.

## API

| Method & path | What |
|---|---|
| `POST /api/events` | The write path: `{ type, payload, occurred_at? }` → event + moves + journal entry |
| `GET /api/events` | Recent events with their journal entries |
| `GET /api/trial-balance` | Live trial balance with balanced flag |
| `GET /api/inventory` | On-hand, moving-average cost, value, open WIP |
| `GET /api/ledger/:code` | Account activity with running balance |
| `GET /api/posting-rules` | The event → journal mapping, as stored |
| `POST/GET /api/purchase-orders`, `/api/sales-orders`, `/api/work-orders` + action routes | Phase 1 documents (issue/receive, confirm/ship, release/issue-materials/log-time/complete) |
| `GET /api/planning`, `POST /api/planning/apply`, `GET /api/capacity` | Planning suggestions and work-center load |
| `POST/GET /api/bills`, `/api/invoices` + pay/record-payment | Phase 2 AR/AP documents |
| `GET /api/financials`, `GET /api/close-checks` | Statements + the close checklist |
| `GET /api/qb/summary`, `GET/PUT /api/qb/mapping`, `POST /api/qb/compare` | QuickBooks bridge: summary JE, account mapping, trial-balance diff |
| `POST/GET /api/items`, `/api/parties` | Minimal masters |

Auth: `Authorization: Bearer dev-bigsur` (demo tenant).

Event types: `GoodsReceived`, `BillPosted`, `ExpenseBillPosted`, `PaymentMade`,
`MaterialIssued`, `TimeLogged`, `ProductionCompleted`, `GoodsShipped`,
`InvoiceIssued`, `PaymentReceived`, `AdjustmentMade`, `OpeningStockSet`,
`OpeningCashSet`, `OpeningReceivableSet`, `OpeningPayableSet`,
`ChannelSettlement`.

## MCP server — the ERP as tools for an AI operator

```bash
npm run seed && npm run dev   # the API must be running
npm run mcp                   # stdio MCP server (SERP_URL / SERP_TOKEN env)
```

A thin client over the same HTTP API as the UI — same auth, same validation, same
events. Ten tools: `get_company_snapshot`, `get_planning`,
`apply_planning_suggestion` (drafts only — a human still issues/releases),
`get_financials`, `get_close_checklist`, `get_inventory`, `list_open_orders`,
`get_capacity`, `trace_lot`, `record_time_entry`. The repo's `.mcp.json` registers
it automatically for Claude Code; ask "what should I make this week?" and the answer
comes from live planning.
