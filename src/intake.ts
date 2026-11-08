import { randomUUID } from 'node:crypto'
import { db, transaction } from './db.ts'
import type pg from 'pg'
import { activeScope, email, enqueue, invalidateConfirmation, lockRequest, note, phonePattern, saveWorkflow, type Workflow, type RecordState } from './workflow-types.ts'
import type { IncomingMail } from './google.ts'
import { modelIntake } from './model.ts'

const source = 'simulated_email'
export const fixture = {
  id: 'school-workshop-001',
  sender: 'Elena Torres <elena@example.test>',
  subject: 'Workshop for our eighth graders',
  body: `Hi, could you help us plan a workshop for our eighth graders?

School: Biscayne Grove Middle School
Contact: Elena Torres
Topic: Family communication and coping skills
Age or grade: 8th grade
Correspondence language: English
Workshop language: Spanish
Format: In person

Thanks,
Elena`,
}

const intakeFields = [
  ['school', 'School', 'What is the name of your school?'],
  ['contact', 'Contact', 'Who should we coordinate with at the school?'],
  ['topic', 'Topic', 'What topic would you like the workshop to cover?'],
  ['grade', 'Age or grade', 'What age group or grade will attend?'],
  ['headcount', 'Headcount', 'How many students do you expect?'],
  ['correspondence_language', 'Correspondence language', 'Which language should we use in our correspondence?'],
  ['workshop_language', 'Workshop language', 'Which language should we deliver the workshop in?'],
  ['format', 'Format', 'Would you prefer an in-person or virtual workshop?'],
  ['availability', 'Availability', 'Which dates and times work for your group?'],
] as const

const inPersonLogistics = ['logistics', 'Room logistics', 'Can you host at the school, or should we look for a room? Please share any equipment or accessibility needs.'] as const
const virtualLogistics = ['logistics', 'Virtual logistics', 'Who should host the virtual meeting, and are there any access or accessibility needs?'] as const

export const detailLabels: Record<string, string> = Object.fromEntries(
  [...intakeFields, inPersonLogistics].map(([key, label]) => [key, key === 'logistics' ? 'Logistics' : label]),
)

const localized: Record<string, string[]> = {
  Spanish: [
    'Hola', 'Gracias por escribirnos. ¿Podría compartir estos datos para que podamos planificar el taller?',
    '¿Cómo se llama su escuela?', '¿Con quién debemos coordinar?', '¿Qué tema desean tratar?',
    '¿Qué edad o grado tiene el grupo?', '¿Cuántos estudiantes esperan?', '¿En qué idioma prefiere la correspondencia?',
    '¿En qué idioma debemos impartir el taller?', '¿Prefiere un taller presencial o virtual?',
    '¿Qué fechas y horas le sirven al grupo?', '¿Pueden recibirnos en la escuela o buscamos una sala? Indique las necesidades de equipo y accesibilidad.',
    '¿Quién organizará la reunión virtual? Indique las necesidades de acceso y accesibilidad.', 'Gracias,\nEl equipo de talleres',
  ],
  'Haitian Creole': [
    'Bonjou', 'Mèsi paske ou kontakte nou. Èske ou ka voye enfòmasyon sa yo pou nou planifye atelye a?',
    'Ki non lekòl la?', 'Ak kiyès nou dwe kowòdone?', 'Ki sijè nou ta dwe abòde?',
    'Ki laj oswa klas gwoup la?', 'Konbyen elèv w ap tann?', 'Nan ki lang ou vle nou kominike?',
    'Nan ki lang nou dwe fè atelye a?', 'Èske ou prefere yon atelye an pèsòn oswa vityèl?',
    'Ki dat ak lè ki bon pou gwoup la?', 'Èske nou ka fè atelye a nan lekòl la, oswa èske nou dwe chèche yon sal? Bay bezwen ekipman ak aksesibilite yo.',
    'Kiyès k ap òganize reyinyon vityèl la? Bay bezwen aksè ak aksesibilite yo.', 'Mèsi,\nEkip atelye a',
  ],
}

