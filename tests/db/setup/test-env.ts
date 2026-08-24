/**
 * Runs as a Jest `setupFiles` entry — before the test framework installs and
 * before any module under test is imported.
 *
 * That ordering is what makes this work. `src/config/env.ts` calls
 * `dotenv.config()` at import time, and dotenv does not overwrite variables
 * that are already present in `process.env`. Setting the connection string
 * here therefore wins over `.env`, and Prisma reads it when the client is
 * constructed.
 */

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:local@localhost:5436/vitals_test';

const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

let databaseName: string;
try {
  databaseName = new URL(url).pathname.replace(/^\//, '');
} catch {
  throw new Error(`TEST_DATABASE_URL is not a valid connection string: ${url}`);
}

/**
 * The suite truncates every table between tests. Pointed at the wrong database
 * that is unrecoverable data loss, and the dev database is one digit away
 * (5433/vitals vs 5436/vitals_test). Refuse anything that is not explicitly a
 * test database rather than trusting the caller to have set it correctly.
 */
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run database tests against "${databaseName}": the name must ` +
      `end in "_test". These tests TRUNCATE every table between cases. ` +
      `Set TEST_DATABASE_URL to a dedicated test database.`,
  );
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
