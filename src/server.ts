import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { authenticate, endSession, getIdentity, hashPassword, startSession } from './auth.ts'
import { db, transaction } from './db.ts'
import { listRequests, simulateIntake } from './intake.ts'
import { adminView, errorView, loginView, queueView, requestView } from './views.ts'
import { googleEnabled, type GoogleKind } from './google.ts'
import { beginOAuth, finishOAuth, relayOAuth, settings, updateSettings, type Workspace } from './settings.ts'
import { canCoordinate, deckFile, detailsForStaff, newIntake, schoolAccess, schoolAction, staffAction, syncMail } from './workflow.ts'
import { feedback, intakeView, issuedLinkView, roomResultsView, schoolView, settingsView, workflowPanel } from './workflow-views.ts'
import { seedVenues } from './venues.ts'
import { receiveSms } from './sms.ts'
import { WorkflowError } from './workflow-types.ts'

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT must be an integer between 1024 and 65535.')
}

const slugPattern = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/
const requestPath = /^\/(api\/)?requests\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uiAssets = new Map(await Promise.all([
  ['assets/manrope.woff2', 'font/woff2'],
  ['assets/roboto-flex.woff2', 'font/woff2'],
  ['assets/material-symbols.woff2', 'font/woff2'],
].map(async ([file, type]) => ['/' + file, { type, body: await readFile(new URL('./' + file, import.meta.url)) }] as const)))
const platform = new URL(process.env.APP_ORIGIN ?? `http://localhost:${port}`)
if (!['https:', 'http:'].includes(platform.protocol) || platform.pathname !== '/' || platform.username ||
    platform.password || platform.search || platform.hash || (platform.protocol === 'http:' && platform.hostname !== 'localhost')) {
  throw new Error('APP_ORIGIN must be an HTTPS base domain or an HTTP localhost origin.')
}
const secure = platform.protocol === 'https:'
const originFor = (slug?: string | null) => slug ? platform.origin.replace('://', `://${slug}.`) : platform.origin
const tokenPattern = /^[a-f0-9]{64}$/


function respond(res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type }).end(body)
}

function sendDeck(res: ServerResponse, content: string) {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
  respond(res, 200, content)
}

function json(res: ServerResponse, status: number, data: unknown) {
  respond(res, status, JSON.stringify(data), 'application/json; charset=utf-8')
}

function redirect(res: ServerResponse, path: string) {
  res.writeHead(303, { Location: path }).end()
}

class FormError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 8192) {
      req.resume()
      throw new FormError(413, 'The submitted form is too large.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readForm(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    throw new FormError(415, 'Submit the form using the provided page.')
  }
  return new URLSearchParams((await readBody(req)).toString('utf8'))
}

async function getTenants() {
  return (await db.query<Workspace>('SELECT slug, name, accent, suspended FROM tenants ORDER BY name')).rows
}

