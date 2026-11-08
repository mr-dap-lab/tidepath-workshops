import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'

const database = process.env.TEST_DATABASE_URL
const demoPassword = 'TidepathDemo2026!'

async function getPort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert(address && typeof address === 'object')
  listener.close()
  await once(listener, 'close')
  return address.port
}

function http(port: number, workspace: string, path: string, options: {
  cookie?: string
  form?: Record<string, string>
  origin?: string
  raw?: string
  signature?: string
} = {}) {
  const host = `${workspace ? workspace + '.' : ''}localhost:${port}`
  const body = options.raw ?? (options.form && new URLSearchParams(options.form).toString())
  return new Promise<{ status: number; body: string; cookie?: string; location?: string }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
      headers: {
        Host: host,
        ...(options.cookie && { Cookie: options.cookie }),
        ...(options.signature && { 'X-Tidepath-Signature': options.signature }),
        ...(body !== undefined && {
          Origin: options.origin ?? `http://${host}`,
          'Content-Type': options.raw === undefined ? 'application/x-www-form-urlencoded' : 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }),
      },
    }, async res => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of res) chunks.push(chunk)
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
          location: res.headers.location,
        })
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('isolates tenant records and runs a workshop from intake through logistics check', {
  skip: !database && 'Set TEST_DATABASE_URL to run against PostgreSQL',
  timeout: 40_000,
}, async () => {
  assert(database)
  const client = new pg.Client({ connectionString: database })
  await client.connect()
  const schema = 'tidepath_test_' + randomUUID().replaceAll('-', '')
  const storage = await mkdtemp(join(tmpdir(), 'tidepath-decks-'))
  let app: ChildProcess | undefined
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(database)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const port = await getPort()
    const googleState = join(storage, 'mock-google.json')
    await writeFile(googleState, '{}')
    const env = { ...process.env, DATABASE_URL: url.toString(), PORT: String(port),
      SMS_WEBHOOK_KEY: 'fixture-sms-signing-key-for-local-tests', SMS_RELAY_URL: 'https://sms.example.test', MODEL_ENDPOINT: 'https://model.example.test',
      GOOGLE_FIXTURE_STATE: googleState, GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret',
      GOOGLE_CALLBACK_URL: `http://localhost:${port}/google/callback`, GOOGLE_TOKEN_KEY: 'a'.repeat(64),
      APP_ORIGIN: `http://localhost:${port}`, DECK_STORAGE_DIR: storage }
    execFileSync(process.execPath, ['src/setup.ts'], { env })
    app = spawn(process.execPath, ['--import', './test-support/google.ts', 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    assert(app.stdout)
    await Promise.race([
      once(app.stdout, 'data'),
      once(app, 'exit').then(([code]) => { throw new Error(`Demo server exited with status ${code}`) }),
    ])

    const get = (workspace: string, path: string, cookie?: string) => http(port, workspace, path, { cookie })
    const post = (workspace: string, path: string, form: Record<string, string>, cookie?: string, origin?: string) =>
      http(port, workspace, path, { form, cookie, origin })
    async function signIn(workspace: string, email: string, password = demoPassword) {
      const result = await post(workspace, '/login', { email, password })
      assert.equal(result.status, 303, result.body)
      assert(result.cookie)
      return result.cookie
    }

    const tidepath = await signIn('tidepath', 'yesenia@example.test')
    const harbor = await signIn('harbor', 'harbor@example.test')
    const platform = await signIn('', 'platform@example.test')

    assert.equal((await post('harbor', '/login', { email: 'yesenia@example.test', password: demoPassword })).status, 401)
    assert.equal((await get('harbor', '/api/requests', tidepath)).status, 401)
    assert.equal((await get('tidepath', '/api/requests', platform)).status, 401)
    assert.equal((await post('tidepath', '/simulate', {}, tidepath, `http://harbor.localhost:${port}`)).status, 403)

    const replays = await Promise.all([
      post('tidepath', '/simulate', {}, tidepath),
      post('tidepath', '/simulate', {}, tidepath),
    ])
    assert.equal(replays[0].status, 303)
    assert.equal(replays[1].status, 303)
    const detail = replays[0].location
    assert(detail)
    assert.equal(replays[1].location, detail)
    const ownPage = await get('tidepath', detail, tidepath)
    assert.equal(ownPage.status, 200)
    assert.match(ownPage.body, /Proposed follow-up/)
    const ownApi = await get('tidepath', '/api' + detail, tidepath)
    assert.equal(ownApi.status, 200)
    const record = JSON.parse(ownApi.body)
    assert.deepEqual(record.missing_fields, ['Headcount', 'Availability', 'Room logistics'])
    assert.match(record.proposed_follow_up, /How many students.*Which dates and times.*Can you host at the school/s)
    assert.equal(JSON.parse((await get('tidepath', '/api/requests', tidepath)).body).length, 1)
    assert.deepEqual(JSON.parse((await get('harbor', '/api/requests', harbor)).body), [])
    assert.equal((await get('harbor', detail, harbor)).status, 404)
    assert.equal((await get('harbor', '/api' + detail, harbor)).status, 404)
    assert.equal((await get('', '/api' + detail, platform)).status, 404)

    const newWorkspace = {
      name: 'Bay Workshop Group', slug: 'bay', accent: '#315c50',
      admin_name: 'Sam Rivera', admin_email: 'sam@example.test', password: 'LocalDemoBay2026!',
    }
    assert.equal((await post('tidepath', '/admin/tenants', newWorkspace, tidepath)).status, 404)
    assert.equal((await post('', '/admin/tenants', newWorkspace, platform)).status, 303)
    assert.equal((await post('', '/admin/tenants', { ...newWorkspace, slug: 'other' }, platform)).status, 409)
    assert.equal((await get('other', '/')).status, 404)
    const bay = await signIn('bay', newWorkspace.admin_email, newWorkspace.password)
    const bayPage = await get('bay', '/', bay)
    assert.equal(bayPage.status, 200)
    assert.match(bayPage.body, /Bay Workshop Group/)
    assert.match(bayPage.body, /--brand:#315c50/)
    assert.equal((await post('bay', '/logout', {}, bay)).status, 303)
    assert.equal((await get('bay', '/api/requests', bay)).status, 401)

    const reviewer = await signIn('tidepath', 'reviewer@example.test')
    const admin = await signIn('tidepath', 'admin@example.test')
    assert.equal((await get('tidepath', '/settings', admin)).status, 200)
    assert.equal((await get('tidepath', '/settings', tidepath)).status, 403)
    const worker = () => execFileSync(process.execPath, ['--import', './test-support/google.ts', 'src/worker.ts', '--once'], { env })
    const step = async (path: string, form: Record<string, string> = {}, cookie = tidepath, expected = 303) => {
      const result = await post('tidepath', path, form, cookie)
      assert.equal(result.status, expected, result.body.match(/<p class="alert"[^>]*>([^<]*)/)?.[1] ?? result.body.slice(0, 1000))
      return result
    }
    const view = async () => JSON.parse((await get('tidepath', '/api' + detail, tidepath)).body)
    const times = (days: number, hour: number) =>
      new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + `T${hour}:00`
    const details = {
      ...record.details, headcount: '30', availability: 'Weekday afternoons', logistics: 'Projector and a room for 30',
    }

    await step(detail + '/pause')
    await step(detail + '/follow-up')
    worker()
    assert.equal((await view()).workflow.followUpRevision, undefined)
    await step(detail + '/pause')
    worker()
    assert.equal((await view()).workflow.followUpRevision, 0)
    await step(detail + '/details', details)

    async function makeLink(contact: string, purpose: string) {
      const result = await step(detail + '/link', { contact, purpose, email: 'school@example.test' }, tidepath, 201)
      const link = result.body.match(/href="(\/school\/[a-f0-9]{64}|http:\/\/[^"]+\/school\/[a-f0-9]{64})"/)?.[1]
      assert(link)
      return new URL(link, 'http://localhost').pathname
    }
    const collaborator = await makeLink('Jamie School', 'collaborator')
    const approver = await makeLink('Elena Torres', 'approver')
    assert.equal((await get('harbor', approver)).status, 404)
    await step(detail + '/offer', { planning_start: times(3, 10), planning_end: times(3, 12) })
    const { workflow: { slots } } = await view()
    await step(approver + '/book', { slot: slots[0].start }, '')
    assert.equal((await view()).workflow.planning, undefined)
    worker()
    assert.equal((await view()).workflow.planning.start, slots[0].start)
    assert.equal((await view()).status, 'ready_for_planning')

    const room = { workshop_start: times(5, 14), workshop_end: times(5, 15), zip: '33134', radius: '10', required: 'projector', room: 'grove' }
    const search = await step(detail + '/search', room, tidepath, 200)
    assert.match(search.body, /Occupied/)
    assert.match(search.body, /Too small/)
    assert.match(search.body, /Missing required equipment/)
    const another = await step('/intake/staff', { ...details, submission: randomUUID(), channel: 'phone' })
    const other = another.location
    assert(other)
    const overlaps = await Promise.all([post('tidepath', detail + '/reserve', room, tidepath),
      post('tidepath', other + '/reserve', room, tidepath)])
    assert.deepEqual(overlaps.map(result => result.status).sort(), [303, 409])
    if (overlaps[0].status === 409) await step(detail + '/reserve', { ...room, room: 'river' })
    await step(detail + '/confirm', {}, tidepath, 409)

    await step(detail + '/draft', {}, tidepath, 403)
    await step(detail + '/draft', {}, reviewer)
    await step(detail + '/share', { version: '1' }, reviewer, 409)
    assert.equal((await get('tidepath', approver + '/deck/1')).status, 404)
    await step(detail + '/clear', { version: '1' }, reviewer)
    await step(detail + '/share', { version: '1' }, reviewer)
    const original = await get('tidepath', approver + '/deck/1')
    assert.equal(original.status, 200)
    assert.match(original.body, /Practiquemos en equipo/)
    assert.equal((await get('harbor', detail + '/deck/1', harbor)).status, 404)
    await step(collaborator + '/comment', { version: '1', comment: 'Añada una actividad breve.' }, '')
    await step(approver + '/comment', { version: '1', comment: 'Incluya un ejemplo para octavo grado.' }, '')
    await step(collaborator + '/approve', { version: '1' }, '', 403)
    await step(approver + '/approve', { version: '1' }, '')
    await step(detail + '/draft', { activity: 'Escuchen y ensayen una conversación en parejas.' }, reviewer)
    await step(approver + '/approve', { version: '1' }, '', 409)
    await step(detail + '/confirm', {}, tidepath, 409)
    await step(detail + '/clear', { version: '2' }, reviewer)
    await step(detail + '/share', { version: '2' }, reviewer)
    await step(approver + '/approve', { version: '2' }, '')
    assert.match((await get('tidepath', approver + '/deck/2')).body, /ensayen una conversación/)
    assert.equal((await get('tidepath', detail + '/deck/1', reviewer)).body, original.body)
    await step(detail + '/confirm')
    worker()
    assert.equal((await view()).status, 'confirmed')
    const staffPage = await get('tidepath', detail, tidepath)
    assert.match(staffPage.body, /Approved by Elena Torres/)
    assert.match(staffPage.body, /Añada una actividad breve/)
    assert.match(staffPage.body, /Incluya un ejemplo para octavo grado/)

    await step(detail + '/demo-reminder')
    worker()
    const delivery = await get('tidepath', detail, tidepath)
    assert.equal((await view()).workflow.reminder, 'sent')
    const logistics = delivery.body.match(/http:\/\/tidepath\.localhost:\d+(\/school\/[a-f0-9]{64})/)?.[1]
    assert(logistics)
    assert.equal((await get('tidepath', logistics + '/deck/2')).status, 404)
    await step(logistics + '/logistics', { answer: 'changed', change: 'Use the west entrance.' }, '')
    assert.equal((await view()).workflow.reminder, 'changed')
    assert.match((await view()).exception, /School reported/)
    await step(detail + '/reopen')
    await step(logistics + '/logistics', { answer: 'confirmed' }, '', 409)
    assert.equal((await view()).status, 'ready_for_planning')
    await step(detail + '/confirm')
    worker()
    await client.query(`UPDATE ${schema}.jobs SET run_at = now() - interval '1 second'
      WHERE request_id = $1 AND kind = 'cutoff' AND state = 'pending'`, [record.id])
    worker()
    assert.equal((await view()).workflow.reminder, 'no_response')
    assert.match((await view()).exception, /did not reach the school/)

    async function authorize(kind: string, cookie: string, code: string) {
      const start = await step('/google/start/' + kind, {}, cookie)
      assert(start.cookie && start.location)
      const state = new URL(start.location).searchParams.get('state')
      assert(state)
      const relay = await get('', '/google/callback?' + new URLSearchParams({ state, code }))
      assert.equal(relay.status, 303)
      assert(relay.location)
      const url = new URL(relay.location)
      const rejected = await get('tidepath', url.pathname + url.search, cookie)
      assert.equal(rejected.status, 403)
      return get('tidepath', url.pathname + url.search, [cookie, start.cookie].filter(Boolean).join('; '))
    }
    const mail = await authorize('mail', admin, 'mail-code')
    assert.equal(mail.location, '/settings?connected=1', mail.body)
    const calendar = await authorize('calendar', admin, 'calendar-code')
    assert.equal(calendar.location, '/settings?connected=1', calendar.body)
    await step('/settings/provider', { kind: 'mail', resource: 'Label_123' }, admin)
    await step('/settings/member', { email: 'test.staff@gmail.com', name: 'Google Staff', password: demoPassword, role: 'coordinator' }, admin)
    const signInGoogle = await authorize('login', '', 'login-code')
    assert.equal(signInGoogle.location, '/', signInGoogle.body)

    await step('/sync-mail')
    await step('/sync-mail')
    const requests = JSON.parse((await get('tidepath', '/api/requests', tidepath)).body)
    assert.equal(requests.filter((request: { source: string }) => request.source === 'gmail').length, 1)
    const incoming = requests.find((request: { source: string }) => request.source === 'gmail')
    const gmailPath = '/requests/' + incoming.id
    worker()
    async function retry(kind: string) {
      const { rows: [job] } = await client.query<{ id: string }>(
        `SELECT id FROM ${schema}.jobs WHERE request_id = $1 AND kind = $2 AND state = 'failed'`, [incoming.id, kind],
      )
      assert(job, `Expected a failed ${kind} job`)
      await step(gmailPath + '/retry', { job: job.id })
      worker()
    }
    await retry('follow_up')
    let fixture = JSON.parse(await readFile(googleState, 'utf8'))
    assert.equal(fixture.sent.threadId, 'school-thread')
    const raw = Buffer.from(fixture.sent.raw, 'base64url').toString()
    assert.match(raw, /^In-Reply-To: <school-email@example.test>$/m)
    assert.match(raw, /^References: <school-email@example.test>$/m)
    assert.match((await get('tidepath', gmailPath, tidepath)).body, /Re: Workshop for our students/)

    await step(gmailPath + '/offer', { planning_start: times(3, 15), planning_end: times(3, 17) })
    const liveView = async () => JSON.parse((await get('tidepath', '/api' + gmailPath, tidepath)).body)
    const liveSlot = (await liveView()).workflow.slots[0]
    await step(gmailPath + '/book', { slot: liveSlot.start })
    worker()
    assert.equal((await liveView()).workflow.planning, undefined)
    await retry('planning')
    assert.equal((await liveView()).workflow.planning.provider, 'Google Calendar')
    fixture = JSON.parse(await readFile(googleState, 'utf8'))
    assert.equal(fixture.calendarWrites, 1)
    assert.equal(fixture.event.attendees[0].email, 'school@example.test')

    const publicIntake = { ...details, school: 'Website School', submission: randomUUID() }
    assert.equal((await post('tidepath', '/intake', publicIntake)).status, 303)
    assert.equal((await post('tidepath', '/intake', publicIntake)).status, 303)
    const smsBody = JSON.stringify({
      id: 'sms-fixture', from: '+13055550123', sentAt: new Date().toISOString(), thread: 'test-conversation',
      body: 'Lekòl: Lekòl Egzanp\nKontak: Manuela\nSijè: Kominikasyon\nLang korespondans: Kreyòl ayisyen\nLang atelye a: Kreyòl ayisyen',
    })
    const key = createHmac('sha256', env.SMS_WEBHOOK_KEY).update('tidepath').digest('hex')
    const signature = createHmac('sha256', key).update(smsBody).digest('hex')
    assert.equal((await http(port, 'tidepath', '/api/sms/inbound', { raw: smsBody })).status, 403)
    assert.equal((await http(port, 'harbor', '/api/sms/inbound', { raw: smsBody, signature })).status, 403)
    assert.equal((await http(port, 'tidepath', '/api/sms/inbound', { raw: smsBody, signature })).status, 202)
    assert.equal((await http(port, 'tidepath', '/api/sms/inbound', { raw: smsBody, signature })).status, 202)
    worker()
    const intake = JSON.parse((await get('tidepath', '/api/requests', tidepath)).body)
    assert.equal(intake.filter((item: { source: string }) => item.source === 'website').length, 1)
    assert.equal(intake.filter((item: { source: string }) => item.source === 'sms').length, 1)
    const sms = intake.find((item: { source: string }) => item.source === 'sms')
    assert.equal(sms.details.correspondence_language, 'Haitian Creole')
    assert.match(sms.proposed_follow_up, /Konbyen elèv/)
    assert.equal(sms.follow_up_sent, true)
    const adapters = JSON.parse(await readFile(googleState, 'utf8'))
    assert.equal(adapters.sms.to, '+13055550123')
    assert.match(adapters.sms.body, /Konbyen elèv/)
    await step(other + '/draft', { template: 'coping', use_model: 'yes' }, reviewer)
    const modelDraft = await get('tidepath', other + '/deck/1', reviewer)
    assert.equal(modelDraft.status, 200)
    assert.match(modelDraft.body, /Una actividad propuesta/)
    assert.match(modelDraft.body, /Estrategias para manejar el estrés/)

    assert.equal((await post('', '/admin/suspension', { slug: 'tidepath' }, platform)).status, 303)
    assert.equal((await get('tidepath', '/api' + detail, tidepath)).status, 404)
    assert.equal((await post('', '/admin/suspension', { slug: 'tidepath' }, platform)).status, 303)
    assert.equal((await get('tidepath', '/api' + detail, tidepath)).status, 200)
  } finally {
    if (app?.pid && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit')
      app.kill()
      await exited
    }
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
      await rm(storage, { recursive: true, force: true })
    }
  }
})
