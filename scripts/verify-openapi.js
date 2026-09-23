/* eslint-disable no-console */
/**
 * Does the spec actually resolve?
 *
 * Three questions, and swagger-jsdoc answers none of them on its own — it
 * silently drops a block whose YAML does not parse, so a spec that is missing
 * half its routes looks exactly like a spec that is fine.
 *
 *   1. Did every @swagger block parse? Counted against the source, so a block
 *      that failed to parse shows up as a missing path or operation.
 *   2. Does every route in the app appear in the spec?
 *   3. Does every $ref point at something that exists?
 *
 * Run with: node scripts/verify-openapi.js
 */
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
require('tsconfig-paths').register({
  baseUrl: './',
  paths: { '@/*': ['src/*'] },
});

const fs = require('fs');
const path = require('path');

const { swaggerSpec } = require('../src/config/swagger');

let failures = 0;
const warnings = [];

/**
 * Fails the run. Reserved for the three things that make a spec wrong rather
 * than merely thin: a route missing from the spec, a $ref pointing at nothing,
 * and a block that did not parse.
 */
const fail = (msg) => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};

/**
 * Reported, but does not fail the run.
 *
 * Completeness of an individual block — whether it states its auth requirement,
 * whether it documents its responses — is a real standard and worth surfacing,
 * but it is not the same question as "does the spec resolve". Kept separate so
 * the gate can be turned on without first fixing every pre-existing block.
 */
const warn = (msg) => warnings.push(msg);

// ── 1. Every $ref resolves ──────────────────────────────────────────────
const refs = new Set();
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') refs.add(value);
    else walk(value);
  }
})(swaggerSpec);

console.log(`\n$refs found: ${refs.size}`);
for (const ref of [...refs].sort()) {
  if (!ref.startsWith('#/')) {
    fail(`external or malformed $ref: ${ref}`);
    continue;
  }
  const target = ref
    .slice(2)
    .split('/')
    .reduce((node, seg) => (node ? node[seg] : undefined), swaggerSpec);

  if (target === undefined) fail(`broken $ref: ${ref}`);
}
if (failures === 0) console.log('  all $refs resolve');

// ── 2. Every documented operation carries the basics ─────────────────────
const paths = swaggerSpec.paths || {};
const operations = [];
for (const [p, item] of Object.entries(paths)) {
  for (const [method, op] of Object.entries(item)) {
    operations.push({ p, method, op });

    if (!op.responses || Object.keys(op.responses).length === 0) {
      warn(`${method.toUpperCase()} ${p} has no responses`);
    }
    if (!op.tags || op.tags.length === 0) {
      warn(`${method.toUpperCase()} ${p} has no tag`);
    }
    if (op.security === undefined) {
      warn(`${method.toUpperCase()} ${p} does not state its auth requirement`);
    }
    // A templated path must declare each of its parameters somewhere.
    for (const name of [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
      const declared = [...(item.parameters || []), ...(op.parameters || [])].some(
        (param) => param.name === name && param.in === 'path',
      );
      if (!declared) fail(`${method.toUpperCase()} ${p} does not document {${name}}`);
    }
  }
}
console.log(`\nOperations in spec: ${operations.length}`);

// ── 3. Every route in the source appears in the spec ─────────────────────
//
// Counted from the source rather than trusted: a block that fails to parse
// vanishes without a word, and this is what notices.
const ROUTE_DIR = path.join(__dirname, '..', 'src', 'modules');

const routeFiles = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.routes.ts')) routeFiles.push(full);
  }
})(ROUTE_DIR);

let declared = 0;
let documented = 0;
const undocumented = [];

for (const file of routeFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const handlers = [...src.matchAll(/^\s*router\.(get|post|patch|put|delete)\(/gm)];
  const blocks = [...src.matchAll(/@swagger/g)];

  declared += handlers.length;
  documented += blocks.length;

  if (blocks.length < handlers.length) {
    undocumented.push(
      `${path.relative(process.cwd(), file)}: ${handlers.length} routes, ${blocks.length} documented`,
    );
  }
}

console.log(`\nRoutes in source: ${declared}`);
console.log(`@swagger blocks:  ${documented}`);

if (undocumented.length > 0) {
  console.error('\nUndocumented routes:');
  for (const line of undocumented) fail(line);
}

// A block that parsed produces an operation. Fewer operations than blocks means
// swagger-jsdoc dropped one for bad YAML and said nothing.
if (operations.length < documented) {
  fail(
    `${documented - operations.length} @swagger block(s) did not parse into an ` +
      'operation — almost always malformed YAML, which swagger-jsdoc drops silently',
  );
}

if (warnings.length > 0) {
  console.warn(`\nIncomplete blocks — ${warnings.length} (reported, not failed):`);
  for (const line of warnings) console.warn(`  WARN  ${line}`);
}

console.log(
  failures === 0
    ? '\nOpenAPI spec verified: every route present, every block parsed, ' +
        'every $ref resolves.\n'
    : `\n${failures} problem(s) found.\n`,
);

process.exit(failures === 0 ? 0 : 1);
