# Ops Console — Phase 3 Technical Foundation

Minimal backend foundation: organisations, users, roles, permissions,
authentication, sessions, and audit. No CRM features migrated yet —
see the Phase 3 report for what this is and isn't.

## Run it

```
npm install
node server.js
```

Server starts on http://localhost:4000 (override with PORT env var).
A SQLite file `foundation.db` is created automatically on first run.

## Deploying so the browser can actually reach it

Node's built-in `node:sqlite` requires Node 22.5+ — `package.json` pins
this via `engines`. `npm start` runs `node server.js`; `PORT` is read from
the environment (falls back to 4000), and CORS is already wide-open in
`server.js` for this phase. That's everything a host needs to know.

1. Push/upload this `D.U.B.S_CRM_Backend_CURRENT/` folder to a Node host
   (Render, Railway, Fly.io, a VPS — anything that runs `npm install` then
   `npm start` on Node 22+).
2. **Persistent disk**: `foundation.db` is a plain file next to the code.
   Most free/hobby tiers wipe the filesystem on every redeploy — if your
   host does that, attach a persistent volume and set
   `FOUNDATION_DB_PATH=/that/volume/foundation.db`, or your users/leads
   will reset on the next deploy. Check this before provisioning agents
   for real.
3. Once it's live, paste the resulting URL + `/api` (e.g.
   `https://your-app.onrender.com/api`) into the CRM's "Backend API base
   URL" field (Backend Sync tab, owner-only). Nothing else changes.
4. Tighten CORS from `*` to your actual frontend origin once that's known
   — noted in `server.js` as a follow-up, not done by default here since
   the origin wasn't known at build time.

## Try it

```
# Register an organisation + its first owner user
curl -X POST http://localhost:4000/api/organisations/register \
  -H "Content-Type: application/json" \
  -d '{"organisationName":"My Company","ownerEmail":"me@example.com","ownerPassword":"a-real-password"}'

# Log in
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"a-real-password"}'

# Use the returned token
curl http://localhost:4000/api/me -H "Authorization: Bearer <token>"
```

## What's here
- `db.js` — schema (organisations, users, roles, permissions, sessions, audit_events)
- `auth.js` — password hashing (scrypt) + session token issuance/validation
- `permissions.js` — central permission catalogue + default roles + requirePermission() middleware
- `middleware/requireAuth.js` — session validation, attaches req.user from the SERVER-VERIFIED session
- `repositories/` — organisation-scoped data access (the enforcement point for tenant isolation)
- `routes/` — auth + protected endpoints

## What's deliberately NOT here yet
No leads, activities, pipelines, or any existing CRM feature. This is the
foundation only — see the Phase 3 report, section M.

## Phase 4 additions
- `db.js` — extended with `leads`, `contacts`, `migration_runs` tables
- `repositories/leadRepository.js`, `repositories/contactRepository.js` — organisation-scoped data access for leads/contacts
- `routes/leads.js` — list/view/create/update leads, list/view contacts — all authenticated, permission-gated, organisation-scoped
- `migrate_leads.js` — safe, idempotent migration script from a legacy CRM lead export (JSON array) into the new schema
- `legacy_leads_export.json` — the real 100-record historical dataset used to test the migration (see Phase 4 report)

Run a migration:
```
node migrate_leads.js legacy_leads_export.json <organisationId> "source label"
```

