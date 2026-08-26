# Deployment State and Known Issues

**Live services last verified: 2026-08-22.**
**Repository claims re-verified against the code: 2026-08-26.**

Those are two different things and this document keeps them apart. Everything
under "Verified working" was checked by making requests to the running service
on 22 August and has **not** been re-checked since. Everything under "Open
issues" and "Continuous integration" was re-derived from the repository on
26 August and is current.

## Topology

```
Browser ──▶ Vercel (frontend)  ──▶ Render (API + worker)  ──▶ Supabase (Postgres)
                                                          └─▶ Upstash (Redis)
```

Both hosts deploy from `main` in their own repository. The two repositories are
separate: `Ige-Joseph/vitals-backend` and `Ige-Joseph/vitals-frontend`.

## Verified working — as of 2026-08-22, not since

Checked against `vitals-backend-service.onrender.com`:

- Service healthy; database and Redis reachable
- Cookie-transport auth live — an untrusted `Origin` is rejected with 403, a
  trusted one passes the check
- `replacedByTokenHash` migration applied; refresh returns 401 for an unknown
  token rather than a 500
- `Cache-Control: no-store` and `access-control-allow-credentials: true` present

Reproduce with the commands in the README's "Verifying a deploy landed" section.

> Several releases have landed since that check — appointments, reports,
> billing, invitations and claiming, plus the worker entrypoint fix below. None
> of it has been verified against the live service.

---

## Resolved since the last live check

### The worker was not running — fixed 2026-08-26

This was real, it was the cause of a visible failure, and it is worth recording
in full because the symptom pointed nowhere near the cause.

**Symptom.** Reminders accumulated as `PENDING` rows and none was ever
delivered.

**Cause.** The `Dockerfile` `CMD` ran `dist/server.js`, which starts the HTTP
API and nothing else. Every repeatable job — the sixty-second reminder tick
above all — is registered by `worker.ts` via `startScheduledJobs()`, which
`server.js` never calls. So the deployment accepted requests, wrote reminders,
scheduled them correctly, and had nothing running that would ever claim one.

**Fix.** The `Dockerfile` now runs `dist/main.js`, which is
`import './worker'; import './server';` — both halves in one process, which is
what this single-service deployment needs. The file carries a comment saying
why, so it is not reverted.

**Rehearsed, not assumed.** The compiled entrypoint was booted against a real
Redis and a seeded overdue reminder. The tick fired sixty seconds after start,
found the reminder, resolved a recipient, wrote the outbox row and moved it to
`SENT` — and the outbox poller then picked that up in turn. A `tests/db` suite
now covers claim and dispatch, including two callers racing one reminder.

**Note on the scripts.** `npm start` still runs `dist/server.js` and
`npm run start:worker` runs `dist/worker.js`. That is correct and deliberate:
those exist for a deployment that splits the API and the worker onto separate
services. If the worker is ever split out, that service runs `dist/worker.js`
and the Dockerfile goes back to `dist/server.js`. Until then, running only half
of it silently loses reminders.

---

## Open issues

### Reminders now dispatch — so the email key matters in a way it did not before

**Risk, not a confirmed fault.** During the worker rehearsal the outbox poller
reached Brevo and got **`401`**. The key in the local `.env` is a placeholder,
so that is expected locally and was itself useful evidence that the whole chain
runs.

The point is what changed. Until 26 August, reminders were never dispatched at
all, so an invalid `BREVO_API_KEY` in production would have caused no visible
symptom. Now that dispatch works, an invalid key means reminders are **sent and
still do not arrive** — and the failure surfaces as `FAILED` outbox rows rather
than as anything a user or an uptime check would notice.

**Check before trusting reminder delivery:** confirm the production
`BREVO_API_KEY` is valid, and query `outbox_events` for
`status = 'FAILED'`.

### Vercel is not deploying the frontend — unverified since 2026-08-22

**As of 22 August the live frontend was a build from before 2026-05-12.** It
predated the calendar integration, the profile redesign, and the login 401 fix.

Evidence at the time: the served `index.html` still carried `theme-color
#0f172a`, changed to `#005bbf` in commit `73506fb`. The served bundle contained
none of `X-Auth-Transport`, `vitals:session-expired`, or `consumeLegacy`.
`vercel.json` was not applied at all — no CSP header returned, and `/dashboard`
404ed, so even the SPA rewrite was missing.

The code on `main` was correct; the deployment was not tracking it. Check in the
Vercel dashboard whether the project is connected to the right repository,
whether Production is set to `main`, whether builds are failing, and whether
production is pinned to an old deployment.

