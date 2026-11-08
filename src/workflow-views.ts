import { randomUUID } from 'node:crypto'
import type { Identity } from './auth.ts'
import type { WorkshopRequest } from './intake.ts'
import { detailLabels } from './intake.ts'
import { backLink, button, escape as h, icon, layout, type Tenant } from './views.ts'
import { canCoordinate, canReview, type detailsForStaff, type schoolAccess } from './workflow.ts'
import { languages, type Scope } from './workflow-types.ts'
import { venueZips, type searchRooms } from './venues.ts'
import { modelEnabled } from './model.ts'
import type { settings, Workspace } from './settings.ts'

type RoomResults = Awaited<ReturnType<typeof searchRooms>>
type StaffData = Awaited<ReturnType<typeof detailsForStaff>>

const action = (path: string, content: string, label: string, primary = false) =>
  `<form method="post" action="${h(path)}" class="fields">${content}${button(label, primary ? 'primary' : 'secondary')}</form>`
const hidden = (key: string, value: unknown) => `<input type="hidden" name="${h(key)}" value="${h(value)}">`
const input = (label: string, key: string, value = '', type = 'text', extra = '') =>
  `<label>${h(label)}<input type="${type}" name="${h(key)}" value="${h(value)}" ${extra}></label>`
const textarea = (label: string, key: string, max: number, value = '') =>
  `<label>${h(label)}<textarea name="${h(key)}" rows="3" maxlength="${max}">${h(value)}</textarea></label>`
const select = (label: string, key: string, items: [string, string][], current = '', required = false) =>
  `<label>${h(label)}<select name="${h(key)}"${required ? ' required' : ''}>${items.map(([value, title]) =>
    `<option value="${h(value)}"${current === value ? ' selected' : ''}>${h(title)}</option>`).join('')}</select></label>`
const options = (values: string[]): [string, string][] => values.map(value => [value, value])
const card = (title: string, content: string, glyph?: string) =>
  `<section class="card panel"><h2 class="with-icon">${glyph ? icon(glyph) : ''}${h(title)}</h2>${content}</section>`
const stage = (id: string, number: string, title: string, glyph: string, content: string) =>
  `<section class="card panel stage" id="${id}"><header class="stage-head">
    <span class="feature-icon">${icon(glyph)}</span><div><span class="eyebrow">Step ${number}</span><h3>${title}</h3></div>
  </header>${content}</section>`
export const feedback = (message: string, error = false) =>
  `<p class="${error ? 'alert' : 'notice'}" role="${error ? 'alert' : 'status'}">${h(message)}</p>`

function dateTime(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value))
}

function localInput(value: string | undefined, timezone: string) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
  }).formatToParts(new Date(value))
  const get = (key: string) => parts.find(part => part.type === key)?.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

function intakeFields(details: Record<string, string>, showEmail: boolean, requireEmail = false, publicIntake = false) {
  const fields = Object.entries(detailLabels).map(([key, label]) => {
    const value = details[key] ?? ''
    if (key.endsWith('_language')) return select(label, key, [['', 'Choose a language'], ...options(languages)], value)
    if (key === 'format') return select(label, key, [['', 'Choose a format'], ...options(['In person', 'Virtual'])], value)
    if (key === 'headcount') return input(label, key, value, 'number', 'min="1" max="9999"')
    return input(label, key, value, 'text', 'maxlength="300"' + (publicIntake && ['school', 'contact', 'topic'].includes(key) ? ' required' : ''))
  }).join('') + (showEmail ? input('School contact email', 'email', details.email, 'email', `maxlength="254"${requireEmail ? ' required' : ''}`) +
    input('School contact phone (optional)', 'phone', details.phone, 'tel', 'maxlength="16" placeholder="+13055550123"') : '')
  return `<div class="intake-fields">${fields}</div>`
}

