/**
 * Safety posture for AI-generated health output.
 *
 * Both AI features are informational, never diagnostic. These guards are
 * applied server-side, after the model responds and before anything is
 * persisted or returned, so the posture cannot be bypassed by a client and is
 * auditable in one place.
 *
 * Two rules, matching the two ways this output can hurt someone:
 *
 * 1. An uncertain drug identification is withheld rather than shown. A wrong
 *    medication name rendered with full confidence is the failure mode with
 *    direct physical consequences.
 * 2. A symptom assessment may always escalate toward care and may never fully
 *    reassure. False reassurance is how symptom checkers cause harm: the danger
 *    is someone with a serious problem being told they are fine.
 */

export type DrugIdentificationConfidence =
  | 'unable_to_identify'
  | 'low'
  | 'moderate'
  | 'high';

export interface DrugIdentificationLike {
  drugName: string;
  commonUsage: string;
  sideEffects: string[];
  caution: string;
  disclaimer: string;
  confidence: DrugIdentificationConfidence;
}

export interface SymptomAssessmentLike {
  severity: string;
  summary: string;
  guidance: string;
  disclaimer: string;
  seekCareIf: string[];
}

const CONFIDENCE_ORDER: DrugIdentificationConfidence[] = [
  'unable_to_identify',
  'low',
  'moderate',
  'high',
];

/**
 * Below this, no medication name is returned at all. Raise to 'high' to be
 * stricter; the trade is that the feature returns a result less often.
 */
export const MIN_CONFIDENCE_TO_NAME_DRUG: DrugIdentificationConfidence = 'moderate';

const rank = (confidence: DrugIdentificationConfidence): number =>
  CONFIDENCE_ORDER.indexOf(confidence);

const VERIFY_BEFORE_TAKING =
  'This identification is not certain. Confirm the medication with a pharmacist ' +
  'or the original packaging before taking it.';

const WITHHELD_CAUTION =
  'Do not take a medication identified this way. Confirm what it is with a ' +
  'pharmacist, your doctor, or the original packaging.';

export const DEFAULT_SEEK_CARE_IF: string[] = [
  'Your symptoms are severe or getting rapidly worse',
  'You are experiencing chest pain, difficulty breathing, or loss of consciousness',
  'Your symptoms persist longer than you would expect',
  'You are concerned and want professional reassurance',
];

export const DEFAULT_SYMPTOM_DISCLAIMER =
  'This is general information only and not a medical diagnosis. Please consult ' +
  'a qualified healthcare professional.';

export const DEFAULT_DRUG_DISCLAIMER =
  'This is general information only and not a medical diagnosis. Always confirm ' +
  'any medication with a qualified pharmacist or doctor.';

/**
 * Withholds the medication name when the model was not confident enough to be
 * relied on, and adds an explicit verification step when it was only moderately
 * confident. Confidence is preserved either way so the client can explain why.
 */
export const applyDrugIdentificationPolicy = (
  result: DrugIdentificationLike,
): DrugIdentificationLike => {
  const disclaimer = result.disclaimer || DEFAULT_DRUG_DISCLAIMER;

  if (rank(result.confidence) < rank(MIN_CONFIDENCE_TO_NAME_DRUG)) {
    return {
      drugName: 'Not identified',
      commonUsage:
        'This image could not be matched to a medication reliably enough to name it.',
      sideEffects: [],
      caution: WITHHELD_CAUTION,
      disclaimer,
      confidence: result.confidence,
    };
  }

  if (result.confidence === 'moderate') {
    return {
      ...result,
      caution: `${VERIFY_BEFORE_TAKING} ${result.caution}`.trim(),
      disclaimer,
    };
  }

  return { ...result, disclaimer };
};

/**
 * Guarantees a symptom assessment always carries a route to professional care.
 * A model that returns a low severity with nothing in `seekCareIf` produces an
 * unqualified "you are fine", which this prevents.
 */
export const ensureEscalationPath = (
  result: SymptomAssessmentLike,
): SymptomAssessmentLike => ({
  ...result,
  seekCareIf:
    Array.isArray(result.seekCareIf) && result.seekCareIf.length > 0
      ? result.seekCareIf
      : DEFAULT_SEEK_CARE_IF,
  disclaimer: result.disclaimer || DEFAULT_SYMPTOM_DISCLAIMER,
});
