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

```bash
docker compose up -d --wait
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Use these local connection values in `.env` — they match `docker-compose.yml`
and the README, which is the authoritative pair:

```dotenv
DATABASE_URL=postgresql://postgres:local@localhost:5433/vitals
DIRECT_URL=postgresql://postgres:local@localhost:5433/vitals
UPSTASH_REDIS_URL=redis://localhost:6379
```

Two things that catch people out:

**Postgres is on 5433, not 5432.** It is published there so it cannot collide
with another Postgres already on the host; inside the compose network it still
listens on 5432. The credentials are `postgres` / `local`, database `vitals`.

**Redis is configured by URL, and the local instance has no password.** The
compose service runs `redis-server --appendonly no` with no `--requirepass`, so
supplying `REDIS_PASSWORD` will fail the connection rather than secure it. Use
the `redis://` scheme locally — `rediss://` enables TLS, which a local Redis does
not speak. `src/config/env.ts` accepts either `UPSTASH_REDIS_URL` or the
`REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` trio, and the URL is simpler.

> **These ports are published on all interfaces**, not loopback only —
> `docker-compose.yml` uses the short `"5433:5432"` form, which binds `0.0.0.0`.
> On an untrusted network that is a local Postgres and Redis reachable by
> anything that can route to the host. If that matters where you work, change
> the mappings to `"127.0.0.1:5433:5432"` and `"127.0.0.1:6379:6379"` and
> recreate the containers.

The test database is a separate service on **5436** under the `test` profile —
see the README. It is tmpfs-backed and wiped on restart.

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
