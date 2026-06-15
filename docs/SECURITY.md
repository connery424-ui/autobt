# Security

## Your keys stay local

This app runs **fully local**. Wallet private keys are generated on your machine,
encrypted with **AES-256-GCM** (PBKDF2, 100k iterations, per-wallet salt), and
stored only in a local SQLite database. Nothing — keys, seed phrases, API keys —
is uploaded to any server. The repo is the whole app; there is no backend service
collecting your data.

**Never commit your secrets.** `.env` and the SQLite database are gitignored and
have never been committed (verified). If you fork this repo, keep it that way.

## Supply-chain hardening (npm)

npm is a common attack surface (typosquatting, hijacked maintainers, malicious
postinstall scripts). This repo is configured to reduce that risk:

- **Pinned lockfile + `npm ci`.** Always install with `npm ci`, never
  `npm install`. `npm ci` installs the EXACT versions in `package-lock.json` and
  fails if `package.json` and the lockfile disagree — a tampered or version-drifted
  dependency can't slip in. The lockfile is committed.
- **`.npmrc`** sets `save-exact=true` (no `^`/`~` drift on new deps),
  `engine-strict=true` (blocks installs on an unexpected Node runtime), and
  `audit=true`.
- **CI** (`.github/workflows/ci.yml`) runs `npm ci` + `npm audit --audit-level=high`
  + signature verification on every push and PR. A new high/critical CVE in a
  production dependency fails the build.
- **Engines pinned** to Node ≥ 20, npm ≥ 10.
- Install scripts are intentionally left enabled (better-sqlite3 and sharp need
  native builds); for maximum lockdown set `ignore-scripts=true` in `.npmrc` and
  run `npm rebuild better-sqlite3 sharp`.

### Before you add or update a dependency
1. `npm ci` first (clean state).
2. Add it pinned: `npm install <pkg>` (the `.npmrc` pins exact versions).
3. Run `npm audit` and review.
4. Commit the updated `package-lock.json` in the same commit as `package.json`.

## Installer trust

Released `.exe`/`.dmg` installers are **unsigned** (no paid code-signing cert), so
Windows SmartScreen / macOS Gatekeeper will warn. The installers are built in
public by GitHub Actions from this source — you can read the workflow
(`.github/workflows/release.yml`) and build them yourself to verify.

## Reporting a vulnerability

Open a private security advisory via the repo's **Security → Advisories** tab, or
open an issue for non-sensitive reports. Do not post wallet keys or `.env`
contents in any issue.