export function intakeView(scope: Workspace, actor?: Identity, submitted = false) {
  return layout('Request a workshop', `<section class="page-head"><p class="eyebrow">${icon('school')} School intake</p>
    <h1>${actor ? 'Record school intake' : 'Request a workshop'}</h1>
    <p class="lede">Tell us about the school and group. Use class-level information.</p></section>
    ${submitted ? feedback('Your request was received. A coordinator will review it.') :
      card('School and workshop details', action(actor ? '/intake/staff' : '/intake',
        hidden('submission', randomUUID()) + (actor ? select('Channel', 'channel', [['phone', 'Staff-entered phone'], ['simulated_sms', 'Simulated SMS']]) : '') +
        intakeFields({}, true, !actor, true), 'Submit request', true), 'assignment')}`, scope, actor, { section: 'intake', page: 'focused' })
}

function slots(path: string, workflow: WorkshopRequest['workflow'], timezone: string) {
  if (workflow.planning) return `<p>Booked ${h(dateTime(workflow.planning.start, timezone))} · ${h(workflow.planning.provider)}</p>`
  if (!workflow.slots?.length) return '<p>No planning slots have been offered yet.</p>'
  return action(path, select('Available times', 'slot', workflow.slots.map(item => [item.start, dateTime(item.start, timezone)])), 'Choose planning call')
}

