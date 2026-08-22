# Vitals Backend

A modular Node.js/TypeScript backend for the Vitals health companion app.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| Language | TypeScript |
| ORM | Prisma |
| Database | PostgreSQL (Supabase in production, Docker locally) |
| Queue / Jobs | BullMQ + Upstash Redis |
| Email | Brevo (HTTP API) |
| AI | Gemini 2.5 Flash (text + vision), AssemblyAI (voice) |
| Push | Firebase Cloud Messaging |
| Deployment | Render (API + worker), Vercel (frontend) |
| CI/CD | None currently — the workflow file is empty |

---

## Local development

### Prerequisites

- Node.js 20+
- Docker (for local Postgres + Redis)

### Setup

```bash
# 1. Clone and install
git clone <repo>
cd vitals-backend
npm install

# 2. Start local Postgres and Redis
docker compose up -d postgres redis

# 3. Configure environment
cp .env.example .env
# Edit .env — local docker values are:
#   DATABASE_URL=postgresql://vitals:vitals_local@localhost:5432/vitals_dev
#   DIRECT_URL=postgresql://vitals:vitals_local@localhost:5432/vitals_dev
#   REDIS_HOST=localhost
#   REDIS_PORT=6379
#   REDIS_PASSWORD=vitals_local
#   REDIS_TLS=false

# 4. Run migrations and seed
npx prisma generate
npx prisma migrate deploy
npm run db:seed

# 5. Start API and worker (two terminals)
npm run dev          # Terminal 1 — API server on :3000
npm run dev:worker   # Terminal 2 — BullMQ worker process
```

### Available scripts

```bash
npm run dev              # Start API in watch mode
npm run dev:worker       # Start worker in watch mode
npm run build            # Compile TypeScript
npm run test             # Run all tests
npm run test:coverage    # Tests with coverage report
npm run typecheck        # TypeScript check (no emit)
npm run db:seed          # Seed database with admin + sample data
npm run db:reset         # Reset DB and re-seed
npx prisma studio        # Open Prisma Studio GUI
```

---

## API Documentation

Swagger UI is available at `http://localhost:3000/api-docs` in development.

Browser authentication uses an HttpOnly refresh cookie and an in-memory access
token. See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the request
contract, deployment requirements, and legacy migration behavior.

See [`docs/API_PERFORMANCE.md`](docs/API_PERFORMANCE.md) for local infrastructure,
request timing, benchmarking, connection guidance, and query-plan verification.

---

## Deployment

| Component | Host |
|---|---|
| API + worker | Render — `vitals-backend-service.onrender.com` |
| Frontend | Vercel |
| Database | Supabase PostgreSQL |
| Redis | Upstash |

Render deploys from `main`. Merging to `main` triggers a build.

Render is configured through its dashboard — there is no `render.yaml` in the
repository, so build and start commands are not visible here. The `Dockerfile`
builds the API and is kept because Render may be building from it; confirm which
before changing it.

### Required environment

Set these in the Render dashboard. `.env.example` lists the full set with
descriptions; these are the ones whose values are deployment-specific:

| Variable | Note |
|---|---|
| `DATABASE_URL` | Supabase pooled connection string |
| `DIRECT_URL` | Supabase direct connection, used for migrations |
| `CORS_ORIGIN` | Exact frontend origins, comma separated. Never `*` — cookie auth rejects requests from origins not listed here |
| `FRONTEND_URL` | Used alongside `CORS_ORIGIN` for cookie-transport origin checks |
| `NODE_ENV` | Must be `production` so the refresh cookie is `Secure` |

### Migrations

Migrations must run before the new code serves traffic. Prisma selects every
column it knows about, so deploying code ahead of its migration produces
PostgreSQL `42703` errors on any table whose schema moved — for `RefreshToken`
that takes down login, signup, refresh, and logout together.

Confirm the build or start command runs `prisma migrate deploy`. `prisma` is in
`dependencies`, not `devDependencies`, so it survives a production install.

