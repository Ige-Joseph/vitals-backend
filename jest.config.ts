import type { Config } from 'jest';

/**
 * Whether this is an automated run rather than a developer's machine.
 *
 * `--ci` is what the workflow passes; the `CI` variable is what almost every
 * runner sets on its own. Either is enough, and an explicitly falsy `CI` is
 * respected so that unsetting it locally does what it looks like it does.
 */
const ciEnv = process.env.CI;
const isCI =
  process.argv.includes('--ci') ||
  (ciEnv !== undefined && ciEnv !== '' && ciEnv !== 'false' && ciEnv !== '0');

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // tests/db needs a live Postgres and has its own config (jest.db.config.ts).
  // Excluded here so `npm test` stays runnable with no containers.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/db/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  moduleDirectories: ['node_modules', 'src'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  verbose: true,
  forceExit: true,
  clearMocks: true,

  // Jest's default is one worker per core, and each one compiles the whole
  // module graph through ts-jest. On a developer machine that is enough to
  // exhaust memory before it is enough to be fast — these suites mock Prisma
  // and do no I/O, so they gain very little from the extra workers anyway.
  //
  // Not applied in CI. The runner is sized for the job and the workflow
  // already passes its own --maxWorkers; a laptop's ceiling should not become
  // a permanent property of the suite.
  ...(isCI ? {} : { maxWorkers: 2 }),
};

export default config;
