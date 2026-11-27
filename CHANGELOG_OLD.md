# Older Changelog

### 1.1.5
- (sadam6752-tech) New adapter logo (`admin/movieswipe.png` and `admin/movieswipe.svg`)

### 1.1.4
- (sadam6752-tech) The movie database is no longer kept inside the adapter package: the working copy lives in the instance data directory (`iobroker-data/movieswipe.N/`) and a durable copy in the ioBroker file storage (`movieswipe.N.storage`, type `meta.user`, so it is part of ioBroker backups). Updates no longer touch it
- (sadam6752-tech) Sync progress and API key cooldowns moved to the instance data directory as well (progress was lost on every adapter update); an existing backup and progress file are migrated on the first start, the packaged database is only used for a fresh installation
- (sadam6752-tech) The app is served with the database from the instance data directory (`/data/movies-poiskkino.json`); the Backup Manager reads and writes the same file and refreshes the stored copy after an upload
- (sadam6752-tech) Add `common.localLinks`: the instance row in the admin now has a link that opens the app
- (sadam6752-tech) Add unit tests for the database store

### 1.1.3
- (sadam6752-tech) Security: new optional "Backup access token" (`dbToken`); when set, `/api/db/download`, `/api/db/upload` and `/api/db/info` require the `X-Db-Token` header (the Backup Manager page has a token field). Without a token the endpoints stay open and a warning is logged
- (sadam6752-tech) Security: API keys are passed to the sync process via the `MOVIESWIPE_API_KEY` environment variable instead of the command line; `apiKeys` and `dbToken` are listed in `protectedNative`
- (sadam6752-tech) Database, sync progress and backups are written atomically (temp file + rename); the sync script no longer overwrites a corrupt database with only the newly fetched movies
- (sadam6752-tech) Backup restore only uses a valid backup, also replaces a corrupt database, and an uploaded database now updates the backup immediately (it was reverted by a larger old backup on the next start)
- (sadam6752-tech) Upload validates that every movie has an `id`; `/api/db/info` caches the movie count and no longer blocks the event loop
- (sadam6752-tech) Stopping a sync now waits for the process and really escalates to SIGKILL (the old check never fired); a stop also prevents switching to the next API key
- (sadam6752-tech) Switching to the next API key no longer risks an unhandled error; API key cooldowns survive adapter restarts
- (sadam6752-tech) Scheduled sync validates `HH:MM` (falls back to 03:00) and cannot fire twice in the same minute
- (sadam6752-tech) Security: for new instances the web server binds to the LAN IP by default (empty `bind`) instead of all interfaces; an unresolvable interface name no longer falls back to `0.0.0.0`. Existing instances keep their saved bind address - choose the LAN IP in the settings to apply it
- (sadam6752-tech) Add unit tests, remove unused code

### 1.1.2
- (sadam6752-tech) io-package.json (checker W1134): the `sync.stop` button is now write-only (`read: false`), like `sync.start` and `sync.reloadApp` - 1.1.1 only converted `sync.start`
- (sadam6752-tech) README: the state table marks `sync.start` and `sync.stop` as write-only buttons
- (sadam6752-tech) Trim `common.news` back to 7 entries (1.0.55 is dropped there and stays documented in this changelog)

### 1.1.1
- (sadam6752-tech) Code quality (checker E5004/E5005): the auto sync timers now use the adapter API (`adapter.setTimeout` / `adapter.setInterval`) so they are cleared automatically when the adapter is unloaded
- (sadam6752-tech) Code quality (checker E5043): built-in modules are imported with the `node:` prefix
- (sadam6752-tech) Code quality (checker E5049): removed the `process.env` usage when starting the sync script - compatible with compact mode again
- (sadam6752-tech) Repository (checker E0075): `eslint.config.js` replaced by `eslint.config.mjs`
- (sadam6752-tech) Repository (checker E5030): fixed `.releaseconfig.json` (`plugins` must be an array)
- (sadam6752-tech) Repository (checker E0036): updated the `@alcalzone/release-script` plugins to 5.2.x
- (sadam6752-tech) io-package.json (checker E1056/W1134): admin dependency `>=7.6.20`, button states are write-only (`read: false`)

### 1.1.0
- (sadam6752-tech) Maintenance release - no functional changes to the adapter
- (sadam6752-tech) CI: Node.js 26 added to the test matrix
- (sadam6752-tech) CI: restore the deploy job - releases are published automatically using npm "Trusted Publishing" (OIDC) including a provenance attestation
- (sadam6752-tech) README.md: complete MIT license text with contact address; "License" section moved to the end of the file
- (sadam6752-tech) LICENSE: add the contact address to the copyright line
- (sadam6752-tech) Update `@iobroker/testing` to 6.2.x
- (sadam6752-tech) Move older changelog entries to CHANGELOG_OLD.md

### 1.0.59
- (sadam6752-tech) Add navigation between app settings and the database backup manager: a "Open backup manager" link in the Settings tab, and a "Back to Settings" link on the backup page

### 1.0.58
- (sadam6752-tech) Add `@tsconfig/node22` and `tsconfig.json` with `extends` (checker rules S0085/S0088), matching the other adapters
- (sadam6752-tech) Add `prettier.config.mjs` required by `@iobroker/eslint-config`


> Versions 1.0.52, 1.0.53 and 1.0.54 were tagged but never published to npm — their deploy
> runs failed before Trusted Publishing was configured. The changes they describe are
> contained in 1.0.55, so they are listed below for history but are absent from `common.news`.

