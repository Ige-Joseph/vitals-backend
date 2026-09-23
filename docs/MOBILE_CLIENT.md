# Mobile client — the decisions, and what they depend on

[`MOBILE_API.md`](MOBILE_API.md) is the API contract: what to call and what
comes back. This document is the layer above it — what was decided about the
client itself, and why. It exists so the reasoning is not re-litigated, and so
the two things the backend does **not** yet support are visible before someone
builds against them.

Nothing here is built yet. The backend is ready for it; that readiness is the
subject of `MOBILE_API.md`.

---

## The decisions

| | Decision |
|---|---|
| Platform | **Android first.** iOS is a later target, not a current requirement |
| Framework | **React Native + Expo + TypeScript**, not bare RN |
| Design | **Custom, neutral design system.** Not React Native Paper, not Material 3 literally |
| Deep links | **Android App Links in v1** |
| Offline | **Cached reads in v1.** Queued writes later, and only where the semantics are unambiguous |
| Billing | **No in-app purchase.** Describe the tier, keep the copy neutral |
| Reports | The asynchronous flow — request, poll, download |

---

## Why these, specifically

### Expo rather than bare React Native

Everything this client needs has an Expo module: FCM push, secure token
storage, filesystem access, sharing, calendar, deep links. None of it requires
dropping to native code.

It also matters *because* iOS is a later target. The conversion cost is mostly
in what you had to write natively, and with Expo that is close to nothing.

### A custom design system, not Material 3

This is the decision most likely to be reversed by accident, so the reasoning
is worth stating plainly.

The web app's design language **is** Material 3 — `src/index.css` uses the M3
token names directly (`--surface-container-highest`, `--on-primary`,
`--primary-fixed-dim`). Reaching for `react-native-paper` would therefore be the
fastest possible start, and would match the web app closely.

It is still the wrong choice here, because the stated goal is a cleaner, more
premium look that ports to iOS later. M3 is Android's design language; adopting
it wholesale means paying for a redesign at the moment iOS arrives, which is
exactly the cost this decision exists to avoid.

So: **own the presentation layer.** What carries across from the web app is the
palette and the spacing/typography scale — the tokens are plain hex values and
port directly into an RN theme. What does not carry across is the component
library, and that is deliberate rather than unfortunate.

The app should still *behave* like an Android application — back button,
navigation conventions, system share — while looking like neither stock Android
nor a transplanted iPhone app.

### App Links in v1, not later

Invitation emails link to `${FRONTEND_URL}/invitations/<token>`. Without App
Links, tapping that on a phone opens the browser rather than the app: someone
invited to help care for a relative lands in a web session they are not logged
into.

The invitation flow is the product's main growth loop — Vitals is largely about
one person bringing another into a care relationship — so this is core, not
polish.

```text
Invitation email
      ↓
https://<domain>/invitations/<token>
      ↓
App installed?
   ├── YES → the app opens on the invitation
   └── NO  → the existing web invitation page
```

This needs an `assetlinks.json` served from the web domain, carrying the app's
signing certificate fingerprint. Getting the URL scheme right now also makes
iOS Universal Links straightforward later, since they read the same shape.

### Offline: cached reads now, queued writes deliberately deferred

Connectivity is patchy in the target market, so offline is not a luxury. It is
also not one decision — it is three, with very different costs:

1. **No offline.** Spinners when the signal drops.
2. **Cached reads.** Recently loaded dashboard, medications, people and
   appointments remain readable. **This is v1.**
3. **Queued writes.** Log a dose offline, sync later.

Level 3 is deferred because it is **not a client feature**. It is a data-model
question, and the model does not currently answer it — see below.

---

## Two things the backend does not support yet

Both are additive. Neither blocks v1 as scoped above. Both will block the
feature that depends on them, so they are recorded here rather than discovered
later.

### 1. There is nowhere to record when a dose was actually taken

This blocks **queued offline writes**, and only those.

`CareEvent` is the whole record of a dose being taken — there is no separate
dose or adherence table:

```prisma
model CareEvent {
  scheduledFor DateTime
  status       CareEventStatus   // PENDING | DONE | SKIPPED | MISSED
  metadata     Json
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

There is **no completion timestamp**. When a dose is marked done, the only
record of *when* is the server-stamped `updatedAt`. Online that is close enough
to the moment the user tapped. Offline it is not: a dose taken at 08:00 and
synced at 18:00 records 18:00, and the record is quietly wrong — in clinical
data, which is the worst place for a quiet inaccuracy.

So a payload like this has nowhere to land, and would need a nullable
completion column, a migration, an API change and a documentation change first:

```jsonc
{ "status": "DONE", "completedAt": "2026-08-27T08:00:00Z" }
```

Two notes for whoever picks this up. The status value is **`DONE`** — the word
"taken" appears nowhere in the enum, and sending it is a 400. And `metadata` is
sitting right there and must not be used for this: smuggling a structured field
through untyped JSON is a known problem in this schema already
(`CarePlan.metadata` carries `frequency` and `customTimes`), not a pattern to
extend.

### 2. `PushToken` does not record a platform

This blocks nothing on Android, and should be fixed before iOS.

```prisma
model PushToken {
  token  String @unique
  userId String
}
```

FCM covers both platforms, so Android works as-is. But with no `platform`
column you cannot target one platform, and cannot tell a stale APNs
registration from an FCM one when expiring tokens. Adding it while there is
only one platform in play is a one-line migration; adding it afterwards means
backfilling rows whose platform has to be guessed.

---

## Scope for the first Android build

The web app is 26 pages and 11 components, and none of that UI ports. A
sensible spine, in order:

1. Auth — sign up, log in, refresh, verification state
2. Dashboard
3. Care — medications and appointments
4. Family — invitations, accepting, claiming
5. Profile

Reports, AI features and billing screens follow. Reports are worth doing early
regardless, because the asynchronous flow is genuinely nicer on mobile: request
it, leave the screen, come back when it is ready.

---

## Where to look next

| Document | Covers |
|---|---|
| [`MOBILE_API.md`](MOBILE_API.md) | The API contract — endpoints, auth, the traps |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | Why the Person model is shaped this way |
| [`AUTHENTICATION.md`](AUTHENTICATION.md) | The token model, and why the body transport is permanent |
