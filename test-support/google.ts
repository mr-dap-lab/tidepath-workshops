import { readFileSync, writeFileSync } from 'node:fs'

const file = process.env.GOOGLE_FIXTURE_STATE
if (!file) throw new Error('GOOGLE_FIXTURE_STATE is required.')
const fixtureState = file
const gmail = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'].join(' ')
const calendar = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'].join(' ')

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  const state = JSON.parse(readFileSync(fixtureState, 'utf8'))
  const save = () => writeFileSync(fixtureState, JSON.stringify(state))
  if (url.hostname === 'model.example.test') {
    const { operation, data } = JSON.parse(String(init?.body))
    if (operation === 'intake') return Response.json({ fields: {}, uncertain: false })
    const { language, slides } = data.template
    slides[2].text = 'Una actividad propuesta con notas y comentarios.'
    return Response.json({ language, slides, uncertain: false })
  }
  if (url.hostname === 'sms.example.test') {
    if (init?.method !== 'PUT') return Response.json({}, { status: 405 })
    state.sms = { operation: url.pathname.split('/').at(-1), ...JSON.parse(String(init.body)) }
    save()
    return Response.json({ id: 'sms-delivery' })
  }
  if (url.hostname === 'oauth2.googleapis.com') {
    const params = init?.body as URLSearchParams
    if (params.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'refreshed' })
    const code = params.get('code')
    if (code === 'login-code') return Response.json({ access_token: 'verified', scope: 'openid https://www.googleapis.com/auth/userinfo.email' })
    return Response.json({ access_token: 'authorized', refresh_token: code, scope: code === 'calendar-code' ? calendar : gmail })
  }
  if (url.hostname === 'openidconnect.googleapis.com') {
    return Response.json({ sub: 'google-test-subject', email: 'test.staff@gmail.com', email_verified: true })
  }
  if (url.pathname.endsWith('/messages/send')) {
    state.sent = JSON.parse(String(init?.body))
    save()
    // The provider performed the write, but the client did not receive a successful response.
    return Response.json({}, { status: 503 })
  }
  if (url.pathname.endsWith('/messages')) {
    if (url.searchParams.get('q')?.startsWith('in:sent rfc822msgid:')) {
      return Response.json(state.sent ? { messages: [{ id: 'gmail-reply', threadId: 'school-thread' }] } : {})
    }
    if (url.searchParams.get('labelIds') !== 'Label_123') return Response.json({}, { status: 400 })
    return Response.json({ messages: [{ id: 'gmail-message' }] })
  }
  if (url.pathname.endsWith('/messages/gmail-message')) {
    return Response.json({
      id: 'gmail-message', threadId: 'school-thread',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'School Contact <school@example.test>' },
          { name: 'Subject', value: 'Workshop for our students' },
          { name: 'Message-ID', value: '<school-email@example.test>' },
        ],
        body: { data: Buffer.from('School: Test School\nContact: School Contact\nTopic: Planning\nCorrespondence language: English').toString('base64url') },
      },
    })
  }
  if (url.pathname.endsWith('/freeBusy')) return Response.json({ calendars: { primary: { busy: [] } } })
  if (url.pathname.endsWith('/events') && init?.method === 'POST') {
    state.event = JSON.parse(String(init.body))
    state.calendarWrites = (state.calendarWrites ?? 0) + 1
    save()
    return Response.json({}, { status: 503 })
  }
  if (url.pathname.includes('/events/')) {
    const event = state.event
    return event?.id === url.pathname.split('/').at(-1) ? Response.json(event) : Response.json({}, { status: 404 })
  }
  throw new Error(`Unexpected fixture request: ${url.pathname}`)
}
