import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { db, transaction } from './db.ts'
import { type Identity } from './auth.ts'
import { calendarAdapter, mailAdapter, mailVersion } from './google.ts'
import { assessDetails, detailLabels, ingest, updateIntake } from './intake.ts'
import { draftDeck, storeDeck, readDeck, type Deck } from './decks.ts'
import { smsDeliveryVersion } from './sms.ts'
import { modelDeck } from './model.ts'
import { reserveRoom, searchRooms, type Criteria } from './venues.ts'
import {
  activeScope, digest, email, enqueue, field, invalidateConfirmation, localWindow, lockRequest, note, phonePattern, saveWorkflow, uuid,
  type RecordState, type Scope, type Window, WorkflowError,
} from './workflow-types.ts'

type Purpose = 'collaborator' | 'approver' | 'logistics'
type Grant = { id: string; request_id: string; contact: string; email: string; purpose: Purpose; workshop_revision: number | null }
type Version = {
  version: number; content: Deck; object_key: string; checksum: string; cleared_at: Date | null
  shared_at: Date | null; approved_at: Date | null; approver: string | null
}

export const canCoordinate = (identity: Identity) => identity.role === 'coordinator' || identity.role === 'tenant_admin'
export const canReview = (identity: Identity) => identity.role === 'reviewer' || identity.role === 'tenant_admin'

export async function detailsForStaff(scope: Scope, id: string) {
  const params = [scope.id, id]
  const [versions, links, comments, timeline, messages, jobs, owners] = await Promise.all([
    db.query<Version>(`SELECT v.*, l.contact AS approver FROM deck_versions v LEFT JOIN school_links l
      ON l.id = v.approved_by AND l.tenant_id = v.tenant_id AND l.request_id = v.request_id
      WHERE v.tenant_id = $1 AND v.request_id = $2 ORDER BY v.version DESC`, params),
    db.query<Grant & { revoked: boolean; expires_at: Date }>(`
      SELECT id, contact, email, purpose, revoked, expires_at FROM school_links
      WHERE tenant_id = $1 AND request_id = $2 AND purpose <> 'logistics' ORDER BY expires_at DESC`, params),
    db.query<{ contact: string; version: number; body: string }>(`
      SELECT l.contact, c.version, c.body FROM deck_comments c JOIN school_links l
        ON l.id = c.contact_id AND l.tenant_id = c.tenant_id AND l.request_id = c.request_id
      WHERE c.tenant_id = $1 AND c.request_id = $2 ORDER BY c.id`, params),
    db.query<{ note: string; created_at: Date }>(`
      SELECT note, created_at FROM timeline WHERE tenant_id = $1 AND request_id = $2 ORDER BY id DESC LIMIT 60`, params),
    db.query<{ source: string; sender: string; subject: string; body: string; direction: string }>(`
      SELECT source, sender, subject, body, direction FROM intake_messages
      WHERE tenant_id = $1 AND request_id = $2 ORDER BY received_at, provider_event_id`, params),
    db.query<{ id: string; kind: string; state: string; error: string | null; run_at: Date; attempts: number }>(`
      SELECT id, kind, state, error, run_at, attempts FROM jobs
      WHERE tenant_id = $1 AND request_id = $2 ORDER BY run_at DESC LIMIT 30`, params),
    db.query<{ id: string; name: string }>(`SELECT a.id, a.name FROM accounts a JOIN memberships m ON m.account_id = a.id
      WHERE m.tenant_id = $1 AND m.role IN ('tenant_admin', 'coordinator') ORDER BY a.name`, [scope.id]),
  ])
  return { owners: owners.rows, versions: versions.rows, links: links.rows, comments: comments.rows, timeline: timeline.rows,
    messages: messages.rows, jobs: jobs.rows }
}

function requireRole(allowed: boolean) {
  if (!allowed) throw new WorkflowError('Your role does not permit this action.', 403)
}

async function createGrant(client: pg.PoolClient, scope: Scope, id: string, purpose: Purpose, contact: string, address: string, workshop?: { revision: number; end: string }) {
  if (purpose === 'approver') {
    await client.query(`UPDATE school_links SET revoked = true WHERE tenant_id = $1 AND request_id = $2 AND purpose = 'approver' AND NOT revoked`, [scope.id, id])
  }
  const token = randomBytes(32).toString('hex')
  await client.query(`
    INSERT INTO school_links (tenant_id, request_id, contact, email, purpose, digest, workshop_revision, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now() + interval '30 days'))
  `, [scope.id, id, contact, address, purpose, digest(token), workshop?.revision ?? null, workshop?.end ?? null])
  return token
}

