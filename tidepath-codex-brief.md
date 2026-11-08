# Tidepath workshop platform

## Goal

Tidepath Family Alliance is a fictional Miami-Dade nonprofit. Its front-desk coordinator, Yesenia, spends days collecting workshop details, booking planning calls, coordinating slide feedback, and confirming rooms. Build a workflow that moves a school request to a confirmed workshop with an approved deck and automated reminders. Give staff a queue for exceptions and a way to take over at every stage.

## Product scope

| Area | Hackathon delivery | Full product |
|---|---|---|
| Intake | One Gmail workflow, with a labeled test inbox fallback. Ask all missing questions in one useful same-day reply. | Email, SMS, phone, and website intake without an app download. Staff-entered phone intake is an initial option. |
| Languages | Demo English correspondence and a Spanish workshop. Keep both settings separate in the model. | English, Spanish, and Haitian Creole for intake and workshop delivery. |
| Calendar | Google Calendar first. Use the staff's existing calendar for the planning call and track the workshop separately. | Independent mail and calendar connections with adapter interfaces for providers such as Outlook and Microsoft 365. |
| Slides | Adapt a short template, require staff clearance, collect feedback, and capture school approval of an exact version. | Expand templates and add AI-assisted drafting and revision with the same review gate. |
| Venues | Simulated Miami-Dade room catalog, search, and reservations. | Leave a path to real inventory and booking integrations. |
| Tenancy | Platform admin provisions branded subdomains in a shared deployment. Demo two isolated workspaces. | Multiple nonprofits, each with its own configuration, staff, Google connections, and records. |

## Roles and permissions

- **Platform admin** creates or suspends tenants, reserves subdomains, and assigns initial tenant admins. Workshop records require separate tenant access.
- **Tenant admin** manages branding, time zone, languages, staff membership, and tenant-specific provider connections.
- **Coordinator** manages intake, scheduling, room reservations, exceptions, and automation pause or resume.
- **Program manager or reviewer** prepares and clears specific slide versions for school review.
- **School collaborator** supplies details, chooses a call slot, views shared slides, and submits comments through a request-scoped link.
- **Designated school approver** can also approve the current shared version on behalf of the school. Use one designated approver per request for the demo.
- **Automation** can extract details, send routine intake follow-ups when the request is clear, summarize feedback, draft slides, and search venues. Ambiguity goes to staff. Booking a room, clearing slides, and providing school approval require authorized people.

## Workflow and controls

| Step | Input | Output and control |
|---|---|---|
| Intake | Channel, school, contact, topic, age or grade, headcount, correspondence language, workshop language, format, availability, and applicable logistics | One request with conversation history. Ask for all missing details together. Deduplicate provider events and route ambiguous thread matches to staff. |
| Planning | School selects a slot from staff calendar availability | Recheck availability at booking. Record the event only after the calendar operation succeeds. Show an actionable failure otherwise. |
| Location | Workshop time window and location needs | Save the school's room or a virtual link, or search and reserve a simulated room. |
| Slides | Planning notes, class profile, and template | Staff clear an exact version before sharing. Store shared versions as immutable artifacts. |
| School review | Feedback from one or more school contacts | Consolidate feedback. Capture approver, version, and timestamp. A replacement version requires new staff clearance and school approval. |
| Confirmation | Agreed date and time, confirmed logistics, and school approval of the current staff-cleared deck | Mark the workshop confirmed and send a confirmation. A planning call or room reservation alone leaves the request pending. |
| Reminder | Upcoming confirmed workshop | Send a day-before room or virtual access check in the tenant's time zone. Surface failed delivery, no response by the cutoff, and reported changes. |

The queue shows status, next action, owner, and exceptions. Staff can correct details or pause automation. Pending jobs recheck pause state and relevant request changes before sending. Use class-level data and avoid collecting student identities or individual health information.

## Architecture

Use one codebase, a web/API process, a background worker, PostgreSQL for operational records and durable jobs, and private object storage for slide files. Keep the workflow independent of provider adapters.

- **Tenancy** resolves a platform-owned subdomain to a tenant. Enforce tenant membership and record ownership server-side across endpoints, school links, file downloads, credentials, and jobs. A school link carries only the permissions needed for its request and action.
- **Integrations** separate mail, calendar, and model interfaces. Start with Gmail and Google Calendar. Authorize and store each connection per tenant, protect credentials, and keep original provider message, thread, and event IDs. Verify provider setup against official docs when implementing.
- **Workflow and jobs** write state and job intent together. Deduplicate inbound events, use stable operation IDs, and reconcile uncertain external outcomes before retries. Record delivery errors and changes in a request timeline. Keep planning and workshop events distinct.
- **AI tools** return structured proposals and uncertainty for intake and slide work. Validate inputs and outputs in the application. The workflow owns permissions and transition rules. Provide deterministic fixtures for development without model credentials.
- **Venue catalog** stores fictional venues with ZIP codes and coordinates, and rooms with capacity, opening hours, amenities, and reservations. Treat demo inventory as tenant-local. Rank by approximate distance from the ZIP center and preferred equipment after filtering on radius, availability, capacity, and required amenities.
- **Reservations** recheck availability and prevent overlapping confirmed reservations atomically. On reschedule, secure a replacement before releasing the original where possible. Label fictional venue data and reservations as simulated throughout the demo.

Use low-cost defaults, existing calendars, and reusable templates. Record enough operational detail to measure response time and investigate failures. After-hours response policy, budget ceiling, live venue inventory, custom domains, and broader provider rollout are open decisions.

## Milestones

1. **Tenant foundation and first request.** Create a platform-admin provisioning form, tenant resolution, tenant membership checks, per-tenant branding, and a coordinator queue. Seed two fictional tenants and support one simulated inbound email with missing fields. Show the request and a single proposed follow-up in the queue.
2. **Google and workflow.** Connect Gmail and Google Calendar for a test tenant when authorized credentials are available. Verify same-thread intake replies, deduplication, and planning-call booking. Keep the labeled test adapters for local development.
3. **Venue simulation.** Search fictional venues for 30 eighth graders using a ZIP code, time window, and required projector. Show an eligible room and why an occupied, undersized, or unequipped room is excluded. Reserve an eligible room and show an overlap rejection.
4. **End-to-end demo.** Prepare a Spanish slide deck with English correspondence. Show two contacts giving feedback, staff clearing v2, and the designated approver approving v2. Confirm the workshop with its room and run the day-before check through a labeled demo trigger.

## Codex kickoff prompt

> Read tidepath-codex-brief.md and inspect this project for existing code and instructions. Implement Milestone 1 only. Reuse the existing stack if present. If the project is empty, use a small TypeScript web app and PostgreSQL as provisional defaults, and document how to run it locally. Build platform-admin tenant provisioning, server-side tenant isolation, per-tenant branding, the coordinator queue, and one clearly labeled simulated email intake. Seed two tenants and make the demo runnable without Google or LLM credentials. Verify that a user from one tenant cannot open the other tenant's request by URL or API and that the intake follow-up contains all missing fields. Report what works, how to run it, and any decisions made.
