import type { Identity } from './auth.ts'
import { detailLabels, type WorkshopRequest } from './intake.ts'

export type Tenant = { slug: string; name: string; accent: string; suspended?: boolean }
type Section = 'queue' | 'intake' | 'settings' | 'platform'
type LayoutOptions = { section?: Section; page?: 'focused' | 'auth' }

export function escape(value: unknown) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char)
}

export const icon = (name: string) => `<span class="symbol" aria-hidden="true">${escape(name)}</span>`
export const backLink = (href: string, label: string) =>
  `<a class="back" href="${escape(href)}">${icon('arrow_back')}${escape(label)}</a>`
export const button = (label: string, variant: 'primary' | 'secondary' | 'text-button' = 'primary', glyph?: string) =>
  `<button class="${variant}">${glyph ? icon(glyph) : ''}${escape(label)}</button>`

function navigation(tenant: Tenant | undefined, identity: Identity, section: Section) {
  const item = (key: Section, href: string, label: string, glyph: string) =>
    `<a class="nav-item" href="${href}"${section === key ? ' aria-current="page"' : ''}>
      <span class="nav-icon">${icon(glyph)}</span><span>${label}</span></a>`
  return `<aside class="sidebar"><nav aria-label="Workspace">
    <p class="nav-caption">${tenant ? 'Workspace' : 'Platform'}</p>
    ${tenant ? [
      item('queue', '/', 'Requests', 'inbox'),
      identity.role !== 'reviewer' ? item('intake', '/intake/staff', 'Record intake', 'phone_in_talk') : '',
      identity.role === 'tenant_admin' ? item('settings', '/settings', 'Settings', 'settings') : '',
    ].join('') : item('platform', '/', 'Workspaces', 'space_dashboard')}
    </nav>${tenant ? `<a class="sidebar-link" href="/intake">${icon('school')}<span>School intake form</span>${icon('arrow_forward')}</a>` : ''}
    </aside>`
}

const roleNames: Record<Identity['role'], string> = {
  platform_admin: 'Platform admin', tenant_admin: 'Workspace admin', coordinator: 'Coordinator', reviewer: 'Reviewer',
}

