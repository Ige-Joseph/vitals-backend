import type { Config } from 'jest';

/**
 * Database-backed integration tests.
 *
 * Separate from `jest.config.ts` on purpose. The existing suites mock Prisma
 * wholesale and stay exactly as they are; these run real SQL against a
 * containerised Postgres:
 *
 *   docker compose --profile test up -d --wait postgres-test
 *   npm run test:db
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/db'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },

  // Order matters: the specific stubs must be matched before the catch-all
  // "@/" alias, or they are shadowed by it and the real modules load.
  moduleNameMapper: {
    '^@/lib/redis$': '<rootDir>/tests/db/stubs/redis.stub.ts',
    '^@/queues/queue\\.registry$': '<rootDir>/tests/db/stubs/queues.stub.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Points the connection string at the test database before anything imports
  // Prisma, and refuses to run if that database is not named *_test.
  setupFiles: ['<rootDir>/tests/db/setup/test-env.ts'],

  // Applies migrations once, before any worker starts.
  globalSetup: '<rootDir>/tests/db/setup/global-setup.ts',

  // Truncates every table between cases.
  setupFilesAfterEnv: ['<rootDir>/tests/db/setup/db-lifecycle.ts'],

  // One shared database plus TRUNCATE between tests cannot be parallelised.
  // Raising this will produce cross-test interference, not speed.
  maxWorkers: 1,

  testTimeout: 30_000,
  clearMocks: true,
  verbose: true,
};

export default config;