export function workflowPanel(scope: Workspace, actor: Identity, request: WorkshopRequest, data: StaffData) {
  const id = request.id
  const path = `/requests/${id}`
  const { workflow } = request
  const workshop = workflow.workshop
  const coordinator = canCoordinate(actor)
  const reviewer = canReview(actor)
  const latest = data.versions.find(version => version.version === workflow.currentDeck)
  const timeInputs = (start?: string, end?: string) =>
    input('Workshop starts', 'workshop_start', localInput(start, scope.timezone), 'datetime-local', 'required') +
    input('Workshop ends', 'workshop_end', localInput(end, scope.timezone), 'datetime-local', 'required')
  const roomSearch = action(path + '/search', timeInputs(workshop?.start, workshop?.end) +
    select('ZIP code', 'zip', options(venueZips), '33134') + input('Radius in miles', 'radius', '10', 'number', 'min="1" max="50" required') +
    `<fieldset><legend>Room amenities</legend><div class="check-options">${['projector', 'wifi', 'accessible'].map(item =>
      `<label><input type="checkbox" name="required" value="${item}"${item === 'projector' ? ' checked' : ''}> Require ${item}</label>
       <label><input type="checkbox" name="preferred" value="${item}"> Prefer ${item}</label>`).join('')}</div></fieldset>`, 'Search simulated venues')

  return `<div id="workflow" class="workflow stack">
    <section class="page-head"><h2>Workshop workflow</h2><p>Dates and times use ${h(scope.timezone)}.</p>
      ${request.exception ? feedback(request.exception, true) : ''}</section>
    <div class="workflow-grid">
        ${stage('intake-actions', '1', 'Intake and automation', 'assignment', coordinator ? `
          <details><summary>Edit intake details</summary>${action(path + '/details', intakeFields(request.details, true), 'Save intake details')}</details>
          <details><summary>Assign request owner</summary>${action(path + '/owner',
            select('Coordinator', 'owner', data.owners.map(owner => [owner.id, owner.name]), request.owner_id), 'Assign owner')}</details>
          <div class="inline-actions">${request.proposed_follow_up ? action(path + '/follow-up', '', 'Queue follow-up') : ''}
          ${action(path + '/pause', '', request.paused ? 'Resume automation' : 'Pause automation')}
          ${workflow.exception ? action(path + '/dismiss', '', 'Mark exception reviewed') : ''}</div>` : '<p>A coordinator manages intake and automation.</p>')}
        ${stage('planning', '2', 'Planning call', 'calendar_month', `${slots(path + '/book', coordinator ? workflow : { planning: workflow.planning }, scope.timezone)}
          ${coordinator && !workflow.planning ? action(path + '/offer',
            input('Search window starts', 'planning_start', '', 'datetime-local', 'required') +
            input('Search window ends', 'planning_end', '', 'datetime-local', 'required'), 'Offer free 30-minute slots') : ''}
          ${coordinator ? `<details><summary>Planning notes</summary>${action(path + '/notes',
            textarea('Class-level notes', 'notes', 2000, workflow.planningNotes), 'Save planning notes')}</details>` :
            (workflow.planningNotes ? `<pre>${h(workflow.planningNotes)}</pre>` : '')}`)}
        ${stage('location', '3', 'Workshop date and location', 'location_on', `
          <p>${workshop?.location ? `${h(dateTime(workshop.start, scope.timezone))} · ${h(workshop.location)}` : 'Workshop logistics pending.'}</p>
          ${coordinator ? `<details><summary>Use the school room or a virtual link</summary>${action(path + '/workshop',
            timeInputs(workshop?.start, workshop?.end) + select('Location type', 'mode', [['school', 'School room'], ['virtual', 'Virtual meeting']], request.details.format === 'Virtual' ? 'virtual' : 'school') +
            input('Room name or HTTPS meeting link', 'location', workshop?.mode === 'room' ? '' : workshop?.location, 'text', 'required maxlength="300"'), 'Save workshop logistics')}</details>
            ${request.details.format === 'In person' ? `<details><summary>Find a simulated room</summary>${roomSearch}</details>` : ''}` : ''}`)}
        ${stage('school-contacts', '4', 'School contacts and permissions', 'contact_mail', `
          <ul class="activity">${data.links.map(link => `<li><strong>${h(link.contact)}</strong> · ${h(link.purpose)}${link.revoked ? ' · revoked' : ''}
            ${coordinator && !link.revoked ? action(path + '/revoke', hidden('link', link.id), 'Revoke link') : ''}</li>`).join('') || '<li>No school links yet.</li>'}</ul>
          ${coordinator ? action(path + '/link', input('School contact name', 'contact', '', 'text', 'required maxlength="100"') +
            input('School contact email', 'email', '', 'email', 'required') +
            select('Permission', 'purpose', [['collaborator', 'Collaborate and comment'], ['approver', 'Designated school approver']]), 'Create school link') : ''}`)}
        ${stage('school-review', '5', 'Slide versions and school review', 'description', `
          <ul class="activity">${data.versions.map(version => `<li><a href="${path}/deck/${version.version}">Open deck v${version.version}</a>
            · ${h(version.content.language)} · ${version.version === latest?.version ? 'Current' : 'Previous'}
            · ${version.shared_at ? 'Shared' : version.cleared_at ? 'Cleared' : 'Draft'}
            ${version.approved_at ? `<small>Approved by ${h(version.approver)} · ${h(dateTime(version.approved_at, scope.timezone))}</small>` : ''}</li>`).join('') || '<li>No versions yet.</li>'}</ul>
          ${reviewer ? `<div class="inline-actions">${latest && !latest.cleared_at ? action(path + '/clear', hidden('version', latest.version), 'Clear current version') : ''}
            ${latest?.cleared_at && !latest.shared_at ? action(path + '/share', hidden('version', latest.version), 'Share cleared version') : ''}</div>
            ${action(path + '/draft',
              select('Workshop template', 'template', [['', 'Use current or default template'], ['communication', 'Communication'], ['coping', 'Coping strategies']]) +
              input('Custom deck title (optional)', 'title', '', 'text', 'maxlength="150"') +
              textarea('Activity or revision text (optional)', 'activity', 2000) +
              (modelEnabled() ? '<label><span><input type="checkbox" name="use_model" value="yes"> Ask the model to adapt the draft using planning notes and feedback</span></label>' : ''), latest ? 'Create replacement draft' : 'Draft workshop deck')}` : ''}
          <details><summary>School feedback (${data.comments.length})</summary>
            <ul class="activity">${data.comments.map(comment => `<li><strong>${h(comment.contact)}</strong> · v${comment.version}<pre>${h(comment.body)}</pre></li>`).join('') || '<li>No feedback yet.</li>'}</ul>
          </details>`)}
        ${stage('confirmation', '6', 'Confirmation and reminders', 'notifications', `<p>Logistics check · ${h(workflow.reminder?.replaceAll('_', ' ') ?? 'pending')}</p>
          ${coordinator ? `<div class="inline-actions">${request.status === 'confirmed'
            ? action(path + '/reopen', '', 'Reopen workshop') + action(path + '/demo-reminder', '', 'Run simulated day-before check')
            : action(path + '/confirm', '', 'Confirm workshop', true)}</div>` : ''}`)}
    </div>
    <div class="columns" id="activity">
      ${card('Conversation history', `<ul class="activity">${data.messages.map(item => `<li><details>
        <summary>${h(item.subject)} · ${h(item.source.replaceAll('_', ' '))}</summary><small>${h(item.sender)}</small><pre>${h(item.body)}</pre></details></li>`).join('')}</ul>`)}
      ${card('Activity and delivery', `<ul class="activity">${data.jobs.map(job => `<li><strong>${h(job.kind.replaceAll('_', ' '))}</strong> · ${h(job.state)}
        ${job.error ? `<small>${h(job.error)}</small>` : ''}
        ${coordinator && job.state === 'failed' ? action(path + '/retry', hidden('job', job.id), 'Retry or reconcile') : ''}</li>`).join('')}</ul>
        <ul class="activity">${data.timeline.map(item => `<li>${h(item.note)}<small>${h(dateTime(item.created_at, scope.timezone))}</small></li>`).join('')}</ul>`)}
    </div>
  </div>`
}

