# Architecture

How Vitals is put together, and why. This document is about the decisions that
would otherwise look arbitrary — the places where the obvious implementation is
not the one in the code, and a future reader would be right to ask why.

For getting the thing running, see [`README.md`](README.md).

---

## 1. Accounts and Persons are different things

The single most important idea in the codebase.

A **Vitals account** is a login — an email, a password, a session. A **Person**
is a human whose health is being recorded. They are not the same entity, and
clinical records belong to the Person.

```
User (account)                    Person (clinical subject)
  │                                 │
  └──── PersonMembership ───────────┘
        role: OWNER | CAREGIVER | VIEWER
        status: INVITED | ACTIVE | REVOKED
```

Every account gets a self-Person at signup, eagerly. Uniformity is worth more
than saving a row: it makes the single-user case a special case of the general
one, so authorization has exactly one shape rather than two.

### Why it exists

Because a mother tracking her baby's vaccinations, a daughter managing her
father's medications, and a couple sharing a pregnancy are all ordinary uses of
a health app — and none of them work if clinical rows hang off an account id.
Attach a medication to a `userId` and you have quietly asserted that the person
taking the medicine is the person who logged in.

### Four rules that follow

1. **A Person's id is canonical and permanent.** Never reissued, never
   superseded by a second record.
2. **No duplication.** If two accounts can both see a Person's medication, they
   are reading the same row — not a copy, not a synced replica.
3. **Access is a membership**, not ownership of the clinical rows.
4. **Deleting an account never deletes a Person's clinical data.** Cascade from
   `User` is unsafe under this model; orphaned Persons are strictly preferable
   to destroyed health records, so the foreign keys are `Restrict` or
   `SetNull`.

### Two columns that mean different things

`Person.ownerUserId` means *this Person is that account's own record*. It is
constrained by `@@unique([ownerUserId])`, which is what makes "self-Person"
mean something. Postgres treats NULLs as distinct, so any number of *unclaimed*
Persons coexist while an account can own at most one — which is exactly the
rule.

`Person.createdByUserId` is provenance only. It is never read for
authorization. The account that typed a dependent's name into a form has no
claim on that dependent's records beyond the membership it also holds.

### Why `origin` is immutable

`PersonOrigin` (`SELF`, `DELIVERY`, `BABY_PROFILE`, `MANAGED`) records how a
Person came to exist. It is written once and never updated.

Because it is history, not state. A baby added through the pregnancy journey
was added that way permanently; that fact does not stop being true when the
child turns four. Making it mutable would invite code to "correct" it, and two
things read it:

- The **first-baby exemption** in `capacityFor`, which does not charge an
  account for the earliest `DELIVERY` or `BABY_PROFILE` Person it owns. That
  exemption is derived from provenance and ordering rather than a stored flag,
  precisely so it cannot drift.
- The **client**, which shows the record's kind.

An `origin` that could be edited would make the free tier's baby exemption a
thing a user could grant themselves.

> A real bug here is worth knowing about: signup never set `origin`, so for a
> period every self-Person was written as `MANAGED` — the column default.
> Migration `20260826160000_self_person_origin_backfill` repaired it. No access
> decision was ever wrong, because `origin` is not read for authorization, and
> entitlement was unaffected because the exemption is scoped to *unclaimed*
> Persons. But it was wrong on screen, and it is the reason the column is now
> set explicitly at the call site instead of relying on a default.

---

## 2. Authorization

Before Person separation, authorization here was **emergent**: repositories
filtered `where: { userId }`, and that was safe only because the caller and the
subject were the same entity. Exactly one explicit ownership check existed in
the whole backend.

Once caller and subject can differ, that stops being safe. `person.access.ts`
is that check generalised.

### Two rules

1. **Access comes from an ACTIVE membership.** Not from owning the clinical
   row, not from having created it, and never from `createdByUserId`.
2. **Memberships are looked up, never carried in the token.** They change and
   tokens do not, so a revoked grant stops working on the next request rather
   than at the next refresh.

