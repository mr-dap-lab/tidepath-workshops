import { createHash } from 'node:crypto'
import type pg from 'pg'

export type Scope = { id: string; slug: string; name: string; timezone: string; language: string }
export type Window = { start: string; end: string }
export type Workflow = {
  simulated?: boolean
  planningNotes?: string
  slots?: Window[]
  planning?: Window & { eventId: string; provider: string }
  workshop?: Window & { location?: string; mode?: 'school' | 'virtual' | 'room' }
  currentDeck?: number
  sharedDeck?: number
  reminder?: 'sent' | 'confirmed' | 'changed' | 'no_response'
  exception?: string
  followUpRevision?: number
}
export type RecordState = {
  id: string; owner_id: string; status: string; details: Record<string, string>; paused: boolean
  revision: number; workflow: Workflow; proposed_follow_up: string | null; missing_fields: string[]
}

export class WorkflowError extends Error {
  status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export const email = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
export const phonePattern = /^\+[1-9][0-9]{7,14}$/
export const languages = ['English', 'Spanish', 'Haitian Creole']

export function field(form: URLSearchParams, key: string, max = 300) {
  const value = form.get(key)?.trim() ?? ''
  if (value.length > max) throw new WorkflowError(`${key.replaceAll('_', ' ')} is too long.`, 400)
  return value
}

export async function activeScope(client: pg.PoolClient, tenantId: string) {
  const { rows: [scope] } = await client.query<Scope & { suspended: boolean }>(`
    SELECT id, slug, name, timezone, language, suspended FROM tenants WHERE id = $1 FOR SHARE
  `, [tenantId])
  if (!scope || scope.suspended) throw new WorkflowError('Workspace unavailable.', 404)
  return scope
}

export async function lockRequest(client: pg.PoolClient, tenantId: string, id: string) {
  const { rows: [record] } = await client.query<RecordState & { simulated: boolean }>(
    `SELECT r.*, EXISTS (
      SELECT 1 FROM intake_messages m WHERE m.tenant_id = r.tenant_id AND m.request_id = r.id
        AND m.direction = 'inbound' AND m.source IN ('simulated_email', 'simulated_sms')
    ) AS simulated FROM requests r WHERE r.tenant_id = $1 AND r.id = $2 FOR UPDATE`, [tenantId, id],
  )
  if (!record) throw new WorkflowError('Request not found.', 404)
  if (record.simulated) record.workflow.simulated = true
  return record
}

export async function note(client: pg.PoolClient, tenantId: string, id: string, text: string) {
  await client.query('INSERT INTO timeline (tenant_id, request_id, note) VALUES ($1, $2, $3)', [tenantId, id, text])
}

export async function saveWorkflow(client: pg.PoolClient, tenantId: string, record: RecordState) {
  await client.query('UPDATE requests SET workflow = $3, status = $4, revision = $5 WHERE tenant_id = $1 AND id = $2',
    [tenantId, record.id, record.workflow, record.status, record.revision])
}

export function invalidateConfirmation(record: RecordState) {
  record.revision++
  delete record.workflow.reminder
  if (record.status === 'confirmed') record.status = record.missing_fields.length ? 'awaiting_details' : 'ready_for_planning'
}

export async function localWindow(client: pg.PoolClient, scope: Scope, start: string, end: string): Promise<Window> {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
  if (!pattern.test(start) || !pattern.test(end) || !Number.isFinite(Date.parse(start + 'Z')) ||
      !Number.isFinite(Date.parse(end + 'Z')) || new Date(start + 'Z').toISOString().slice(0, 16) !== start ||
      new Date(end + 'Z').toISOString().slice(0, 16) !== end) {
    throw new WorkflowError('Enter valid start and end times in the workspace time zone.', 400)
  }
  const { rows: [time] } = await client.query<{ start: Date; end: Date; valid: boolean }>(`
    SELECT $1::timestamp AT TIME ZONE $3 AS start, $2::timestamp AT TIME ZONE $3 AS "end",
      (($1::timestamp AT TIME ZONE $3) AT TIME ZONE $3) = $1::timestamp
        AND (($2::timestamp AT TIME ZONE $3) AT TIME ZONE $3) = $2::timestamp AS valid
  `, [start, end, scope.timezone])
  if (!time.valid || time.end <= time.start || time.start.getTime() <= Date.now()) {
    throw new WorkflowError('Choose a future window with an end after the start.', 400)
  }
  return { start: time.start.toISOString(), end: time.end.toISOString() }
}

export type JobKind = 'planning' | 'follow_up' | 'confirmation' | 'reminder' | 'cutoff'
export async function enqueue(client: pg.PoolClient, tenantId: string, id: string, kind: JobKind,
  operation: string, payload: object, runAt?: Date) {
  await client.query(`
    INSERT INTO jobs (tenant_id, request_id, kind, operation, payload, run_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
    ON CONFLICT (tenant_id, request_id, operation) DO NOTHING
  `, [tenantId, id, kind, operation, payload, runAt ?? null])
}
