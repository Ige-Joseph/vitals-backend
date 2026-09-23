import {
  applyDrugIdentificationPolicy,
  ensureEscalationPath,
  DEFAULT_SEEK_CARE_IF,
  DEFAULT_SYMPTOM_DISCLAIMER,
  type DrugIdentificationConfidence,
  type DrugIdentificationLike,
} from '@/lib/ai-safety';

const identification = (
  confidence: DrugIdentificationConfidence,
  overrides: Partial<DrugIdentificationLike> = {},
): DrugIdentificationLike => ({
  drugName: 'Paracetamol 500mg',
  commonUsage: 'Pain relief and fever reduction',
  sideEffects: ['Nausea', 'Rash'],
  caution: 'Do not exceed the stated dose.',
  disclaimer: 'Consult a pharmacist.',
  confidence,
  ...overrides,
});

describe('Drug identification safety policy', () => {
  describe('withholds an unreliable identification', () => {
    it.each<DrugIdentificationConfidence>(['low', 'unable_to_identify'])(
      'returns no medication name at %s confidence',
      (confidence) => {
        const result = applyDrugIdentificationPolicy(identification(confidence));

        expect(result.drugName).not.toContain('Paracetamol');
        expect(result.drugName).toBe('Not identified');
        // Clinical detail must not survive either — usage and side effects for
        // a drug we could not name would imply we had named it.
        expect(result.sideEffects).toEqual([]);
        expect(result.commonUsage).not.toContain('Pain relief');
        expect(result.caution).toMatch(/pharmacist|doctor|packaging/i);
        // Confidence is preserved so the client can explain the outcome.
        expect(result.confidence).toBe(confidence);
      },
    );
  });

  describe('names the drug when the model was confident enough', () => {
    it('returns the identification unchanged at high confidence', () => {
      const result = applyDrugIdentificationPolicy(identification('high'));

      expect(result.drugName).toBe('Paracetamol 500mg');
      expect(result.sideEffects).toEqual(['Nausea', 'Rash']);
    });

    it('adds an explicit verification step at moderate confidence', () => {
      const result = applyDrugIdentificationPolicy(identification('moderate'));

      expect(result.drugName).toBe('Paracetamol 500mg');
      expect(result.caution).toMatch(/not certain/i);
      expect(result.caution).toMatch(/pharmacist|packaging/i);
      // The model's own caution is kept, not replaced.
      expect(result.caution).toContain('Do not exceed the stated dose.');
    });
  });

  it('always returns a disclaimer, even when the model omitted one', () => {
    const result = applyDrugIdentificationPolicy(
      identification('high', { disclaimer: '' }),
    );

    expect(result.disclaimer).toBeTruthy();
    expect(result.disclaimer).toMatch(/not a medical diagnosis/i);
  });
});

describe('Symptom assessment escalation path', () => {
  const assessment = (overrides: Record<string, unknown> = {}) => ({
    severity: 'low',
    summary: 'Mild headache reported.',
    guidance: 'Rest and stay hydrated.',
    disclaimer: 'Consult a professional.',
    seekCareIf: ['Symptoms worsen'],
    ...overrides,
  });

  it('injects warning signs when the model returned none', () => {
    const result = ensureEscalationPath(assessment({ seekCareIf: [] }));

    expect(result.seekCareIf.length).toBeGreaterThan(0);
    expect(result.seekCareIf).toEqual(DEFAULT_SEEK_CARE_IF);
  });

  it('injects warning signs when the field is missing entirely', () => {
    const result = ensureEscalationPath(
      assessment({ seekCareIf: undefined }) as never,
    );

    expect(result.seekCareIf).toEqual(DEFAULT_SEEK_CARE_IF);
  });

  it('never leaves a low-severity assessment without a route to care', () => {
    const result = ensureEscalationPath(
      assessment({ severity: 'low', seekCareIf: [] }),
    );

    // The dangerous output is a low severity that reassures with no next step.
    expect(result.severity).toBe('low');
    expect(result.seekCareIf.length).toBeGreaterThan(0);
    expect(result.disclaimer).toBeTruthy();
  });

  it('keeps the model warning signs when it supplied them', () => {
    const result = ensureEscalationPath(assessment());

    expect(result.seekCareIf).toEqual(['Symptoms worsen']);
  });

  it('supplies a disclaimer when the model omitted one', () => {
    const result = ensureEscalationPath(assessment({ disclaimer: '' }));

    expect(result.disclaimer).toBe(DEFAULT_SYMPTOM_DISCLAIMER);
  });
});
