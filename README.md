# Tidepath workshop platform

Tidepath moves a school inquiry through intake, a planning call, workshop logistics, versioned slide review, confirmation, and a day-before access check. It runs locally with simulated mail, calendar, and rooms. Google sign-in, Gmail, and Google Calendar can be enabled independently of the demo data.

## Run locally

Install Node.js 24+ and start PostgreSQL 15+. The commands below assume PostgreSQL accepts connections as your current user. Set `DATABASE_URL` in `.env` if your installation uses different credentials.

```sh
npm ci
createdb -h localhost tidepath
cp .env.example .env
npm run setup
npm run dev
```

In a second terminal, run `npm run worker`. Setup is safe to rerun for an existing Milestone 1 database. Use `TidepathDemo2026!` for each seeded account.

| Workspace | Role | Account |
| --- | --- | --- |
| [Platform console](http://localhost:3000/) | Platform administrator | `platform@example.test` |
| [Tidepath](http://tidepath.localhost:3000/) | Coordinator | `yesenia@example.test` |
| Tidepath | Slide reviewer | `reviewer@example.test` |
| Tidepath | Tenant administrator | `admin@example.test` |
| [Harbor](http://harbor.localhost:3000/) | Coordinator | `harbor@example.test` |

Most browsers resolve `*.localhost` to loopback. If yours needs host entries, map the workspace hostnames to `127.0.0.1`. Each tenant has a separate session. Use another browser profile or sign out when switching roles on the same tenant.

## Walk through the demo

1. Sign in to Tidepath as Yesenia and load the simulated email. Review the single English follow-up asking for headcount, availability, and room logistics. Queue it and let the worker write the simulated delivery to the conversation. Fill in the missing details for 30 eighth graders. Keep Spanish as the workshop language.
2. Offer a future planning window and create two school links, one collaborator and one designated approver. Save each link when it appears. Open a school link to choose a 30-minute slot. Refresh after the worker books it. The planning call is tracked separately from the workshop.
3. On the request, open **Find a simulated room**. Choose a future daytime workshop window, ZIP `33134`, and require a projector. Review the eligible, occupied, undersized, and unequipped rooms. Reserve an eligible room. Try reserving it for an overlapping request to see the rejection.
4. Sign in as the reviewer and draft, clear, and share the Spanish deck. Use both school links to comment on v1. Create v2 with revised activity text, clear it, and share it. Approve v2 with the approver's link. Each version opens as a printable HTML slide deck.
5. Sign back in as Yesenia and confirm the workshop. Use **Run simulated day-before check** and refresh after the worker runs. Open the logistics link from the simulated outbound message and submit a response. Reporting a change adds an exception to the coordinator queue.

Use the public **School intake form** for website intake, or **Record phone or test SMS intake** for coordinator-entered requests. Workspace settings manage branding, time zone, correspondence defaults, staff roles, and provider connections. The platform console can provision, suspend, and resume tenants.

## Connect Google

1. Create a web OAuth client, enable the Gmail and Google Calendar APIs, and configure the OAuth consent screen and test users. Register the exact platform callback, typically `http://localhost:3000/google/callback` locally. Fill in the Google variables in `.env` and generate `GOOGLE_TOKEN_KEY` with `openssl rand -hex 32`. Use the same key in the web and worker processes.
2. Sign in as a tenant administrator and connect Gmail and Calendar separately. Use a test mailbox and set a dedicated Gmail label ID such as `Label_123`. The worker imports mail from that label. The coordinator can also sync it on demand. Select the intended Calendar ID, or use `primary`. The app stores refresh credentials encrypted with the configured key.
3. Add the verified Google email as a staff member in the intended workspace before using **Sign in with Google**. The first sign-in links the Gmail or Google Workspace identity to that existing account. Subsequent sign-ins use the Google subject and recheck tenant membership.

Gmail reads the configured label, tracks provider message and thread IDs, and sends replies in the original thread. Use a labeled test message with explicit school, contact, and correspondence language for automatic follow-up. Ambiguous matches or uncertain field extraction surface for staff review. Google Calendar checks availability and reconciles the stable event ID on retries. Gmail retries first look in Sent for the stable Message-ID. If delivery remains uncertain, staff review Sent before taking over.

Google references for setup and behavior are [web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Sign in with Google](https://developers.google.com/identity/openid-connect/openid-connect), [Gmail threads](https://developers.google.com/workspace/gmail/api/guides/threads), [Calendar FreeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), and [Calendar event creation](https://developers.google.com/workspace/calendar/api/guides/create-events).

## Optional adapters

- **SMS relay.** Configure a secret of at least 32 characters in `SMS_WEBHOOK_KEY` and optionally `SMS_RELAY_URL` for outbound replies. Derive each workspace signing key as the lowercase hex HMAC-SHA256 of its slug using the deployment secret. The derived hex string is the key for subsequent HMACs. The relay posts `{ id, from, body, sentAt, thread? }` to the tenant's `/api/sms/inbound` endpoint with `X-Tidepath-Signature` over the raw JSON bytes. Use an E.164 sender, a stable event ID, an ISO timestamp within ten minutes, and a stable thread identifier when available. The app sends signed JSON `{ to, body }` to `PUT <SMS_RELAY_URL>/messages/<operation-id>`. The relay must make this operation idempotent and return `{ id }`. Real SMS transport requires an external relay.
- **Model gateway.** Set `MODEL_ENDPOINT` and optionally `MODEL_API_KEY` to use a gateway you control. It receives JSON `{ operation, data }`. For `intake`, return `{ fields, uncertain }`, with supported field names and short values copied from the source. For `deck`, return `{ language, slides: [{ title, text }], uncertain: false }` with four slides. Drafts still require reviewer clearance and school approval. The built-in templates and labeled intake parser work without a model. Use class-level information in intake, notes, and feedback.

## Operating defaults

Reminders are due at 9 a.m. the day before the workshop, with a 5 p.m. response cutoff in the tenant time zone. Staff see failed delivery, a missed cutoff, and changes reported by the school. Pending work respects the current pause state and workshop revision. Run `npm run worker -- --once` to drain currently due jobs without polling the inbox.

For a shared deployment, configure `APP_ORIGIN` with the HTTPS platform origin, route the base and wildcard subdomains to the web process, and preserve the original host at the proxy. Give all web processes the same private persistent mount for `DECK_STORAGE_DIR`. Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` for initial setup, then remove the password from the environment. HTTPS deployments disable the seeded demo accounts. Use a dedicated database for shared workspaces.

Venue inventory and reservations remain fictional. The brief leaves live venue inventory, custom domains, provider expansion, after-hours rules, and budget limits open.

## Verify

```sh
npm run check
npm test
TEST_DATABASE_URL=postgresql://localhost/tidepath npm test
```

The PostgreSQL integration test creates and removes an isolated schema. It checks tenant and school link isolation, version gates, simulated delivery, room conflicts, and the end-to-end workflow. It also exercises Google, SMS, and model requests against HTTP fixtures, including Gmail and Calendar writes that succeed remotely before an error reaches the app.