function extractDetails(form: URLSearchParams) {
  const values = Object.fromEntries(Object.keys(detailLabels).map(key => [key, field(form, key)]))
  const address = field(form, 'email', 254).toLowerCase()
  if (address && !email.test(address)) throw new WorkflowError('Enter a valid contact email.', 400)
  if (address) values.email = address
  const phone = field(form, 'phone', 16)
  if (phone && !phonePattern.test(phone)) throw new WorkflowError('Use an international phone number such as +13055550123.', 400)
  if (phone) values.phone = phone
  return values
}

export async function newIntake(scope: Scope, form: URLSearchParams, actor?: Identity) {
  const source = actor ? field(form, 'channel') : 'website'
  if (actor) requireRole(canCoordinate(actor))
  if (!['website', 'phone', 'simulated_sms'].includes(source)) throw new WorkflowError('Choose a supported intake channel.', 400)
  const values = extractDetails(form)
  if (!values.school || !values.contact || !values.topic || (!actor && !values.email)) {
    throw new WorkflowError('Enter the school, contact, topic, and a contact email for web requests.', 400)
  }
  const body = Object.entries(detailLabels).map(([key, label]) => {
    const display = key === 'logistics' ? (values.format === 'Virtual' ? 'Virtual logistics' : 'Room logistics') : label
    return values[key] ? `${display}: ${values[key]}` : ''
  }).filter(Boolean).join('\n')
  const formId = field(form, 'submission', 36)
  if (!uuid.test(formId)) throw new WorkflowError('Reload the intake form and try again.', 400)
  return transaction(async client => {
    const active = await activeScope(client, scope.id)
    const { rows: [owner] } = await client.query<{ account_id: string }>(`
      SELECT account_id FROM memberships WHERE tenant_id = $1 AND role IN ('coordinator', 'tenant_admin')
      ORDER BY role, account_id LIMIT 1
    `, [scope.id])
    if (!actor && !owner) throw new WorkflowError('This workspace has no intake coordinator.', 503)
    return ingest(client, scope.id, actor?.id ?? owner.account_id, source, {
      id: formId, sender: values.email ?? values.contact, subject: 'School workshop request', body, phone: values.phone,
    }, active.language, undefined, values)
  })
}

export async function syncMail(scope: Scope, actor?: Identity) {
  if (actor) requireRole(canCoordinate(actor))
  const provider = await mailAdapter(scope.id)
  if (provider.name !== 'Gmail') throw new WorkflowError('Connect a Gmail test inbox in workspace settings first.')
  const { rows: [owner] } = await db.query<{ account_id: string }>(`
    SELECT account_id FROM memberships WHERE tenant_id = $1 AND role IN ('coordinator', 'tenant_admin')
    ORDER BY role, account_id LIMIT 1
  `, [scope.id])
  if (!owner && !actor) throw new WorkflowError('Assign an intake coordinator before syncing mail.')
  const messages = await provider.receive()
  for (const message of messages.reverse()) {
    await transaction(async client => {
      const active = await activeScope(client, scope.id)
      if (await mailVersion(scope.id, client) !== provider.version) throw new WorkflowError('The Gmail connection changed. Sync again.')
      await ingest(client, scope.id, actor?.id ?? owner.account_id, 'gmail', message, active.language, provider.version)
    })
  }
  return messages.length
}

function criteriaFrom(form: URLSearchParams, record: RecordState): Criteria {
  const amenities = ['projector', 'wifi', 'accessible']
  const required = form.getAll('required')
  const preferred = form.getAll('preferred')
  if ([...required, ...preferred].some(value => !amenities.includes(value))) throw new WorkflowError('Select valid room amenities.', 400)
  const radius = Number(field(form, 'radius') || 10)
  if (!Number.isFinite(radius)) throw new WorkflowError('Enter a valid search radius.', 400)
  return { zip: field(form, 'zip', 5), radius, capacity: Number(record.details.headcount), required, preferred }
}

