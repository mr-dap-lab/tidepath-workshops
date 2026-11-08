import { readFile } from 'node:fs/promises'
import { hashPassword } from './auth.ts'
import { db, transaction } from './db.ts'
import { seedVenues } from './venues.ts'
import { email } from './workflow-types.ts'

try {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8')
  const shared = process.env.APP_ORIGIN?.startsWith('https://')
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? ''
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? ''
  const bootstrapName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Platform administrator'
  if (shared && (bootstrapEmail || bootstrapPassword) &&
      (!email.test(bootstrapEmail) || bootstrapEmail.endsWith('@example.test') ||
        bootstrapPassword.length < 16 || bootstrapPassword.length > 128 || bootstrapName.length > 100)) {
    throw new Error('Use a real bootstrap administrator email and a password of 16–128 characters.')
  }
  const passwordHash = await hashPassword(shared ? bootstrapPassword : 'TidepathDemo2026!')
  await transaction(async client => {
    await client.query(schema)
    await client.query(`UPDATE accounts SET demo_account = true
      WHERE email IN ('platform@example.test', 'yesenia@example.test', 'harbor@example.test', 'reviewer@example.test', 'admin@example.test')`)
    if (shared) {
      if (bootstrapEmail) {
        await client.query(`
          INSERT INTO accounts (email, name, password_hash, platform_admin) VALUES ($1, $2, $3, true)
          ON CONFLICT (email) DO NOTHING
        `, [bootstrapEmail, bootstrapName, passwordHash])
      }
      const administrator = await client.query('SELECT 1 FROM accounts WHERE platform_admin AND NOT demo_account LIMIT 1')
      if (!administrator.rowCount) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for the initial platform administrator.')
      return
    }
    await client.query(`
      INSERT INTO tenants (slug, name, accent) VALUES
        ('tidepath', 'Tidepath Family Alliance', '#17645e'),
        ('harbor', 'Harbor Learning Collective', '#325a9e')
      ON CONFLICT (slug) DO NOTHING
    `)
    await client.query(`
      INSERT INTO accounts (email, name, password_hash, platform_admin, demo_account) VALUES
        ('platform@example.test', 'Morgan Rivera', $1, true, true),
        ('yesenia@example.test', 'Yesenia Cruz', $1, false, true),
        ('harbor@example.test', 'Alex Morales', $1, false, true),
        ('reviewer@example.test', 'Marisol Vega', $1, false, true),
        ('admin@example.test', 'Rosa Díaz', $1, false, true)
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash])
    await client.query(`
      INSERT INTO memberships (tenant_id, account_id, role)
      SELECT t.id, a.id, 'coordinator' FROM tenants t
      JOIN accounts a ON a.email = CASE t.slug
        WHEN 'tidepath' THEN 'yesenia@example.test' WHEN 'harbor' THEN 'harbor@example.test' END
      ON CONFLICT DO NOTHING
    `)
    await client.query(`
      INSERT INTO memberships (tenant_id, account_id, role)
      SELECT t.id, a.id, CASE WHEN a.email = 'reviewer@example.test' THEN 'reviewer' ELSE 'tenant_admin' END
      FROM tenants t CROSS JOIN accounts a
      WHERE t.slug = 'tidepath' AND a.email IN ('reviewer@example.test', 'admin@example.test')
      ON CONFLICT DO NOTHING
    `)
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug IN ('tidepath', 'harbor')`)
    for (const tenant of rows) await seedVenues(client, tenant.id)
  })
  console.log(shared ? 'Schema and platform administrator are ready.' : 'Schema and demo accounts are ready.')
} finally {
  await db.end()
}
