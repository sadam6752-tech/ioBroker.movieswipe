# ioBroker.movieswipe

![Logo](admin/movieswipe.png)

[![NPM version](https://img.shields.io/npm/v/iobroker.movieswipe.svg)](https://www.npmjs.com/package/iobroker.movieswipe)
[![Downloads](https://img.shields.io/npm/dm/iobroker.movieswipe.svg)](https://www.npmjs.com/package/iobroker.movieswipe)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/sadam6752-tech/ioBroker.movieswipe/blob/main/LICENSE)

## MovieSwipe PWA Adapter for ioBroker

This adapter integrates the MovieSwipe Progressive Web Application (PWA) into ioBroker, providing:

- **Web Server** - Hosts the MovieSwipe PWA application
- **Database Synchronization** - Manages movie database updates from Kinopoisk API
- **Configuration** - Easy setup through ioBroker admin interface
- **Monitoring** - Real-time sync status and progress tracking

## Features

### 🎬 MovieSwipe PWA
- Swipe-based movie discovery interface
- Mood-based movie recommendations
- Advanced filtering (genres, countries, content types, ratings)
- Favorites management
- Multi-language support (Russian, English, German)
- Dark theme optimized
- Offline-capable PWA

### 🔄 Synchronization Management
- Multiple API key support with automatic rotation
- Configurable search criteria (rating, votes, year range)
- Real-time progress monitoring
- Automatic error handling and retry logic
- Manual and scheduled synchronization

### 📊 Monitoring
- Connection status
- Sync progress (0-100%)
- Total movies in database
- API requests usage
- Last sync timestamp
- Error reporting

## Installation

### From ioBroker Admin (when published)
1. Open ioBroker Admin interface
2. Go to "Adapters" tab
3. Search for "movieswipe"
4. Click "Install"

### From GitHub (development)
```bash
cd /opt/iobroker
npm install https://github.com/sadam6752-tech/ioBroker.movieswipe/tarball/main
```

### From URL
```bash
iobroker url https://github.com/sadam6752-tech/ioBroker.movieswipe
```

## Configuration

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Port** | Web server port for PWA | 3000 |
| **API Keys** | Kinopoisk API keys (one or more) | [] |
| **Min Rating** | Minimum movie rating (0-10) | 5.0 |
| **Min Votes** | Minimum number of votes | 500 |
| **Year Range** | Start and end year for movies | 2020-2026 |

### Advanced Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Auto Sync** | Enable automatic synchronization | false |
| **Sync Interval** | Hours between auto-sync | 24 |

## Usage

### Accessing the Application

After installation and configuration:

1. Start the adapter instance
2. Open the application URL (shown in `server.url` state)
3. Default: `http://YOUR_IOBROKER_IP:3000`

### Starting Synchronization

Set the `sync.start` state to `true` in the Objects tab to start synchronization.

### Updating the Application After Sync

After synchronization completes:

1. The `sync.reloadApp` state will be set to `true`
2. Open the MovieSwipe application in your browser
3. Press **F5** (or Ctrl+R) to refresh and clear the cache
4. Click "Update Catalog" button to reload movies from the database

**Important:** The application caches data in IndexedDB. You must refresh the page to see newly synchronized movies.

### Monitoring Progress

Monitor synchronization progress through the following states:
- `sync.status` - Current status (idle, running, completed, error)
- `sync.progress` - Progress percentage (0-100%)
- `sync.foundMovies` - Number of movies found in current sync
- `sync.newMovies` - Number of new movies added to database
- `sync.totalMovies` - Total movies in database
- `sync.totalMovies` - Total movies in database
- `sync.newMovies` - New movies added

## States

### info.*
| State | Type | Description |
|-------|------|-------------|
| `info.connection` | boolean | Adapter connection status |

### sync.*
| State | Type | R/W | Description |
|-------|------|-----|-------------|
| `sync.start` | boolean | R/W | Start synchronization trigger |
| `sync.stop` | boolean | R/W | Stop synchronization trigger |
| `sync.status` | string | R | Current status (idle/running/error/completed) |
| `sync.progress` | number | R | Progress percentage (0-100) |
| `sync.currentStep` | string | R | Current synchronization step |
| `sync.totalMovies` | number | R | Total movies in database |
| `sync.newMovies` | number | R | New movies added in last sync |
| `sync.requestsUsed` | number | R | API requests used |
| `sync.requestsRemaining` | number | R | API requests remaining today |
| `sync.lastSync` | string | R | Last sync timestamp (ISO 8601) |
| `sync.error` | string | R | Error message (if any) |

### server.*
| State | Type | Description |
|-------|------|-------------|
| `server.url` | string | Application URL |
| `server.port` | number | Server port |
| `server.running` | boolean | Server running status |

## API Keys

Get your Kinopoisk API key at https://api.kinopoisk.dev/ and add it to the adapter configuration.

Free tier provides 200 requests per day per key. You can add multiple keys for extended limits.

## Troubleshooting

### Web Server Not Starting
- Check if port is already in use
- Try changing port in configuration
- Check adapter logs for errors

### Synchronization Fails
- Verify API key is valid
- Check internet connection
- Review error message in `sync.error` state
- Check adapter logs

### PWA Not Loading
- Ensure web server is running (`server.running` = true)
- Check firewall settings
- Verify URL in `server.url` state

## Changelog

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

## Credits

- **MovieSwipe PWA** - Original application
- **Kinopoisk API** - Movie database provider
- **ioBroker** - Smart home platform

## Support

- **GitHub Issues**: https://github.com/sadam6752-tech/ioBroker.movieswipe/issues
- **ioBroker Forum**: https://forum.iobroker.net/

## License

MIT License

Copyright (c) 2026 sadam6752-tech

---

**Made with ❤️ for ioBroker community**
