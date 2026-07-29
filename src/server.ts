import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './api.js'
import { openDb, provisionTenant } from './bootstrap.js'

const db = await openDb('.data/kernel')
await provisionTenant(db, 'Big Sur Provisions', 'dev-bigsur')

const app = createApp(db)
app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT ?? 5310)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Countinghouse kernel — http://localhost:${info.port}`)
  console.log('Demo tenant token: dev-bigsur  (seed demo data: npm run seed, before starting the server)')
})
