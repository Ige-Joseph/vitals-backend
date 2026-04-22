import { OutboxEventType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface CreateOutboxEventInput {
  userId?: string;
  type: OutboxEventType;
  payload: Prisma.InputJsonValue;
}

export const outboxRepository = {
  create(input: CreateOutboxEventInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.outboxEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: input.payload,
        status: 'PENDING',
      },
    });
  },

  findPending(limit = 50) {
    return prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  markProcessing(id: string) {
    return prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSING', lastAttemptAt: new Date() },
    });
  },

  markProcessed(id: string) {
    return prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  },

  markFailed(id: string, errorMessage: string) {
    return prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorMessage,
        lastAttemptAt: new Date(),
        retryCount: { increment: 1 },
      },
    });
  },

  resetStuck(olderThanMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - olderThanMs);
    return prisma.outboxEvent.updateMany({
      where: {
        status: 'PROCESSING',
        lastAttemptAt: { lt: cutoff },
      },
      data: { status: 'PENDING' },
    });
  },
};