async function workshopWindow(client: pg.PoolClient, scope: Scope, form: URLSearchParams) {
  return localWindow(client, scope, field(form, 'workshop_start'), field(form, 'workshop_end'))
}

async function offerSlots(client: pg.PoolClient, scope: Scope, form: URLSearchParams, simulated?: boolean) {
  const window = await localWindow(client, scope, field(form, 'planning_start'), field(form, 'planning_end'))
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  if (end - start > 8 * 3600000) throw new WorkflowError('Choose a planning window of up to eight hours.', 400)
  const calendar = await calendarAdapter(scope, client, simulated)
  const busy = await calendar.busy(window, client)
  const slots: Window[] = []
  for (let time = start; time + 30 * 60000 <= end && slots.length < 12; time += 30 * 60000) {
    const finish = time + 30 * 60000
    if (!busy.some(item => Date.parse(item.start) < finish && Date.parse(item.end) > time)) {
      slots.push({ start: new Date(time).toISOString(), end: new Date(finish).toISOString() })
    }
  }
  if (!slots.length) throw new WorkflowError('No free 30-minute slots in that window. Try different times.')
  return slots
}

async function book(client: pg.PoolClient, scope: Scope, record: RecordState, start: string, attendee?: string) {
  const slot = record.workflow.slots?.find(item => item.start === start)
  if (!slot || record.workflow.planning || Date.parse(start) <= Date.now()) {
    throw new WorkflowError('This planning slot is no longer available. Ask staff for new options.')
  }
  const pending = await client.query(`
    SELECT 1 FROM jobs WHERE tenant_id = $1 AND request_id = $2 AND kind = 'planning' AND state = 'pending'
  `, [scope.id, record.id])
  if (pending.rowCount) throw new WorkflowError('A planning call is already being booked.')
  const calendar = await calendarAdapter(scope, client, record.workflow.simulated)
  const operation = `planning:${calendar.version}:${start}`
  const existing = await client.query('SELECT state FROM jobs WHERE tenant_id = $1 AND request_id = $2 AND operation = $3', [scope.id, record.id, operation])
  if (existing.rowCount) throw new WorkflowError('This slot was already attempted. Staff can retry the job or offer a different slot.')
  await enqueue(client, scope.id, record.id, 'planning', operation, { slot, provider: calendar.version, attendee: attendee ?? record.details.email })
}

async function confirm(client: pg.PoolClient, scope: Scope, record: RecordState, origin: string) {
  const workshop = record.workflow.workshop
  const version = record.workflow.currentDeck
  if (record.status === 'confirmed') throw new WorkflowError('This workshop is already confirmed.')
  if (!workshop?.location || Date.parse(workshop.start) <= Date.now() || record.missing_fields.length ||
      !version || version !== record.workflow.sharedDeck) {
    throw new WorkflowError('Complete intake, save future workshop logistics, and share the current cleared deck first.')
  }
  const { rows: [deck] } = await client.query<{ contact: string; email: string }>(`
    SELECT l.contact, l.email FROM deck_versions v JOIN school_links l ON l.id = v.approved_by
      AND l.tenant_id = v.tenant_id AND l.request_id = v.request_id
    WHERE v.tenant_id = $1 AND v.request_id = $2 AND v.version = $3
      AND v.cleared_at IS NOT NULL AND v.shared_at IS NOT NULL AND v.approved_at IS NOT NULL AND NOT l.revoked
  `, [scope.id, record.id, version])
  if (!deck) throw new WorkflowError('The designated school approver must approve this exact deck version first.')
  const { rows: [dates] } = await client.query<{ reminder: Date; cutoff: Date }>(`
    SELECT ((($1::timestamptz AT TIME ZONE $2)::date - 1) + time '09:00') AT TIME ZONE $2 AS reminder,
      ((($1::timestamptz AT TIME ZONE $2)::date - 1) + time '17:00') AT TIME ZONE $2 AS cutoff
  `, [workshop.start, scope.timezone])
  invalidateConfirmation(record)
  const token = await createGrant(client, scope, record.id, 'logistics', deck.contact, deck.email, { revision: record.revision, end: workshop.end })
  record.status = 'confirmed'
  delete record.workflow.exception
  const payload = { revision: record.revision, to: deck.email, origin,
    provider: record.workflow.simulated ? 'simulated' : await mailVersion(scope.id, client) }
  await enqueue(client, scope.id, record.id, 'confirmation', `confirmation:${record.revision}`, payload)
  if (dates.cutoff.getTime() > Date.now()) {
    await enqueue(client, scope.id, record.id, 'reminder', `reminder:${record.revision}`, { ...payload, token, cutoff: dates.cutoff.toISOString() }, new Date(Math.max(dates.reminder.getTime(), Date.now() + 1000)))
    await enqueue(client, scope.id, record.id, 'cutoff', `cutoff:${record.revision}`, payload, dates.cutoff)
  } else {
    record.workflow.exception = 'The day-before reminder window has passed. Check logistics with the school.'
  }
}