export function assessDetails(values: Record<string, string>, defaultLanguage = 'English') {
  const aliases: Record<string, string> = {
    english: 'English', 'inglés': 'English', 'anglè': 'English', spanish: 'Spanish', 'español': 'Spanish', 'panyòl': 'Spanish',
    'haitian creole': 'Haitian Creole', 'criollo haitiano': 'Haitian Creole', 'kreyòl ayisyen': 'Haitian Creole',
    'in person': 'In person', presencial: 'In person', 'an pèsòn': 'In person', virtual: 'Virtual', 'vityèl': 'Virtual',
  }
  values = { ...values }
  for (const key of ['format', 'workshop_language', 'correspondence_language']) {
    values[key] = aliases[values[key]?.toLowerCase()] ?? values[key]
  }
  const format = values.format?.toLowerCase()
  const applicable = format === 'in person' ? [...intakeFields, inPersonLogistics]
    : format === 'virtual' ? [...intakeFields, virtualLogistics] : intakeFields
  const details: Record<string, string> = {}
  const missingFields: string[] = []
  const questions: string[] = []
  const words = localized[values.correspondence_language || defaultLanguage]
  for (const [index, [key, label, question]] of applicable.entries()) {
    const value = values[key]
    const valid = value && (key !== 'format' || format === 'in person' || format === 'virtual') &&
      (key !== 'headcount' || (/^[1-9]\d{0,3}$/.test(value))) &&
      (!key.endsWith('_language') || ['English', 'Spanish', 'Haitian Creole'].includes(value))
    if (valid) details[key] = key === 'format' ? (format === 'virtual' ? 'Virtual' : 'In person') : value
    else {
      missingFields.push(label)
      questions.push(words?.[format === 'virtual' && key === 'logistics' ? 12 : index + 2] ?? question)
    }
  }
  if (values.email) details.email = values.email
  if (values.phone) details.phone = values.phone
  const greeting = words?.[0] ?? (details.contact ? 'Hi' : 'Hello')
  const proposedFollowUp = questions.length ? [
    `${greeting}${details.contact ? ' ' + details.contact.split(/\s+/)[0] : ''},`,
    words?.[1] ?? 'Thanks for reaching out about a workshop. Could you share a few details so we can plan it with you?',
    questions.map(question => `- ${question}`).join('\n'),
    words?.[13] ?? 'Thanks,\nThe workshop team',
  ].join('\n\n') : null
  return { details, missingFields, proposedFollowUp }
}

export function proposeIntake(body: string, defaultLanguage = 'English', prior: Record<string, string> = {}) {
  const values = { ...prior }
  const labels = new Map([...intakeFields, inPersonLogistics, virtualLogistics].map(([key, label]) => [label.toLowerCase(), key]))
  const labelsByLanguage = [
    ['Escuela', 'Contacto', 'Tema', 'Edad o grado', 'Número de estudiantes', 'Idioma de correspondencia', 'Idioma del taller', 'Formato', 'Disponibilidad', 'Logística'],
    ['Lekòl', 'Kontak', 'Sijè', 'Laj oswa klas', 'Kantite elèv', 'Lang korespondans', 'Lang atelye a', 'Fòma', 'Disponibilite', 'Lojistik'],
  ]
  for (const translated of labelsByLanguage) translated.forEach((label, index) =>
    labels.set(label.toLowerCase(), ([...intakeFields, inPersonLogistics][index])[0]))
  for (const line of body.split(/\r?\n/)) {
    if (/^(On .+wrote:|El .+escribió:|-----Original Message-----|>)/i.test(line)) break
    const match = /^([^:]+):\s*(.+)$/.exec(line)
    const key = match && labels.get(match[1].trim().toLowerCase())
    if (key && match) values[key] = match[2].trim().slice(0, 300)
  }
  return assessDetails(values, defaultLanguage)
}

export function senderAddress(sender: string) {
  const address = (/<([^<>]+)>\s*$/.exec(sender)?.[1] ?? sender).trim().toLowerCase()
  return email.test(address) ? address : undefined
}