### Capabilities

Coarse on purpose. A fine-grained permission matrix is the thing that would
make family access feel complicated to the people using it.

| Role | read | write | manage |
|---|---|---|---|
| `VIEWER` | ✓ | | |
| `CAREGIVER` | ✓ | ✓ | |
| `OWNER` | ✓ | ✓ | ✓ |

- **read** — see the record
- **write** — act on care: mark a dose taken, log a symptom, book an appointment
- **manage** — invite, revoke, transfer, archive

### `resolveSubject` is the only way in

```ts
const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'write');
```

One entry point, used by every person-scoped endpoint. It resolves the subject
— the named Person, or the caller's own if none was named — *and* asserts the
capability, in one call. Splitting those into two steps is how a caller
eventually forgets the second one.

A `personId` in a request is **only ever a request for a subject, never a grant
of one.**

### `PersonScope` makes unscoped queries unwritable

```ts
export interface PersonScope {
  personId: string;      // required — that is the whole point
  userId?: string;       // compatibility window, not a second auth path
}
```

The repository layer takes this type rather than loose arguments, so a query
for "everyone's care events" cannot be expressed by accident — there is no
overload that omits the subject.

`userId` is there because rows written before their module started dual-writing
`personId` carry `personId = NULL`. For a self-Person those are the caller's own
records, and a strict person-only filter would make them silently disappear.
The scope helpers admit exactly those rows and never one already carrying a
different subject:

```ts
OR: [
  { personId: scope.personId },
  ...(scope.userId ? [{ personId: null, userId: scope.userId }] : []),
]
```

It comes out when `personId` is `NOT NULL` everywhere. It is a migration
artefact with a defined end, not a design.

---

## 3. The care engine

Every health journey — medications, pregnancy, vaccinations, appointments —
compiles down to the same three tables.

```
CarePlan  (the root; person-scoped)
   │
   ├── Medication         1:1   ─┐
   ├── PregnancyProfile   1:1    │ typed detail, one per plan type
   ├── Appointment        1:1   ─┘
   │
   └── CareEvent  (something happens at a time)
          │
          ├── Reminder  (tell someone before it)
          │      └── NotificationAttempt  (what we actually tried)
          │
          └── CalendarEventLink  (per account, per provider)
```

`CarePlanType` is `MEDICATION | PREGNANCY | VACCINATION | APPOINTMENT`.

### Typed detail, not JSON

`CarePlan.metadata` is a `Json` column and it is **not** where new fields go. It
already carries `frequency`, `customTimes`, `aiDraftId` and `babyName` as
untyped JSON, which is exactly the debt not to add to.

New plan types get a **1:1 detail table** — the shape `Medication` and
`PregnancyProfile` already use, and the shape `Appointment` followed. Real
columns are queryable, typed, and can be constrained.

### "Plan" means two things

This trips people up, so it is worth stating plainly:

- **`CarePlan`** is the care engine root. **Person-scoped.**
- **`PlanType`** is the billing tier on `User` (`FREE | PREMIUM`).
  **Account-scoped, permanently.**

They are unrelated and the codebase calls both "plan". `PlanType` is never
attached to a Person.

### An appointment is a plan, and why

An appointment is a moment, not a course of treatment — so making it a
`CarePlanType` is not obviously right. It was chosen anyway, because:

- `CareEvent.carePlanId` is **non-null**. A sibling entity could not produce
  care events without altering a shared table holding live clinical data.
- Calendar sync is CarePlan-keyed (`prepareCarePlanSync(userId, carePlanId)`).

The cost is a borrowed lifecycle, and it is contained rather than pretended
away: an appointment plan only ever moves `ACTIVE → COMPLETED`. `PAUSED` is
meaningless for a moment in time and is never written.

### One event, many reminders

An appointment produces **one** `CareEvent` with several `Reminder` rows, not
one event per reminder. A `CareEvent` is the unit the calendar syncs — an event
per lead time would put the same appointment in someone's diary twice.

### Calendar sync must never block care

