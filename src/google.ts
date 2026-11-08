import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type pg from 'pg'
import { db } from './db.ts'
import { digest, email, WorkflowError, type Scope, type Window } from './workflow-types.ts'

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL)
export type GoogleKind = 'login' | 'mail' | 'calendar'
const scopes: Record<GoogleKind, string> = {
  login: 'openid email',
  mail: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
}

export function googleAuthorization(kind: GoogleKind, state: string, verifier: string) {
  if (!googleEnabled()) throw new WorkflowError('Google OAuth is not configured.', 503)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_CALLBACK_URL!,
    response_type: 'code',
    scope: scopes[kind],
    state,
    code_challenge: Buffer.from(digest(verifier), 'hex').toString('base64url'),
    code_challenge_method: 'S256',
    ...(kind === 'login' ? { prompt: 'select_account' } : { access_type: 'offline', prompt: 'consent' }),
  }).toString()
  return url.toString()
}

class GoogleError extends WorkflowError {
  providerStatus: number
  constructor(operation: string, status: number) {
    super(`Google ${operation} returned HTTP ${status}. Check the provider connection and try again.`, 502)
    this.providerStatus = status
  }
}

async function googleRequest<T>(url: string, operation: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) }).catch(() => {
    throw new WorkflowError(`Could not reach Google for ${operation}. Check the connection and try again.`, 502)
  })
  if (!response.ok) throw new GoogleError(operation, response.status)
  return await response.json() as T
}

async function exchange(params: Record<string, string>) {
  if (!googleEnabled()) throw new WorkflowError('Google OAuth is not configured.', 503)
  return googleRequest<{ access_token: string; refresh_token?: string; scope: string }>(
    'https://oauth2.googleapis.com/token', 'token exchange', {
      method: 'POST',
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }),
    },
  )
}

export async function redeemCode(code: string, verifier: string, kind: GoogleKind) {
  const result = await exchange({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: process.env.GOOGLE_CALLBACK_URL! })
  if (scopes[kind].split(' ').some(scope => !result.scope.split(' ').includes(scope) &&
      !(scope === 'email' && result.scope.includes('https://www.googleapis.com/auth/userinfo.email')))) {
    throw new WorkflowError('Grant the requested Google permissions and try again.', 403)
  }
  return result
}

export async function verifiedGoogleUser(token: string) {
  const user = await googleRequest<{ sub: string; email: string; email_verified: boolean; hd?: string }>(
    'https://openidconnect.googleapis.com/v1/userinfo', 'identity lookup', { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!user.sub || !user.email_verified || !email.test(user.email)) throw new WorkflowError('Google could not verify this account.', 403)
  return user
}

function tokenKey() {
  const key = process.env.GOOGLE_TOKEN_KEY ?? ''
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new WorkflowError('Configure GOOGLE_TOKEN_KEY before connecting providers.', 503)
  return Buffer.from(key, 'hex')
}

export function encryptCredential(token: string, tenantId: string, kind: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv)
  cipher.setAAD(Buffer.from(`${tenantId}:${kind}`))
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.')
}

async function connection(tenantId: string, kind: 'mail' | 'calendar', client: pg.PoolClient | typeof db = db) {
  const { rows: [record] } = await client.query<{ resource: string; credential: string; provider: string }>(
    'SELECT resource, credential, provider FROM provider_connections WHERE tenant_id = $1 AND kind = $2', [tenantId, kind],
  )
  if (!record) return undefined
  if (record.provider !== 'google') throw new WorkflowError('This provider is unavailable.')
  const [iv, tag, encrypted] = record.credential.split('.').map(value => Buffer.from(value, 'base64url'))
  const cipher = createDecipheriv('aes-256-gcm', tokenKey(), iv)
  cipher.setAAD(Buffer.from(`${tenantId}:${kind}`))
  cipher.setAuthTag(tag)
  const refresh = Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8')
  const { access_token } = await exchange({ refresh_token: refresh, grant_type: 'refresh_token' })
  return { resource: record.resource, accessToken: access_token, version: digest(record.credential + ':' + record.resource) }
}

