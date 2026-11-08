import type { Identity } from './auth.ts'
import { detailLabels, type WorkshopRequest } from './intake.ts'

export type Tenant = { slug: string; name: string; accent: string; suspended?: boolean }

export function escape(value: unknown) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char)
}

function mark() {
  return `<span class="mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M3 8c3.2 0 3.2-3 6-3s2.8 3 6 3 3.2-3 6-3M3 13c3.2 0 3.2-3 6-3s2.8 3 6 3 3.2-3 6-3M3 18c3.2 0 3.2-3 6-3s2.8 3 6 3 3.2-3 6-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  </svg></span>`
}

export function layout(title: string, content: string, tenant?: Tenant, identity?: Identity) {
  const brand = tenant?.name ?? 'Tidepath Platform'
  const accent = tenant?.accent ?? '#17645e'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(brand)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body style="--brand:${escape(accent)}">
<header class="top"><div class="frame top-inner">
<a class="brand" href="/">${mark()}<span>${escape(brand)}<small>${tenant ? 'Workshop operations' : 'Workspace administration'}</small></span></a>
${identity ? `<div class="account"><span>${escape(identity.name)}</span><form method="post" action="/logout"><button class="text-button">Sign out</button></form></div>` : ''}
</div></header>
<main class="frame">${content}</main>
<footer class="frame footer"><span>Tidepath workshop platform</span><span>Local demo</span></footer>
</body>
</html>`
}

function alert(message?: string) {
  return message ? `<p class="alert" role="alert">${escape(message)}</p>` : ''
}

export function loginView(platform: string, tenant?: Tenant, error?: string, google = false) {
  return layout('Sign in', `
    <div class="login">
      <section>
        <p class="eyebrow">${tenant ? 'WORKSHOP WORKSPACE' : 'PLATFORM CONSOLE'}</p>
        <h1>${tenant ? 'Welcome to your workspace.' : 'Manage workshop workspaces.'}</h1>
        <p class="lede">${tenant ? 'Sign in to review school requests and prepare the next step.' : 'Provision isolated, branded workspaces for each organization.'}</p>
        <nav class="workspace-links" aria-label="Demo workspaces">
          <a href="${platform}/">Platform console</a>
          <a href="${platform.replace('://', '://tidepath.')}/">Tidepath</a>
          <a href="${platform.replace('://', '://harbor.')}/">Harbor</a>
          ${tenant ? '<a href="/intake">Request a workshop</a>' : ''}
        </nav>
      </section>
      <section class="card panel">
        <p class="eyebrow">STAFF ACCESS</p>
        <h2>Sign in</h2>
        ${alert(error)}
        <form method="post" action="/login" class="fields">
          <label>Email<input name="email" type="email" required autocomplete="username" maxlength="254"></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password" maxlength="128"></label>
          <button class="primary">Sign in</button>
        </form>
        ${google ? '<form class="fields" method="post" action="/google/start/login"><button class="secondary">Sign in with Google</button></form>' : ''}
      </section>
    </div>`, tenant)
}

export function adminView(tenants: Tenant[], platform: string, identity: Identity, error?: string, created = false) {
  return layout('Workspaces', `
    <section class="page-head">
      <p class="eyebrow">PLATFORM CONSOLE</p>
      <h1>Workspaces</h1>
      <p class="lede">Manage the organizations using Tidepath.</p>
    </section>
    ${created ? '<p class="notice" role="status">Workspace created. Its initial administrator can now sign in.</p>' : ''}
    <div class="columns">
      <section class="card panel">
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
          <button class="primary">Create workspace</button>
        </form>
      </section>
      <section class="card panel">
        <h2>Provisioned workspaces</h2>
        <ul class="tenant-list">${tenants.map(tenant => `
          <li><span class="swatch" style="--swatch:${escape(tenant.accent)}"></span><div><strong>${escape(tenant.name)}</strong>
            <a href="${escape(platform.replace('://', '://' + tenant.slug + '.'))}/">${escape(new URL(platform).host.replace(/^/, tenant.slug + '.'))}</a></div>
            <form method="post" action="/admin/suspension"><input type="hidden" name="slug" value="${escape(tenant.slug)}"><button class="text-button">${tenant.suspended ? 'Resume workspace' : 'Suspend workspace'}</button></form></li>
        `).join('')}</ul>
      </section>
    </div>`, undefined, identity)
}

function status(request: WorkshopRequest) {
  if (request.status === 'confirmed') return '<span class="badge">Confirmed</span>'
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

export function queueView(tenant: Tenant, identity: Identity, requests: WorkshopRequest[]) {
  const exceptions = requests.filter(request => request.exception || request.missing_fields.length > 0).length
  return layout('Coordinator queue', `
    <section class="page-head">
      <p class="eyebrow">WORKSHOP OPERATIONS</p>
      <h1>Coordinator queue</h1>
      <p class="lede">Review school requests, missing details, and the next action.</p>
      <nav class="workspace-links" aria-label="Workspace tools">
        <a href="/intake">School intake form</a>
        ${identity.role !== 'reviewer' ? '<a href="/intake/staff">Record phone or test SMS intake</a>' : ''}
        ${identity.role === 'tenant_admin' ? '<a href="/settings">Workspace settings</a>' : ''}
      </nav>
    </section>
    <div class="stats">
      <div class="card stat"><strong>${requests.length}</strong><span>Workshop requests</span></div>
      <div class="card stat"><strong>${exceptions}</strong><span>Requests to review</span></div>
    </div>
    <section class="card simulation">
      <div><p class="eyebrow">SIMULATED EMAIL</p><h2>Test inbox</h2><p>Load a fictional school email and generate a proposed reply for staff review.</p></div>
      ${identity.role !== 'reviewer' ? '<form method="post" action="/simulate"><button class="primary">Load or replay simulated email</button></form><form method="post" action="/sync-mail"><button class="secondary">Sync Gmail test inbox</button></form>' : ''}
    </section>
    <section class="card">
      <div class="panel queue-head"><h2>School requests</h2></div>
      ${requests.length ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">School request</th><th scope="col">Status</th><th scope="col">Next action</th><th scope="col">Owner</th><th scope="col">Exception</th></tr></thead>
        <tbody>${requests.map(request => `
          <tr><td><a href="/requests/${escape(request.id)}">${escape(request.details.school ?? request.subject)}</a><small>${escape(request.subject)}</small></td>
          <td>${status(request)}</td><td>${nextAction(request)}</td><td>${escape(request.owner)}</td>
          <td>${escape(request.exception || (request.missing_fields.length ? `${request.missing_fields.length} missing fields` : 'None'))}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty"><strong>Your queue is empty</strong><p>Load the simulated email to create a workshop request.</p></div>'}
    </section>`, tenant, identity)
}

export function requestView(tenant: Tenant, identity: Identity, request: WorkshopRequest, workflowPanel = '', feedback = '') {
  const school = request.details.school ?? request.subject
  return layout(school, `
    <section class="page-head">
      <a class="back" href="/">← Coordinator queue</a>
      <p class="eyebrow">WORKSHOP REQUEST</p>
      <h1>${escape(school)}</h1>
      <p class="lede">${escape(request.subject)}</p>
      <div class="meta">${status(request)}<span>Owner · ${escape(request.owner)}</span><span>Next · ${nextAction(request)}</span></div>
    </section>
    ${feedback}
    <div class="columns">
      <div class="stack">
        <section class="card panel">
          <h2>Intake details</h2>
          <dl>${Object.entries(detailLabels).map(([key, label]) => `
            <div><dt>${escape(label)}</dt><dd>${request.details[key] ? escape(request.details[key]) : '<span class="missing">Missing</span>'}</dd></div>`).join('')}</dl>
        </section>
        <section class="card panel">
          <p class="eyebrow">${escape(request.source.replaceAll('_', ' ').toUpperCase())}</p><h2>Original intake</h2>
          <p class="email-meta"><strong>From</strong> ${escape(request.sender)}<br><strong>Subject</strong> ${escape(request.subject)}</p>
          <pre>${escape(request.body)}</pre>
        </section>
      </div>
      <section class="card panel">
        <p class="eyebrow">STAFF REVIEW</p><h2>Proposed follow-up</h2>
        ${request.proposed_follow_up ? `
          <p>One draft covering all missing details. Draft only.</p>
          <ul class="chips" aria-label="Missing fields">${request.missing_fields.map(field => `<li>${escape(field)}</li>`).join('')}</ul>
          <pre class="draft">${escape(request.proposed_follow_up)}</pre>` : '<p>The school supplied all applicable details.</p>'}
      </section>
    </div>
    ${workflowPanel}`, tenant, identity)
}

export function errorView(title: string, message: string, tenant?: Tenant) {
  return layout(title, `<section class="page-head"><h1>${escape(title)}</h1><p>${escape(message)}</p><a href="/">Return home</a></section>`, tenant)
}
