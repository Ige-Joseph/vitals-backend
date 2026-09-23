import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Provider identities.
 *
 * Every lookup here is by `(provider, providerAccountId)`. There is no
 * find-by-email, and that absence is deliberate: an email lookup is how a
 * federated login quietly becomes "whoever controls this address is this user",
 * which is a different and much weaker claim than the one the provider made.
 */
export const oauthRepository = {
  findByProviderAccount(
    provider: 'GOOGLE',
    providerAccountId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId },
      },
      include: { user: true },
    });
  },

  findByUser(userId: string, provider: 'GOOGLE', tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.oAuthAccount.findUnique({
      where: { userId_provider: { userId, provider } },
    });
  },

  create(
    data: {
      userId: string;
      provider: 'GOOGLE';
      providerAccountId: string;
      email?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    return client.oAuthAccount.create({ data });
  },
};