export async function updateIntake(client: pg.PoolClient, tenantId: string, record: RecordState, result: ReturnType<typeof assessDetails>) {
  const { details, missingFields, proposedFollowUp } = result
  if (JSON.stringify(Object.entries(details).sort()) === JSON.stringify(Object.entries(record.details).sort())) return false
  if (record.details.workshop_language !== details.workshop_language || record.details.topic !== details.topic ||
      record.details.grade !== details.grade || record.details.school !== details.school) {
    delete record.workflow.currentDeck
    delete record.workflow.sharedDeck
  }
  const capacityChanged = record.details.headcount !== details.headcount && record.workflow.workshop?.mode === 'room'
  const invalidRoom = capacityChanged && Boolean((await client.query(`
    SELECT 1 FROM room_reservations r JOIN venue_rooms v ON v.tenant_id = r.tenant_id AND v.id = r.room_id
    WHERE r.tenant_id = $1 AND r.request_id = $2 AND v.capacity < $3
  `, [tenantId, record.id, Number(details.headcount || 10000)])).rowCount)
  if (record.details.format !== details.format || invalidRoom) {
    await client.query('DELETE FROM room_reservations WHERE tenant_id = $1 AND request_id = $2', [tenantId, record.id])
    if (record.workflow.workshop) record.workflow.workshop = { start: record.workflow.workshop.start, end: record.workflow.workshop.end }
  }
  record.status = missingFields.length ? 'awaiting_details' : 'ready_for_planning'
  invalidateConfirmation(record)
  await client.query(`UPDATE requests SET details = $3, missing_fields = $4, proposed_follow_up = $5
    WHERE tenant_id = $1 AND id = $2`, [tenantId, record.id, details, missingFields, proposedFollowUp])
  return true
}

