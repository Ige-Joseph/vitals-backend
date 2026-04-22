# Vitals Backend

A modular Node.js/TypeScript backend for the Vitals health companion app.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| Language | TypeScript |
| ORM | Prisma |
| Database | PostgreSQL (NeonDB) |
| Queue / Jobs | BullMQ + Upstash Redis |
| Email | Brevo (SMTP) |
| AI | Gemini 1.5 Flash |
| Deployment | Fly.io (API + Worker) |
| CI/CD | GitHub Actions |

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
docker-compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env — local docker values are:
#   DATABASE_URL=postgresql://vitals:vitals_local@localhost:5432/vitals_dev
#   REDIS_HOST=localhost
#   REDIS_PORT=6379
#   REDIS_PASSWORD=vitals_local
#   REDIS_TLS=false

# 4. Run migrations and seed
npx prisma generate
npx prisma migrate dev --name init
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

---

## Deployment

### Fly.io setup (first time)

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Create API app
flyctl apps create vitals-api --config fly.api.toml

# Create Worker app
flyctl apps create vitals-worker --config fly.worker.toml

# Set secrets for API
flyctl secrets set \
  DATABASE_URL="postgresql://..." \
  JWT_ACCESS_SECRET="..." \
  JWT_REFRESH_SECRET="..." \
  REDIS_HOST="..." \
  REDIS_PORT="6380" \
  REDIS_PASSWORD="..." \
  REDIS_TLS="true" \
  BREVO_SMTP_HOST="smtp-relay.brevo.com" \
  BREVO_SMTP_PORT="587" \
  BREVO_SMTP_USER="..." \
  BREVO_SMTP_PASS="..." \
  EMAIL_FROM_ADDRESS="noreply@vitals.health" \
  EMAIL_FROM_NAME="Vitals" \
  FRONTEND_URL="https://vitals.app" \
  API_URL="https://vitals-api.fly.dev" \
  CORS_ORIGIN="https://vitals.app" \
  GEMINI_API_KEY="..." \
  VAPID_PUBLIC_KEY="..." \
  VAPID_PRIVATE_KEY="..." \
  VAPID_SUBJECT="mailto:admin@vitals.health" \
  --config fly.api.toml

# Copy same secrets to worker (shares most config)
flyctl secrets set \
  DATABASE_URL="postgresql://..." \
  JWT_ACCESS_SECRET="..." \
  JWT_REFRESH_SECRET="..." \
  REDIS_HOST="..." \
  REDIS_PORT="6380" \
  REDIS_PASSWORD="..." \
  REDIS_TLS="true" \
  BREVO_SMTP_HOST="smtp-relay.brevo.com" \
  BREVO_SMTP_PORT="587" \
  BREVO_SMTP_USER="..." \
  BREVO_SMTP_PASS="..." \
  EMAIL_FROM_ADDRESS="noreply@vitals.health" \
  EMAIL_FROM_NAME="Vitals" \
  FRONTEND_URL="https://vitals.app" \
  API_URL="https://vitals-api.fly.dev" \
  CORS_ORIGIN="https://vitals.app" \
  --config fly.worker.toml

# Deploy
flyctl deploy --config fly.api.toml
flyctl deploy --config fly.worker.toml
```

### GitHub Actions secrets required

Set these in your repository Settings → Secrets → Actions:

| Secret | Description |
|---|---|
| `FLY_API_TOKEN` | From `flyctl auth token` |
| `DATABASE_URL` | NeonDB connection string |
| `JWT_ACCESS_SECRET` | Min 32 chars |
| `JWT_REFRESH_SECRET` | Min 32 chars |
| `CODECOV_TOKEN` | Optional — for coverage reports |

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
