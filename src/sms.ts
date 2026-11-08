import { createHmac, timingSafeEqual } from 'node:crypto'
import { transaction } from './db.ts'
import { ingest } from './intake.ts'
import { activeScope, digest, phonePattern, type Scope, WorkflowError } from './workflow-types.ts'

const sign = (secret: string, value: string | Buffer) => createHmac('sha256', secret).update(value).digest('hex')

function key(scope: Scope) {
  const secret = process.env.SMS_WEBHOOK_KEY
  return secret && secret.length >= 32 ? sign(secret, scope.slug) : undefined
}

export async function receiveSms(scope: Scope, raw: Buffer, signature?: string) {
  const secret = key(scope)
  if (!secret) throw new WorkflowError('SMS intake is not configured.', 404)
  if (!signature || !/^[0-9a-f]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(sign(secret, raw), 'hex'), Buffer.from(signature, 'hex'))) {
    throw new WorkflowError('Invalid SMS signature.', 403)
  }
  let message: { id?: string; from?: string; body?: string; sentAt?: string; thread?: string }
  try { message = JSON.parse(raw.toString('utf8')) } catch { throw new WorkflowError('Invalid SMS payload.', 400) }
  if (!message || typeof message.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(message.id) ||
      typeof message.from !== 'string' || !phonePattern.test(message.from) ||
      typeof message.body !== 'string' || !message.body.trim() || message.body.length > 4000 ||
      typeof message.sentAt !== 'string' || !(Math.abs(Date.now() - Date.parse(message.sentAt)) <= 10 * 60_000) ||
      (message.thread !== undefined && (typeof message.thread !== 'string' || message.thread.length > 200))) {
    throw new WorkflowError('Invalid or expired SMS event.', 400)
  }
  return transaction(async client => {
    const active = await activeScope(client, scope.id)
    const { rows: [owner] } = await client.query<{ account_id: string }>(`
      SELECT account_id FROM memberships WHERE tenant_id = $1 AND role IN ('coordinator', 'tenant_admin')
      ORDER BY role, account_id LIMIT 1
    `, [scope.id])
    if (!owner) throw new WorkflowError('Assign an intake coordinator before enabling SMS.', 503)
    return ingest(client, scope.id, owner.account_id, 'sms', {
      id: message.id!, sender: message.from!, subject: 'School workshop SMS', body: message.body!, thread: message.thread,
    }, active.language, smsDeliveryVersion(scope))
  })
}

export function smsDeliveryVersion(scope: Scope) {
  const secret = key(scope)
  const relay = process.env.SMS_RELAY_URL
  return secret && relay ? 'sms:' + digest(relay + secret) : 'simulated'
}

export async function sendSms(scope: Scope, operation: string, to: string, body: string) {
  const secret = key(scope)
  const relay = process.env.SMS_RELAY_URL
  if (!secret || !relay || !phonePattern.test(to)) throw new WorkflowError('SMS delivery needs a relay and a valid phone number.')
  const endpoint = new URL(relay.replace(/\/$/, '') + '/messages/' + operation)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost')) {
    throw new WorkflowError('The SMS relay must use HTTPS or localhost.')
  }
  const data = JSON.stringify({ to, body })
  const response = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(8000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Tidepath-Signature': sign(secret, data) }, body: data })
  if (!response.ok) throw new WorkflowError(`SMS relay returned HTTP ${response.status}.`)
  const result = await response.json() as { id?: unknown }
  if (typeof result.id !== 'string' || !result.id || result.id.length > 200) throw new WorkflowError('SMS relay did not return a delivery ID.')
  return { id: result.id }
}