export async function staffAction(workspace: Scope, identity: Identity, id: string, action: string, form: URLSearchParams, origin: string) {
  requireRole(['draft', 'clear', 'share'].includes(action) ? canReview(identity) : canCoordinate(identity))
  return transaction(async client => {
    const scope = await activeScope(client, workspace.id)
    const record = await lockRequest(client, scope.id, id)
    const workflow = record.workflow
    let message: string
    let token: string | undefined
    switch (action) {
      case 'details':
        if (await updateIntake(client, scope.id, record, assessDetails(extractDetails(form), scope.language))) {
          delete workflow.exception
        }
        message = 'Intake details saved'
        break
      case 'owner': {
        const owner = field(form, 'owner', 36)
        if (!uuid.test(owner)) throw new WorkflowError('Choose an active coordinator.', 400)
        const { rows: [member] } = await client.query<{ name: string }>(`
          SELECT a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.tenant_id = $1 AND m.account_id = $2 AND m.role IN ('coordinator', 'tenant_admin')
        `, [scope.id, owner])
        if (!member) throw new WorkflowError('Choose an active coordinator.', 400)
        await client.query('UPDATE requests SET owner_id = $3 WHERE tenant_id = $1 AND id = $2', [scope.id, id, owner])
        message = `Request assigned to ${member.name}`
        break
      }
      case 'pause':
        await client.query('UPDATE requests SET paused = NOT paused WHERE tenant_id = $1 AND id = $2', [scope.id, id])
        message = record.paused ? 'Automation resumed' : 'Automation paused'
        break
      case 'dismiss':
        delete workflow.exception
        message = 'Staff reviewed the exception'
        break
      case 'follow-up': {
        if (!record.proposed_follow_up) throw new WorkflowError('There are no missing details to ask about.')
        const operation = `follow_up:${record.revision}`
        const existing = await client.query('SELECT 1 FROM jobs WHERE tenant_id = $1 AND request_id = $2 AND operation = $3', [scope.id, id, operation])
        if (existing.rowCount) throw new WorkflowError('This draft was already queued. Check delivery status or use Retry.')
        const { rows: [first] } = await client.query<{ source: string }>(`SELECT source FROM intake_messages
          WHERE tenant_id = $1 AND request_id = $2 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1`, [scope.id, id])
        const provider = workflow.simulated ? 'simulated' : first?.source === 'sms'
          ? smsDeliveryVersion(scope) : await mailVersion(scope.id, client)
        await enqueue(client, scope.id, id, 'follow_up', operation, { revision: record.revision, provider })
        message = 'Follow-up queued by staff'
        break
      }
      case 'notes':
        workflow.planningNotes = field(form, 'notes', 2000)
        message = 'Planning notes saved'
        break
      case 'offer':
        if (workflow.planning) throw new WorkflowError('A planning call is already booked.')
        const unresolved = await client.query(`SELECT 1 FROM jobs WHERE tenant_id = $1 AND request_id = $2
          AND kind = 'planning' AND (state = 'pending' OR (state = 'failed' AND error LIKE 'planning: Calendar write could not be verified%'))`,
          [scope.id, id])
        if (unresolved.rowCount) throw new WorkflowError('Resolve the previous booking attempt before offering new slots.')
        workflow.slots = await offerSlots(client, scope, form, workflow.simulated)
        message = `Offered ${workflow.slots.length} planning slots`
        break
      case 'book':
        await book(client, scope, record, field(form, 'slot'))
        message = 'Planning call booking queued by staff'
        break
      case 'link': {
        const contact = field(form, 'contact', 100)
        const address = field(form, 'email', 254).toLowerCase()
        const purpose = field(form, 'purpose')
        if (!contact || !email.test(address) || (purpose !== 'approver' && purpose !== 'collaborator')) {
          throw new WorkflowError('Enter a school contact, email, and role.', 400)
        }
        if (purpose === 'approver' && record.status === 'confirmed') {
          throw new WorkflowError('Reopen the workshop before changing its designated approver.')
        }
        if (purpose === 'approver' && workflow.sharedDeck) {
          await client.query(`UPDATE deck_versions SET approved_by = NULL, approved_at = NULL
            WHERE tenant_id = $1 AND request_id = $2 AND version = $3`, [scope.id, id, workflow.sharedDeck])
        }
        token = await createGrant(client, scope, id, purpose, contact, address)
        message = `School link issued for ${contact} (${purpose})`
        break
      }
      case 'revoke': {
        const link = field(form, 'link', 36)
        if (!uuid.test(link)) throw new WorkflowError('Link not found.', 404)
        const { rows: [revoked] } = await client.query<{ purpose: Purpose }>(`
          UPDATE school_links SET revoked = true WHERE tenant_id = $1 AND request_id = $2 AND id = $3 AND NOT revoked
          RETURNING purpose`, [scope.id, id, link])
        if (!revoked) throw new WorkflowError('Link not found.', 404)
        if (revoked.purpose === 'approver') invalidateConfirmation(record)
        message = 'School link revoked'
        break
      }
      case 'workshop': {
        const window = await workshopWindow(client, scope, form)
        const mode = field(form, 'mode')
        const location = field(form, 'location')
        if (mode === 'virtual' ? record.details.format !== 'Virtual' || !/^https:\/\/[^\s]+$/i.test(location)
          : mode !== 'school' || record.details.format !== 'In person' || !location) {
          throw new WorkflowError('Enter a school room for an in-person workshop or an HTTPS meeting link for a virtual workshop.', 400)
        }
        if (JSON.stringify(workflow.workshop) === JSON.stringify({ ...window, mode: mode === 'virtual' ? 'virtual' : 'school', location })) return { message: 'Workshop logistics are current' }
        await client.query('DELETE FROM room_reservations WHERE tenant_id = $1 AND request_id = $2', [scope.id, id])
        workflow.workshop = { ...window, mode: mode === 'virtual' ? 'virtual' : 'school', location }
        invalidateConfirmation(record)
        message = 'Workshop logistics saved'
        break
      }
      case 'search': {
        if (record.details.format !== 'In person') throw new WorkflowError('Choose an in-person workshop before searching rooms.')
        const window = await workshopWindow(client, scope, form)
        const criteria = criteriaFrom(form, record)
        const rooms = await searchRooms(client, scope, id, window, criteria)
        return { message: 'Simulated venue search', rooms }
      }
      case 'reserve': {
        if (record.details.format !== 'In person') throw new WorkflowError('Choose an in-person workshop before reserving a room.')
        const window = await workshopWindow(client, scope, form)
        const location = await reserveRoom(client, scope, id, window, criteriaFrom(form, record), field(form, 'room'))
        workflow.workshop = { ...window, mode: 'room', location }
        invalidateConfirmation(record)
        message = 'Simulated room reserved'
        break
      }
      case 'draft': {
        const { rows: [latest] } = await client.query<Version>(`SELECT version, content FROM deck_versions
          WHERE tenant_id = $1 AND request_id = $2 ORDER BY version DESC LIMIT 1`, [scope.id, id])
        const version = (latest?.version ?? 0) + 1
        let deck = draftDeck(record, field(form, 'title', 150), field(form, 'activity', 2000), workflow.currentDeck === latest?.version ? latest?.content : undefined, field(form, 'template', 30))
        if (form.get('use_model') === 'yes') {
          const { rows: comments } = await client.query<{ body: string }>(`
            SELECT body FROM deck_comments WHERE tenant_id = $1 AND request_id = $2 AND version = $3 ORDER BY id LIMIT 20
          `, [scope.id, id, latest?.version ?? 0])
          deck = await modelDeck(deck, record.details.topic ?? '', record.details.grade ?? '',
            workflow.planningNotes ?? '', comments.map(item => item.body))
        }
        const object = await storeDeck(scope.id, deck)
        await client.query(`INSERT INTO deck_versions (tenant_id, request_id, version, object_key, checksum, content, author_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [scope.id, id, version, object.key, object.checksum, deck, identity.id])
        workflow.currentDeck = version
        delete workflow.sharedDeck
        invalidateConfirmation(record)
        message = `Drafted deck v${version}`
        break
      }
      case 'clear':
      case 'share': {
        const version = Number(field(form, 'version'))
        if (!version || version !== workflow.currentDeck) throw new WorkflowError('Open the current deck version and try again.')
        const result = action === 'clear'
          ? await client.query(`UPDATE deck_versions SET cleared_by = $4, cleared_at = now()
              WHERE tenant_id = $1 AND request_id = $2 AND version = $3 AND cleared_at IS NULL`, [scope.id, id, version, identity.id])
          : await client.query(`UPDATE deck_versions SET shared_at = now()
              WHERE tenant_id = $1 AND request_id = $2 AND version = $3 AND cleared_at IS NOT NULL AND shared_at IS NULL`, [scope.id, id, version])
        if (!result.rowCount) throw new WorkflowError('This action is unavailable. Share only a cleared current version.')
        if (action === 'share') workflow.sharedDeck = version
        message = `${action === 'share' ? 'Shared' : 'Cleared'} deck v${version}`
        break
      }
      case 'reopen':
        if (record.status !== 'confirmed') throw new WorkflowError('Only confirmed workshops can be reopened.')
        invalidateConfirmation(record)
        message = 'Workshop reopened by staff'
        break
      case 'confirm':
        await confirm(client, scope, record, origin)
        message = 'Workshop confirmed and delivery queued'
        break
      case 'demo-reminder': {
        if (record.status !== 'confirmed' || !workflow.workshop || Date.parse(workflow.workshop.start) <= Date.now()) {
          throw new WorkflowError('Confirm an upcoming workshop first.')
        }
        const { rows: [approver] } = await client.query<{ contact: string; email: string }>(`
          SELECT contact, email FROM school_links WHERE tenant_id = $1 AND request_id = $2 AND purpose = 'approver' AND NOT revoked
        `, [scope.id, id])
        if (!approver) throw new WorkflowError('Designate a school approver first.')
        const logisticsToken = await createGrant(client, scope, id, 'logistics', approver.contact, approver.email,
          { revision: record.revision, end: workflow.workshop.end })
        await enqueue(client, scope.id, id, 'reminder', `demo:${digest(logisticsToken)}`,
          { revision: record.revision, to: approver.email, origin, token: logisticsToken, simulated: true })
        message = 'Simulated day-before check queued'
        break
      }
      case 'retry': {
        const job = field(form, 'job', 36)
        if (!uuid.test(job)) throw new WorkflowError('Job not found.', 404)
        const result = await client.query(`UPDATE jobs SET state = 'pending', error = NULL, run_at = now()
          WHERE tenant_id = $1 AND request_id = $2 AND id = $3 AND state = 'failed'`, [scope.id, id, job])
        if (!result.rowCount) throw new WorkflowError('This job is not available to retry.')
        message = 'Delivery or booking retry queued'
        break
      }
      default: throw new WorkflowError('Action not found.', 404)
    }
    await saveWorkflow(client, scope.id, record)
    await note(client, scope.id, id, message)
    return { message, token }
  })
}

async function lookupGrant(client: pg.PoolClient | typeof db, scope: Scope, token: string) {
  const { rows: [grant] } = await client.query<Grant>(`
    SELECT id, request_id, contact, email, purpose, workshop_revision FROM school_links
    WHERE tenant_id = $1 AND digest = $2 AND NOT revoked AND expires_at > now()
  `, [scope.id, digest(token)])
  if (!grant) throw new WorkflowError('This school link is unavailable or expired.', 404)
  return grant
}

export async function schoolAccess(scope: Scope, token: string) {
  const grant = await lookupGrant(db, scope, token)
  const { rows: [record] } = await db.query<RecordState>('SELECT * FROM requests WHERE tenant_id = $1 AND id = $2', [scope.id, grant.request_id])
  const { rows: [deck] } = grant.purpose !== 'logistics' && record.workflow.sharedDeck ? await db.query<Version>(`
    SELECT version, approved_at FROM deck_versions WHERE tenant_id = $1 AND request_id = $2 AND version = $3 AND shared_at IS NOT NULL
  `, [scope.id, record.id, record.workflow.sharedDeck]) : { rows: [] }
  if (grant.purpose === 'logistics' && (record.status !== 'confirmed' || grant.workshop_revision !== record.revision)) throw new WorkflowError('This workshop is no longer confirmed. Contact your coordinator.')
  return { grant, record, deck }
}

export async function schoolAction(workspace: Scope, token: string, action: string, form: URLSearchParams) {
  return transaction(async client => {
    const scope = await activeScope(client, workspace.id)
    const initial = await lookupGrant(client, scope, token)
    const record = await lockRequest(client, scope.id, initial.request_id)
    const grant = await lookupGrant(client, scope, token)
    if (grant.purpose === 'logistics') {
      if (action !== 'logistics' || record.status !== 'confirmed' || grant.workshop_revision !== record.revision || !record.workflow.workshop ||
          Date.parse(record.workflow.workshop.start) <= Date.now()) throw new WorkflowError('This logistics check is no longer available.')
      const answer = field(form, 'answer')
      const change = field(form, 'change', 1500)
      if (!['confirmed', 'changed'].includes(answer) || (answer === 'changed' && !change)) {
        throw new WorkflowError('Confirm the logistics or describe the change.', 400)
      }
      record.workflow.reminder = answer as 'confirmed' | 'changed'
      if (answer === 'changed') record.workflow.exception = 'School reported a logistics change. Review the timeline.'
      else if (record.workflow.exception === 'No response to the day-before logistics check.') delete record.workflow.exception
      await note(client, scope.id, record.id, answer === 'changed' ? `${grant.contact} reported a logistics change: ${change}` : `${grant.contact} confirmed logistics`)
    } else if (action === 'details') {
      if (record.status === 'confirmed') throw new WorkflowError('Contact your coordinator to change a confirmed workshop.')
      const values = extractDetails(form)
      delete values.email
      await updateIntake(client, scope.id, record, assessDetails({ ...values, email: record.details.email, phone: record.details.phone }, scope.language))
      await note(client, scope.id, record.id, `${grant.contact} updated intake details`)
    } else if (action === 'book') {
      await book(client, scope, record, field(form, 'slot'), grant.email)
      await note(client, scope.id, record.id, `${grant.contact} selected a planning slot`)
    } else {
      const version = Number(field(form, 'version'))
      if (!version || version !== record.workflow.sharedDeck || version !== record.workflow.currentDeck) {
        throw new WorkflowError('This deck version changed. Open the link again to review the current version.')
      }
      if (action === 'comment') {
        const body = field(form, 'comment', 2000)
        if (!body) throw new WorkflowError('Enter feedback before submitting.', 400)
        await client.query('INSERT INTO deck_comments (tenant_id, request_id, version, contact_id, body) VALUES ($1, $2, $3, $4, $5)',
          [scope.id, record.id, version, grant.id, body])
        await note(client, scope.id, record.id, `${grant.contact} commented on deck v${version}`)
      } else if (action === 'approve' && grant.purpose === 'approver') {
        const updated = await client.query(`UPDATE deck_versions SET approved_by = $4, approved_at = now()
          WHERE tenant_id = $1 AND request_id = $2 AND version = $3 AND cleared_at IS NOT NULL
            AND shared_at IS NOT NULL AND approved_at IS NULL`, [scope.id, record.id, version, grant.id])
        if (updated.rowCount) await note(client, scope.id, record.id, `${grant.contact} approved deck v${version}`)
      } else throw new WorkflowError('This link does not grant that permission.', 403)
    }
    await saveWorkflow(client, scope.id, record)
  })
}

export async function deckFile(scope: Scope, id: string, version: number, token?: string) {
  if (token) {
    const access = await schoolAccess(scope, token)
    if (access.grant.request_id !== id || access.deck?.version !== version) throw new WorkflowError('This deck is unavailable.', 404)
  }
  const { rows: [deck] } = await db.query<Version>(`
    SELECT object_key, checksum FROM deck_versions WHERE tenant_id = $1 AND request_id = $2 AND version = $3
  `, [scope.id, id, version])
  if (!deck) throw new WorkflowError('This deck is unavailable.', 404)
  return readDeck(scope.id, deck.object_key, deck.checksum)
}