A standing rule. Every calendar call is wrapped, best-effort, and only ever
warns:

> An appointment that exists but is missing from someone's Google Calendar is a
> degraded appointment. An appointment that failed to be booked because Google
> was unreachable is a lost one.

Ordering matters when rescheduling: cleanup reads the sync links, which point
at care events, so it must run **before** those events are deleted. Otherwise
there is nothing left to tell Google which entry to withdraw. The sequence is
cleanup → transaction → prepare.

---

## 4. Billing: five concepts

### 1. `Price` — immutable, insert-only

A row, not a config value. A subscription points at one.

Repricing means **adding a row and retiring the old one**, never updating.
Everyone already subscribed stays attached to the price they signed up at and
keeps being charged that amount by the provider itself. Grandfathering needs no
code that remembers to protect anyone.

### 2. `Subscription` — the money fact

Provider-backed. Carries `providerMetadata` as opaque JSON that only the
adapter reads — Paystack needs an email token alongside the subscription code
before it will accept a cancellation, and that token has to live somewhere
without putting a vendor's field name in the schema.

### 3. `Entitlement` — resolved, never stored

The answer to "what can this account do", computed from **two** independent
facts — a paid subscription and an `EntitlementGrant` — with the higher tier
winning:

```
tier + managedPersonLimit + connectionLimit
source: 'subscription' | 'grant' | 'default'
```

There is exactly one calculation, `entitlementService.effective()`, and
`tierFor` and `resolve` are two shapes of it. That is not tidiness: when they
were two calculations they disagreed, and an admin-granted account was refused
by the one the UI read while being served by the one every gate used.

`PAST_DUE` still grants — losing access to a dependent's records the day a card
expires is the wrong failure — bounded by a grace window running from the failed
charge. `CANCELED` still grants until the period ends, because it was paid for.
Both are bounded, so neither grants forever.

### 4. `PlanType` — a projection, not the answer

The column on `User`. **Nothing authorises against it.** It is written through
whenever entitlement changes and survives for three reasons — the access token
carries it, the admin user list displays it, and older reads expect it — none
of which are authorisation.

This is load-bearing. Reading it in the resolver would make it a second source
of truth, which is the bug the grant model replaced. Quota and every gate read
entitlement, so an upgrade takes effect on the next request instead of the next
refresh.

### 5. `EntitlementGrant` — Premium given rather than bought

A subscription is money; a grant is a decision. They are independent, neither
writes the other, and an account can hold both — the resolver takes the higher
tier and reports the subscription as the source while the grant stays live
underneath. A failed card must not remove something nobody paid for.

The row is the audit trail: who granted it, when, why, until when, and who
revoked it and why. Revocation is recorded, never deleted — "this account had
Premium for three months and then did not" is a fact about the account.

**Expiry is not a status.** `GrantStatus` is `ACTIVE` or `REVOKED`, the states a
person puts a grant into. A grant whose `expiresAt` has passed stops granting at
that instant because the lookup is a `WHERE` clause, not because a sweep marked
it. There is no job, and correctness does not wait for one.

### The capacity grant — tops up, never reduces

Separately, `User.managedPersonLimit` and `User.connectionLimit` can be raised
directly for a support decision or a pilot account. Entitlement takes `Math.max`
of the tier default and those columns, so raising them tops up rather than
replaces, and an expiring subscription cannot silently strip capacity given
separately.

### Two capacity axes, both zero on free

| Tier | managed | connections |
|---|---|---|
| `FREE` | 0 | 0 |
| `PREMIUM` | 5 | 5 |

A self-Person consumes neither, so **free means self only** — and the first
baby is exempt from managed capacity, so the free tier still covers the whole
mother-baby journey for one child.

**Limits are a ceiling on new only, never continuous.** An account that falls
below its limit after a downgrade keeps full access to every Person it already
has. Health data must never become read-only on a billing event. There is no
product-level cap on clinical records at all: a user's own health data is never
paywalled, and abuse protection lives at the API layer as throttling and
payload limits.

### The provider boundary

