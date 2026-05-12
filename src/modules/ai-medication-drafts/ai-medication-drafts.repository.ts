import { DraftSource, DraftStatus, Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

export interface CreateMedicationDraftData {
  userId: string;
  extractedData: Prisma.InputJsonValue;
  missingFields: string[];
  status: DraftStatus;
  source: DraftSource;
  confidence?: number;
  transcript?: string;
  lastQuestion?: string;
  expiresAt: Date;
}

export interface UpdateMedicationDraftData {
  extractedData?: Prisma.InputJsonValue;
  missingFields?: string[];
  status?: DraftStatus;
  confidence?: number | null;
  transcript?: string | null;
  lastQuestion?: string | null;
  turnCount?: number;
}

export const aiMedicationDraftsRepository = {
  create(data: CreateMedicationDraftData) {
    return prisma.medicationDraft.create({ data });
  },

  findByIdForUser(id: string, userId: string) {
    return prisma.medicationDraft.findFirst({
      where: { id, userId },
    });
  },

  update(id: string, userId: string, data: UpdateMedicationDraftData) {
    return prisma.medicationDraft.updateMany({
      where: { id, userId },
      data,
    });
  },

  async updateAndReturn(id: string, userId: string, data: UpdateMedicationDraftData) {
    await prisma.medicationDraft.updateMany({
      where: { id, userId },
      data,
    });

    return prisma.medicationDraft.findFirstOrThrow({
      where: { id, userId },
    });
  },

  cancel(id: string, userId: string) {
    return prisma.medicationDraft.updateMany({
      where: {
        id,
        userId,
        status: {
          in: [
            DraftStatus.IN_PROGRESS,
            DraftStatus.READY_FOR_REVIEW,
            DraftStatus.NEEDS_MANUAL_REVIEW,
          ],
        },
      },
      data: {
        status: DraftStatus.CANCELLED,
        lastQuestion: null,
      },
    });
  },
};