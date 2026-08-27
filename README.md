# Vitals Backend

A modular Node.js/TypeScript backend for the Vitals health companion app.

For how the system is put together and why, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 5 |
| Language | TypeScript |
| ORM | Prisma |
| Database | PostgreSQL 16 (Supabase in production, Docker locally) |
| Queue / Jobs | BullMQ + Redis (Upstash in production) |
| Email | Brevo (HTTP API) |
| Payments | Paystack |
| Documents | PDFKit |
| AI | Gemini 2.5 Flash (text + vision), AssemblyAI (voice) |
| Push | Firebase Cloud Messaging |
| Deployment | Render (API + worker), Vercel (frontend) |
| CI | GitHub Actions — typecheck, build, both test suites |

---

## Local development

### Prerequisites

- Node.js 20 (`engines` pins `20.x`)
- Docker, for local Postgres and Redis

### Setup

```bash
# 1. Install
git clone <repo>
cd vitals-backend
npm install

# 2. Start Postgres and Redis
docker compose up -d --wait

# 3. Configure environment
cp .env.example .env
```

The local stack values `.env` expects:

```ini
DATABASE_URL=postgresql://postgres:local@localhost:5433/vitals
DIRECT_URL=postgresql://postgres:local@localhost:5433/vitals
UPSTASH_REDIS_URL=redis://localhost:6379
```

Redis is configured by URL, not by host/port/password. Use the `redis://`
scheme locally — `rediss://` enables TLS, which a local Redis does not speak.

```bash
# 4. Generate the client, migrate, seed
npx prisma generate
npx prisma migrate deploy
npm run db:seed

# 5. Run it — API and worker are separate processes
npm run dev          # Terminal 1 — API on :3000
npm run dev:worker   # Terminal 2 — BullMQ worker

# …or both in one process, which is what the container runs
npm run dev:all
```