`PaymentTransaction` and `BillingWebhookEvent` sit between us and a payment
provider. Three guarantees, each against a different failure:

- **Signature verification runs on the raw bytes**, before anything is parsed.
  The webhook route mounts ahead of the JSON parser precisely so those bytes
  survive. An unsigned request is not a malformed event, it is an
  unauthenticated one.
- **Replay is keyed on the provider's event id**, not the payload — a resend
  may be byte-identical or re-serialised and neither should matter. A duplicate
  still answers 200; anything else invites the provider to retry forever.
- **Out-of-order is a separate problem** and is handled by comparing the
  provider's timestamp against the last applied. Delivery order is not event
  order, so arrival order is never consulted.

Retries exhausted means `DEAD_LETTERED`: kept, logged loudly, never retried
automatically, and readable at an admin endpoint. A billing event that quietly
stops being processed is money going wrong unobserved.

---

## 5. The consent ledger

`PersonAccessEvent` is append-only. A revocation is a **new row**, never a
mutation of the grant it revokes, and nothing is ever deleted.

```
GRANTED · ACCEPTED · CLAIMED · REVOKED · LEFT
TRANSFERRED · ARCHIVED · ERASED · CLAIM_REFUSED
```

`REVOKED` and `LEFT` are distinct on purpose: "they took my access away" and "I
walked away" are different facts about a consent relationship, and the ledger
has to be able to tell them apart.

It exists because Nigeria's Data Protection Act applies to sharing health data.
It is **not** `ActivityLog`, which is a user-facing feed — and it is not
repurposed as one.

`ReportGeneration` is the same idea for exports: it records that a summary left
the system — who, whose record, when, over what period. It now also carries the
lifecycle of the document, including `storageKey` while one exists. The row
outlives the file deliberately: the document expires within the hour, the record
that a copy was taken does not.

### Two things the ledger deliberately does not record

**Why a claim was refused.** `CLAIM_REFUSED` records that someone was offered
their own record and could not take it. The reason is absent because the ledger
is readable by everyone with read access to that Person — the inviter included
— and what is in the invitee's *own* health record is not the inviter's to see.

**The reason reaches the invitee instead**, in the API response, and never
touches the ledger.

---

## 6. Invitations and claiming

An invitation is addressed to an **email**, not an account, because the case
that dominates is someone who has never used Vitals arriving from a link.
`PersonMembership` cannot express that — its `userId` is a required foreign key
— so the offer gets a table of its own and the membership is created when there
is an account to attach it to.

Answering has three shapes: `connect`, `claim`, `decline`.

### Why claiming refuses rather than merges

The situation: an adult is invited to claim a record a relative kept about them,
but they already have a self-Person with their own history. Two Persons, both
legitimately about the same human, both with records.

**Merging is not available**, and this is a consequence of the rules rather
than an omission:

- Moving one Person's rows onto the other empties the first and makes the
  second the survivor — supersession in substance, which rule 1 forbids.
- Copying the rows is duplication, which rule 2 forbids.

So the two histories cannot be unified, and the only question is how gracefully
that is said. The answer:

- **Self-Person empty** → it is archived (`ownerUserId` released, then the
  claimed record acquires it — the unique index is real and the order is not
  incidental), and ownership moves. Nothing is lost because there was nothing
  to lose.
- **Self-Person not empty** → the claim is refused, and **the invitation stays
  open**. It was always a connection invitation; claiming was an upgrade
  offered on top of it. Not taking the upgrade leaves an ordinary offer, still
  acceptable. The screen says what is possible — both records, open, complete —
  rather than what is not.

"Empty" is read from **contents, not row counts**. A `PersonHealthProfile` of
all nulls is an empty shell, because the update endpoint upserts and a request
carrying nothing creates one. The demographics signup writes are not data
either, or the dominant flow — someone who signed up from the link thirty
seconds ago — would refuse itself.

### Claiming revokes, then offers back

A successful claim revokes everyone who was managing the record. Once the
record's subject owns it, anyone else's access is the subject's decision rather
than something inherited from having set the record up first.