async function provision(form: URLSearchParams) {
  const name = form.get('name')?.trim() ?? ''
  const slug = form.get('slug')?.trim().toLowerCase() ?? ''
  const accent = form.get('accent') ?? ''
  const adminName = form.get('admin_name')?.trim() ?? ''
  const email = form.get('admin_email')?.trim().toLowerCase() ?? ''
  const password = form.get('password') ?? ''
  if (!name || name.length > 100 || !adminName || adminName.length > 100 ||
      !slugPattern.test(slug) || !/^#[a-f0-9]{6}$/i.test(accent) ||
      email.length > 254 || !emailPattern.test(email) || password.length < 12 || password.length > 128) {
    throw new FormError(400, 'Check the workspace and administrator details. Use a lowercase subdomain and a password of at least 12 characters.')
  }

  const passwordHash = await hashPassword(password)
  try {
    await transaction(async client => {
      const { rows: [tenant] } = await client.query<{ id: string }>(`
        INSERT INTO tenants (name, slug, accent) VALUES ($1, $2, $3) RETURNING id
      `, [name, slug, accent])
      const { rows: [account] } = await client.query<{ id: string }>(`
        INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id
      `, [email, adminName, passwordHash])
      await seedVenues(client, tenant.id)
      await client.query(`
        INSERT INTO memberships (tenant_id, account_id, role) VALUES ($1, $2, 'tenant_admin')
      `, [tenant.id, account.id])
    })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
      throw new FormError(409, 'The subdomain or administrator email is already in use.')
    }
    throw error
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', "default-src 'none'; font-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com")
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  const host = req.headers.host?.toLowerCase() ?? ''
  const platformHost = platform.host
  const suffix = `.${platformHost}`
  const slug = host.endsWith(suffix) ? host.slice(0, -suffix.length) : ''
  if (host !== platformHost && !slugPattern.test(slug)) {
    return respond(res, 404, errorView('Workspace not found', 'Check the workspace address.'))
  }

  const origin = originFor(slug)
  const url = new URL(req.url ?? '/', origin)
  if (url.origin !== origin) return respond(res, 400, 'Invalid request URL.', 'text/plain; charset=utf-8')
  const path = url.pathname
  const isApi = path.startsWith('/api/')
  const method = req.method

  if (method === 'GET' && path === '/app.css') {
    return respond(res, 200, await readFile(new URL('./app.css', import.meta.url)), 'text/css; charset=utf-8')
  }
  const asset = method === 'GET' ? uiAssets.get(path) : undefined
  if (asset) return respond(res, 200, asset.body, asset.type)

  const tenant = slug ? (await db.query<Workspace>(
    'SELECT id, slug, name, accent, timezone, language, suspended FROM tenants WHERE slug = $1', [slug],
  )).rows[0] : undefined
  if (slug && (!tenant || tenant.suspended)) {
    return isApi ? json(res, 404, { error: 'Workspace not found' })
      : respond(res, 404, errorView('Workspace not found', 'Check the workspace address.'))
  }

  if (tenant && method === 'POST' && path === '/api/sms/inbound') {
    const signature = req.headers['x-tidepath-signature']
    await receiveSms(tenant, await readBody(req), typeof signature === 'string' ? signature : undefined)
    return json(res, 202, { accepted: true })
  }

  if (method === 'POST' && req.headers.origin !== origin) {
    return isApi ? json(res, 403, { error: 'Invalid request origin' })
      : respond(res, 403, errorView('Request blocked', 'Submit the form from this workspace.', tenant))
  }

  const tenantId = tenant?.id ?? null
  if (method === 'POST' && path === '/login') {
    const form = await readForm(req)
    const email = form.get('email')?.trim().toLowerCase() ?? ''
    const password = form.get('password') ?? ''
    const account = email.length <= 254 && password.length <= 128
      ? await authenticate(tenantId, email, password, !secure) : undefined
    if (!account) return respond(res, 401, loginView(platform.origin, tenant, 'This email and password do not grant access to this workspace.', googleEnabled()))
    res.setHeader('Set-Cookie', await startSession(account.id, tenantId, secure))
    return redirect(res, '/')
  }

  if (method === 'GET' && !tenant && path === '/google/callback') {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!tokenPattern.test(state) || !code || code.length > 2048) throw new WorkflowError('Google authorization was not completed.', 403)
    const workspace = await relayOAuth(state)
    return redirect(res, `${originFor(workspace)}/google/finish?${new URLSearchParams({ state, code })}`)
  }

  const identity = await getIdentity(tenantId, req.headers.cookie, !secure)
  if (method === 'POST' && /^\/google\/start\/(login|mail|calendar)$/.test(path)) {
    const kind = path.split('/').at(-1) as GoogleKind
    if (kind !== 'login' && (!tenant || identity?.role !== 'tenant_admin')) throw new WorkflowError('Tenant administrator access is required.', 403)
    const { state, url: target } = await beginOAuth(kind, tenantId, identity?.id)
    res.setHeader('Set-Cookie', `tidepath_oauth=${state}; HttpOnly; SameSite=Lax; Path=/google; Max-Age=600${secure ? '; Secure' : ''}`)
    return redirect(res, target)
  }
  if (method === 'GET' && path === '/google/finish') {
    res.setHeader('Referrer-Policy', 'no-referrer')
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)tidepath_oauth=([a-f0-9]{64})(?:;|$)/)?.[1]
    if (!cookie || cookie !== state || !code || code.length > 2048) throw new WorkflowError('This Google authorization did not start in this browser.', 403)
    const accountId = await finishOAuth(tenantId, state, code, identity)
    const cookies = [`tidepath_oauth=; HttpOnly; SameSite=Lax; Path=/google; Max-Age=0${secure ? '; Secure' : ''}`]
    if (accountId) cookies.push(await startSession(accountId, tenantId, secure))
    res.setHeader('Set-Cookie', cookies)
    return redirect(res, accountId ? '/' : '/settings?connected=1')
  }

  if (tenant && path === '/intake') {
    if (method === 'GET') return respond(res, 200, intakeView(tenant, undefined, url.searchParams.has('submitted')))
    if (method === 'POST') {
      await newIntake(tenant, await readForm(req))
      return redirect(res, '/intake?submitted=1')
    }
  }

  const school = /^\/school\/([a-f0-9]{64})(?:\/([a-z]+)(?:\/([1-9]\d{0,8}))?)?$/.exec(path)
  if (tenant && school) {
    const [, token, action, version] = school
    if (method === 'GET' && !action) {
      return respond(res, 200, schoolView(tenant, token, await schoolAccess(tenant, token), url.searchParams.has('saved')))
    }
    if (method === 'GET' && action === 'deck' && version) {
      const { record } = await schoolAccess(tenant, token)
      return sendDeck(res, await deckFile(tenant, record.id, Number(version), token))
    }
    if (method === 'POST' && action && !version) {
      await schoolAction(tenant, token, action, await readForm(req))
      return redirect(res, `/school/${token}?saved=1`)
    }
  }
  if (!identity) {
    return isApi ? json(res, 401, { error: 'Sign in required' })
      : respond(res, method === 'GET' && path === '/' ? 200 : 401, loginView(platform.origin, tenant, undefined, googleEnabled()))
  }

  if (method === 'POST' && path === '/logout') {
    res.setHeader('Set-Cookie', await endSession(tenantId, secure, req.headers.cookie))
    return redirect(res, '/')
  }

  if (!tenant && identity.role === 'platform_admin') {
    if (method === 'GET' && path === '/') {
      return respond(res, 200, adminView(await getTenants(), platform.origin, identity, undefined, url.searchParams.has('created')))
    }
    if (method === 'POST' && path === '/admin/suspension') {
      const slug = (await readForm(req)).get('slug')
      const result = await db.query('UPDATE tenants SET suspended = NOT suspended WHERE slug = $1', [slug])
      if (!result.rowCount) throw new WorkflowError('Workspace not found.', 404)
      return redirect(res, '/')
    }
    if (method === 'POST' && path === '/admin/tenants') {
      try {
        await provision(await readForm(req))
        return redirect(res, '/?created=1')
      } catch (error) {
        if (error instanceof FormError) {
          return respond(res, error.status, adminView(await getTenants(), platform.origin, identity, error.message))
        }
        throw error
      }
    }
  }

  if (tenant) {
    if (path === '/intake/staff') {
      if (!canCoordinate(identity)) throw new WorkflowError('Coordinator access is required.', 403)
      if (method === 'GET') return respond(res, 200, intakeView(tenant, identity))
      if (method === 'POST') return redirect(res, '/requests/' + await newIntake(tenant, await readForm(req), identity))
    }
    if (path === '/settings' || path.startsWith('/settings/')) {
      if (identity.role !== 'tenant_admin') throw new WorkflowError('Tenant administrator access is required.', 403)
      if (method === 'GET' && path === '/settings') {
        return respond(res, 200, settingsView(tenant, identity, await settings(tenant), googleEnabled(),
          url.searchParams.has('connected') ? 'Google connection saved.' : url.searchParams.has('saved') ? 'Settings saved.' : undefined))
      }
      if (method === 'POST' && path !== '/settings') {
        await updateSettings(tenant, identity, path.slice('/settings/'.length), await readForm(req))
        return redirect(res, '/settings?saved=1')
      }
    }
    if (method === 'POST' && path === '/sync-mail') {
      await syncMail(tenant, identity)
      return redirect(res, '/')
    }
    if (method === 'POST' && path === '/simulate') {
      if (!canCoordinate(identity)) throw new WorkflowError('Coordinator access is required.', 403)
      const id = await simulateIntake(tenant.id, identity.id)
      return redirect(res, `/requests/${id}`)
    }
    const workflowPath = /^(\/requests\/[a-f0-9-]{36})\/([a-z-]+)(?:\/([1-9]\d{0,8}))?$/.exec(path)
    if (workflowPath) {
      const [, base, action, version] = workflowPath
      const match = requestPath.exec(base)
      if (!match) throw new WorkflowError('Request not found.', 404)
      const id = match[2]
      if (method === 'GET' && action === 'deck' && version) return sendDeck(res, await deckFile(tenant, id, Number(version)))
      if (method === 'POST' && !version) {
        const form = await readForm(req)
        try {
          const result = await staffAction(tenant, identity, id, action, form, origin)
          if (result.rooms) return respond(res, 200, roomResultsView(tenant, identity, id, form, result.rooms))
          if (result.token) return respond(res, 201, issuedLinkView(tenant, identity, id, `${origin}/school/${result.token}`))
          return redirect(res, base + '?saved=1#workflow')
        } catch (error) {
          if (!(error instanceof WorkflowError) || error.status === 404 || error.status === 403) throw error
          const [record] = await listRequests(tenant.id, id)
          if (!record) throw error
          return respond(res, error.status, requestView(tenant, identity, record,
            workflowPanel(tenant, identity, record, await detailsForStaff(tenant, id)), feedback(error.message, true)))
        }
      }
    }
    if (method === 'GET') {
      if (path === '/') return respond(res, 200, queueView(tenant, identity, await listRequests(tenant.id), url.searchParams.get('view')))
      if (path === '/api/requests') return json(res, 200, await listRequests(tenant.id))
      const match = requestPath.exec(path)
      if (match) {
        const [request] = await listRequests(tenant.id, match[2])
        if (request) {
          return isApi ? json(res, 200, request) : respond(res, 200, requestView(tenant, identity, request,
            workflowPanel(tenant, identity, request, await detailsForStaff(tenant, request.id)),
            url.searchParams.has('saved') ? feedback('Request updated.') : ''))
        }
      }
    }
  }

  return isApi ? json(res, 404, { error: 'Not found' })
    : respond(res, 404, errorView('Page not found', 'The page is unavailable in this workspace.', tenant))
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    if (error instanceof FormError || error instanceof WorkflowError) {
      if (req.url?.startsWith('/api/')) json(res, error.status, { error: error.message })
      else respond(res, error.status, errorView('Action unavailable', error.message))
    } else {
      console.error(error)
      respond(res, 500, errorView('Something went wrong', 'Try again in a moment.'))
    }
  })
})

await db.query('SELECT 1')
server.listen(port, process.env.APP_BIND ?? '127.0.0.1', () => {
  console.log(`Tidepath: ${platform.origin}/`)
})
