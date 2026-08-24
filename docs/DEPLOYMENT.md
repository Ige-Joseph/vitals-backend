# Deployment State and Known Issues

Last verified: 2026-08-22, against the live services.

## Topology

```
Browser ──▶ Vercel (frontend)  ──▶ Render (API + worker)  ──▶ Supabase (Postgres)
                                                          └─▶ Upstash (Redis)
```

Both hosts deploy from `main` in their own repository. The two repositories are
separate: `Ige-Joseph/vitals-backend` and `Ige-Joseph/vitals-frontend`.

## Verified working

Checked against `vitals-backend-service.onrender.com`:

- Service healthy; database and Redis reachable
- Cookie-transport auth live — an untrusted `Origin` is rejected with 403, a
  trusted one passes the check
- `replacedByTokenHash` migration applied; refresh returns 401 for an unknown
  token rather than a 500
- `Cache-Control: no-store` and `access-control-allow-credentials: true` present

Reproduce with the commands in the README's "Verifying a deploy landed" section.

## Open issues

### Vercel is not deploying the frontend

**The live frontend is a build from before 2026-05-12.** It predates the
calendar integration, the profile redesign, and the login 401 fix, as well as
everything merged since.

Evidence: the served `index.html` still carries `theme-color #0f172a`, changed
to `#005bbf` in commit `73506fb`. The served bundle contains none of
`X-Auth-Transport`, `vitals:session-expired`, or `consumeLegacy`. `vercel.json`
is not applied at all — no CSP header is returned, and `/dashboard` 404s, so
even the SPA rewrite is missing.

The code on `main` is correct. The deployment is not tracking it. Check in the
Vercel dashboard whether the project is connected to the right repository,
whether Production is set to `main`, whether builds are failing, and whether
production is pinned to an old deployment.

Until this is fixed, no frontend change reaches users, and any conclusion drawn
from the live site is about a months-old build.

### The worker may not be running

`npm start` and the `Dockerfile` `CMD` both run `dist/server.js`, which starts
the API only. `dist/main.js` runs the API and the worker together. If reminders
and scheduled jobs are not firing, this is the first thing to check.

### The Vercel dashboard environment is outside CI's reach

CI builds the frontend with `VITE_API_URL` unset, which is what keeps requests
same-origin. It cannot see the environment variables configured in the Vercel
dashboard, so a `VITE_API_URL` added there breaks Safari with CI fully green.
That invariant is enforced by review, not by a check — see `API_TRANSPORT.md`
in the frontend repository.

## Continuous integration

Both repositories run a `CI` workflow on push to `main` and on pull requests
against it.

| Repository | Steps |
|---|---|
| `vitals-backend` | `npm ci` → `prisma generate` → typecheck → tests → build |
| `vitals-frontend` | `npm ci` → build (`tsc && vite build`) |

The backend job supplies throwaway values for every variable `src/config/env.ts`
requires, because that module validates the environment at import time and calls
`process.exit(1)` when something is missing — without them no test would run.
The suites mock Prisma, Redis and every provider, so CI needs no database and no
Redis instance.

The frontend has a `lint` script left over from the Vite template that calls
`eslint`, which is neither installed nor configured. CI does not run it. Adding
a linter is a separate decision from wiring up CI.

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
| [`AUTHENTICATION.md`](AUTHENTICATION.md) | Token model, cookie transport, rotation grace window |
| [`AI_SAFETY.md`](AI_SAFETY.md) | AI posture, output guards, known limits |
| [`API_PERFORMANCE.md`](API_PERFORMANCE.md) | Query timing, indexes, benchmarking |
