import { setTimeout as delay } from 'node:timers/promises'
import { db } from './db.ts'
import { runNextJob } from './jobs.ts'
import { syncMail } from './workflow.ts'
import type { Scope } from './workflow-types.ts'

async function pollMail() {
  const { rows } = await db.query<Scope>(`
    SELECT t.id, t.slug, t.name, t.timezone, t.language FROM tenants t
    JOIN provider_connections p ON p.tenant_id = t.id AND p.kind = 'mail'
    WHERE NOT t.suspended AND (p.last_sync IS NULL OR p.last_sync < now() - interval '1 minute')
  `)
  for (const scope of rows) {
    let error: string | null = null
    try { await syncMail(scope) }
    catch (cause) { error = cause instanceof Error ? cause.message.slice(0, 240) : 'Inbox sync failed.' }
    await db.query(`UPDATE provider_connections SET last_sync = now(), last_error = $2 WHERE tenant_id = $1 AND kind = 'mail'`, [scope.id, error])
  }
}

let stop = false
for (const event of ['SIGTERM', 'SIGINT'] as const) process.on(event, () => { stop = true })
const once = process.argv.includes('--once')
try {
  do {
    try {
      for (let i = 0; i < 30 && !stop && await runNextJob(); i++) { /* drain due jobs */ }
      if (!once && !stop) await pollMail()
    } catch (error) {
      if (once) throw error
      console.error('Worker iteration failed:', error)
    }
    if (!once && !stop) await delay(2000)
  } while (!once && !stop)
} finally {
  await db.end()
}
