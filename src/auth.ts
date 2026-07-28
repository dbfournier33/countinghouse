// Real sign-in: users with scrypt-hashed passwords, server-side sessions in an
// HttpOnly cookie. The bearer token remains as an API-client credential (curl,
// agents, tests); the browser uses the cookie. No external auth service — the
// swamps we integrate are payroll and tax, not a login box.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { KernelError } from './events.js'

const SESSION_DAYS = 7

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export async function createUser(
  db: PGlite,
  tenantId: string,
  input: { email: string; name: string; password: string },
) {
  if (input.password.length < 8) throw new KernelError('password must be at least 8 characters')
  const email = input.email.trim().toLowerCase()
  const existing = await db.query('select 1 from users where tenant_id = $1 and email = $2', [tenantId, email])
  if (existing.rows.length > 0) throw new KernelError(`user ${email} already exists`)
  const r = await db.query<{ id: string }>(
    'insert into users (tenant_id, email, name, password_hash) values ($1, $2, $3, $4) returning id',
    [tenantId, email, input.name, hashPassword(input.password)],
  )
  return { id: r.rows[0].id, email, name: input.name }
}

export async function login(db: PGlite, email: string, password: string) {
  const r = await db.query<{ id: string; tenant_id: string; name: string; password_hash: string }>(
    'select id, tenant_id, name, password_hash from users where email = $1',
    [email.trim().toLowerCase()],
  )
  const user = r.rows[0]
  // Verify against a dummy hash on unknown users to keep timing flat.
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : (verifyPassword(password, hashPassword('invalid-timing-pad')), false)
  if (!ok || !user) throw new KernelError('invalid email or password', 401)

  const session = await db.query<{ token: string }>(
    `insert into sessions (tenant_id, user_id, expires_at)
     values ($1, $2, now() + interval '${SESSION_DAYS} days') returning token`,
    [user.tenant_id, user.id],
  )
  return { token: session.rows[0].token, user: { id: user.id, name: user.name }, tenant_id: user.tenant_id }
}

export async function sessionLookup(db: PGlite, token: string) {
  if (!/^[0-9a-f-]{36}$/.test(token)) return null
  await db.query('delete from sessions where expires_at < now()')
  const r = await db.query<{ tenant_id: string; user_id: string; name: string; email: string }>(
    `select s.tenant_id, s.user_id, u.name, u.email
     from sessions s join users u on u.id = s.user_id
     where s.token = $1 and s.expires_at >= now()`,
    [token],
  )
  return r.rows[0] ?? null
}

export async function logout(db: PGlite, token: string) {
  await db.query('delete from sessions where token = $1', [token])
}
