# Mobile API — building a React Native client

A handoff document. It assumes you have never seen this backend and covers what
you need to build a client against it: how auth works, what the endpoints are,
and the four or five places where a reasonable-looking implementation will be
subtly wrong.

Read [§3 Persons](#3-persons-the-model-that-shapes-everything) before writing
any feature code. It is the idea the rest of the API is built on, and getting it
wrong late is expensive.

---

## Contents

1. [Conventions](#1-conventions)
2. [Auth and the token lifecycle](#2-auth-and-the-token-lifecycle)
3. [Persons: the model that shapes everything](#3-persons-the-model-that-shapes-everything)
4. [Dashboard](#4-dashboard)
5. [Care: medications, appointments, events](#5-care-medications-appointments-events)
6. [Family: members, invitations, claiming](#6-family-members-invitations-claiming)
7. [Billing — read the Play Store note](#7-billing--read-the-play-store-note)
8. [Reports](#8-reports)
9. [AI features and quota](#9-ai-features-and-quota)
10. [Push notifications](#10-push-notifications)
11. [Things clients get wrong](#11-things-clients-get-wrong)

---

## 1. Conventions

**Base URL:** `{API_URL}/api/v1`

**Every response has the same envelope.** There are no bare arrays or objects at
the top level:

```jsonc
{
  "success": true,
  "message": "Plan retrieved",
  "data": { /* the payload — this is what you want */ },
  "errorCode": null
}
```

Errors use the same shape with `success: false`, a human-readable `message`, and
an `errorCode` string:

```jsonc
{ "success": false, "message": "No pending invitation for this account",
  "data": null, "errorCode": "NOT_FOUND" }
```

Unwrap `data` once, centrally, in your HTTP client. **Show `message` to users** —
it is written to be read, and error copy in this API is deliberate.

**Status codes** follow the obvious meanings, with two exceptions worth knowing
now: a refused claim is a **200** (§6), and a duplicate payment webhook is a 200.
Neither is an error.

**Dates** are ISO 8601 strings. Values that are calendar *dates* rather than
moments (a date of birth, a report period) are `YYYY-MM-DD` — parse those as
local, not UTC, or they render a day early in any timezone behind UTC.

---

## 2. Auth and the token lifecycle

Two tokens:

| Token | Lifetime | Where it lives |
|---|---|---|
| **Access** — JWT, sent as `Authorization: Bearer <token>` | 15 minutes | Memory, or secure storage |
| **Refresh** — opaque, rotating, single-use | 7 days | **Secure storage** (Keychain / Keystore) |

### Native clients get the refresh token in the response body

The backend supports two transports. Browsers send `X-Auth-Transport: cookie`
and the refresh token goes into an `HttpOnly` cookie. **You should not send that
header.** Omit it and the refresh token is returned in the JSON body, which is
what you want on mobile:

```jsonc
// POST /auth/login  →  data
{
  "user": { "id": "…", "email": "…", "firstName": "…", "role": "USER",
            "planType": "FREE", "emailVerified": true },
  "accessToken": "eyJ…",
  "refreshToken": "a1b2c3…"     // present only without the cookie header
}
```

The trusted-`Origin` check that guards cookie transport does not apply to you,
so a client sending no `Origin` header is fine.

> ⚠️ **Flag this with the backend team before you start.**
> `docs/AUTHENTICATION.md` describes the body-based refresh contract as
> *temporarily available* to let the backend deploy ahead of the browser app,
> and says it should be removed "after all supported browser releases have
> migrated". That removal would break every mobile client. The contract needs to
> be reclassified as the permanent **native** transport rather than a legacy
> browser one. It is a doc/intent problem, not a code problem — the behaviour
> works today — but it should be settled before it is deleted out from under you.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/signup` | Returns tokens. Creates the user's own Person automatically. |
| `POST` | `/auth/login` | Returns tokens. |
| `POST` | `/auth/refresh` | Body `{ refreshToken }`. Returns a **new pair**. |
| `POST` | `/auth/logout` | Body `{ refreshToken }`. Revokes it. |
| `GET` | `/auth/me` | Current user. |
| `GET` | `/auth/verify-email` | `?token=…` from the email. |
| `POST` | `/auth/resend-verification` | Authenticated. |
| `POST` | `/auth/forgot-password` | Body `{ email }`. |
| `POST` | `/auth/reset-password` | Body `{ token, password }`. |

### The refresh flow, and the trap in it

Refresh tokens are **single-use and rotating**. Every successful refresh revokes
the token you presented and issues a new one. You must persist the new refresh
token before using the new access token, or a crash between the two logs the
user out.

```
401 on any request
  └─▶ POST /auth/refresh { refreshToken }
        ├─ 200 → store BOTH new tokens, retry the original request once
        └─ 401 → session is genuinely over: clear storage, go to login
```

**Deduplicate concurrent refreshes.** If five requests 401 at once and you fire
five refreshes, four present an already-rotated token. Hold a single in-flight
refresh promise and have every caller await it.

The server has a **30-second grace window** that follows the replacement chain,
so a small race usually resolves rather than logging the user out. Do not rely
on it: outside that window, presenting a rotated token is treated as theft and
**every token for that user is revoked**, signing them out everywhere.

Never retry a refresh more than once, and never retry the same refresh token
after a 401.

### Email verification gates one thing

An unverified account can use the app, but **cannot answer an invitation**
(§6) — it gets a 403. `GET /invitations` returns an empty list rather than
erroring. If you build the family features, surface verification state.

---

## 3. Persons: the model that shapes everything

**An account is not a person.** A Vitals *account* is a login. A *Person* is a
human whose health is recorded. Clinical data — medications, appointments,
symptoms — belongs to a **Person**, never to an account.

An account reaches a Person through a **membership** with a role:

| Role | Can |
|---|---|
| `VIEWER` | read |
| `CAREGIVER` | read, and act on care — mark a dose taken, book an appointment |
| `OWNER` | the above, plus invite, revoke, transfer |

Every account gets its own Person at signup, so the simplest case — one user,
their own data — is just the general case with one Person in it.

### How the client selects a subject

Most clinical endpoints accept an optional **`personId`**:

- **`GET` routes** take it as a **query parameter**: `?personId=<uuid>`
- **`POST` / `PATCH` routes** take it in the **body**

Omit it and the server resolves to the caller's own Person. So:

```
GET /medications                          → my medications
GET /medications?personId=<grandma>       → grandma's medications
```

**Hold the selected `personId` in app-wide state** (a "person switcher") and
attach it to every person-scoped call. That is the single decision that makes
this API pleasant to work with; retro-fitting it is painful.

Person-scoped areas: `dashboard`, `medications`, `appointments`, `care`, `mood`,
`symptoms`, `mother-baby`, `reports`, and the `persons/{personId}/…` routes.

Account-scoped, and **not** affected by the switcher: `auth`, `users/profile`,
`billing`, `usage`, `push`, `articles`.

### What `personId` is not

Sending a `personId` is a **request** for a subject, never a grant of one. The
server resolves access on every call. If the caller has no relationship with
that Person, the answer is **403**, and no data is returned.

Access is checked per request, not baked into the token — so a revoked
membership stops working immediately, not at the next refresh. **A 403 on a
person-scoped route can appear mid-session and is not a bug.** Handle it by
dropping back to the caller's own Person.

### `GET /persons` — the switcher's data source

```jsonc
// data: an array
[{
  "personId": "…", "displayName": "Grandma Ngozi",
  "dateOfBirth": "1951-04-02", "gender": "FEMALE",
  "origin": "MANAGED",          // SELF | DELIVERY | BABY_PROFILE | MANAGED
  "role": "OWNER",              // the caller's role on this Person
  "isSelf": false,
  "isClaimed": false            // false = a dependent; true = an adult with their own account
}]
```

`isSelf` marks the caller's own record. `isClaimed` separates a **managed**
dependent from a **connected** adult — a distinction the Family UI needs, since
a managed record can be transferred or archived and a connected one belongs to
someone who can revoke you.

### Other person endpoints

| Method | Path | Role needed |
|---|---|---|
| `GET` | `/persons` | — |
| `POST` | `/persons` | — (consumes managed capacity) |
| `GET` | `/persons/capacity` | — |
| `GET` | `/persons/{personId}` | read |
| `PATCH` | `/persons/{personId}` | write |
| `GET` | `/persons/{personId}/health` | read |
| `PATCH` | `/persons/{personId}/health` | write |
| `GET` | `/persons/{personId}/members` | read |
| `DELETE` | `/persons/{personId}/members/{targetUserId}` | manage — **or none, to remove yourself** |
| `POST` | `/persons/{personId}/transfer` | manage |
| `GET` | `/persons/{personId}/access-history` | read |

`GET /persons/capacity` returns both limits, which you need before showing an
"add someone" button:

```jsonc
{ "managedLimit": 0, "managedUsed": 0,
  "connectionLimit": 0, "connectionsUsed": 0,
  "firstBabyExempt": true }
```

Free accounts are **0 and 0** — free means "yourself only". The first baby added
through the Mother & Baby journey is exempt from the managed count, so the free
tier still covers that whole journey for one child.

---

## 4. Dashboard

`GET /dashboard?personId=<optional>` returns four keys, and **the split between
them is the point**:

```jsonc
{
  "subject": {                    // whose body this is about
    "personId": "…", "displayName": "Grandma Ngozi", "isSelf": false
  },

  "care": {                       // person-scoped — FOLLOWS the switcher
    "todayTasks": [ /* CareEvent */ ],
    "upcomingReminders": [ /* CareEvent, next 5 */ ],
    "recentActivity": [ /* last 10 */ ],
    "latestMoodInsight": { /* or null */ },
    "journey": { /* pregnancy/vaccination summary, or null */ }
  },

  "account": {                    // account-scoped — does NOT change
    "usageSummary": {
      "symptomChecks":  { "used": 1, "limit": 3 },
      "drugDetections": { "used": 0, "limit": 3 }
    }
  },

  "people": [ /* every Person this account can see */ ]
}
```

**Do not render `account` inside the person-scoped part of your UI.** AI quota is
metered per login, not per body. If you show it under the selected person's
name, a user switching to their mother will reasonably think her quota is being
consumed. It is not, and it does not change.

`people` is the switcher's payload and includes the selected person:

```jsonc
{ "personId": "…", "displayName": "Baby Chidi",
  "relationship": "managed",     // 'self' | 'managed' | 'connected'
  "isClaimed": false, "origin": "DELIVERY", "role": "OWNER",
  "isSelected": false, "upcomingTasks": 3 }
```

`relationship` is **three** values, not two. `self` is the caller's own record;
`managed` is a dependent with no account; `connected` is an adult who has their
own account and shared it. Labelling a connected person as "managed" would be
simply false — they can revoke you at any time.

---

## 5. Care: medications, appointments, events

### Medications

| Method | Path |
|---|---|
| `POST` | `/medications` |
| `GET` | `/medications?personId=` |
| `GET` | `/medications/{carePlanId}?personId=` |
| `DELETE` | `/medications/{carePlanId}?personId=` |
| `GET` | `/medications/{carePlanId}/history?personId=` |

Creating one generates the whole dose schedule server-side:

```jsonc
// POST /medications
{ "name": "Amlodipine", "dosage": "5mg",
  "frequency": "ONCE_DAILY",              // ONCE_DAILY | TWICE_DAILY | THREE_TIMES_DAILY
  "startDate": "2026-09-01",
  "durationDays": 7,                      // …or endDate, not both
  "customTimes": ["08:00"],               // count must match frequency
  "instructions": "Take after food",
  "personId": "…" }                       // optional
```

`customTimes` must have exactly as many entries as the frequency implies —
1, 2 or 3. A mismatch is a 400.

### Appointments

| Method | Path | Notes |
|---|---|---|
| `POST` | `/appointments` | `startsAt` must be in the future |
| `GET` | `/appointments?scope=upcoming\|past\|all&status=&limit=&personId=` | |
| `GET` | `/appointments/{id}?personId=` | |
| `PATCH` | `/appointments/{id}` | Changing `startsAt` re-derives reminders |
| `POST` | `/appointments/{id}/cancel` | Body `{ reason? }` |
| `POST` | `/appointments/{id}/complete` | |

```jsonc
// POST /appointments
{ "title": "Cardiology follow-up",
  "startsAt": "2026-09-14T10:00:00.000Z",
  "durationMinutes": 45,
  "clinician": "Dr Adeyemi", "specialty": "Cardiology",
  "location": "LUTH", "reason": "…", "notes": "Bring the previous ECG",
  "reminderLeadMinutes": [1440, 60] }    // minutes before; max 5
```

Status is `SCHEDULED | CONFIRMED | COMPLETED | CANCELLED | MISSED`.

**Cancel and complete are separate endpoints, not a `PATCH` on status** — each
withdraws reminders and cleans up a calendar entry, and `PATCH` deliberately
cannot set status.

**`MISSED` is set by a background sweep**, not by the client. An appointment
whose time has passed flips to `MISSED` roughly 15 minutes later. Do not style
it as an error: it is a fact about a visit that did not happen, not the user's
fault.

A **lead time already in the past is silently skipped**, not rejected. Booking
something for this afternoon with "a day before" selected is valid and produces
one reminder instead of two.

### Care events

`GET /care/events?personId=&status=&type=&from=&to=&limit=` — the unified
timeline. `PATCH /care/events/{id}/status` marks a dose taken or skipped:
`PENDING | DONE | SKIPPED | MISSED`.

---

## 6. Family: members, invitations, claiming

The most intricate area, and the one with real privacy rules in it.

### Sending an invitation

```jsonc
// POST /persons/{personId}/invitations     — requires OWNER
{ "email": "sister@example.com",
  "role": "CAREGIVER",          // CAREGIVER | VIEWER — never OWNER
  "claimable": false }
```

The address **need not have a Vitals account** — that is the normal case. They
get an email with a link.

`claimable: true` asserts *this record is about the person I am inviting*, which
lets them take ownership of it. Only offer it for unclaimed records, and
understand what it costs the inviter: **a successful claim revokes their
access.**

| Method | Path |
|---|---|
| `GET` | `/persons/{personId}/invitations` — offers on this record |
| `DELETE` | `/persons/{personId}/invitations/{invitationId}` — withdraw |

### Receiving one

Two ways in, and you need both:

**From the emailed link** — deep-link `/invitations/:token`:

```
GET /invitations/{token}          ← PUBLIC, works signed out
```

```jsonc
{ "personId": "…", "email": "sister@example.com", "role": "CAREGIVER",
  "claimable": true, "recordName": "Emma Okafor", "inviterName": "Ada",
  "status": "PENDING",            // PENDING|ACCEPTED|DECLINED|REVOKED|EXPIRED
  "expiresAt": "…",
  "requiresSignup": false }       // whether they need an account first
```

It is public so someone with no account can see what they are being asked to
join before signing up. Use `requiresSignup` to route to signup vs login.

**From inside the app** — `GET /invitations` lists offers addressed to the
signed-in account's **verified** address:

```jsonc
[{ "invitationId": "…", "personId": "…", "recordName": "Emma Okafor",
   "role": "CAREGIVER", "claimable": true, "inviterName": "Ada",
   "expiresAt": "…" }]
```

### Answering

```
POST /invitations/{token}/respond              { "mode": "connect|claim|decline" }
POST /invitations/by-id/{invitationId}/respond { "mode": "connect|claim|decline" }
```

Identical behaviour; use whichever handle you have. The id is **not** a
credential — the server matches on the caller's verified email either way — so
an id belonging to someone else's invitation returns 404, exactly as a
non-existent one does.

### The four outcomes you must handle

```jsonc
{ "outcome": "connected" }   // access granted, done
{ "outcome": "declined" }    // done

{ "outcome": "claimed",      // they now OWN this record
  "personId": "…", "supersededPersonId": "…",
  "revoked": [ { "userId": "…", "role": "CAREGIVER", "name": "Ada" } ] }

{ "outcome": "refused",      // ← a 200, NOT an error
  "blockedBy": { "carePlans": 2, "appointments": 1 },
  "connectionStillAvailable": true }
```

**`refused` means: they asked to claim, and could not, because their own record
already has data in it.** The two records cannot be merged — a health record is
never merged into another, because merging risks losing or mixing up
information. The invitation is **still open**, and connecting still works.

Present it as a choice, not a failure. No red, no error styling:

> **You already have health records in Vitals**
> Ada kept a record about you. Because you've already recorded medications and
> appointments of your own, we can't merge the two — combining health records
> risks losing or mixing up information.
> You can open Ada's record alongside your own, with full access. Both stay
> separate and complete.
> **[Open both records]** **[Not now]**

`blockedBy` is for the **invitee's eyes only**. It describes their own record.
It never reaches the inviter, and you must not send it anywhere.

### After a claim: the re-grant step

A successful claim **revokes everyone who was managing the record** — once the
subject owns it, other people's access is the subject's decision. `revoked`
names them so you can offer it straight back:

```jsonc
// POST /persons/{personId}/claim-regrant
{ "grants": [ { "userId": "…", "role": "CAREGIVER" } ] }
```

Show this immediately after the claim, while the user still knows who Ada is.
Default each person to the role they already had, so keeping is one tap.
Granting nobody is a valid choice — just skip the call.

It only accepts accounts that *this claim* revoked. Anything else is a 400.

### Accepting via the older members route

`POST /persons/{personId}/members/accept` exists for an invitation created
through `POST /persons/{personId}/members` (which requires the invitee to
already have an account). New clients should prefer the invitation routes above.

### Removing access

`DELETE /persons/{personId}/members/{targetUserId}` — removing **someone else**
needs OWNER; removing **yourself** needs nothing. Unlinking removes access only:
it never deletes an account and never deletes health data. Say that in your
confirmation copy, because it is the thing users fear.

---

## 7. Billing — read the Play Store note

### ⚠️ A Play-listed build must use Play Billing, not Paystack

This backend sells subscriptions through **Paystack**, on the web. That is a
deliberate commercial choice: an in-app digital purchase on Google Play must go
through **Play Billing**, at a fee that matters on a low-priced subscription in
this market.

**If your build is distributed through Google Play, you cannot send users to the
Paystack checkout from inside the app.** Doing so violates Play's payments
policy and risks removal. You have two options, and this is a **product decision
that needs making before you build the billing screens**:

1. **Integrate Play Billing** — which needs backend work that does not exist
   yet: a Play purchase-token verification endpoint and a
   `purchases.subscriptions` webhook. There is no Play provider in the payment
   adapter today.
2. **Ship without purchasing in-app** — show what Premium includes and let
   people subscribe on the web separately. Google's anti-steering rules restrict
   how you may point at that, so keep the copy neutral: describe the tier, do
   not advertise the web, name a browser, or say it is cheaper elsewhere.

The existing web frontend takes option 2 and its copy is deliberately neutral —
follow it.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/billing/tiers` | **Public.** Tiers, prices, what's included |
| `GET` | `/billing/plan` | The caller's tier, entitlements, subscription |
| `POST` | `/billing/checkout` | Paystack only — see the warning above |
| `POST` | `/billing/subscriptions/{id}/cancel` | Ends renewal, keeps the paid period |

```jsonc
// GET /billing/plan  →  data
{ "tier": "PREMIUM",
  "entitlements": { "managedPersonLimit": 5, "connectionLimit": 5 },
  "entitlementSource": "subscription",
  "subscription": { "id": "…", "status": "ACTIVE",
                    "currentPeriodEnd": "…", "cancelAtPeriodEnd": false },
  "pendingCheckout": null,
  "checkoutAvailable": true,
  "tiers": [ /* same as /billing/tiers */ ] }
```

`checkoutAvailable` is `false` when no payment provider is configured. Respect
it: an upgrade button that leads nowhere is worse than one that is honestly
absent.

Cancelling ends the **next charge**, not today's access — Premium runs to
`currentPeriodEnd`. Say so plainly in your confirmation.

---

## 8. Reports

A PDF of what has been recorded for one Person over a period. **Asking for one
and fetching it are two different requests.**

```
POST /reports/health-summary          { personId?, from?, to? }   → 202 { id, status }
GET  /reports/health-summary/{id}                                 → status
GET  /reports/health-summary/{id}/download                        → the PDF
```

### The flow

```text
POST /reports/health-summary
      ↓  202 Accepted, status PENDING
poll GET /reports/health-summary/{id}
      ↓  PENDING → PROCESSING → READY
GET  /reports/health-summary/{id}/download
      ↓  application/pdf
save to a file, hand to the OS viewer or share sheet
```

Rendering happens on a worker, one document at a time. A summary is usually
ready in a second or two, but the point of `202` is that you must not assume
it: poll rather than sleeping for a fixed interval.

```jsonc
// GET /reports/health-summary/{id}  →  data
{ "id": "…", "personId": "…", "kind": "HEALTH_SUMMARY",
  "status": "READY",                  // PENDING | PROCESSING | READY | FAILED | EXPIRED
  "periodStart": "…", "periodEnd": "…",
  "generatedAt": "…",                 // when it was asked for
  "completedAt": "…",                 // when rendering finished
  "expiresAt": "…",                   // when the file is deleted
  "downloadedAt": null,               // when a copy first left the system
  "failureReason": null }             // set when status is FAILED
```

### The document expires

`expiresAt` is set when rendering finishes — an hour later by default. After
that the file is deleted and the download answers **410 Gone**.

That is not an error to apologise for. Show something like *"This summary has
expired — generate a new one"* and offer the button again. Treating 410 as a
failure state is the most likely way to get this wrong.

The **record** that a summary was generated is kept permanently; only the file
expires. `GET /reports/generations?personId=` still lists them, and that list is
the answer to "who has taken a copy of this Person's history out of the system".

### Downloading

**This streams a file. It does not return the JSON envelope.** Do not put it
through your normal API client, which unwraps `data` and will produce garbage.

```
Content-Type: application/pdf
Content-Disposition: attachment; filename="vitals-summary-….pdf"
Content-Length: …
Cache-Control: no-store, private
```

In React Native, download it to a file and hand it to the OS share or viewer —
`expo-file-system` plus `expo-sharing`, or `react-native-blob-util`. **Errors
still return JSON**, so check the status and content type before treating the
body as a PDF.

The download needs your `Authorization` header like any other request. There is
no signed URL and there is deliberately never going to be one: access is
re-resolved from the database on **every** download, so a membership revoked
after the document was generated stops the next fetch. A signed URL would keep
working, which is exactly what must not happen to a health record.

### The failures, and how they differ

| Status | Meaning | What to show |
|---|---|---|
| `400` | still `PENDING`/`PROCESSING` | keep polling — you fetched too early |
| `400` | status is `FAILED` | `failureReason`, and offer to try again |
| `403` | membership | no access to that Person |
| `403` | Premium | this is a Premium feature |
| `404` | no such report | — |
| `410` | expired | offer to generate a new one |

Both `403`s are checked again on **every** download, not just when you asked.
Access is checked before entitlement, so someone with no relationship to a
Person is told that rather than invited to upgrade.

### The older synchronous route still works

`GET /reports/health-summary` renders inside the request and streams the PDF
back, exactly as it always did. It is **deprecated** and kept only while the
web client migrates. Do not build a new client on it: it renders on the same
process that serves requests, which is the reason the asynchronous flow exists.

---

## 9. AI features and quota

| Method | Path |
|---|---|
| `POST` | `/symptoms/check` — `{ symptomsText, severity?, personId? }` |
| `GET` | `/symptoms/history?personId=` |
| `POST` | `/drug-detection` — multipart image |
| `GET` | `/drug-detection/history` |
| `GET` | `/usage` — today's quota |

Quota is **account-scoped**, metered per login, and resets daily. Free is 3 of
each per day; Premium 20. Check `/usage` (or `dashboard.account.usageSummary`)
before offering the action, so the user is not refused after typing.

All AI output is framed as information, never diagnosis. Do not add UI that
presents it as a clinical assessment — no severity badges you invented, no
"you probably have…". Show the model's own wording.

---

## 10. Push notifications

```jsonc
POST /push/register     { "token": "<FCM token from Firebase SDK>" }
DELETE /push/register   { "token": "…" }
```

Uses Firebase Cloud Messaging. Register after permission is granted and after
every token refresh — FCM rotates tokens and a stale one silently stops
delivering.

**Reminders fall back to email** when an account has no usable FCM token, so a
user without push still gets told. That means a missing registration degrades
quietly rather than visibly, which is easy to miss in testing.

---

## 11. Things clients get wrong

### The settling window after payment

**A user returning from checkout is not yet Premium.** Entitlement is granted by
a webhook from the payment provider, which arrives on its own schedule — usually
seconds, sometimes longer. The browser coming back proves nothing.

So after checkout, do **not**:

- say "You're Premium now" — you don't know that yet
- say "Payment failed" — you don't know that either

Instead, poll `GET /billing/plan` on a bounded schedule (every 2s, ~30s) and
show three honest states:

| State | Copy |
|---|---|
| waiting | "Confirming your payment. This usually takes a few seconds." |
| `tier` became `PREMIUM` | "Payment received. Premium is active." |
| budget exhausted | "Still being confirmed. It'll switch on by itself, and you don't need to pay again." |

**A failed poll is not a failed payment.** Ignore poll errors and keep waiting;
the two are unrelated and money has already moved.

`pendingCheckout` on `GET /billing/plan` tells you a checkout was started and
has not finished — useful if the user closes the app mid-payment and comes back.
It means *a checkout was started*, **not** *a payment succeeded*: the backend
cannot tell those apart either. Word it accordingly.

### `claimable: false` is not the same as `outcome: "refused"`

These look similar and must be handled completely differently.

**`claimable: false`** — ownership was never offered. The inviter did not mark
this record as being about the invitee.

> **Show nothing.** No greyed-out "claim" button, no "not available for this
> record" line. Offer the connection and say nothing at all about claiming.
> Whether the inviter made that assertion is the *inviter's* business, and even
> a gentle explanation of the option's absence discloses it.

**`outcome: "refused"`** — ownership *was* offered, they tried, and their own
record is not empty.

> **Explain fully.** They asked, and what blocked it is a fact about their own
> record, which is theirs to know. Use the copy in §6.

The rule: *absence* of the option is never explained; *refusal* of it always is.

### Reports are two requests, and the file expires

Covered in §8 and repeated because both halves bite.

**The download returns bytes, not the JSON envelope.** A generic API client will
parse `application/pdf` as JSON, fail, and produce a confusing error a long way
from the cause. Route the download around your normal client.

**`410` on a download means the document expired**, not that something broke.
Documents are deleted about an hour after they are rendered, on purpose — a
stored PDF is one Person's whole record sitting outside the tables that own it.
Offer to generate another rather than showing an error.

**`202` is not success.** It means rendering was queued. A client that treats it
as done and never polls will show a report that never arrives.

### Other things

**A 403 mid-session is normal.** Memberships are checked per request, so access
revoked by someone else takes effect immediately. Fall back to the caller's own
Person rather than showing a crash screen.

**Don't cache `personId` across accounts.** Clear the selected person on logout,
or the next user starts pointed at a record they cannot read.

**Don't compute an adherence percentage.** Dose counts are exposed as recorded
counts — taken, skipped, missed, still scheduled. A ratio is an *assessment* of
how someone is managing their health, and this product does not assess. Show the
counts.

**Empty sections should be absent, not empty.** A Person with no medications
should not render a "Medications" heading with nothing under it.

**`durationDays` and `endDate` are mutually exclusive** on medications. Sending
both is a 400.

---

## Where to look next

| Document | Covers |
|---|---|
| Swagger UI at `/api-docs` | Every endpoint, live, with request and response schemas |
| [`MOBILE_CLIENT.md`](MOBILE_CLIENT.md) | Client decisions — Expo, design system, deep links, offline — and the two schema gaps they depend on |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | Why the Person model exists, and the reasoning behind the rules above |
| [`AUTHENTICATION.md`](AUTHENTICATION.md) | Token model in full, rotation grace window |
| [`AI_SAFETY.md`](AI_SAFETY.md) | What AI output may and may not say |

Swagger is generated from the route definitions and verified in CI — every route
is present and every reference resolves — so when this document and Swagger
disagree, **Swagger is right**.