Restoring it is a **separate, explicit step**, so the ledger carries two events
because two decisions were made. The re-grant is bounded to exactly the
accounts that claim revoked — read off the claim event, not off the request —
so it cannot become a way to grant access to anyone else.

It lands `ACTIVE` rather than `INVITED`, and bypasses the recipient's
connection ceiling, for the same reason a handoff does: this is a continuation,
not an acquisition.

### Why capacity is checked on the *accepting* account

Connecting to someone else's record consumes a **connection** slot. That slot
belongs to the account gaining access, not the one offering it.

So the check lives in `connect()`, where the membership actually becomes
`ACTIVE` — not in `invite()`, which has no capacity check at all. Inviting
someone to a record you manage costs you nothing, and gating the invite on the
inviter's ceiling would stop a free account sharing its own record with a
relative, which is an action the model allows.

This is also why it is a ceiling on *new* only: it is checked at the moment
access is taken, and never again.

### Identity is the whole point, so the address must be verified

The address on an invitation must match the **verified** address of the account
answering it. An unverified address is an unproven claim to an identity, and
this is the one place where the identity is the entire question: accepting
decides who reads someone's health record, and claiming decides who that record
is *about*.

Both entry points — the token from the email, and the id from the account's own
list — go through one gate rather than each carrying a copy of the matching
logic. The id is not a credential: the lookup is narrowed by the caller's
verified address, so an id belonging to someone else's offer finds nothing and
answers the same 404 as an id that does not exist. **One error covers "no such
invitation", "not yours" and "already answered"** — distinguishing them would
let a caller probe which addresses have live offers against which records.

---

## 7. Background jobs

Two processes. `src/server.ts` is the API; `src/worker.ts` runs the queues and
registers the repeatable jobs. `src/main.ts` is both in one process, and is what
the container runs.

> This matters more than it looks. The deployment ran `dist/server.js` — the API
> alone — so `startScheduledJobs()` was never called and no reminder was ever
> dispatched. They accumulated as `PENDING` rows indefinitely. The Dockerfile
> now runs `dist/main.js` and says why.

### Repeatable jobs

| Job | Interval | Does |
|---|---|---|
| `PROCESS_DUE_REMINDERS` | 60s | Claims and dispatches due reminders |
| `PROCESS_OUTBOX` | 30s | Turns outbox rows into queue jobs |
| `SWEEP_MISSED_APPOINTMENTS` | 15m | Moves past appointments to `MISSED` |
| `billing-reconcile` | 1h | Compares our state against the provider's |

### Queues

`notifications`, `adherence`, `outbox`, `billing` — plus the
`reminder-scheduler` queue that carries the repeatable ticks above.

### The outbox pattern

Domain events are written **in the same transaction as the domain data**, then
picked up by a poller. A process that dies between creating an invitation and
queueing its email leaves an invitation nobody was told about; the row and the
intent to send it commit together or neither does.

### Claiming, and why it is a conditional update

Every job that takes work does so with a single atomic statement where the
status is both the filter and what is written:

```sql
UPDATE ... SET status = 'MISSED'
 WHERE status IN ('SCHEDULED','CONFIRMED') AND ...
RETURNING id
```

The scheduler runs in **every** worker process, so two workers racing the same
row is the ordinary case rather than an edge one. A read followed by a write
would let both claim it. `RETURNING` tells each worker exactly which rows it —
and only it — took.

### Why reports queue, and what that cost

This section used to argue the opposite, and the reversal is worth recording
along with what did **not** change.

The original objection was never that rendering is slow. It was that making it
a job **adds a stored artefact** — a PDF holding an entire health record,
duplicated outside the tables that own it and outside every access check that
guards them, sitting somewhere until someone remembers to delete it. That is
still exactly what a stored report is, and it is still the risk.

