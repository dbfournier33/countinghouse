import { PGlite } from '@electric-sql/pglite'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { COA } from './coa.js'
import { POSTING_RULES } from './rules.js'

const here = dirname(fileURLToPath(import.meta.url))

// Dev/test run on PGlite (real Postgres compiled to WASM) — the schema is plain
// Postgres and moves to a managed instance unchanged. In-memory when no dataDir.
export async function openDb(dataDir?: string): Promise<PGlite> {
  if (dataDir) mkdirSync(dataDir, { recursive: true }) // PGlite's mkdir is not recursive
  const db = dataDir ? new PGlite(dataDir) : new PGlite()
  await db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
  return db
}

// Creates the tenant (idempotent by token) and seeds its chart of accounts,
// posting rules, and default location.
export async function provisionTenant(db: PGlite, name: string, token: string): Promise<string> {
  const existing = await db.query<{ id: string }>('select id from tenants where token = $1', [token])
  if (existing.rows[0]) return existing.rows[0].id

  const created = await db.query<{ id: string }>(
    'insert into tenants (name, token) values ($1, $2) returning id',
    [name, token],
  )
  const tenantId = created.rows[0].id

  for (const a of COA) {
    await db.query(
      'insert into accounts (tenant_id, code, name, kind, normal_side, qb_account) values ($1, $2, $3, $4, $5, $6)',
      [tenantId, a.code, a.name, a.kind, a.normal, a.qb],
    )
  }
  for (const [eventType, lines] of Object.entries(POSTING_RULES)) {
    await db.query(
      'insert into posting_rules (tenant_id, event_type, version, lines) values ($1, $2, 1, $3)',
      [tenantId, eventType, JSON.stringify(lines)],
    )
  }
  await db.query(
    "insert into locations (tenant_id, code, name, kind) values ($1, 'MAIN', 'Main warehouse', 'warehouse')",
    [tenantId],
  )
  return tenantId
}