function api(token: string, prefix: string) {
  return <T>(path: string, operation: string, body?: object) => googleRequest<T>(prefix + path, operation, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  })
}

export interface CalendarAdapter {
  name: string
  version: string
  busy(window: Window, client: pg.PoolClient): Promise<Window[]>
  find(eventId: string): Promise<Window | undefined>
  create(eventId: string, window: Window, school: string, attendee?: string): Promise<void>
}

export async function calendarAdapter(scope: Scope, client?: pg.PoolClient, simulated = false): Promise<CalendarAdapter> {
  const linked = simulated ? undefined : await connection(scope.id, 'calendar', client)
  if (!linked) return {
    name: 'Simulated calendar', version: 'simulated',
    async busy(window, client) {
      const { rows } = await client.query<{ planning: Window }>(`
        SELECT workflow->'planning' AS planning FROM requests WHERE tenant_id = $1
          AND workflow->'planning'->>'provider' = 'Simulated calendar'
          AND (workflow->'planning'->>'start')::timestamptz < $3
          AND (workflow->'planning'->>'end')::timestamptz > $2
      `, [scope.id, window.start, window.end])
      return rows.map(row => row.planning)
    },
    async find() { return undefined },
    async create() {},
  }
  const call = api(linked.accessToken, 'https://www.googleapis.com/calendar/v3')
  const calendar = `/calendars/${encodeURIComponent(linked.resource)}/events`
  return {
    name: 'Google Calendar', version: linked.version,
    async busy(window) {
      const result = await call<{ calendars: Record<string, { errors?: object[]; busy: Window[] }> }>(
        '/freeBusy', 'calendar availability', { timeMin: window.start, timeMax: window.end, items: [{ id: linked.resource }] },
      )
      const availability = Object.values(result.calendars)[0]
      if (!availability || availability.errors?.length) throw new WorkflowError('Google Calendar could not read availability.')
      return availability.busy
    },
    async find(id) {
      try {
        const event = await call<{ status: string; start: { dateTime: string }; end: { dateTime: string } }>(
          `${calendar}/${id}`, 'event lookup',
        )
        if (event.status === 'cancelled') throw new WorkflowError('This calendar event was cancelled. Review it before rebooking.')
        return { start: event.start.dateTime, end: event.end.dateTime }
      } catch (error) {
        if (error instanceof GoogleError && error.providerStatus === 404) return undefined
        throw error
      }
    },
    async create(id, window, school, attendee) {
      await call(calendar + (attendee ? '?sendUpdates=all' : ''), 'event creation', {
        id, summary: `Workshop planning call · ${school}`,
        start: { dateTime: window.start }, end: { dateTime: window.end },
        ...(attendee && email.test(attendee) && { attendees: [{ email: attendee }] }),
      })
    },
  }
}

export type IncomingMail = {
  id: string; sender: string; subject: string; body: string; thread?: string; internetId?: string; uncertain?: boolean; phone?: string
}
export type OutgoingMail = { to: string; subject: string; body: string; thread?: string; parent?: string }
export async function mailVersion(tenantId: string, client: pg.PoolClient) {
  const { rows: [record] } = await client.query<{ resource: string; credential: string }>(
    "SELECT resource, credential FROM provider_connections WHERE tenant_id = $1 AND kind = 'mail'", [tenantId],
  )
  return record ? digest(record.credential + ':' + record.resource) : 'simulated'
}

export interface MailAdapter {
  name: string
  version: string
  receive(): Promise<IncomingMail[]>
  reconcile(operation: string): Promise<{ id: string; thread?: string } | undefined>
  send(operation: string, message: OutgoingMail): Promise<{ id: string; thread?: string }>
}

