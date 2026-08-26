import { prisma } from '@/lib/prisma';
import { providerRegistry } from '@/modules/billing/provider/provider.registry';

/**
 * Jest `setupFilesAfterEnv` — per-test isolation.
 *
 * Isolation is by truncation, not by transactional rollback. Rollback would be
 * the faster and stricter option, but it needs the code under test to run
 * inside a transaction the harness controls, and `@/lib/prisma` exports a
 * module-level singleton with no seam to inject one. Application code also
 * opens its own `prisma.$transaction` blocks, which would then be nested.
 * Giving the client an injection point is an application change, and this is
 * infrastructure work — so: truncate.
 *
 * Consequence: the suite runs single-worker (see `jest.db.config.ts`). One
 * shared database plus TRUNCATE between cases cannot be parallelised.
 */

let tableNames: string[] | null = null;

async function getTableNames(): Promise<string[]> {
  if (tableNames) return tableNames;

  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> '_prisma_migrations'
  `;

  tableNames = rows.map((r) => r.tablename);

  if (tableNames.length === 0) {
    throw new Error(
      'No tables found in the test database. Did globalSetup migrations run?',
    );
  }

  return tableNames;
}

/**
 * One statement for every table: CASCADE settles foreign keys regardless of
 * insertion order, and RESTART IDENTITY resets sequences so tests cannot come
 * to depend on ids left behind by an earlier case.
 */
export async function truncateAll(): Promise<void> {
  const tables = await getTableNames();
  const list = tables.map((t) => `"public"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await truncateAll();
});

/**
 * Undo the other kind of state a test can leave behind.
 *
 * Truncation only reaches the database. The payment provider registry is a
 * module-level map, so an adapter registered by one test survives into the
 * next one — still registered, pointing at a stub server that has since been
 * closed. Clearing it here keeps "no provider is configured" the honest
 * starting point it is in a fresh process.
 *
 * Defined after the truncating hook and so, being an `afterEach`, running
 * after a suite's own — a test closing its stub still gets to do that first.
 */
afterEach(() => {
  providerRegistry.reset();
});

afterAll(async () => {
  await prisma.$disconnect();
});
