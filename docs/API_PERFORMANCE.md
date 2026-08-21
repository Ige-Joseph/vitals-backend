# API performance

This document records the first performance pass and gives a repeatable way to
measure future changes. Do not use production health data or credentials in
local benchmarks.

## What is optimized

- Dashboard queries that do not depend on each other run concurrently.
- Calendar connection state and synchronization counts are loaded concurrently.
- Pregnancy timeline week maintenance and upcoming ANC lookup run concurrently.
- The ANC lookup is limited to three rows in PostgreSQL instead of loading every
  future visit and slicing the result in Node.js.
- Composite indexes match the filters and ordering used by care events,
  reminders, activity, symptom history, and drug-detection history.
- Every API request is timed. Development logs include all request durations;
  requests taking 750 ms or longer are warnings in every environment. Timing
  logs contain method, path, status, and duration only—never query strings,
  bodies, tokens, or user health data.

## Local database

The application uses Prisma directly, so local development only needs ordinary
PostgreSQL and Redis; a full local Supabase stack is not required.
Compose binds both services to `127.0.0.1`, not every network interface.

```bash
docker compose up -d postgres redis
npx prisma migrate deploy
npm run db:seed
npm run dev
```

If containers were created before the loopback-only port bindings were added,
apply them once with `docker compose up -d --force-recreate postgres redis`.

Use these local connection values in `.env`:

```dotenv
DATABASE_URL=postgresql://vitals:vitals_local@localhost:5432/vitals_dev
DIRECT_URL=postgresql://vitals:vitals_local@localhost:5432/vitals_dev
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=vitals_local
REDIS_TLS=false
```

`DATABASE_URL` should use the Supabase transaction pooler in a deployed API.
`DIRECT_URL` should be the direct database connection used by Prisma migrations.
Never commit either real connection string.

## Measuring an endpoint

Start with several warm-up requests, then record at least 20 samples. For a
simple request from PowerShell:

```powershell
curl.exe -s -o NUL -w "status=%{http_code} total=%{time_total}s`n" http://localhost:3000/api/v1/health
```

For protected endpoints, add a short-lived access token in the Authorization
header. Compare median and p95 response times rather than relying on one request.
The dashboard, profile, usage, calendar summary, care timeline, and history
endpoints are the first paths to benchmark.

AI symptom and drug-detection requests include an external model call. Separate
their provider time from ordinary database endpoints before attributing the
latency to PostgreSQL.

## Verifying indexes

After applying migrations to a database with representative data, use
`EXPLAIN (ANALYZE, BUFFERS)` for the slow query. Confirm that the intended index
is used and inspect rows removed, buffer reads, and sort behavior. Small local
tables may correctly use sequential scans, so query plans from empty or tiny
datasets are not proof of production performance.

Run Supabase's performance and index advisors after deploying the migration.
Do not add further indexes without a recurring query shape and a measured plan;
indexes also consume storage and slow writes.

## Verification record — 2026-08-08

- Docker Compose configuration parsed successfully.
- Local PostgreSQL and Redis containers started successfully.
- All six Prisma migrations applied successfully to a clean local database.
- The local seed completed successfully.
- `npm run typecheck` passed after the optimization changes.
- The first focused Jest run passed seven tests and exposed an outdated
  `recordDelivery` transaction mock. That fixture was repaired. A rerun and
  real HTTP timing sample remain pending because the execution environment
  reached its approval/usage limit, not because of an application error.

To complete the pending local checks:

```bash
npm test -- --runInBand tests/unit/mother-baby.service.test.ts tests/integration/dashboard.test.ts tests/integration/auth.test.ts
npm test -- --runInBand
```

Then start the API with the local connection values above, sign in with the
seeded demo account, and sample the protected endpoints listed in the measuring
section. Keep the generated timing logs as the baseline for the next pass.
