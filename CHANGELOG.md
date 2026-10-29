# Changelog

All notable changes to this project are documented here. Version numbers follow
[Semantic Versioning](https://semver.org/) and match `package.json`.

## v0.26.7 — security hardening, webmail trust, CI fallback

### Security & correctness (from #76)

- Telemetry list scoped to authenticated owners; public POST rate-limited with body cap.
- App passwords cannot create/revoke sessions or use session exchange endpoints.
- Basic-auth brute-force throttling per IP; capability URLs redacted in logs.
- Secret-box decrypt pins IV/tag lengths; public ICS feed uses property allow-list.
- Webmail: trusted-sender and AI consent paths tightened; install path guard in quickstart.
- Many backend/webmail fixes with expanded unit coverage (911 server tests, 127 webmail unit tests).

### CI (#75)

- **`resolve-runner`** prefers online self-hosted runners (alexpc/matthewpc) when listable, else **ubuntu-latest** so jobs do not queue forever.
- Fork PRs skip self-hosted test jobs on this public repo.

## v0.26.6 — mailcow DB hardening, CI, and webhook staging fix

### Fixed

- **Webhook staging downloads** no longer call `decodeURIComponent` on route params
  that Fastify already decoded; addresses containing a bare `%` no longer 500.
- **mailcow DB** skips pool creation when the configured password is whitespace-only.
- **`getMailbox`** uses a `LEFT JOIN` on `quota2` so mailboxes without a quota row
  still resolve instead of returning a false 404.
- **`createTempAlias`** retries on `ER_DUP_ENTRY` when the random local part collides.
- **`getLogins`** clamps the SQL `LIMIT` to 1–100 even when callers pass garbage.
- **Boolean env vars** (`WEBMAIL_ENABLED`, rate limits, feature flags) treat empty
  strings like unset values, consistent with numeric env parsing.

### Changed

- Shared **`isValidEmail`** helper under `src/utils/email.js` (used by mailcow DB and Sieve).
- Startup log says **mailcow DB enabled** rather than implying a live connection was verified.

### Testing & CI

- New unit coverage for **mailcow-db**, **config bool** parsing, **email** validation, and
  webhook-staging param handling.
- Webmail unit tests run in CI again; **`esbuild`** is a declared devDependency for tests that
  transpile Svelte rune modules.

## v0.26.5

See [GitHub release v0.26.5](https://github.com/jr551/mailcow-rest-api/releases/tag/v0.26.5).
