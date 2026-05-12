import { DraftSource, DraftStatus, Prisma } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { aiMedicationDraftsRepository } from './ai-medication-drafts.repository';
import {
  medicationDraftProvider,
  MedicationDraftData,
} from '@/providers/ai/medication-draft.provider';
import { assemblyAiProvider } from '@/providers/speech/assemblyai.provider';


const log = createLogger('ai-medication-drafts-service');

const DRAFT_TTL_HOURS = Number(process.env.AI_MEDICATION_DRAFT_TTL_HOURS ?? 24);
const MAX_DRAFT_TURNS = Number(process.env.AI_MEDICATION_DRAFT_MAX_TURNS ?? 3);

const getExpiresAt = () => {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + DRAFT_TTL_HOURS);
  return expiresAt;
};

const isExpired = (expiresAt: Date) => expiresAt.getTime() < Date.now();

const TERMINAL_STATUSES: DraftStatus[] = [
  DraftStatus.CONFIRMED,
  DraftStatus.CANCELLED,
  DraftStatus.NEEDS_MANUAL_REVIEW,
];

const isTerminalStatus = (status: DraftStatus) => {
  return TERMINAL_STATUSES.includes(status);
};

const formatDraftResponse = (draft: {
  id: string;
  status: DraftStatus;
  missingFields: string[];
  extractedData: unknown;
  lastQuestion: string | null;
  confidence: number | null;
  turnCount: number;
  expiresAt: Date;
  transcript: string | null;
}) => {
  return {
    draftId: draft.id,
    status: draft.status,
    missingFields: draft.missingFields,
    nextQuestion: draft.lastQuestion,
    medicationDraft: draft.extractedData,
    confidence: draft.confidence,
    turnCount: draft.turnCount,
    expiresAt: draft.expiresAt,
    transcript: draft.transcript,
  };
};

export const aiMedicationDraftsService = {
  async createFromText(userId: string, message: string) {
    const result = await medicationDraftProvider.extractFromText(message);

    const draft = await aiMedicationDraftsRepository.create({
      userId,
      extractedData: result.extractedData as Prisma.InputJsonValue,
      missingFields: result.missingFields,
      status: result.status,
      source: DraftSource.TEXT,
      confidence: result.confidence,
      lastQuestion: result.nextQuestion ?? undefined,
      expiresAt: getExpiresAt(),
    });

    log.info('Medication draft created from text', {
      userId,
      draftId: draft.id,
      status: draft.status,
      missingFields: draft.missingFields,
    });

    return formatDraftResponse(draft);
  },


  async createFromAudio(userId: string, file: Express.Multer.File) {
    const transcript = await assemblyAiProvider.transcribeAudio(
      file.buffer,
      file.mimetype,
    );

    const result = await medicationDraftProvider.extractFromText(transcript);

    const draft = await aiMedicationDraftsRepository.create({
      userId,
      extractedData: result.extractedData as Prisma.InputJsonValue,
      missingFields: result.missingFields,
      status: result.status,
      source: DraftSource.AUDIO,
      confidence: result.confidence,
      transcript,
      lastQuestion: result.nextQuestion ?? undefined,
      expiresAt: getExpiresAt(),
    });

    log.info('Medication draft created from audio transcript', {
      userId,
      draftId: draft.id,
      status: draft.status,
      missingFields: draft.missingFields,
      mimeType: file.mimetype,
      size: file.size,
    });

    return formatDraftResponse(draft);
  },



  async updateFromText(userId: string, draftId: string, message: string) {
    const existing = await aiMedicationDraftsRepository.findByIdForUser(
      draftId,
      userId,
    );

    if (!existing) {
      throw AppError.notFound('Medication draft not found');
    }

    if (isExpired(existing.expiresAt)) {
      throw AppError.badRequest('This medication draft has expired. Please start again.');
    }

    if (existing.status === DraftStatus.CANCELLED) {
      throw AppError.badRequest('This medication draft has been cancelled.');
    }

    if (existing.status === DraftStatus.CONFIRMED) {
      throw AppError.badRequest('This medication draft has already been confirmed.');
    }

    if (isTerminalStatus(existing.status)) {
      throw AppError.badRequest('This medication draft can no longer be updated.');
    }

    const nextTurnCount = existing.turnCount + 1;

    if (nextTurnCount > MAX_DRAFT_TURNS) {
      const manualDraft = await aiMedicationDraftsRepository.updateAndReturn(
        draftId,
        userId,
        {
          status: DraftStatus.NEEDS_MANUAL_REVIEW,
          lastQuestion: null,
          turnCount: nextTurnCount,
        },
      );

      return formatDraftResponse(manualDraft);
    }

    const result = await medicationDraftProvider.updateFromText(
      existing.extractedData as MedicationDraftData,
      message,
    );

    const draft = await aiMedicationDraftsRepository.updateAndReturn(
      draftId,
      userId,
      {
        extractedData: result.extractedData as Prisma.InputJsonValue,
        missingFields: result.missingFields,
        status: result.status,
        confidence: result.confidence,
        lastQuestion: result.nextQuestion,
        turnCount: nextTurnCount,
      },
    );

    log.info('Medication draft updated from text', {
      userId,
      draftId,
      status: draft.status,
      missingFields: draft.missingFields,
      turnCount: draft.turnCount,
    });

    return formatDraftResponse(draft);
  },

  async getDraft(userId: string, draftId: string) {
    const draft = await aiMedicationDraftsRepository.findByIdForUser(
      draftId,
      userId,
    );

    if (!draft) {
      throw AppError.notFound('Medication draft not found');
    }

    if (isExpired(draft.expiresAt)) {
      throw AppError.badRequest('This medication draft has expired. Please start again.');
    }

    return formatDraftResponse(draft);
  },

  async cancelDraft(userId: string, draftId: string) {
    const draft = await aiMedicationDraftsRepository.findByIdForUser(
      draftId,
      userId,
    );

    if (!draft) {
      throw AppError.notFound('Medication draft not found');
    }

    if (draft.status === DraftStatus.CONFIRMED) {
      throw AppError.badRequest('This medication draft has already been confirmed.');
    }

    if (draft.status === DraftStatus.CANCELLED) {
      return formatDraftResponse(draft);
    }

    const result = await aiMedicationDraftsRepository.cancel(draftId, userId);

    if (result.count === 0) {
      throw AppError.badRequest('This medication draft cannot be cancelled.');
    }

    const cancelledDraft = await aiMedicationDraftsRepository.findByIdForUser(
      draftId,
      userId,
    );

    if (!cancelledDraft) {
      throw AppError.notFound('Medication draft not found');
    }

    return formatDraftResponse(cancelledDraft);
  },
};