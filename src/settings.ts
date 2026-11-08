import { randomBytes } from 'node:crypto'
import { db, transaction } from './db.ts'
import { hashPassword, type Identity } from './auth.ts'
import { encryptCredential, googleAuthorization, redeemCode, verifiedGoogleUser, type GoogleKind } from './google.ts'
import { digest, email, field, languages, uuid, WorkflowError, type Scope } from './workflow-types.ts'

export type Workspace = Scope & { accent: string; suspended: boolean }

export async function settings(scope: Scope) {
  const [staff, connections] = await Promise.all([
    db.query<{ id: string; name: string; email: string; role: string }>(`
      SELECT a.id, a.name, a.email, m.role FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.tenant_id = $1 ORDER BY a.name`, [scope.id]),
    db.query<{ kind: string; provider: string; resource: string; last_sync: Date | null; last_error: string | null }>(`
      SELECT kind, provider, resource, last_sync, last_error FROM provider_connections WHERE tenant_id = $1`, [scope.id]),
  ])
  return { staff: staff.rows, connections: connections.rows }
}

export async function updateSettings(scope: Scope, actor: Identity, action: string, form: URLSearchParams) {
  if (actor.role !== 'tenant_admin') throw new WorkflowError('Tenant administrator access is required.', 403)
  await transaction(async client => {
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [scope.id])
    if (action === 'branding') {
      const name = field(form, 'name', 100)
      const accent = field(form, 'accent', 7)
      const timezone = field(form, 'timezone', 80)
      const language = field(form, 'language')
      const { rowCount } = await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone])
      if (!name || !/^#[a-f0-9]{6}$/i.test(accent) || !rowCount || !languages.includes(language)) {
        throw new WorkflowError('Enter a name, color, IANA time zone, and supported language.', 400)
      }
      if (timezone !== scope.timezone) {
        const confirmed = await client.query(`SELECT 1 FROM requests WHERE tenant_id = $1 AND status = 'confirmed'
          AND (workflow->'workshop'->>'start')::timestamptz > now() LIMIT 1`, [scope.id])
        if (confirmed.rowCount) throw new WorkflowError('Reopen upcoming confirmed workshops before changing the time zone.')
      }
      await client.query('UPDATE tenants SET name = $2, accent = $3, timezone = $4, language = $5 WHERE id = $1',
        [scope.id, name, accent, timezone, language])
      return
    }
    if (action === 'member') {
      const address = field(form, 'email', 254).toLowerCase()
      const name = field(form, 'name', 100)
      const role = field(form, 'role')
      const password = form.get('password') ?? ''
      if (!email.test(address) || !['tenant_admin', 'coordinator', 'reviewer'].includes(role)) {
        throw new WorkflowError('Enter a valid staff email and role.', 400)
      }
      let { rows: [account] } = await client.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [address])
      if (!account) {
        if (!name || password.length < 12 || password.length > 128) {
          throw new WorkflowError('New staff need a name and an initial password of 12–128 characters.', 400)
        }
        const result = await client.query<{ id: string }>('INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id',
          [address, name, await hashPassword(password)])
        account = result.rows[0]
        if (!account) throw new WorkflowError('This account was created concurrently. Submit again.')
      }
      if (account.id === actor.id) throw new WorkflowError('Ask another administrator to change your role.')
      if (role === 'reviewer') {
        await client.query('UPDATE requests SET owner_id = $3 WHERE tenant_id = $1 AND owner_id = $2',
          [scope.id, account.id, actor.id])
      }
      await client.query(`INSERT INTO memberships (tenant_id, account_id, role) VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, account_id) DO UPDATE SET role = EXCLUDED.role`, [scope.id, account.id, role])
      return
    }
    if (action === 'remove') {
      const account = field(form, 'account', 36)
      if (!uuid.test(account) || account === actor.id) throw new WorkflowError('Select another staff member.', 400)
      await client.query('UPDATE requests SET owner_id = $3 WHERE tenant_id = $1 AND owner_id = $2', [scope.id, account, actor.id])
      await client.query('DELETE FROM memberships WHERE tenant_id = $1 AND account_id = $2', [scope.id, account])
      await client.query('DELETE FROM sessions WHERE tenant_id = $1 AND account_id = $2', [scope.id, account])
      return
    }
    if (action === 'provider') {
      const kind = field(form, 'kind')
      const resource = field(form, 'resource', 200)
      if (!['mail', 'calendar'].includes(kind) || !resource ||
          (kind === 'mail' && !/^Label_[a-zA-Z0-9_-]+$/.test(resource))) {
        throw new WorkflowError('Enter a Gmail test label ID (Label_…) or a Calendar ID.', 400)
      }
      const updated = await client.query('UPDATE provider_connections SET resource = $3, last_sync = NULL, last_error = NULL WHERE tenant_id = $1 AND kind = $2',
        [scope.id, kind, resource])
      if (!updated.rowCount) throw new WorkflowError('Connect Google first.')
      return
    }
    if (action === 'disconnect') {
      const kind = field(form, 'kind')
      if (!['mail', 'calendar'].includes(kind)) throw new WorkflowError('Unknown provider.', 400)
      await client.query('DELETE FROM provider_connections WHERE tenant_id = $1 AND kind = $2', [scope.id, kind])
      return
    }
    throw new WorkflowError('Setting not found.', 404)
  })
}

