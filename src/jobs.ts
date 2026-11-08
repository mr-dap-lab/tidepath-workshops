import type pg from 'pg'
import { db, transaction } from './db.ts'
import { calendarAdapter, mailAdapter, mailVersion, messageInternetId } from './google.ts'
import { sendSms, smsDeliveryVersion } from './sms.ts'
import { senderAddress } from './intake.ts'
import { digest, lockRequest, note, saveWorkflow, WorkflowError, type JobKind, type RecordState, type Scope, type Window } from './workflow-types.ts'

type Job = {
  id: string; tenant_id: string; request_id: string; kind: JobKind; operation: string; attempts: number; state: string
  payload: { revision?: number; to?: string; slot?: Window; origin?: string; token?: string; simulated?: boolean; provider?: string; attendee?: string; cutoff?: string }
}

const messageText = {
  English: {
    confirmed: 'Workshop confirmed', reminder: 'Day-before workshop logistics check', when: 'When', where: 'Where',
    check: 'Please confirm access to the room or virtual meeting, or report any changes:',
  },
  Spanish: {
    confirmed: 'Taller confirmado', reminder: 'Verificación de logística del taller', when: 'Cuándo', where: 'Dónde',
    check: 'Confirme el acceso a la sala o a la reunión virtual, o informe de cualquier cambio:',
  },
  'Haitian Creole': {
    confirmed: 'Atelye a konfime', reminder: 'Verifikasyon lojistik anvan atelye a', when: 'Kilè', where: 'Ki kote',
    check: 'Tanpri konfime aksè nan sal la oswa reyinyon vityèl la, oswa fè nou konnen nenpòt chanjman:',
  },
}

async function execute(client: pg.PoolClient, scope: Scope, record: RecordState, job: Job) {
  const workflow = record.workflow
  const { kind, payload } = job
  const operation = job.id
  if (kind === 'planning') {
    const slot = payload.slot
    if (!slot || workflow.planning || !workflow.slots?.some(item => item.start === slot.start && item.end === slot.end)) {
      return 'cancelled'
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope.id + ':calendar'])
    const provider = await calendarAdapter(scope, client, workflow.simulated)
    if (payload.provider !== provider.version) throw new WorkflowError('Calendar connection changed. Offer new slots or restore the previous connection.')
    const id = digest(operation)
    const existing = await provider.find(id)
    if (existing && (Date.parse(existing.start) !== Date.parse(slot.start) || Date.parse(existing.end) !== Date.parse(slot.end))) {
      throw new WorkflowError('The calendar event was edited externally. Review it in the connected calendar.')
    }
    if (!existing) {
      if (Date.parse(slot.start) <= Date.now()) throw new WorkflowError('The planning slot has passed. Offer new times.')
      if ((await provider.busy(slot, client)).length) throw new WorkflowError('The planning slot was taken. Offer new times.')
      try {
        await provider.create(id, slot, record.details.school ?? 'School', payload.attendee)
      } catch {
        throw new WorkflowError('Calendar write could not be verified. Retry to look up the event before creating another.')
      }
    }
    workflow.planning = { ...slot, eventId: id, provider: provider.name }
    delete workflow.slots
    await note(client, scope.id, record.id, `Planning call booked · ${provider.name}`)
    return 'done'
  }

  if (payload.revision !== record.revision) return 'cancelled'
  const workshop = workflow.workshop
  if (kind !== 'follow_up' && (record.status !== 'confirmed' || !workshop || Date.parse(workshop.start) <= Date.now())) return 'cancelled'
  if (kind === 'cutoff') {
    if (!workflow.reminder || workflow.reminder === 'sent') {
      const delivered = await client.query(`
        SELECT 1 FROM jobs WHERE tenant_id = $1 AND request_id = $2 AND operation = $3 AND state = 'done'
      `, [scope.id, record.id, `reminder:${record.revision}`])
      workflow.reminder = 'no_response'
      workflow.exception = delivered.rowCount ? 'No response to the day-before logistics check.' : 'The day-before logistics check did not reach the school before the cutoff.'
      await note(client, scope.id, record.id, workflow.exception)
    }
    return 'done'
  }
  if (kind === 'reminder' && !payload.simulated && (workflow.reminder === 'confirmed' || workflow.reminder === 'changed' ||
      (payload.cutoff && Date.parse(payload.cutoff) <= Date.now()))) return 'cancelled'
  if (kind === 'follow_up' && !record.proposed_follow_up) return 'cancelled'

  const { rows: messages } = await client.query<{ source: string; sender: string; subject: string; thread_id: string | null; internet_id: string | null }>(`
    SELECT source, sender, subject, thread_id, internet_id FROM intake_messages
    WHERE tenant_id = $1 AND request_id = $2 AND direction = 'inbound' ORDER BY received_at DESC, provider_event_id DESC
  `, [scope.id, record.id])
  const parent = messages[0]
  const followUp = kind === 'follow_up'
  const sms = followUp && parent?.source === 'sms'
  const to = followUp ? sms ? record.details.phone : record.details.email ?? senderAddress(parent?.sender ?? '') : payload.to
  const isFixture = parent?.source === 'simulated_email' || parent?.source === 'simulated_sms'
  const target = payload.simulated || isFixture ? 'simulated' : sms ? smsDeliveryVersion(scope) : await mailVersion(scope.id, client)
  if (payload.provider && payload.provider !== target) throw new WorkflowError('The delivery connection changed. Review the message before taking over.')
  const provider = target === 'simulated' || sms ? undefined : await mailAdapter(scope.id, client)
  if (!to && !isFixture) throw new WorkflowError('Add a valid school email before sending.')
  if (sms && to !== parent?.sender) throw new WorkflowError('Verify the original SMS sender before replying.')
  if (provider?.name === 'Gmail' && followUp && parent?.source === 'gmail' &&
      (!parent.thread_id || !parent.internet_id || senderAddress(parent.sender) !== to)) {
    throw new WorkflowError('Verify the Gmail sender and thread before replying.')
  }
  const language = (record.details.correspondence_language ?? scope.language) as keyof typeof messageText
  const words = messageText[language] ?? messageText.English
  const subject = followUp ? (parent?.subject.startsWith('Re: ') ? parent.subject : `Re: ${parent?.subject ?? 'Workshop inquiry'}`)
    : kind === 'confirmation' ? words.confirmed : words.reminder
  const date = new Intl.DateTimeFormat(language === 'Spanish' ? 'es' : language === 'Haitian Creole' ? 'ht' : 'en', {
    dateStyle: 'full', timeStyle: 'short', timeZone: scope.timezone,
  })
  const body = followUp ? record.proposed_follow_up! :
    `${words.when}: ${date.format(new Date(workshop!.start))} (${scope.timezone})\n${words.where}: ${workshop!.location}` +
    (kind === 'reminder' ? `\n\n${words.check}\n${payload.origin}/school/${payload.token}` : '')
  const liveSms = sms && target !== 'simulated'
  const simulated = !liveSms && (!provider || provider.name === 'Simulated mail')
  const found = provider?.name === 'Gmail' ? await provider.reconcile(operation) : undefined
  if (!found && provider?.name === 'Gmail' && job.attempts > 1) {
    throw new WorkflowError('Gmail delivery could not be verified. Check Sent before taking over to avoid a duplicate.')
  }
  const sent: { id: string; thread?: string } = found ?? (liveSms ? await sendSms(scope, operation, to!, body) : provider ? await provider.send(operation, {
    to: to ?? '', subject, body,
    thread: followUp && parent?.source === 'gmail' ? parent.thread_id ?? undefined : undefined,
    parent: followUp && parent?.source === 'gmail' ? parent.internet_id ?? undefined : undefined,
  }) : { id: digest(operation), thread: undefined })
  await client.query(`
    INSERT INTO intake_messages (tenant_id, request_id, source, provider_event_id, sender, subject, body, thread_id, internet_id, direction)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'outbound') ON CONFLICT DO NOTHING
  `, [scope.id, record.id, simulated ? sms ? 'simulated_sms' : 'simulated_mail' : sms ? 'sms' : 'gmail', sent.id, `To ${to ?? 'test inbox'}`, subject,
    body, sent.thread ?? null, messageInternetId(operation)])
  if (kind === 'reminder' && (!workflow.reminder || workflow.reminder === 'no_response')) workflow.reminder = 'sent'
  if (followUp) workflow.followUpRevision = record.revision
  await note(client, scope.id, record.id, `${subject} · ${simulated ? sms ? 'Simulated SMS' : 'Simulated mail' : sms ? 'SMS' : 'Gmail'}`)
  return 'done'
}