export function layout(title: string, content: string, tenant?: Tenant, identity?: Identity, options: LayoutOptions = {}) {
  const brand = tenant?.name ?? 'Tidepath Platform'
  const accent = tenant?.accent ?? '#354e92'
  const initials = identity?.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(brand)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="${identity ? 'staff-shell' : 'public-shell'} ${options.page ?? ''}" style="--brand:${escape(accent)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="top"><div class="top-inner">
  <a class="brand" href="/"><span class="mark">${icon('waves')}</span><span><strong>Tidepath</strong><small>${escape(brand)}</small></span></a>
  ${identity ? `<div class="account"><span class="avatar" aria-hidden="true">${escape(initials)}</span>
    <div class="account-name"><strong>${escape(identity.name)}</strong><small>${roleNames[identity.role]}</small></div>
    <form method="post" action="/logout"><button class="icon-button" aria-label="Sign out" title="Sign out">${icon('logout')}</button></form>
  </div>` : ''}
</div></header>
<div class="shell">
  ${identity ? navigation(tenant, identity, options.section ?? (tenant ? 'queue' : 'platform')) : ''}
  <main class="frame" id="main">${content}</main>
</div>
</body>
</html>`
}

function alert(message?: string) {
  return message ? `<p class="alert" role="alert">${escape(message)}</p>` : ''
}

export function loginView(platform: string, tenant?: Tenant, error?: string, google = false) {
  const demoLinks = new URL(platform).hostname === 'localhost'
  return layout('Sign in', `
    <div class="login">
      <section class="login-cover">
        <div class="login-art" aria-hidden="true"><i></i><i></i><i></i>${icon('calendar_month')}</div>
        <div class="login-intro">
          <p class="eyebrow">${tenant ? 'Workshop workspace' : 'Platform console'}</p>
          <h1>${tenant ? 'Workshop coordination' : 'Workspace administration'}</h1>
          <p class="lede">${tenant ? 'Manage school requests, planning calls, and slide approvals.' : 'Provision workspaces and manage their availability.'}</p>
        </div>
      </section>
      <section class="login-form">
        <h2>Sign in</h2>
        <p>Continue to ${escape(tenant?.name ?? 'the platform console')}.</p>
        ${alert(error)}
        <form method="post" action="/login" class="fields">
          <label>Email<input name="email" type="email" required autocomplete="username" maxlength="254"></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password" maxlength="128"></label>
          ${button('Sign in', 'primary', 'arrow_forward')}
        </form>
        ${google ? `<form class="fields" method="post" action="/google/start/login">${button('Sign in with Google', 'secondary')}</form>` : ''}
        <nav class="workspace-links" aria-label="Other workspaces">
          ${demoLinks ? `<a href="${platform}/">Platform console</a>
            <a href="${platform.replace('://', '://tidepath.')}/">Tidepath</a>
            <a href="${platform.replace('://', '://harbor.')}/">Harbor</a>` : ''}
          ${tenant ? '<a href="/intake">Request a workshop</a>' : ''}
        </nav>
      </section>
    </div>`, tenant, undefined, { page: 'auth' })
}

export function adminView(tenants: Tenant[], platform: string, identity: Identity, error?: string, created = false) {
  return layout('Workspaces', `
    <section class="page-head">
      <p class="eyebrow">Platform console</p>
      <h1>Workspaces</h1>
      <p class="lede">Provision organizations and manage workspace access.</p>
    </section>
    ${created ? '<p class="notice" role="status">Workspace created. Its initial administrator can now sign in.</p>' : ''}
    <div class="columns admin-layout">
      <section class="card panel">
        <h2>Provisioned workspaces</h2>
        <ul class="tenant-list">${tenants.map(tenant => `
          <li><span class="swatch" style="--swatch:${escape(tenant.accent)}" aria-hidden="true">${icon('space_dashboard')}</span>
            <div><strong>${escape(tenant.name)}</strong>
              <a href="${escape(platform.replace('://', '://' + tenant.slug + '.'))}/">${escape(new URL(platform).host.replace(/^/, tenant.slug + '.'))}</a></div>
            <form method="post" action="/admin/suspension"><input type="hidden" name="slug" value="${escape(tenant.slug)}">${button(tenant.suspended ? 'Resume workspace' : 'Suspend workspace', 'text-button')}</form></li>
        `).join('') || '<li>No workspaces yet.</li>'}</ul>
      </section>
      <section class="card panel raised">
        <h2>Provision a workspace</h2>
        <p>Set its identity and create its first tenant administrator.</p>
        ${alert(error)}
        <form method="post" action="/admin/tenants" class="fields">
          <label>Organization name<input name="name" maxlength="100" required></label>
          <label>Subdomain<input name="slug" placeholder="example" pattern="[a-z0-9]([a-z0-9\\-]{0,38}[a-z0-9])?" maxlength="40" required></label>
          <label>Brand color<input type="color" name="accent" value="#17645e" required></label>
          <label>Administrator name<input name="admin_name" maxlength="100" required></label>
          <label>Administrator email<input name="admin_email" type="email" maxlength="254" required></label>
          <label>Initial password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>
          ${button('Create workspace', 'primary', 'add')}
        </form>
      </section>
    </div>`, undefined, identity)
}

function status(request: WorkshopRequest) {
  if (request.status === 'confirmed') return `<span class="badge positive">${icon('check_circle')}Confirmed</span>`
  return request.status === 'awaiting_details'
    ? '<span class="badge pending">Awaiting details</span>'
    : '<span class="badge">Ready for planning</span>'
}

function nextAction(request: WorkshopRequest) {
  if (request.paused) return 'Automation paused'
  if (request.exception) return 'Review exception'
  if (request.status === 'confirmed') return 'Track logistics check'
  if (request.missing_fields.length) return request.follow_up_sent ? 'Await school details' : 'Review proposed reply'
  if (request.workflow.workshop?.location && request.ready_to_confirm) return 'Confirm workshop'
  if (!request.workflow.planning) return 'Arrange planning call'
  if (!request.workflow.workshop?.location) return 'Save workshop logistics'
  if (!request.workflow.sharedDeck) return 'Prepare and share slides'
  return 'Review school approval'
}

const needsAttention = (request: WorkshopRequest) => Boolean(request.exception || request.missing_fields.length)

export function queueView(tenant: Tenant, identity: Identity, requests: WorkshopRequest[], filter?: string | null) {
  const review = requests.filter(needsAttention)
  const confirmed = requests.filter(request => request.status === 'confirmed')
  const active = filter === 'attention' ? 'attention' : filter === 'confirmed' ? 'confirmed' : 'all'
  const visible = active === 'attention' ? review : active === 'confirmed' ? confirmed : requests
  const filters = [
    ['all', 'All requests', requests.length, '/'],
    ['attention', 'Needs attention', review.length, '/?view=attention'],
    ['confirmed', 'Confirmed', confirmed.length, '/?view=confirmed'],
  ] as const
  return layout('Coordinator queue', `
    <section class="page-head queue-title">
      <div><p class="eyebrow">${icon('space_dashboard')} Coordinator queue</p>
        <h1>Workshop requests</h1>
        <p class="lede">Track school inquiries, approvals, and upcoming workshops.</p></div>
      ${identity.role !== 'reviewer' ? `<a class="primary" href="/intake/staff">${icon('add')} Record intake</a>` : ''}
    </section>
    <div class="overview" aria-label="Queue totals">
      ${[['assignment', 'Total requests', requests.length], ['warning', 'Needs attention', review.length], ['check_circle', 'Confirmed', confirmed.length]].map(([glyph, label, count]) =>
        `<div class="metric"><span class="metric-icon">${icon(String(glyph))}</span><div><strong>${count}</strong><span>${label}</span></div></div>`).join('')}
    </div>
    <div class="queue-layout">
      <section class="card queue-list">
        <div class="queue-head"><h2>School requests</h2>
          <nav class="filters" aria-label="Filter requests">${filters.map(([key, label, count, href]) =>
            `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}<span>${count}</span></a>`).join('')}</nav>
        </div>
        ${visible.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="School request table"><table>
          <thead><tr><th scope="col">School request</th><th scope="col">Status</th><th scope="col">Next action</th><th scope="col">Owner</th></tr></thead>
          <tbody>${visible.map(request => `<tr>
            <td><a class="request-name" href="/requests/${escape(request.id)}">${escape(request.details.school ?? request.subject)}</a>
              <small>${escape(request.subject)}</small></td>
            <td>${status(request)}</td>
            <td><span>${nextAction(request)}</span>${needsAttention(request) ? `<small class="row-exception">${escape(request.exception || `${request.missing_fields.length} missing fields`)}</small>` : ''}</td>
            <td>${escape(request.owner)}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : `<div class="empty"><span class="empty-icon">${icon('inbox')}</span>
          <strong>${active === 'all' ? 'Your queue is empty' : 'No matching requests'}</strong>
          <p>${active === 'all' ? 'New school requests will appear here.' : 'Choose All requests to see the rest of the queue.'}</p></div>`}
      </section>
      ${identity.role !== 'reviewer' ? `<aside class="card panel inbox-panel raised">
        <span class="feature-icon">${icon('mail')}</span>
        <h2>Inbox tools</h2>
        <p>Import from Gmail or load a fictional request to try the workflow.</p>
        <form method="post" action="/sync-mail">${button('Sync Gmail test inbox', 'secondary', 'sync')}</form>
        <form method="post" action="/simulate">${button('Load simulated email', 'text-button', 'inbox')}</form>
      </aside>` : ''}
    </div>`, tenant, identity)
}

export function requestView(tenant: Tenant, identity: Identity, request: WorkshopRequest, workflowPanel = '', feedback = '') {
  const school = request.details.school ?? request.subject
  const sections = [
    ['intake', 'Intake'], ['planning', 'Planning'], ['location', 'Location'], ['school-review', 'School review'],
    ['confirmation', 'Confirmation'], ['activity', 'Activity'],
  ]
  return layout(school, `
    <section class="page-head request-title">
      ${backLink('/', 'Coordinator queue')}
      <div class="request-heading"><span class="feature-icon">${icon('school')}</span><div>
        <h1>${escape(school)}</h1><p class="lede">${escape(request.subject)}</p>
      </div></div>
      <div class="meta">${status(request)}<span>${icon('person')}${escape(request.owner)}</span><span>${icon('arrow_forward')}${nextAction(request)}</span></div>
    </section>
    <nav class="section-nav" aria-label="Request sections">${sections.map(([id, name]) => `<a href="#${id}">${name}</a>`).join('')}</nav>
    ${feedback}
    <section class="request-overview" id="intake" aria-label="Intake overview">
      <section class="card panel">
        <h2 class="with-icon">${icon('assignment')} Intake details</h2>
        <dl class="intake-facts">${Object.entries(detailLabels).map(([key, label]) => `
          <div><dt>${escape(label)}</dt><dd>${request.details[key] ? escape(request.details[key]) : '<span class="missing">Missing</span>'}</dd></div>`).join('')}</dl>
        <details class="original-intake"><summary>Original intake</summary>
          <p class="email-meta">${escape(request.source.replaceAll('_', ' '))} · ${escape(request.sender)}</p>
          <pre>${escape(request.body)}</pre>
        </details>
      </section>
      <section class="card panel reply-panel">
        <h2 class="with-icon">${icon('mail')} Proposed follow-up</h2>
        ${request.proposed_follow_up ? `
          <ul class="chips" aria-label="Missing fields">${request.missing_fields.map(field => `<li>${escape(field)}</li>`).join('')}</ul>
          <pre class="draft">${escape(request.proposed_follow_up)}</pre>` : '<p>The school supplied all applicable details.</p>'}
      </section>
    </section>
    ${workflowPanel}`, tenant, identity)
}

export function errorView(title: string, message: string, tenant?: Tenant) {
  return layout(title, `<section class="page-head error-page"><span class="feature-icon">${icon('info')}</span>
    <h1>${escape(title)}</h1><p class="lede">${escape(message)}</p>${backLink('/', 'Return home')}</section>`, tenant, undefined, { page: 'focused' })
}
