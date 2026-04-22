import { PrismaClient } from '@prisma/client';

/**
 * Type for the Prisma interactive transaction client.
 * Derived directly from $transaction — no runtime import needed.
 * Works correctly with Prisma 6.
 */
export type PrismaTx = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];
