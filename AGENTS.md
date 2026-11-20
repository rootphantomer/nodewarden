# AGENTS.md

Bitwarden-compatible password manager server on Cloudflare Workers. Single package (not a monorepo).

## Key commands

```sh
# Typecheck (two separate configs — run both for full coverage)
npx tsc -p tsconfig.json --noEmit          # backend (src/, shared/)
npx tsc -p webapp/tsconfig.json --noEmit   # webapp (webapp/src/)

# Build (Vite builds webapp to dist/, Worker reads from dist/)
npm run build

# Dev servers (must run both for full-stack local dev)
npm run dev          # Worker on :8787 (wrangler)
npm run dev:demo     # Webapp on :5174 (vite, demo mode)
# Default webapp dev is on :5173 with proxy to :8787

# i18n validation (required when touching user-facing text or locales)
npm run i18n:validate

# Tests (no unified test runner — each script is standalone)
tsx --test scripts/config-compatibility.test.ts
npm run test:web-crypto
npm run test:webauthn-connectors
```

No lint or formatter configured. No `test` or `lint` scripts in package.json.

## Architecture

- **`src/`** — Cloudflare Worker backend. Entry: `src/index.ts` → `src/router.ts` → handler files.
- **`webapp/`** — Preact SPA (Vite). Entry: `webapp/src/main.tsx`. Builds to `dist/`.
- **`shared/`** — Code shared between Worker and webapp (version, backup schema, domain normalization).
- **`migrations/`** — D1 SQLite schema. Single file `0001_init.sql`.
- **`scripts/`** — Standalone test/audit/utility scripts (not part of build).

Two `wrangler.toml` variants:
- `wrangler.toml` — R2 mode (default, requires Cloudflare card)
- `wrangler.kv.toml` — KV mode (no card needed, lower attachment limits)

## Deployment flow

`npm run build` → Vite outputs `dist/` → `wrangler deploy` uploads Worker + assets. SPA routing: Worker runs first, serves API; static assets served from `dist/` via Cloudflare Pages asset binding.

## Critical gotchas

- **Database schema changes** require updating BOTH `src/services/storage-schema.ts` (runtime) AND `migrations/0001_init.sql` (initial), plus bumping `STORAGE_SCHEMA_VERSION` in `src/services/storage.ts`.
- **Backup is whitelist-based.** New persistent data must be explicitly added to `src/services/backup-archive.ts` and `src/services/backup-import.ts`. Never export runtime lock rows or retired sensitive fields.
- **Secrets must not be stored/exported as plain config JSON.** Use the encrypted settings pattern in `src/services/backup-settings-crypto.ts`.
- **Bitwarden client compatibility:** Official clients send/expect fields the web vault may not use. Preserve unknown client fields in cipher/sync handlers unless known-invalid. Key files: `src/handlers/ciphers.ts`, `src/handlers/sync.ts`, `src/services/storage-cipher-repo.ts`.
- **Domain rules** store both UI state and derived groups. Don't remove `equivalent_domains` or `excluded_global_equivalent_domains` as "duplicates" without a migration.
- **`users.master_password_hash`** is for login verification only, not vault decryption. Keep password changes, key material, and `securityStamp` aligned.
- **i18n:** Locale files are complete standalone bundles. When adding/changing user-facing text, update ALL locales and run `npm run i18n:validate`.
- **`JWT_SECRET`** must be set (32+ chars) or the Worker rejects most requests. Required env var in Cloudflare dashboard.
- **`HIDE_WEB_VAULT=1`** env var returns 404 for frontend routes while keeping API endpoints alive.
- **Cron trigger** runs every 5 minutes (`*/5 * * * *`) for scheduled backups.
- **Service worker** is generated at build time by Vite plugin in `webapp/vite.config.ts` — do not edit `sw.js` directly.

## Git workflow

- **After a PR is merged, delete the merged branch by default** — the remote branch (`gh pr merge --delete-branch`, or `git push origin --delete <branch>`) and the local one (`git branch -d <branch>`). No need to ask first.
- Keep a branch only when work continues on it; say so before merging.

## Verification checklist (from CONTRIBUTING.md)

For backend/shared changes: typecheck both configs + build.
For webapp text/locale changes: `npm run i18n:validate` + typecheck webapp + build.
For docs-only: `git diff --check`.