export async function ingest(client: pg.PoolClient, tenantId: string, ownerId: string, source: string,
  input: IncomingMail, defaultLanguage = 'English', provider?: string, structured?: Record<string, string>) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:${source}:${input.thread ?? input.id}`])
  const { rows: [known] } = await client.query<{ request_id: string }>(
    'SELECT request_id FROM intake_messages WHERE tenant_id = $1 AND source = $2 AND provider_event_id = $3',
    [tenantId, source, input.id],
  )
  if (known) return known.request_id

  const { rows: matches } = input.thread ? await client.query<{ request_id: string; sender: string }>(`
    SELECT DISTINCT request_id, sender FROM intake_messages
    WHERE tenant_id = $1 AND source = $2 AND thread_id = $3 AND direction = 'inbound'
  `, [tenantId, source, input.thread]) : { rows: [] }
  const senderKey = (value: string) => source === 'sms' ? (phonePattern.test(value) ? value : undefined) : senderAddress(value)
  const address = senderKey(input.sender)
  const matchedIds = [...new Set(matches.map(item => item.request_id))]
  const ambiguous = matches.length > 0 && (matchedIds.length !== 1 || !address || matches.some(item => senderKey(item.sender) !== address))
  const previous = matchedIds.length === 1 && !ambiguous ? await lockRequest(client, tenantId, matchedIds[0]) : undefined
  const id = previous?.id ?? randomUUID()
  const proposal = (source === 'gmail' || source === 'sms') && !ambiguous && !input.uncertain
    ? await modelIntake(input.body, Object.keys(detailLabels)) : undefined
  const result = structured ? assessDetails(structured, defaultLanguage)
    : proposeIntake(input.body, defaultLanguage, { ...previous?.details, ...proposal?.fields })
  const { details, missingFields, proposedFollowUp } = result
  if (address) details[source === 'sms' ? 'phone' : 'email'] = address
  if (input.phone) details.phone = input.phone
  const status = missingFields.length ? 'awaiting_details' : 'ready_for_planning'
  const review = ambiguous ? 'Ambiguous conversation. Verify the school contact before merging or replying.'
    : ['gmail', 'sms'].includes(source) && (input.uncertain || proposal?.uncertain || (source === 'gmail' && !input.internetId) ||
      !address || !details.school || !details.contact || !details.correspondence_language)
      ? 'Intake needs staff review before any reply is sent.' : undefined
  let changed = true
  if (!previous) {
    await client.query(`
      INSERT INTO requests (id, tenant_id, owner_id, status, details, missing_fields, proposed_follow_up, workflow)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, tenantId, ownerId, status, details, missingFields, proposedFollowUp, { exception: review }])
  } else if (previous.status !== 'confirmed') {
    changed = await updateIntake(client, tenantId, previous, result)
    if (review || changed) previous.workflow.exception = review
    if (review && !changed) previous.revision++
    await saveWorkflow(client, tenantId, previous)
  } else {
    previous.workflow.exception = 'New school correspondence on a confirmed workshop. Review any changes.'
    await saveWorkflow(client, tenantId, previous)
  }

  await client.query(`
    INSERT INTO intake_messages (tenant_id, request_id, source, provider_event_id, sender, subject, body, thread_id, internet_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [tenantId, id, source, input.id, input.sender, input.subject, input.body, input.thread ?? null, input.internetId ?? null])
  await note(client, tenantId, id, review ?? `Intake received · ${source.replaceAll('_', ' ')}`)
  if (['gmail', 'sms'].includes(source) && changed && proposedFollowUp && !review && previous?.status !== 'confirmed') {
    const revision = previous?.revision ?? 0
    await enqueue(client, tenantId, id, 'follow_up', `follow_up:${revision}`, { revision, provider })
  }
  return id
}

export function simulateIntake(tenantId: string, ownerId: string) {
  return transaction(async client => {
    await activeScope(client, tenantId)
    return ingest(client, tenantId, ownerId, 'simulated_email', fixture)
  })
}

export type WorkshopRequest = {
  id: string
  status: 'awaiting_details' | 'ready_for_planning' | 'confirmed'
  workflow: Workflow
  paused: boolean
  exception?: string
  owner_id: string
  ready_to_confirm: boolean
  follow_up_sent: boolean
  source: string
  details: Record<string, string>
  missing_fields: string[]
  proposed_follow_up: string | null
  created_at: Date
  owner: string
  sender: string
  subject: string
  body: string
}

export async function listRequests(tenantId: string, id?: string) {
  const { rows } = await db.query<WorkshopRequest>(`
    SELECT r.id, r.owner_id, r.status, r.details, r.missing_fields, r.proposed_follow_up,
      r.created_at, a.name AS owner, m.sender, m.subject, m.body, m.source, r.workflow, r.paused,
      COALESCE(r.workflow->>'followUpRevision' = r.revision::text, false) AS follow_up_sent,
      EXISTS (SELECT 1 FROM deck_versions v JOIN school_links l ON l.id = v.approved_by
        AND l.tenant_id = v.tenant_id AND l.request_id = v.request_id
        WHERE v.tenant_id = r.tenant_id AND v.request_id = r.id AND v.version::text = r.workflow->>'currentDeck'
        AND v.version::text = r.workflow->>'sharedDeck' AND v.cleared_at IS NOT NULL
        AND v.shared_at IS NOT NULL AND v.approved_at IS NOT NULL AND NOT l.revoked) AS ready_to_confirm,
      COALESCE(r.workflow->>'exception', (SELECT error FROM jobs j WHERE j.tenant_id = r.tenant_id
        AND j.request_id = r.id AND j.state = 'failed'
        AND ((j.kind = 'planning' AND r.workflow->'planning' IS NULL) OR j.payload->>'revision' = r.revision::text)
        ORDER BY j.run_at DESC LIMIT 1)) AS exception
    FROM requests r
    JOIN accounts a ON a.id = r.owner_id
    JOIN LATERAL (
      SELECT * FROM intake_messages m WHERE m.request_id = r.id AND m.tenant_id = r.tenant_id
        AND m.direction = 'inbound' ORDER BY m.received_at, m.provider_event_id LIMIT 1
    ) m ON true
    WHERE r.tenant_id = $1 AND ($2::uuid IS NULL OR r.id = $2)
    ORDER BY r.created_at DESC
  `, [tenantId, id ?? null])
  return rows
}