**This has not been re-checked.** If it is still true, none of the invitation,
claiming, appointment or report frontends have ever reached a user, and any
conclusion drawn from the live site is about a build that is now months old.

### The Vercel dashboard environment is outside CI's reach

CI builds the frontend with `VITE_API_URL` unset, which is what keeps requests
same-origin. It cannot see the environment variables configured in the Vercel
dashboard, so a `VITE_API_URL` added there breaks Safari with CI fully green.
That invariant is enforced by review, not by a check — see `API_TRANSPORT.md`
in the frontend repository.

### The frontend `lint` script does not work

`vitals-frontend` has `"lint": "eslint . --ext ts,tsx"` left over from the Vite
template. ESLint is **not** in `devDependencies` and there is no config file, so
`npx eslint` fetches ESLint 10, which then fails looking for a flat
`eslint.config.*`. CI does not run it. Adding a linter is a separate decision
from wiring up CI.

---

## Migrations

`prisma migrate deploy` runs the pending migrations. Two things to know before
a release.

**Some migrations change data, not just shape.** `self_person_origin_backfill`
rewrites `persons.origin` for every account's own record. Migrations that touch
data carry their verification query in the header comment — run it after
deploying and confirm the result, rather than assuming.

**Enum values cannot be removed.** Several migrations add values to existing
enums (`CLAIM_REFUSED`, `PERSON_INVITATION`, `APPOINTMENT`, `DEAD_LETTERED`).
Postgres has no `DROP VALUE`, so a rollback leaves them in place. They are inert
when unused, and each migration's header says so — but it means a partial
rollback of a release is not symmetrical, and the rollback notes are worth
reading before you need them.

## Configuration that fails closed

Two boot-time guards worth knowing about, because both stop the service rather
than degrading quietly:

- **`src/config/env.ts` validates the environment at import** and calls
  `process.exit(1)` on anything missing. A half-configured deploy does not
  start; it exits. Required variables are listed in the README.
- **A live Paystack key outside production is refused at start-up.** If
  `PAYSTACK_SECRET_KEY` begins `sk_live_` and `NODE_ENV` is not `production`,
  registration throws. One paste into the wrong `.env` would otherwise mean a
  development box charging real cards, and nothing else in the codebase would
  notice.

`PAYSTACK_SECRET_KEY` is optional. Absent, no provider is registered, checkout
refuses with a clear message and `checkoutAvailable` is false — a deploy without
it works, it just cannot sell anything.

---

## Continuous integration

Both repositories run a `CI` workflow on push to `main` and on pull requests
against it.

| Repository | Job | Steps |
|---|---|---|
| `vitals-backend` | Typecheck, test, build | `npm ci` → `prisma generate` → `typecheck` → `verify:openapi` → `npm test` → `build` |
| `vitals-backend` | Database-backed integration tests | `npm ci` → `prisma generate` → `npm run test:db` |
| `vitals-frontend` | Build | `npm ci` → `tsc && vite build` |

The backend's first job supplies throwaway values for every variable
`src/config/env.ts` requires, because that module validates at import time and
exits — without them no test would run. Its suites mock Prisma, Redis and every
provider, so that job needs no database.

**The second job does.** It runs a `postgres:16-alpine` service container on
port 5436 with `TEST_DATABASE_URL` pointed at it, applies real migrations and
issues real queries. This is the job that can catch a cross-person data leak;
the mocked suites cannot, because a mocked client answers whatever it was told
to.

`verify:openapi` runs as a step in the first job. It fails if a route is
undocumented, a block's YAML does not parse, or a `$ref` does not resolve —
which is what catches a new route landing without documentation. It is static
and needs no database, so it sits beside the typecheck rather than in the
database job.

## Safari and cookie transport

The refresh cookie is `HttpOnly` and cross-site between `vercel.app` and
`onrender.com`, and Safari blocks third-party cookies outright. The frontend
therefore routes API calls through a same-origin Vercel proxy — see
`docs/API_TRANSPORT.md` in the frontend repository.

Custom domains sharing one registrable domain remove the need for the proxy and
are the better fix. They also become a prerequisite if the PWA is ever packaged
as an Android app, since a Trusted Web Activity verifies ownership through
`/.well-known/assetlinks.json` on a domain you control.

## Related documents

| Document | Covers |
|---|---|
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | How the system is put together, and why |
| [`AUTHENTICATION.md`](AUTHENTICATION.md) | Token model, cookie transport, rotation grace window |
| [`AI_SAFETY.md`](AI_SAFETY.md) | AI posture, output guards, known limits |
| [`API_PERFORMANCE.md`](API_PERFORMANCE.md) | Query timing, indexes, benchmarking |