type GmailPart = {
  mimeType: string; filename?: string; body?: { data?: string }; parts?: GmailPart[];
  headers?: { name: string; value: string }[]
}
type GmailMessage = { id: string; threadId: string; payload: GmailPart }
function plainText(part: GmailPart): string {
  if (part.filename) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8')
  return (part.parts ?? []).map(plainText).find(Boolean) ?? ''
}

export function messageInternetId(operation: string) {
  return `<${digest(operation)}@tidepath.invalid>`
}

export async function mailAdapter(tenantId: string, client?: pg.PoolClient): Promise<MailAdapter> {
  const linked = await connection(tenantId, 'mail', client)
  if (!linked) return {
    name: 'Simulated mail', version: 'simulated',
    async receive() { return [] }, async reconcile() { return undefined },
    async send(operation) { return { id: digest(operation) } },
  }
  const call = api(linked.accessToken, 'https://gmail.googleapis.com/gmail/v1/users/me')
  const clean = (value: string) => value.replace(/[\r\n\x00-\x1f]/g, ' ').trim()
  const header = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`
  return {
    name: 'Gmail', version: linked.version,
    async receive() {
      if (!linked.resource) throw new WorkflowError('Set the Gmail test label ID in workspace settings.')
      const messages: IncomingMail[] = []
      let page: string | undefined
      do {
        const params = new URLSearchParams({ labelIds: linked.resource, maxResults: '50', q: '-in:sent -in:drafts' })
        if (page) params.set('pageToken', page)
        const result = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${params}`, 'message listing')
        for (const item of result.messages ?? []) {
          const known = await db.query('SELECT 1 FROM intake_messages WHERE tenant_id = $1 AND source = $2 AND provider_event_id = $3', [tenantId, 'gmail', item.id])
          if (known.rowCount) continue
          const message = await call<GmailMessage>(`/messages/${encodeURIComponent(item.id)}?format=full`, 'message retrieval')
          const headers = new Map(message.payload.headers?.map(item => [item.name.toLowerCase(), item.value]))
          const body = plainText(message.payload)
          messages.push({ id: message.id, thread: message.threadId, internetId: headers.get('message-id'),
            sender: headers.get('from') ?? '', subject: headers.get('subject') ?? 'Workshop inquiry',
            body: body.slice(0, 12000), uncertain: !body || Boolean(
              (headers.get('reply-to') && headers.get('reply-to') !== headers.get('from')) ||
              (headers.get('auto-submitted') && headers.get('auto-submitted') !== 'no') ||
              headers.get('list-id') || /^(bulk|list|junk)$/i.test(headers.get('precedence') ?? ''),
            ) })
        }
        page = result.nextPageToken
      } while (page)
      return messages
    },
    async reconcile(operation) {
      const params = new URLSearchParams({ q: `in:sent rfc822msgid:${messageInternetId(operation).slice(1, -1)}`, maxResults: '2' })
      const { messages } = await call<{ messages?: { id: string; threadId: string }[] }>(`/messages?${params}`, 'sent-mail lookup')
      const item = messages?.[0]
      return item && { id: item.id, thread: item.threadId }
    },
    async send(operation, message) {
      if (!email.test(message.to) || (message.thread && !/^<[^<>\s]+>$/.test(message.parent ?? ''))) {
        throw new WorkflowError('A valid school address and reply header are required.')
      }
      const mime = [
        `To: ${message.to}`, `Subject: ${header(clean(message.subject))}`, `Message-ID: ${messageInternetId(operation)}`,
        ...(message.thread ? [`In-Reply-To: ${message.parent}`, `References: ${message.parent}`] : []),
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
        (Buffer.from(message.body).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
      ].join('\r\n')
      const result = await call<{ id: string; threadId: string }>('/messages/send', 'mail delivery', {
        raw: Buffer.from(mime).toString('base64url'), threadId: message.thread,
      })
      return { id: result.id, thread: result.threadId }
    },
  }
}
