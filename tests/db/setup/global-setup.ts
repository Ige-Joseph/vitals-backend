import { execSync } from 'node:child_process';

/**
 * Jest `globalSetup` — runs once, before any worker starts.
 *
 * Applies the committed migrations to the test database with
 * `migrate deploy` rather than `migrate dev`: deploy never generates a new
 * migration and never prompts, so a schema drift shows up as a failure here
 * instead of silently rewriting `prisma/migrations` during a test run.
 */
export default async function globalSetup(): Promise<void> {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:local@localhost:5436/vitals_test';

  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to migrate "${databaseName}": test database names must end in "_test".`,
    );
  }

  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    });
  } catch (err: any) {
    const detail = [err?.stdout?.toString(), err?.stderr?.toString()]
      .filter(Boolean)
      .join('\n')
      .trim();

    throw new Error(
      'Could not apply migrations to the test database.\n\n' +
        'Is it running?  docker compose --profile test up -d --wait postgres-test\n\n' +
        detail,
    );
  }
}