export function roomResultsView(scope: Workspace, actor: Identity, id: string, form: URLSearchParams, rooms: RoomResults) {
  const params = [...form.entries()].filter(([key]) => ['workshop_start', 'workshop_end', 'zip', 'radius', 'required', 'preferred'].includes(key))
  const eligible = rooms.filter(room => !room.reasons.length)
  const unavailable = rooms.filter(room => room.reasons.length)
  const result = (room: RoomResults[number]) => `<li class="room-row">
    <span class="feature-icon">${icon('location_on')}</span><div class="room-summary">
      <h3>${h(room.room)}</h3><p>${h(room.venue)} · ${room.distance.toFixed(1)} mi · Capacity ${room.capacity}</p>
      ${room.reasons.length ? `<p class="room-reason">${h(room.reasons.join(' · '))}</p>` :
      `<p>${h(room.amenities.join(', '))}</p>${action(`/requests/${id}/reserve`,
        params.map(([key, value]) => hidden(key, value)).join('') + hidden('room', room.id), 'Reserve simulated room')}`}
    </div></li>`
  return layout('Simulated room search', `<section class="page-head">${backLink('/requests/' + id, 'Workshop request')}
    <p class="eyebrow">${icon('location_on')} Fictional inventory</p><h1>Simulated room search</h1>
    <p class="lede">Distances are approximate from ZIP ${h(form.get('zip'))}.</p></section>
    <div class="columns room-results">
      ${card('Available rooms', eligible.length ? `<ul class="room-list">${eligible.map(result).join('')}</ul>` :
        '<p>No rooms meet these requirements. Return to the request to change your search.</p>', 'check_circle')}
      ${unavailable.length ? card('Unavailable rooms', `<ul class="room-list unavailable">${unavailable.map(result).join('')}</ul>`, 'info') : ''}
    </div>`, scope, actor)
}

export function issuedLinkView(scope: Workspace, actor: Identity, id: string, link: string) {
  return layout('School link ready', `<section class="page-head">${backLink('/requests/' + id, 'Workshop request')}
    <h1>School link ready</h1></section>${card('Share with the designated contact', `<p>Anyone with this link can act as that contact. Copy it now, or issue a new link later.</p>
    <p class="link-copy"><a href="${h(link)}">${h(link)}</a></p>`)}`, scope, actor)
}

