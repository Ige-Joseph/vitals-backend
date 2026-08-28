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

  // Recycle the worker when it gets heavy.
  //
  // maxWorkers: 1 means every suite runs in the same process, and Jest does not
  // fully release a suite's module registry when it moves to the next one. With
  // ts-jest compiling two dozen suites that accumulates, and the run died at
  // Node's ~4 GB heap ceiling once the suite count grew — an out-of-memory
  // crash rather than a test failure, which is a confusing thing to debug.
  //
  // Restarting the worker between suites costs a little startup time and bounds
  // the growth. It does not weaken isolation: each suite already truncates
  // every table, so a fresh process is if anything cleaner.
  workerIdleMemoryLimit: '1GB',

  testTimeout: 30_000,
  clearMocks: true,
  verbose: true,
};

export default config;
