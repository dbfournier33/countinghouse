import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { Hono } from 'hono'
import { createApp } from '../src/api.js'
import { createUser, hashPassword, verifyPassword } from '../src/auth.js'
import { openDb, provisionTenant } from '../src/bootstrap.js'

let db: PGlite
let app: ReturnType<typeof createApp>
let tenantId: string

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  })

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]

beforeAll(async () => {
  db = await openDb()
  tenantId = await provisionTenant(db, 'Auth Co', 'auth-token')
  app = createApp(db)
  await createUser(db, tenantId, { email: 'don@test.co', name: 'Don', password: 'granola-demo' })
})

describe('password hashing', () => {
  it('round-trips and rejects tampering', () => {
    const h = hashPassword('correct horse')
    expect(verifyPassword('correct horse', h)).toBe(true)
    expect(verifyPassword('wrong horse', h)).toBe(false)
    expect(verifyPassword('correct horse', 'garbage')).toBe(false)
  })

  it('enforces minimum length and unique emails', async () => {
    await expect(createUser(db, tenantId, { email: 'x@y.z', name: 'X', password: 'short' })).rejects.toThrow(
      /at least 8/,
    )
    await expect(
      createUser(db, tenantId, { email: 'DON@test.co', name: 'Dupe', password: 'long-enough' }),
    ).rejects.toThrow(/already exists/)
  })
})

describe('session flow', () => {
  it('rejects bad credentials without leaking which part was wrong', async () => {
    const bad = await post('/auth/login', { email: 'don@test.co', password: 'nope-nope' })
    expect(bad.status).toBe(401)
    const ghost = await post('/auth/login', { email: 'ghost@test.co', password: 'nope-nope' })
    expect(ghost.status).toBe(401)
    expect((await bad.json()).error).toBe((await ghost.json()).error)
  })

  it('logs in, authenticates API calls via cookie, and logs out', async () => {
    const res = await post('/auth/login', { email: 'don@test.co', password: 'granola-demo' })
    expect(res.status).toBe(200)
    const cookie = cookieOf(res)
    expect(cookie).toMatch(/^ch_session=/)

    const me = await app.request('/auth/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect((await me.json()).tenant).toBe('Auth Co')

    const tb = await app.request('/api/trial-balance', { headers: { Cookie: cookie } })
    expect(tb.status).toBe(200)
    expect((await tb.json()).balanced).toBe(true)

    await post('/auth/logout', {}, cookie)
    const after = await app.request('/api/trial-balance', { headers: { Cookie: cookie } })
    expect(after.status).toBe(401)
  })

  it('still accepts the bearer token for API clients, and rejects nothing-at-all', async () => {
    const bearer = await app.request('/api/trial-balance', {
      headers: { Authorization: 'Bearer auth-token' },
    })
    expect(bearer.status).toBe(200)
    const nothing = await app.request('/api/trial-balance')
    expect(nothing.status).toBe(401)
    const garbageCookie = await app.request('/api/trial-balance', {
      headers: { Cookie: 'ch_session=not-a-real-token' },
    })
    expect(garbageCookie.status).toBe(401)
  })
})