export function schoolView(scope: Scope & Tenant, token: string, access: Awaited<ReturnType<typeof schoolAccess>>, saved: boolean) {
  const { grant, record, deck } = access
  const path = '/school/' + token
  const workshop = record.workflow.workshop
  const heading = grant.purpose === 'logistics' ? 'Check workshop logistics' : 'Your workshop request'
  const content = grant.purpose === 'logistics' ? card('Room or meeting access',
    `<p>${h(dateTime(workshop!.start, scope.timezone))} · ${h(workshop!.location)}</p>
      ${action(path + '/logistics', select('Logistics response', 'answer', [['confirmed', 'Access confirmed'], ['changed', 'Something changed']]) +
        textarea('Describe any changes', 'change', 1500), 'Submit logistics response', true)}`) :
    `<div class="stack">${card('Planning call', slots(path + '/book', record.workflow, scope.timezone))}
      ${record.status !== 'confirmed' ? card('School details', `<details><summary>Supply or update workshop details</summary>
        ${action(path + '/details', intakeFields(record.details, false), 'Save details')}</details>`) : ''}
      ${card('Slides and feedback', deck ? `<p><a href="${path}/deck/${deck.version}">Open shared deck v${deck.version}</a></p>
        ${action(path + '/comment', hidden('version', deck.version) + textarea('Feedback on this version', 'comment', 2000), 'Submit feedback')}
        ${grant.purpose === 'approver' ? (deck.approved_at ? '<p>This version has been approved.</p>' :
          action(path + '/approve', hidden('version', deck.version), `Approve deck v${deck.version}`, true)) : ''}` : '<p>Staff will share slides when they are ready for review.</p>')}
    </div>`
  return layout(heading, `<section class="page-head"><p class="eyebrow">${icon('school')} School collaboration</p><h1>${heading}</h1>
    <p class="lede">${h(record.details.school ?? 'School')} · ${h(grant.contact)} · ${h(scope.timezone)}</p></section>
    ${saved ? feedback('Your response was recorded.') : ''}${content}`, scope, undefined, { page: 'focused' })
}

export function settingsView(scope: Workspace, actor: Identity, data: Awaited<ReturnType<typeof settings>>, google: boolean, message?: string) {
  return layout('Workspace settings', `<section class="page-head">${backLink('/', 'Coordinator queue')}<h1>Workspace settings</h1></section>
    ${message ? feedback(message) : ''}<div class="columns settings-layout"><div class="stack">
      ${card('Branding and defaults', action('/settings/branding',
        input('Organization name', 'name', scope.name, 'text', 'required maxlength="100"') + input('Brand color', 'accent', scope.accent, 'color') +
        input('Time zone', 'timezone', scope.timezone, 'text', 'required') +
        select('Default correspondence language', 'language', options(languages), scope.language), 'Save workspace settings', true))}
      ${card('Staff membership', `<ul class="activity">${data.staff.map(member => `<li><strong>${h(member.name)}</strong> · ${h(member.role)}
        <small>${h(member.email)}</small>${member.id !== actor.id ? action('/settings/remove', hidden('account', member.id), 'Remove membership') : ''}</li>`).join('')}</ul>
        ${action('/settings/member', input('Staff email', 'email', '', 'email', 'required') + input('New staff name', 'name') +
          input('Initial password for new staff', 'password', '', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"') +
          select('Role', 'role', [['coordinator', 'Coordinator'], ['reviewer', 'Reviewer'], ['tenant_admin', 'Tenant administrator']]), 'Add or update membership')}`)}
    </div><div class="stack">
      ${(['mail', 'calendar'] as const).map(kind => {
        const connection = data.connections.find(item => item.kind === kind)
        return card(kind === 'mail' ? 'Gmail test inbox' : 'Google Calendar', `
          <p>${connection ? 'Google connected.' : 'Simulated provider active.'}</p>
          ${connection?.last_error ? feedback(connection.last_error, true) : ''}
          ${connection?.last_sync ? `<p>Last sync attempt · ${h(dateTime(connection.last_sync, scope.timezone))}</p>` : ''}
          ${google ? action('/google/start/' + kind, '', connection ? 'Reconnect Google' : 'Connect Google') : '<p>Google OAuth is not configured for this deployment.</p>'}
          ${connection ? action('/settings/provider', hidden('kind', kind) + input(kind === 'mail' ? 'Gmail test label ID' : 'Calendar ID', 'resource', connection.resource, 'text', 'required'), 'Save provider resource') +
            action('/settings/disconnect', hidden('kind', kind), 'Disconnect provider') : ''}`)
      }).join('')}
    </div></div>`, scope, actor, { section: 'settings' })
}
