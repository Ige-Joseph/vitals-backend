# AI Safety Posture

Vitals uses AI in three features. None diagnoses, prescribes, or treats.

| Feature | Input | Output | Model |
|---|---|---|---|
| Symptom information | Free-text symptom description | Summary, general guidance, warning signs to seek care | Gemini (text) |
| Medication identification | Photo of a medication or its packaging | Medication name, common usage, side effects, cautions | Gemini (vision) |
| Medication drafting | Typed or spoken description of a medication | A **draft** of the fields a medication plan needs, plus what is still missing | Gemini (text), AssemblyAI (speech-to-text) |

The first two are purely informational: they return text and change nothing.
The third is different in kind and is the one to understand carefully — see
[the care engine boundary](#the-care-engine-boundary) below.

Nothing else in the product uses a model. Medication schedules, pregnancy
timelines, vaccination schedules, and mood insights are all deterministic and
config-driven — see `src/config/`.

## What the AI is not permitted to do

The system instruction constrains the model to non-diagnostic information only,
and forbids diagnoses and prescriptions.

## The care engine boundary

This section previously said model output is *never* used to create anything in
the care engine. That was true when only the two informational features existed.
Medication drafting changed it, and the honest statement is narrower:

> **Model output can become a medication plan — but only by passing through an
> explicit human confirmation, and never on the model's own authority.**

What that means concretely:

- **No AI route writes to `CarePlan`, `CareEvent`, `Medication` or `Reminder`.**
  That part of the original claim still holds and is still structural. A draft
  lives in its own table, `MedicationDraft`, and is inert.
- **A draft is a proposal, not a plan.** It holds extracted fields and a list of
  what is still missing. Nothing is scheduled, nothing is reminded, and it
  expires on its own if never acted on.
- **Creating the plan is a separate, user-initiated request.** The user reviews
  the fields, edits anything wrong, and submits `POST /medications` themselves.
  The draft id travels with that request only so the draft can be marked
  `CONFIRMED` and not reused.
- **The plan is built from the submitted request, not from the draft.** The
  medication service validates the fields it is given and generates the schedule
  deterministically. A draft cannot bypass validation, and the same request
  would produce the same plan had the user typed every field by hand.
- **A symptom check still cannot produce a plan, a dose, or a reminder.** That
  route has no path into the care engine at all. Only the drafting feature does,
  and only through the step above.

The distinction that matters clinically: the model can *suggest what to type*,
and cannot *decide what is scheduled*. A user who does not press the button gets
no medication plan, and a user who edits the draft gets what they edited.

Two consequences worth stating plainly, because they are the risks this design
accepts rather than removes:

- A user who confirms a draft without reading it has accepted whatever the model
  extracted. The confirmation step is a real control only if the UI shows the
  fields for review — clients must not auto-submit a draft.
- Extraction errors are silent in a way an identification error is not. There is
  no confidence threshold on drafting as there is on medication identification
  (below); a misheard dosage looks exactly like a correct one. The mitigation is
  the review step, and nothing else.

## Server-side guards

Model output passes through `src/lib/ai-safety.ts` before it is persisted or
returned. These run on the server, so no client can bypass them, and the policy
lives in one auditable place.

### Uncertain medication identifications are withheld

The model reports its own confidence. Below `moderate`, no medication name is
returned at all — the name, common usage, and side effects are all replaced with
an explanation that the image could not be matched reliably, and the user is
directed to a pharmacist or the original packaging.

At `moderate`, the name is returned with an explicit verification step prepended
to the caution.

A wrong medication name presented with full confidence is the failure mode with
direct physical consequences, so the default is to return nothing rather than
something uncertain. `MIN_CONFIDENCE_TO_NAME_DRUG` controls the threshold.

This guard applies to **identification only**. Medication *drafting* has no
equivalent confidence gate: a misheard dosage is returned looking exactly like a
correct one, and the review step before submission is the only thing standing
between it and a scheduled dose.

### Symptom assessments may escalate but never fully reassure

False reassurance is how symptom checkers cause harm: the danger is not telling
someone to see a doctor unnecessarily, it is telling someone with a serious
problem that they are fine.

The system instruction forbids stating or implying that symptoms need no
professional evaluation. Server-side, every assessment is guaranteed to carry a
non-empty list of warning signs and a disclaimer, whatever severity the model
assigned and whatever it returned. A low severity with no route to care cannot
reach the user.

### Failure is safe

If the model errors, times out, or returns output failing validation, a
conservative fallback is returned instead, and the response is flagged. The
fallback directs the user to professional care. It never guesses.

## Disclaimers

Every AI response carries a disclaimer. If the model omits it, the server
supplies one. Disclaimers are part of the response body, not presentation, so
they cannot be dropped by a client.

## Quotas

AI use is metered per user per day and enforced server-side by
`quotaService.checkAndIncrement` before every model call. See
`src/modules/usage/`.

The increment is a single conditional update — in effect `SET used = used + 1
WHERE used < limit` — so two requests arriving together serialise on the row and
the loser re-evaluates the limit against the committed count. `count === 0`
means the limit was genuinely reached; there is no window in which both callers
read the same count and both increment. Same claim-then-process shape as
`careRepository.claimReminder`.

Limits come from the environment (`FREE_*` and `PREMIUM_*` per day). The plan is
read from the **database**, via `entitlementService.tierFor`, not from the
access token — so an upgrade takes effect on the next request rather than the
next token refresh.

That is a change from an earlier design in which the tier came from the JWT and
a purchase did not raise the limit until the token rotated, up to fifteen
minutes later. Entitlement now resolves from subscription state, and the
`planType` column on `User` is a projection of it rather than the answer.

## Known limits

- The model can be wrong, including confidently wrong within a confidence band.
- Confidence is self-reported by the model and is not a calibrated probability.
- Coverage of medications available in Nigerian markets is unverified.
- No output has been clinically validated, and the product has no regulatory
  clearance in any jurisdiction.

## Constraints this posture derives from

The Gemini API terms prohibit use "in clinical practice, to provide medical
advice, or in any manner that is overseen by or requires clearance or approval
from a medical device regulatory agency", for paid and unpaid use alike.

If the PWA is ever distributed through an app store, further requirements apply
that this document does not yet cover — Google Play's health features
declaration and Medical Functionalities policy, and Apple's guideline 1.4.1
including its methodology disclosure requirement.
