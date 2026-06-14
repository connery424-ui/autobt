#!/usr/bin/env node
/**
 * Supply-chain audit gate (CI).
 *
 * Runs `npm audit --omit=dev --json` and fails the build on any HIGH or
 * CRITICAL advisory in production dependencies — EXCEPT advisories that are
 * explicitly accepted below. Any NEW high/critical advisory (i.e. one not on
 * the allowlist) still fails CI, so supply-chain protection is preserved.
 *
 * Why an allowlist instead of raw `npm audit`:
 *   The remaining accepted advisories have NO patched version available and
 *   live in core, required Solana/Raydium trading SDKs. They cannot be removed
 *   or upgraded without breaking the bot. Each is documented with a reason and
 *   should be revisited whenever a fix is published.
 */

import { execSync } from 'node:child_process';

/**
 * Accepted advisories. Key = npm advisory source id, value = human note.
 * Revisit periodically: if a fix ships, remove the entry so CI enforces it.
 */
const ALLOWLIST = new Map([
  [
    1103747,
    'GHSA-3gc7-fjrx-p6mg — bigint-buffer buffer overflow in toBigIntLE(). ' +
      'No patched version exists (vulnerable range *). Pulled transitively by ' +
      '@solana/spl-token -> @solana/buffer-layout-utils and ' +
      '@raydium-io/raydium-sdk-v2, both core to trading. Accepted until upstream ships a fix.',
  ],
]);

function runAudit() {
  try {
    const out = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found; the JSON is
    // still on stdout. Only treat it as a real failure if we can't parse.
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* fall through */
      }
    }
    console.error('audit-check: failed to run `npm audit`:', err.message);
    process.exit(2);
  }
}

const report = runAudit();
const vulns = report.vulnerabilities || {};

const blocking = [];
const accepted = [];

for (const name of Object.keys(vulns)) {
  const v = vulns[name];
  if (v.severity !== 'high' && v.severity !== 'critical') continue;

  for (const via of v.via) {
    if (typeof via !== 'object') continue; // string = "flagged because it depends on X"
    if (via.severity !== 'high' && via.severity !== 'critical') continue;

    const entry = {
      id: via.source,
      pkg: via.name,
      severity: via.severity,
      title: via.title,
      url: via.url,
    };
    if (ALLOWLIST.has(via.source)) {
      accepted.push(entry);
    } else {
      blocking.push(entry);
    }
  }
}

// De-dupe by advisory id for readable output.
const dedupe = (arr) => [...new Map(arr.map((e) => [e.id, e])).values()];
const acceptedUnique = dedupe(accepted);
const blockingUnique = dedupe(blocking);

if (acceptedUnique.length) {
  console.log(`\nAccepted (allowlisted) high/critical advisories — ${acceptedUnique.length}:`);
  for (const e of acceptedUnique) {
    console.log(`  • [${e.severity}] ${e.pkg} ${e.url} (id ${e.id})`);
  }
}

if (blockingUnique.length) {
  console.error(`\n✖ Unaccepted high/critical advisories — ${blockingUnique.length}:`);
  for (const e of blockingUnique) {
    console.error(`  • [${e.severity}] ${e.pkg}: ${e.title}`);
    console.error(`      ${e.url} (id ${e.id})`);
  }
  console.error(
    '\nFix the advisory, or — only if there is no fix and the dependency is ' +
      'required — add its id to the ALLOWLIST in scripts/audit-check.mjs with a reason.',
  );
  process.exit(1);
}

console.log('\n✓ Audit gate passed: no unaccepted high/critical advisories in production deps.');
process.exit(0);