type Flow = { tenant_id: string | null; account_id: string | null; kind: GoogleKind; verifier: string }
export async function beginOAuth(kind: GoogleKind, tenantId: string | null, accountId?: string) {
  const state = randomBytes(32).toString('hex')
  const verifier = randomBytes(32).toString('base64url')
  const url = googleAuthorization(kind, state, verifier)
  await db.query('DELETE FROM oauth_flows WHERE expires_at < now()')
  await db.query('INSERT INTO oauth_flows (digest, tenant_id, account_id, kind, verifier) VALUES ($1, $2, $3, $4, $5)',
    [digest(state), tenantId, accountId ?? null, kind, verifier])
  return { state, url }
}

export async function relayOAuth(state: string) {
  const { rows: [flow] } = await db.query<{ slug: string | null; suspended: boolean | null }>(`
    SELECT t.slug, t.suspended FROM oauth_flows f LEFT JOIN tenants t ON t.id = f.tenant_id
    WHERE f.digest = $1 AND f.expires_at > now()
  `, [digest(state)])
  if (!flow || flow.suspended) throw new WorkflowError('This Google sign-in or connection expired. Start again.', 403)
  return flow.slug
}

export async function finishOAuth(tenantId: string | null, state: string, code: string, identity?: Identity) {
  const { rows: [flow] } = await db.query<Flow>(`
    DELETE FROM oauth_flows WHERE digest = $1 AND tenant_id IS NOT DISTINCT FROM $2::uuid AND expires_at > now()
    RETURNING tenant_id, account_id, kind, verifier
  `, [digest(state), tenantId])
  if (!flow) throw new WorkflowError('This Google sign-in or connection expired. Start again.', 403)
  if (flow.kind !== 'login' && (!tenantId || identity?.role !== 'tenant_admin' || identity.id !== flow.account_id)) {
    throw new WorkflowError('Sign in as the tenant administrator who started this connection.', 403)
  }
  const tokens = await redeemCode(code, flow.verifier, flow.kind)
  if (flow.kind !== 'login') {
    if (!tokens.refresh_token) throw new WorkflowError('Google did not return offline authorization. Reconnect and grant access.')
    const kind = flow.kind
    await db.query(`
      INSERT INTO provider_connections (tenant_id, kind, resource, credential)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, kind) DO UPDATE SET credential = EXCLUDED.credential,
        resource = EXCLUDED.resource, last_sync = NULL, last_error = NULL
    `, [tenantId, kind, kind === 'calendar' ? 'primary' : '', encryptCredential(tokens.refresh_token, tenantId!, kind)])
    return null
  }

  const google = await verifiedGoogleUser(tokens.access_token)
  const address = google.email.toLowerCase()
  return transaction(async client => {
    const { rows: [account] } = await client.query<{ id: string; subject: string | null }>(`
      SELECT a.id, g.subject FROM accounts a
      LEFT JOIN google_identities g ON g.account_id = a.id
      LEFT JOIN memberships m ON m.account_id = a.id AND m.tenant_id = $1
      WHERE NOT a.demo_account AND (g.subject = $2 OR (g.subject IS NULL AND a.email = $3))
        AND (($1::uuid IS NULL AND a.platform_admin) OR m.account_id IS NOT NULL)
      ORDER BY g.subject IS NULL LIMIT 1 FOR UPDATE OF a
    `, [tenantId, google.sub, address])
    if (!account || (!account.subject && !address.endsWith('@gmail.com') && !google.hd)) {
      throw new WorkflowError('This verified Google account has no access to the workspace.', 403)
    }
    if (!account.subject) {
      const linked = await client.query(`INSERT INTO google_identities (subject, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [google.sub, account.id])
      if (!linked.rowCount) throw new WorkflowError('This Google identity is already linked. Contact an administrator.')
    }
    return account.id
  })
}
