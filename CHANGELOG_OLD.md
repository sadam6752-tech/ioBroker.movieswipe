# Older Changelog

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