## Phase 5 additions
- `db.js` — extended with `activities`, `tasks` tables
- `repositories/activityRepository.js`, `repositories/taskRepository.js` — organisation + ownership scoped
- `routes/activities.js` — activities (create/read/update) and tasks (create/read/update/complete)
- `test_phase5.js` — repeatable verification script (uses Node's built-in fetch)

Channels supported: call, email, whatsapp, meeting, note, other (validated server-side, easy to extend — not hardcoded business rules).

## Frontend/Backend connection
- `crm-api-client.js` — thin fetch-based API client, dual-use (Node + browser, same code)
- The actual CRM HTML (see `Ops_Console_with_Backend_Sync.html` alongside this zip) has a new
  "Backend Sync" tab with this client embedded, wired to Login → view lead → open contact →
  create activity → create/complete task → refresh. Existing Pipeline/Dashboard/Leaderboard/
  everything else is untouched — still running on the old local storage system.
- `run_full_integration.js` — starts the API in-process and runs the full flow end-to-end,
  using the EXACT client code extracted from the HTML file, against real migrated lead data.
  Run it yourself: `node run_full_integration.js`
- New endpoint added this phase: `GET /api/leads/:leadId/activities` (needed once a frontend
  actually renders lead history — Phase 5 only built the write side).

**To actually use this from your browser:** the backend needs to be deployed somewhere with a
real, reachable URL (Claude artifacts can't reach an ad-hoc localhost server). Once deployed,
open the CRM, go to Backend Sync, set the URL, and log in.

## Phase 6 additions
- `db.js` — extended with a `stage_history` table
- `repositories/stageHistoryRepository.js` — records a row every time `leadRepository.updateScoped()`
  actually changes a lead's `stage` (not on every update, and not on a no-op "set it to what it
  already was" call) — written from inside the repository, so no route can forget to call it separately
- `leadRepository.js` — `updateScoped()` now accepts `contact_id` (attach a contact to an existing
  lead), takes an `actorUserId` for stage-history attribution, and gained `archiveScoped()` /
  `unarchiveScoped()`; `listScoped()` now excludes archived leads by default (`includeArchived: true`
  to include them) — archived leads are never deleted, still reachable directly via `getByIdScoped()`
- `contactRepository.js` — gained `updateScoped()`; contacts could previously only be created inline
  at lead-creation time and never edited
- `taskRepository.js` — `listScoped()` gained a `leadId` filter (previously only `assignedUserId`)
- `permissions.js` — added `contact.create` / `contact.edit` to the catalogue, on all four default roles
- `routes/leads.js` — new endpoints:
  - `POST /api/contacts`, `PUT /api/contacts/:id` — standalone or lead-attached contact create/edit
  - `POST /api/leads/:id/archive`, `POST /api/leads/:id/unarchive` — dedicated action endpoints
  - `GET /api/leads/:id/stage-history` — **fixes a real bug**: the frontend already called this
    unconditionally on every lead-detail load; it didn't exist, so viewing any lead's details failed
  - `GET /api/leads/:leadId/tasks` — the "tasks created this session only" limitation from Phase 6's
    first pass is now a real persisted list, mirroring `GET /api/leads/:leadId/activities`
- `run_phase6_integration.js` — 25-check suite covering everything above (contact CRUD, archive/
  unarchive, stage history including the no-duplicate-on-no-op case, tasks-for-lead, ownership
  scoping for an AGENT user — not just cross-org isolation, cross-org isolation on every new endpoint,
  and persistence across a fresh client instance). Run: `node run_phase6_integration.js`
- `extracted_client.js` — a thin re-export of `crm-api-client.js` under the filename the older test
  scripts import; same client code, not a second copy
- Removed `test_phase5.js` — it hardcoded an organisation ID from a prior session's database and no
  longer runs against a fresh one; its coverage (activity/task create/read/update/complete, cross-org
  blocking, unauthenticated blocking) is superseded by `run_full_integration.js` and
  `run_phase6_integration.js`

**Both suites pass together with zero conflicts:** `run_full_integration.js` (13/13) then
`run_phase6_integration.js` (25/25), run back-to-back against a fresh database each time.

## Phase 7 additions
- `stages.js` — the canonical pipeline stage vocabulary (`New`, `Contacted`, `Engaged`,
  `Follow-up scheduled`, `Converted`, `Dead`), matching the stage list already used by the
  existing frontend's stage selects/badges. One shared source of truth instead of a free-text
  field with no server-side vocabulary.
- `routes/leads.js` — `POST /leads` and `PUT /leads/:id` now reject a `stage` value outside
  the canonical list (400), instead of silently accepting any string. A lead already carrying
  a non-canonical stage (e.g. migrated/legacy data) is untouched — validation only applies to
  new writes.
- `routes/leads.js` — new `GET /api/pipeline`: leads grouped by stage in canonical order, each
  group carrying its `count` and `leads`. Same own-vs-org visibility rule as `GET /leads`
  (`data.view.own` vs `data.view.org`) and the same archived-exclusion default — this is a
  regrouping of that same list, not a separate data source. A lead with a non-canonical stage
  still appears, grouped under its own key, rather than being dropped.
- `crm-api-client.js` — gained `getPipeline()`.
- `run_phase7_integration.js` — 14-check suite: stage validation on create/update (including
  that a rejected update doesn't mutate the lead), canonical stage ordering, correct grouping,
  archived-lead exclusion, own-scoping for an AGENT vs full-org view for the OWNER, cross-org
  isolation, and unauthenticated blocking. Run: `node run_phase7_integration.js`

**All three suites pass together with zero conflicts:** `run_full_integration.js` (13/13),
`run_phase6_integration.js` (25/25), `run_phase7_integration.js` (14/14) — run back-to-back
against a fresh database each time.

## Phase 8 additions
- `repositories/userRepository.js` — gained `updateScoped()` (role_id / status) and
  `getPublicByIdScoped()` (same shape as `listByOrganisation` — never returns password
  hash/salt). Users could previously only be created once, at organisation-registration time.
- `routes/protected.js` — new endpoints, both `users.manage`-gated:
  - `POST /api/users` — add a user to the caller's organisation (email, password ≥8 chars,
    role from `OWNER|MANAGER|SENIOR|AGENT`); rejects a duplicate email (same global-uniqueness
    rule as org registration) and an unrecognised role.
  - `PUT /api/users/:id` — change role and/or `status` (`active`/`disabled`). A disabled user
    is blocked on their very next request — `requireAuth` already re-checks `user.status` on
    every call, so this needed no new enforcement, just a way to flip the flag.
- `routes/leads.js` — `PUT /leads/:id` now accepts `ownerUserId` to reassign a lead's owner.
  Gated on `data.view.org` (the same permission level already used elsewhere in this file to
  mean "can edit any lead," not just your own) rather than `users.manage` — reassignment is a
  lead-editing action, not a user-management one. Validates the target is an active user in
  the caller's organisation; sets both `owner_user_id` and `owner_name_raw`.
- `crm-api-client.js` — gained `listUsers`, `createUser`, `updateUser`, `reassignLead`.
- `run_phase8_integration.js` — 17-check suite: user create/validation (duplicate email,
  invalid role, short password), permission gating (AGENT forbidden from creating users),
  role promotion, deactivation taking effect immediately, cross-org user isolation, lead
  reassignment (including AGENT forbidden, invalid target user, cross-org lead blocked).
  Run: `node run_phase8_integration.js`

**All four suites pass together with zero conflicts:** `run_full_integration.js` (13/13),
`run_phase6_integration.js` (25/25), `run_phase7_integration.js` (14/14),
`run_phase8_integration.js` (17/17) — run back-to-back against a fresh database each time.

### Note on this session's test environment
This sandbox has no network access, so `npm install` could not fetch the real `express`
package. To actually execute and verify the three suites above, a minimal local shim
implementing only the subset of Express this codebase uses (Router, `express.json()`,
`req.params`/`req.body`, `res.json`/`status`/`sendStatus`) was placed under
`node_modules/express` for this session only. All test results above are real — the shim
runs your actual, unmodified route/repository code — but it is not a substitute for the real
`express` package. Run `npm install` in a normal environment (or redeploy) before relying on
`node_modules` here; don't ship this sandbox's `node_modules` folder.

### Frontend wiring
`crm-api-client.js` (and the copy embedded in the CRM HTML) gained `createContact`, `updateContact`,
`archiveLead`, `unarchiveLead`. The Backend Sync tab's lead-detail view now shows editable
name/email/phone fields for the contact (creates-and-attaches if the lead has none, otherwise saves
in place) and an Archive/Unarchive button that flips label and color based on the lead's current
`archived` state.