What changed is where this runs. The API and the workers share one Node process
on a 1 GB instance. PDFKit rendering is the most CPU-hungry thing that process
does, and on the request path it competes for the same event loop as every
other request — including the reminder engine. Stall it long enough and BullMQ
stops renewing job locks, at which point healthy jobs are reported as stalled
and retried. The danger was never latency; it was **blocking**.

The earlier note named its own escape hatch — *"accept a job whose output is
deleted on a timer"* — and this is that, taken deliberately. The timer is not a
follow-up task, and nothing in the module can produce a file without one:

- `expiresAt` is written in the same update that sets `READY`
- a sweep deletes the file and moves the row to `EXPIRED`
- files that no row owns are swept too, so a crash between writing a document
  and committing its row cannot leave a health record on disk untracked
- the storage directory is **not** persisted across restarts, so a lost file
  costs a regeneration rather than outliving the process accountable for it

### Why downloads are authorised rather than addressed

A signed storage URL is the usual way to serve a generated file, and is
deliberately not used.

A signed URL is a **bearer capability**: it keeps working for as long as it is
valid, because nothing re-reads the membership that justified issuing it. That
is precisely wrong here. Memberships change, and §5's rule — look them up,
never carry them in a token — applies to a URL exactly as it applies to a JWT.

So the document is served by an authenticated endpoint that re-resolves
membership *and* entitlement on **every** download. Revoking a caregiver's
access stops the next fetch of a document generated while they still had it.
The storage key never appears in any response.

### What the ledger means now

`generatedAt` is when a summary was **asked for**. `downloadedAt` is when a copy
actually **left the system**, and it is stamped once, on the first fetch.

Under the synchronous contract those were the same instant, so one column
carried both meanings. They are no longer the same: a document can be rendered
and never fetched, which discloses nothing. The consent ledger records the
disclosure, so it follows the download.

---

## 8. Reports

### The lifecycle

```text
POST /reports/health-summary        both gates checked, row created PENDING
        ↓                           202 Accepted — nothing rendered yet
   reports queue                    priority 10, concurrency 1
        ↓
   worker renders                   gates checked AGAIN, file written 0600
        ↓                           status READY, expiresAt set
GET  …/{id}/download                gates checked AGAIN, downloadedAt stamped
        ↓
   sweep (every 5 min)              file deleted, status EXPIRED
```

The gates are resolved three times on purpose. Access can be revoked and
Premium can lapse between asking for a document and fetching it, and both must
stop the fetch.

Two independent gates, resolved separately:

- **Membership** decides *whose* record may be summarised (read access).
- **Entitlement** decides whether *this account* may generate one at all
  (Premium).

A Premium account still cannot report on a stranger, and an `OWNER` on the free
tier still cannot export. Access is checked **first**, deliberately: someone
with no relationship to a Person should be told they cannot see that Person,
not invited to upgrade in order to find out.

### What a report may say

Vitals helps people **understand and organise** their health. It does not
diagnose, treat or advise, and the document is framed that way in the document
itself.

Doses appear as the four **recorded counts** — taken, skipped, missed, still
scheduled — beside the period they were counted over. No percentage, score,
rating, trend, streak or chart appears anywhere, and none should be added: a
ratio of taken to scheduled is an adherence figure, and an adherence figure is
an assessment of how someone is managing their health.

No model-generated text reaches the document. Symptom AI guidance, mood
insights and drug detections are excluded **at the query**, not filtered at the
renderer, so there is no path by which they could arrive.

---

## 9. Migration discipline

This is medical data belonging to real users. Every migration is treated as
production-critical regardless of user count.

- Existing endpoints keep working across a deploy. The person separation ran in
  phases — `phase_a` added nullable columns, `phase_b` backfilled, `phase_c`
  tightened cascades — precisely so no deploy needed a simultaneous cutover.
- Every migration that moves data carries a **backfill**, a **verification
  query**, and a stated **rollback path**. "It should be fine" is not
  verification.
- Authorization tests exercise real query scoping. The mocked suites cannot
  catch a cross-person leak, because a mocked client answers whatever it was
  told to — which is why `tests/db` exists and runs against real Postgres.