> **Run the worker.** The API accepts requests and writes reminders; the worker
> is what sends them. Running only `npm run dev` gives you an app where
> reminders accumulate and nothing is ever delivered — see
> [Background jobs](ARCHITECTURE.md#7-background-jobs).

### Local stack

`docker-compose.yml` runs three services:

| Service | Container | Host port | Notes |
|---|---|---|---|
| `postgres` | `vitals-postgres` | **5433** | Dev database. Persisted in `vitals-pgdata`. |
| `redis` | `vitals-redis` | 6379 | Not persisted — queued jobs are disposable locally. |
| `postgres-test` | `vitals-postgres-test` | **5436** | Profile `test`. tmpfs, wiped on restart. |

Postgres is published on 5433 rather than 5432 so it cannot collide with
another Postgres already on the host; inside the compose network it still
listens on 5432.

```bash
docker compose up -d --wait   # start, blocking until healthchecks pass
docker compose ps             # health and published ports
docker compose logs -f postgres

docker compose down           # stop, keeping the database
docker compose down -v        # stop and destroy the volume
```

> If the database behaves as though it holds someone else's data, check that
> the host port reaches the container you think it does. Comparing
> `pg_postmaster_start_time()` through `docker exec` against the same query
> over the mapped port will tell you: different values mean two different
> postmasters.

### Running the whole stack in Docker

The setup above runs the apps on the host against containerised infrastructure,
which is the fast loop and what you want day to day. To run **everything** in
containers instead — API, worker and the built web app:

```bash
docker compose --profile app up -d --build
```

| | Address |
|---|---|
| Web app | <http://localhost:8080> |
| API (direct) | <http://localhost:3000> |
| API (as the app sees it) | <http://localhost:8080/api/v1> |

The `app` profile is opt-in, so a bare `docker compose up -d` still starts only
Postgres and Redis and the host loop is unaffected.

**What this is for.** It is slower to iterate on — every change needs a rebuild
— so use it for the things the host loop cannot show you:

- the **production frontend build**, not the dev server
- the **same-origin `/api` proxy**, which is how production works and where the
  dev setup differs most
- **cookie auth over that proxy**, including refresh rotation
- the **worker running beside the API**, as the deployed container does, so
  reminders actually dispatch

**How the pieces find each other.** The frontend container is nginx serving the
built SPA and proxying `/api/` to the backend, mirroring the two rewrites in
`vercel.json`. That matters: a production build resolves its API base URL to the
empty string and calls its own origin, so without that proxy it has no backend
at all. `VITE_API_URL` is deliberately left unset — setting it would make the
requests cross-origin, which is a different transport from the one production
uses.

Because the browser reaches everything through `http://localhost:8080`, the
backend container is configured with `FRONTEND_URL` and `CORS_ORIGIN` set to
that origin. Auth requests carry `X-Auth-Transport: cookie` and the backend
refuses one whose `Origin` is not listed, so if you publish the web app on a
different port, change those two together or login answers **403**.

Migrations run automatically when the backend container starts — `prisma` is a
runtime dependency, so the production image has the CLI.

```bash
docker compose --profile app logs -f backend    # watch it migrate and boot
docker compose --profile app up -d --build      # rebuild after a change
docker compose --profile app down               # stop the apps and the database
```

The database is the same `vitals-pgdata` volume the host loop uses, so data
carries across between the two ways of running.

### Migrations

```bash
npx prisma migrate deploy     # apply pending migrations (what CI and prod run)
npm run prisma:migrate        # create a new migration from schema changes
npm run db:reset              # drop, re-migrate and re-seed
npx prisma studio             # browse the data
```

Twenty migrations, and the history is worth reading if you are touching the
Person model: `person_account_separation_phase_a` through `phase_c` moved
clinical data from accounts to Persons in three deploys, adding nullable
columns first, backfilling second, tightening cascades third. Nothing needed a
simultaneous cutover.

Every migration that moves data carries a backfill, a verification query and a
rollback path in its header comment.

### Seeding

```bash
npm run db:seed
```

Syncs `Price` rows from config — insert-only, because a price anyone may have
bought must not change underneath them — and creates `admin@vitals.health` and
`demo@vitals.health`. Override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

### Tests

Two commands, and the difference between them matters.

```bash
npm test                 # mocked suites — no containers needed
```

`npm test` runs `tests/unit` and `tests/integration`. The integration suites
mock Prisma wholesale: they are fast, and they **cannot** catch a cross-person
data leak, because a mocked client answers whatever it was told to.
Authorization is not meaningfully covered here.

```bash
npm run test:db:up       # start the test database (profile "test")
npm run test:db          # migrate, then run tests/db
npm run test:db:down     # stop it
```

`npm run test:db` runs against real Postgres on **5436**, applying real
migrations and issuing real `where` clauses. Every test that matters for access
control lives here. Tables are truncated between cases, so the harness refuses
to start unless the target database name ends in `_test` — the dev database is
one digit away.

If your host maps the ports differently, override the target:

```bash
TEST_DATABASE_URL=postgresql://postgres:local@127.0.0.1:5436/vitals_test npm run test:db
```

### Scripts

```bash
npm run dev              # API, watch mode
npm run dev:worker       # Worker, watch mode
npm run dev:all          # Both in one process
npm run build            # tsc
npm run typecheck        # tsc --noEmit  (alias: npm run lint)
npm test                 # Mocked suites
npm run test:coverage    # …with coverage
npm run test:db          # Database-backed suites
npm run verify:openapi   # Check every route is documented and every $ref resolves
npm run verify:docs      # Check the docs still match the code
npm run db:seed          # Seed
npm run db:reset         # Reset and re-seed
npm run prisma:generate  # Regenerate the Prisma client
```

---

## Environment

`src/config/env.ts` validates everything at boot with Zod and **exits rather
than starting half-configured**. Three categories:

### Required — the app will not start without these

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Pooled connection |
| `DIRECT_URL` | Direct connection, used for migrations |
| `JWT_ACCESS_SECRET` | Min 32 chars |
| `JWT_REFRESH_SECRET` | Min 32 chars |
| `BREVO_API_KEY` | Email |
| `BREVO_FROM_EMAIL` | |
| `BREVO_FROM_NAME` | |
| `FRONTEND_URL` | Used to build invitation and checkout return links |
| `API_URL` | |
| `CORS_ORIGIN` | Comma-separated, or `*` |
| `GOOGLE_CLIENT_ID` | Calendar OAuth |
| `GOOGLE_CLIENT_SECRET` | |
| `GOOGLE_REDIRECT_URI` | |

**Redis is required but flexible**: set either `UPSTASH_REDIS_URL`, or all of
`REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`. Boot fails if neither is
present.

### Optional — absence disables a feature, cleanly

| Variable | Absent means |
|---|---|
| `PAYSTACK_SECRET_KEY` | No payment provider registered. Checkout refuses with a clear message; `checkoutAvailable` is false and the UI keeps its placeholder. A **live** key outside `NODE_ENV=production` is refused at start-up. |
| `GEMINI_API_KEY` | Symptom checker and drug detection unavailable |
| `ASSEMBLYAI_API_KEY` | Voice transcription unavailable |
| `CLOUDINARY_*` | Image upload unavailable |
| `FIREBASE_*` | No push notifications; reminders fall back to email |
| `VAPID_PUBLIC_KEY` | Web push key for the frontend |

### Defaulted — safe to leave unset

Tuning knobs with working defaults: `PORT` (3000), `API_PREFIX` (`/api/v1`),
JWT expiry, rate limits, AI quotas per tier, and the billing and reminder
timings —

| Variable | Default | Meaning |
|---|---|---|
| `SUBSCRIPTION_PAST_DUE_GRACE_DAYS` | 7 | How long a failed renewal keeps Premium, from the failed charge |
| `BILLING_RECONCILE_INTERVAL_MS` | 1h | How often our state is compared against the provider's |
| `BILLING_EVENT_MAX_ATTEMPTS` | 5 | Attempts before a billing event is dead-lettered |
| `MISSED_WINDOW_MS` | 2h | How overdue a care event is before it counts as missed |
| `APPOINTMENT_MISSED_GRACE_MS` | 2h | Grace after an appointment's **end** before it counts as missed |
| `APPOINTMENT_SWEEP_INTERVAL_MS` | 15m | How often that sweep runs |
| `ADHERENCE_CHECK_DELAY_MS` | 30m | Delay before an adherence check fires |

See `.env.example` for the full annotated list.

---

## API documentation

Swagger UI at `http://localhost:3000/api-docs` in development.

```bash
npm run verify:openapi
```

`swagger-jsdoc` silently drops a block whose YAML does not parse, so a spec
missing half its routes looks exactly like a healthy one. The verifier counts
routes in the source against operations in the spec, resolves every `$ref`, and
fails if the numbers disagree.

Further reading:

- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — cookie transport, refresh rotation
- [`docs/API_PERFORMANCE.md`](docs/API_PERFORMANCE.md) — request timing, query plans
- [`docs/AI_SAFETY.md`](docs/AI_SAFETY.md) — AI guardrails
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Render/Vercel deployment

---

## CI

`.github/workflows/build.yml` runs on push, in two jobs:

- **Typecheck, test, build** — `prisma generate`, `typecheck`, `verify:openapi`, `verify:docs`, `npm test`, `build`
- **Database-backed integration tests** — spins up Postgres and runs `tests/db`

---

## Layout

```
src/
  modules/            One folder per domain
    person/           Persons, memberships, invitations, claiming, erasure
    auth/             Signup, login, refresh, verification
    user/             Profile, admin user control
    billing/          Prices, subscriptions, entitlement, webhooks, Paystack
    care/             Shared care engine — plans, events, reminders
    medications/      Medication plans and dose scheduling
    appointments/     Appointments, person-native
    reports/          Streamed PDF health summaries
    mother-baby/      Pregnancy timeline, delivery, baby vaccination
    calendar/         Google Calendar sync
    mood/             Mood and craving logging
    symptoms/         AI symptom checker
    drug-detection/   AI image-based drug identification
    ai-medication-drafts/  Conversational medication capture
    dashboard/        Aggregated home screen
    articles/         Health content — public read, admin CRUD
    push/             Push subscription lifecycle
    usage/            AI quota state
    outbox/           Reliable async event dispatch
    health/           Readiness check

  providers/          External integrations, isolated from domain
  queues/             BullMQ queue and job registry
  workers/            Worker processes — notifications, adherence, billing
  jobs/               Repeatable scheduled jobs
  middleware/         Auth, errors, rate limiting, request timing
  lib/                Prisma, Redis, logger, JWT, errors, responses
  config/             env, swagger, and domain config
  types/              Shared types

prisma/               Schema, 20 migrations, seed
scripts/              verify-openapi.js
tests/
  unit/               Pure logic — validators, schedulers, safety rules
  integration/        Mocked Prisma — fast, cannot catch scoping bugs
  db/                 Real Postgres — where authorization is actually tested
```

### Endpoints

| Prefix | Purpose |
|---|---|
| `/api/v1/auth` | Signup, login, refresh, verify, logout |
| `/api/v1/users` | Profile, admin user management |
| `/api/v1/persons` | Persons, health profiles, members, invitations, transfer, consent ledger |
| `/api/v1/invitations` | The invitee's side — preview, list, accept, claim, decline |
| `/api/v1/billing` | Tiers, plan, checkout, cancellation, admin tier writes |
| `/api/v1/billing/webhooks` | Provider webhooks — unauthenticated, signature-verified |
| `/api/v1/appointments` | Appointments for a Person |
| `/api/v1/reports` | Streamed PDF health summary |
| `/api/v1/care` | Care event timeline and status |
| `/api/v1/medications` | Medication plans and schedules |
| `/api/v1/mother-baby` | Pregnancy, delivery, baby vaccination |
| `/api/v1/calendar` | Google Calendar connection and sync |
| `/api/v1/mood` | Mood and craving logging |
| `/api/v1/symptoms` | AI symptom checker |
| `/api/v1/drug-detection` | AI drug identification |
| `/api/v1/ai/medication-drafts` | Conversational medication capture |
| `/api/v1/usage` | Daily AI quota state |
| `/api/v1/articles` | Health content |
| `/api/v1/health` | Readiness check |

---

## Working on this codebase

Three things that will save you time:

1. **Accounts and Persons are different entities.** Clinical rows belong to a
   Person. If you are writing a query with `where: { userId }` against clinical
   data, stop and read
   [the authorization section](ARCHITECTURE.md#2-authorization).
2. **`resolveSubject` is the only way in.** Every person-scoped endpoint
   resolves its subject and asserts its capability in one call. A `personId` in
   a request is a request for a subject, never a grant of one.
3. **Test authorization in `tests/db`.** The mocked suites cannot catch a
   cross-person leak.
