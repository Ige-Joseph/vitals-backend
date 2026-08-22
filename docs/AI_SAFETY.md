# AI Safety Posture

Vitals uses AI in exactly two features. Both are informational. Neither
diagnoses, prescribes, or treats.

| Feature | Input | Output | Model |
|---|---|---|---|
| Symptom information | Free-text symptom description | Summary, general guidance, warning signs to seek care | Gemini (text) |
| Medication identification | Photo of a medication or its packaging | Medication name, common usage, side effects, cautions | Gemini (vision) |

Nothing else in the product uses a model. Medication schedules, pregnancy
timelines, vaccination schedules, and mood insights are all deterministic and
config-driven — see `src/config/`.

## What the AI is not permitted to do

The system instruction constrains the model to non-diagnostic information only,
and forbids diagnoses and prescriptions. Model output is never used to create,
modify, or schedule anything in the care engine. A symptom check cannot produce
a medication plan, a dose, or a reminder. The boundary is structural: the AI
routes read nothing from and write nothing to `CarePlan` or `CareEvent`.

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
`quotaService.checkAndIncrement` before every model call, atomically. See
`src/modules/usage/`.

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