If migrations are not automated, this start command does both and also runs the
worker, which `dist/server.js` alone does not:

```bash
prisma migrate deploy && node -r module-alias/register dist/main.js
```

| Entry point | Runs |
|---|---|
| `dist/server.js` | API only |
| `dist/worker.js` | Worker only |
| `dist/main.js` | Both |

### Verifying a deploy landed

Do not infer from a green build that the running service changed. These checks
confirm it against the live API:

```bash
API=https://vitals-backend-service.onrender.com

# Service up, dependencies reachable
curl -s $API/api/v1/health

# Migration applied — 401 means the RefreshToken schema matches the code.
# A 500 means a column is missing and auth is down.
curl -s -X POST $API/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"probe"}'

# Cookie-transport origin check is enforced — expect 403
curl -s -X POST $API/api/v1/auth/refresh \
  -H 'X-Auth-Transport: cookie' -H 'Origin: https://untrusted.example' \
  -H 'Content-Type: application/json' -d '{}'

# A trusted origin gets past the origin check — expect 422, not 403
curl -s -X POST $API/api/v1/auth/refresh \
  -H 'X-Auth-Transport: cookie' -H 'Origin: <your frontend origin>' \
  -H 'Content-Type: application/json' -d '{}'
```

### CI

`.github/workflows/build.yml` exists but is empty, so nothing runs on push. Two
unit suites are currently failing and unrelated to CI being absent — see the
known issues in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Architecture

```
src/
  modules/          One folder per domain module
    auth/           Signup, login, token refresh, verification
    user/           Profile management, admin user control
    care/           Shared care engine — plans, events, reminders
    medications/    Medication plans and dose scheduling
    mother-baby/    Pregnancy timeline, delivery, baby vaccination
    mood/           Mood and craving logging (deterministic insights)
    symptoms/       AI symptom checker
    drug-detection/ AI image-based drug identification
    push/           Push subscription lifecycle
    dashboard/      Aggregated home screen data
    articles/       Health content — public read, admin CRUD
    usage/          AI quota state
    outbox/         Reliable async event processing
    health/         Readiness check

  providers/        External integrations (isolated from domain)
    email/          Brevo SMTP adapter + email service
    push/           Web Push provider
    ai/             Gemini text + vision provider

  queues/           BullMQ queue registry — all queue/job definitions
  workers/          BullMQ worker processes
  jobs/             Scheduled repeatable jobs
  middleware/       Auth, error handling, rate limiting
  lib/              Shared utilities — logger, Prisma, Redis, JWT
  config/           Domain config files — medication, pregnancy, mood
  types/            Shared TypeScript types
```

### Key patterns

- **Outbox pattern** — domain events written to DB atomically with domain data, picked up by worker
- **Shared care engine** — all health journeys (medication, pregnancy, vaccination) schedule events through one system
- **Config-driven domains** — pregnancy milestones, vaccination schedules, mood options, medication frequencies all live in config files
- **Server-side quota enforcement** — AI quotas checked and incremented atomically before every AI call
- **Idempotent jobs** — every BullMQ job checks for existing attempts before processing

---

## Module summary

| Endpoint prefix | Purpose |
|---|---|
| `/api/v1/auth` | Signup, login, refresh, verify email, logout |
| `/api/v1/users` | Profile CRUD, admin user management |
| `/api/v1/care` | Care event timeline and status updates |
| `/api/v1/dashboard` | Aggregated home screen |
| `/api/v1/push` | Push subscription register/remove |
| `/api/v1/medications` | Medication plans and schedules |
| `/api/v1/mood` | Mood and craving logging |
| `/api/v1/symptoms` | AI symptom checker |
| `/api/v1/drug-detection` | AI drug image identification |
| `/api/v1/usage` | Daily AI quota state |
| `/api/v1/mother-baby` | Pregnancy, delivery, baby vaccination |
| `/api/v1/articles` | Health content |
| `/api/v1/health` | Readiness check |
