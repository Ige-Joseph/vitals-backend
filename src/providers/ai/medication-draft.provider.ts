import { DraftStatus } from '@prisma/client';

import { geminiProvider } from './gemini.provider';


export interface MedicationDraftData {
  name?: string;
  dosage?: string;
  frequency?: 'ONCE_DAILY' | 'TWICE_DAILY' | 'THREE_TIMES_DAILY';
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  customTimes?: string[];
  instructions?: string | null;
}

export interface MedicationDraftExtractionResult {
  extractedData: MedicationDraftData;
  missingFields: string[];
  status: DraftStatus;
  confidence: number;
  nextQuestion: string | null;
}

const todayDateOnly = () => new Date().toISOString().slice(0, 10);

const getSuggestedTimes = (
  frequency?: MedicationDraftData['frequency'],
): string[] => {
  if (frequency === 'ONCE_DAILY') return ['20:00'];
  if (frequency === 'TWICE_DAILY') return ['08:00', '20:00'];
  if (frequency === 'THREE_TIMES_DAILY') return ['08:00', '14:00', '20:00'];
  return [];
};

const getNextQuestion = (missingFields: string[]): string | null => {
  const field = missingFields[0];

  if (field === 'name') return 'What medication name should I use?';
  if (field === 'dosage') return 'What dosage should I use?';
  if (field === 'frequency') return 'How often should you take it?';
  if (field === 'durationDays') return 'For how many days should this medication run?';
  if (field === 'customTimes') return 'What time should I remind you?';

  return null;
};


const normalizeName = (name?: string) => {
  if (!name) return undefined;

  return name
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
};

const normalizeDosage = (dosage?: string) => {
  if (!dosage) return undefined;

  return dosage
    .trim()
    .replace(/milligrams?/gi, 'mg')
    .replace(/micrograms?/gi, 'mcg')
    .replace(/grams?/gi, 'g')
    .replace(/milliliters?/gi, 'ml')
    .replace(/\s+/g, '');
};

const normalizeDraft = (draft: MedicationDraftData): MedicationDraftData => {
  const frequency = draft.frequency;

  return {
    name: normalizeName(draft.name),
    dosage: normalizeDosage(draft.dosage),
    frequency,
    startDate: draft.startDate || todayDateOnly(),
    endDate: draft.endDate || undefined,
    durationDays: draft.durationDays || undefined,
    customTimes: draft.customTimes?.length
      ? draft.customTimes
      : getSuggestedTimes(frequency),
    instructions: draft.instructions ?? null,
  };
};

const calculateMissingFields = (draft: MedicationDraftData): string[] => {
  const missing: string[] = [];

  if (!draft.name) missing.push('name');
  if (!draft.dosage) missing.push('dosage');
  if (!draft.frequency) missing.push('frequency');
  if (!draft.durationDays && !draft.endDate) missing.push('durationDays');

  return missing;
};

const buildResult = (
  draftInput: MedicationDraftData,
  confidence = 0.8,
): MedicationDraftExtractionResult => {
  const draft = normalizeDraft(draftInput);
  const missingFields = calculateMissingFields(draft);
  const status =
    missingFields.length === 0
      ? DraftStatus.READY_FOR_REVIEW
      : DraftStatus.IN_PROGRESS;

  return {
    extractedData: draft,
    missingFields,
    status,
    confidence,
    nextQuestion: getNextQuestion(missingFields),
  };
};

const SYSTEM_INSTRUCTION = `
You extract medication reminder setup details from user input.

Return ONLY valid JSON. No markdown. No explanation.

Allowed frequency values:
- ONCE_DAILY
- TWICE_DAILY
- THREE_TIMES_DAILY

Return this JSON shape:
{
  "name": string | null,
  "dosage": string | null,
  "frequency": "ONCE_DAILY" | "TWICE_DAILY" | "THREE_TIMES_DAILY" | null,
  "startDate": string | null,
  "endDate": string | null,
  "durationDays": number | null,
  "customTimes": string[],
  "instructions": string | null,
  "confidence": number
}

Rules:
- Use YYYY-MM-DD for dates.
- If no start date is mentioned, use today's date.
- If frequency is once daily and no time is mentioned, customTimes should be ["20:00"].
- If frequency is twice daily and no times are mentioned, customTimes should be ["08:00", "20:00"].
- If frequency is three times daily and no times are mentioned, customTimes should be ["08:00", "14:00", "20:00"].
- If duration is mentioned as one week, use durationDays 7.
- If duration is mentioned as two weeks, use durationDays 14.
- Do not invent medication name or dosage.
- Do not provide medical advice.
`;

const buildTextPrompt = (message: string) => `
Today is ${todayDateOnly()}.

User message:
${message}
`;

const buildUpdatePrompt = (
  existingDraft: MedicationDraftData,
  message: string,
) => `
Today is ${todayDateOnly()}.

Existing draft:
${JSON.stringify(existingDraft)}

User update:
${message}

Merge the user update into the existing draft. Do not remove valid existing fields unless the user clearly replaces them.
`;

type GeminiMedicationDraftJson = {
  name: string | null;
  dosage: string | null;
  frequency: MedicationDraftData['frequency'] | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  customTimes: string[];
  instructions: string | null;
  confidence: number;
};

const fromGeminiJson = (
  parsed: GeminiMedicationDraftJson | null,
): MedicationDraftExtractionResult | null => {
  if (!parsed) return null;

  return buildResult(
    {
      name: parsed.name ?? undefined,
      dosage: parsed.dosage ?? undefined,
      frequency: parsed.frequency ?? undefined,
      startDate: parsed.startDate ?? todayDateOnly(),
      endDate: parsed.endDate ?? undefined,
      durationDays: parsed.durationDays ?? undefined,
      customTimes: Array.isArray(parsed.customTimes) ? parsed.customTimes : [],
      instructions: parsed.instructions ?? null,
    },
    typeof parsed.confidence === 'number' ? parsed.confidence : 0.75,
  );
};

export const medicationDraftProvider = {
  async extractFromText(message: string): Promise<MedicationDraftExtractionResult> {
    const text = await geminiProvider.generateText(
      buildTextPrompt(message),
      SYSTEM_INSTRUCTION,
    );

    const parsed = geminiProvider.parseJsonSafe<GeminiMedicationDraftJson>(text);
    const result = fromGeminiJson(parsed);

    if (!result) {
      return buildResult({});
    }

    return result;
  },

  async updateFromText(
    existingDraft: MedicationDraftData,
    message: string,
  ): Promise<MedicationDraftExtractionResult> {
    const text = await geminiProvider.generateText(
      buildUpdatePrompt(existingDraft, message),
      SYSTEM_INSTRUCTION,
    );

    const parsed = geminiProvider.parseJsonSafe<GeminiMedicationDraftJson>(text);
    const result = fromGeminiJson(parsed);

    if (!result) {
      return buildResult(existingDraft, 0.4);
    }

    return result;
  },

};