### 1.0.57
- (sadam6752-tech) Update `multer` to 2.x
- (sadam6752-tech) Remove the Content Filters section from the Synchronization tab: `Maximum Rating` was never read by any code, and minimum rating / minimum votes are already configured per API key
- (sadam6752-tech) Per-key filter fallbacks no longer use `||`, so a deliberate `0` in a key row is respected instead of being replaced by the default
- (sadam6752-tech) `Year To` in the API keys table no longer defaults to a hardcoded 2026; leave it empty and the current year is used
- (sadam6752-tech) Align request-limit fallbacks with the UI defaults (`dailyRequestLimit` fell back to 250 while the field default was 200)
- (sadam6752-tech) Migrate `admin/i18n` to the short format (`{lang}.json`, checker rule S5601) and extend from 3 to 11 languages
- (sadam6752-tech) Add the 8 admin strings that were never translated, including the whole Status tab; drop 3 orphaned keys
- (sadam6752-tech) Add missing Ukrainian entries to `common.titleLang` and `common.desc`
- (sadam6752-tech) Remove news entries for 1.0.52, 1.0.53, 1.0.54 and 1.0.56, which never reached npm (checker rule E2004)

### 1.0.56
- (sadam6752-tech) Update `multer` to 2.x
- (sadam6752-tech) Remove the Content Filters section from the Synchronization tab: `Maximum Rating` was never read by any code, and minimum rating / minimum votes are already configured per API key
- (sadam6752-tech) Per-key filter fallbacks no longer use `||`, so a deliberate `0` in a key row is respected instead of being replaced by the default

### 1.0.55
- (sadam6752-tech) Fix invalid dependabot schedule: with `interval: cron` the expression key is `cronjob`, not `cron`. Switched to `interval: weekly` to match the other adapters

### 1.0.54
- (sadam6752-tech) Add dependabot cooldown of 7 days (checker rule E8915) and a weekly cron schedule
- (sadam6752-tech) Ignore major `@types/node` bumps — the type definitions must stay within the Node major line the adapter runs on
- (sadam6752-tech) Add `.github/auto-merge.yml` (checker rule S8914)
- (sadam6752-tech) Restrict dependabot auto-merge: dev dependencies up to minor, runtime dependencies to patch only. The action defaults to merging everything including majors

### 1.0.53
- (sadam6752-tech) CI: bump `ioBroker/testing-action-check` to v2 (`testing-action-adapter` and `testing-action-deploy` have no v2 yet)
- (sadam6752-tech) CI: Node.js 24 for the check and deploy jobs; test matrix reduced to 22.x / 24.x (Node 20 is end-of-life)
- (sadam6752-tech) Require Node.js `>=22`, matching the other adapters

### 1.0.52
- (sadam6752-tech) Fix CI: commit `package-lock.json` — `npm ci` cannot run without it
- (sadam6752-tech) Upgrade to Express 5; SPA fallback route adapted to path-to-regexp v8 (`'*'` -> `'/{*splat}'`)
- (sadam6752-tech) Update `@iobroker/adapter-core` to `^3.4.3`, `@iobroker/eslint-config` to `^2.3.4`
- (sadam6752-tech) Remove redundant `eslint` / `mocha` devDependencies (provided by `@iobroker/eslint-config` and `@iobroker/testing`)
- (sadam6752-tech) Fix broken `npm test` script (`test:js` failed with "No test files found")
- (sadam6752-tech) Trim `common.news` to 7 entries; fill missing changelog entries

### 1.0.51
- (sadam6752-tech) Replace `timePicker` with a text field for the sync time (`timePicker` rejects `default`/`help` in the jsonConfig schema)

Older changelog entries can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

### 1.0.50
- (sadam6752-tech) Fix scheduled auto sync: per-key parameters (year range, min votes, min rating) are now passed correctly instead of falling back to the global content filters

### 1.0.49
- (sadam6752-tech) Add scheduled auto sync: run daily at a fixed time (HH:MM) instead of every N hours
- (sadam6752-tech) Remove redundant global year range fields — the year range is configured per API key

### 1.0.48
- (sadam6752-tech) Per-key request tracking: each API key keeps its own daily request counter, keyed by hash

### 1.0.47
- (sadam6752-tech) Fix `sync.totalMovies`: always report the real database count instead of the per-key counter
- (sadam6752-tech) Fix `sync.requestsUsed` / `sync.requestsRemaining` parsing from the sync script output

### 1.0.46
- (sadam6752-tech) Fix year range expansion: stop at the assigned range end and switch to the next key instead of expanding backwards

### 1.0.45
- (sadam6752-tech) Per-key year range and filters: each API key can define its own year range, min votes and min rating

### 1.0.44 (2026-03-30)
- (sadam6752-tech) Add CI/CD workflow, dependabot, release-script
- (sadam6752-tech) Use node: prefix for built-in modules (path, fs, os)
- (sadam6752-tech) Fix unload: null references after cleanup
- (sadam6752-tech) Fix lint warnings in web-server.js and main.js

### 1.0.43 (2026-03-19)
- Add EU server mirror option (eu-api.poiskkino.dev) for users in Europe where main API is not accessible

### 1.0.42 (2026-03-18)
- Replace log.info with log.debug for startup/shutdown details (adapter starting, ready, cleanup, database info)

### 1.0.0 (2026-03-11)
- First stable release
- Web server for PWA hosting
- Synchronization management with Kinopoisk API
- Multi-language support (DE, EN, RU, FR, IT, ES, PL, PT, NL, ZH-CN)
- Real-time progress monitoring
- Multiple API key support with rotation
- Configurable filters (rating, votes, year range)

### 0.1.0 (2026-03-09)
- Initial development release