export async function runNextJob() {
  const { rows: [claimed] } = await db.query<Job>(`
    WITH candidate AS (
      SELECT j.id FROM jobs j JOIN requests r ON r.tenant_id = j.tenant_id AND r.id = j.request_id
        JOIN tenants t ON t.id = j.tenant_id
      WHERE j.state = 'pending' AND j.run_at <= now() AND NOT r.paused AND NOT t.suspended
      ORDER BY j.run_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE jobs j SET attempts = attempts + 1, run_at = now() + interval '5 minutes'
    FROM candidate c WHERE j.id = c.id RETURNING j.*
  `)
  if (!claimed) return false
  await transaction(async client => {
    const { rows: [scope] } = await client.query<Scope & { suspended: boolean }>(
      'SELECT id, slug, name, timezone, language, suspended FROM tenants WHERE id = $1 FOR SHARE', [claimed.tenant_id],
    )
    const record = await lockRequest(client, claimed.tenant_id, claimed.request_id)
    const { rows: [job] } = await client.query<Job>('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [claimed.id])
    if (job.state !== 'pending' || job.attempts !== claimed.attempts) return
    if (record.paused || scope.suspended) {
      await client.query('UPDATE jobs SET run_at = now(), attempts = attempts - 1 WHERE id = $1', [job.id])
      return
    }
    await client.query('SAVEPOINT before_job')
    try {
      const state = await execute(client, scope, record, job)
      await saveWorkflow(client, scope.id, record)
      await client.query('UPDATE jobs SET state = $2, error = NULL WHERE id = $1', [job.id, state])
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT before_job')
      const detail = error instanceof Error ? error.message.slice(0, 240) : 'Unexpected provider error.'
      const message = `${job.kind.replaceAll('_', ' ')}: ${detail}`
      await client.query('UPDATE jobs SET state = $2, error = $3 WHERE id = $1', [job.id, 'failed', message])
      await note(client, scope.id, record.id, message)
    }
  })
  return true
}
