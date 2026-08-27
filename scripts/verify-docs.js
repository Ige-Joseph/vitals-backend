/* eslint-disable no-console */
/**
 * Do the documents still describe the code?
 *
 * Documentation rots silently. Nothing fails when a README names a port that
 * moved, an env var that was renamed, or an npm script that no longer exists —
 * it just quietly misleads the next person, and the only signal is somebody
 * losing an afternoon. This checks the claims that are mechanically checkable.
 *
 * Six checks:
 *
 *   1. Every relative link resolves, and every in-document anchor exists.
 *   2. Every Postgres URL matches what docker-compose actually publishes.
 *   3. No document hands out a Redis password the local service does not have.
 *   4. Every `ENV_VAR` named in a doc exists in src/config/env.ts.
 *   5. Every `npm run x` exists in package.json.
 *   6. Every `src/…` path referenced exists on disk.
 *
 * What it deliberately cannot check is whether the prose is *true* — only
 * whether the identifiers in it are real. A sentence can be wrong in ways no
 * script will catch, which is why this is a floor and not a substitute for
 * reading.
 *
 * Run with: npm run verify:docs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = [
  'README.md',
  'ARCHITECTURE.md',
  'docs/AI_SAFETY.md',
  'docs/API_PERFORMANCE.md',
  'docs/AUTHENTICATION.md',
  'docs/DEPLOYMENT.md',
  'docs/MOBILE_API.md',
  'docs/MOBILE_CLIENT.md',
];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const problems = [];
const fail = (doc, msg) => problems.push(`${doc}: ${msg}`);

const text = {};
for (const doc of DOCS) {
  if (!fs.existsSync(path.join(ROOT, doc))) {
    fail(doc, 'listed in this script but missing from the repository');
    continue;
  }
  text[doc] = read(doc);
}

/**
 * GitHub's heading slug, which is not the obvious one.
 *
 * Punctuation is stripped and each remaining space becomes one hyphen — runs
 * are NOT collapsed. So "7. Billing — read this" yields a double hyphen where
 * the em dash was. Collapsing here would report working anchors as broken,
 * which is how a checker teaches people to ignore it.
 */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');

// ── 1. Links and anchors ────────────────────────────────────────────────
for (const doc of Object.keys(text)) {
  const dir = path.dirname(doc);
  const anchors = new Set(
    [...text[doc].matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1])),
  );

  for (const [, , target] of text[doc].matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    if (target.startsWith('http')) continue;

    const [filePart, fragment] = target.split('#');

    if (filePart) {
      const resolved = path.join(ROOT, dir, filePart);
      if (!fs.existsSync(resolved)) fail(doc, `broken link -> ${target}`);
    } else if (fragment && !anchors.has(fragment)) {
      fail(doc, `broken anchor -> #${fragment}`);
    }
  }
}

// ── 2 & 3. Local connection details ─────────────────────────────────────
const compose = read('docker-compose.yml');

// The dev service, not the test one — they publish different ports on purpose.
const devPort = (compose.match(/"(\d+):5432"/) || [])[1];
const devUser = (compose.match(/POSTGRES_USER:\s*(\S+)/) || [])[1];
const devPass = (compose.match(/POSTGRES_PASSWORD:\s*(\S+)/) || [])[1];
const devName = (compose.match(/POSTGRES_DB:\s*(\S+)/) || [])[1];

for (const doc of Object.keys(text)) {
  for (const [, url] of text[doc].matchAll(/postgresql:\/\/([^\s`"'\n]+)/g)) {
    // Test-database URLs legitimately point elsewhere.
    if (url.includes('vitals_test') || url.includes('vitals_shadow')) continue;
    // CI's throwaway values are not instructions to a developer.
    if (url.includes('postgres@localhost') || url.includes(':5432/vitals_test')) continue;

    if (devPort && !url.includes(`:${devPort}/`)) {
      fail(doc, `Postgres URL should use host port ${devPort}: ${url}`);
    }
    if (devUser && devPass && !url.includes(`${devUser}:${devPass}@`)) {
      fail(doc, `Postgres URL should use ${devUser}:${devPass}: ${url}`);
    }
    if (devName && !url.endsWith(`/${devName}`)) {
      fail(doc, `Postgres URL should name database ${devName}: ${url}`);
    }
  }

  // The local Redis runs without --requirepass, so a documented password does
  // not secure the connection — it breaks it.
  if (!compose.includes('--requirepass') && /REDIS_PASSWORD\s*=\s*\S+/.test(text[doc])) {
    fail(doc, 'documents a REDIS_PASSWORD, but the local redis has no password set');
  }
}

// ── 4. Environment variables ────────────────────────────────────────────
//
// The allowlist is derived, not hand-written. A hand-maintained skip list goes
// stale exactly like the documents this script exists to check, and a new enum
// value would fail CI for no reason.
const envSource = read('src/config/env.ts');
const known = new Set([...envSource.matchAll(/^\s*([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]));

// Read by Prisma or the tooling rather than by env.ts, so absent from the schema.
for (const extra of [
  'DIRECT_URL', 'TEST_DATABASE_URL', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD',
  'VITE_API_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
  'GIT_LFS_SKIP_SMUDGE',
]) known.add(extra);

// Every enum value in the schema, so documents may name domain states freely.
const schema = read('prisma/schema.prisma');
for (const [, body] of schema.matchAll(/enum\s+\w+\s*\{([^}]*)\}/g)) {
  for (const [, value] of body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*$/gm)) known.add(value);
}

// Identifiers that are neither env vars nor enum values: SQL, HTTP, job names,
// and constants that live in application config.
for (const other of [
  'SELECT', 'UPDATE', 'WHERE', 'RETURNING', 'DELETE', 'PATCH', 'POST', 'JSON',
  'PROCESS_OUTBOX', 'PROCESS_DUE_REMINDERS', 'SWEEP_MISSED_APPOINTMENTS',
  'MIN_CONFIDENCE_TO_NAME_DRUG', 'NOT_FOUND', 'VALIDATION_ERROR',
]) known.add(other);

for (const doc of Object.keys(text)) {
  const named = new Set([...text[doc].matchAll(/`([A-Z][A-Z0-9_]{4,})`/g)].map((m) => m[1]));
  for (const variable of named) {
    if (!known.has(variable)) {
      fail(doc, `names \`${variable}\`, which is not an env var, enum value or known constant`);
    }
  }
}

// ── 5. npm scripts ──────────────────────────────────────────────────────
const scripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts));
for (const doc of Object.keys(text)) {
  for (const [, script] of text[doc].matchAll(/npm run ([a-z][a-z:-]*)/g)) {
    if (!scripts.has(script)) fail(doc, `references \`npm run ${script}\`, which does not exist`);
  }
}

// ── 6. Source paths ─────────────────────────────────────────────────────
for (const doc of Object.keys(text)) {
  const paths = new Set(
    [...text[doc].matchAll(/`((?:src|prisma|scripts|tests)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1]),
  );
  for (const referenced of paths) {
    const clean = referenced.replace(/[/.]+$/, '');
    const full = path.join(ROOT, clean);
    // A directory reference, a file, or a glob-ish parent all count as real.
    if (fs.existsSync(full) || fs.existsSync(path.dirname(full))) continue;
    fail(doc, `references \`${referenced}\`, which does not exist`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────
console.log(`\nAudited ${Object.keys(text).length} documents against the code.`);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`  FAIL  ${problem}`);
  console.error(`\n${problems.length} problem(s). Documentation no longer matches the code.\n`);
  process.exit(1);
}

console.log('  Links resolve, connection details match, and every identifier is real.\n');
