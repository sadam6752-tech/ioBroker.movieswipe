# ioBroker.movieswipe

![Logo](admin/movieswipe.png)

![Stable](https://iobroker.live/badges/movieswipe-stable.svg)
[![NPM version](https://img.shields.io/npm/v/iobroker.movieswipe.svg)](https://www.npmjs.com/package/iobroker.movieswipe)
[![Downloads](https://img.shields.io/npm/dm/iobroker.movieswipe.svg)](https://www.npmjs.com/package/iobroker.movieswipe)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.movieswipe.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.movieswipe.png?downloads=true)](https://nodei.co/npm/iobroker.movieswipe/)

[![Test and Release](https://github.com/sadam6752-tech/ioBroker.movieswipe/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/sadam6752-tech/ioBroker.movieswipe/actions/workflows/test-and-release.yml)
![Number of Installations](https://iobroker.live/badges/movieswipe-installed.svg)

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

1. Open the ioBroker Admin interface
2. Go to the "Adapters" tab
3. Search for "movieswipe"
4. Click "Install"

> The adapter is not part of the official ioBroker repository yet, so it may not show up in the
> adapter search. In that case install it by name from the ioBroker console with
> `iobroker install iobroker.movieswipe`.

## Configuration

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Bind IP address** | Interface/IP the web server listens on. Empty = first LAN IPv4 address, `0.0.0.0` = all interfaces | empty (LAN IP) |
| **Port** | Web server port for PWA | 3000 |
| **Backup access token** | Optional token required by `/backup.html` and `/api/db/*` (download/upload of the database). Empty = unprotected, so set it if the server is reachable from untrusted networks | empty |
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

## AI agents

The adapter answers `help` (`common.supportedMessages.help`), so an AI agent such as
[ioBroker.pi-agent](https://github.com/sadam6752-tech/ioBroker.pi-agent) finds its commands and can recommend what to
watch from the movie database. All commands are sent with `sendTo("movieswipe.0", command, {...})`:

| Command | Changes | What it does |
|---------|---------|--------------|
| `help` | no | Description for the agent and the list of commands |
| `suggest` | history | Random well rated titles of a type (`movie`, `series`, `cartoon`, `anime`, `any`) with optional genres, moods, rating, duration, years and country; leaves out what was watched, skipped or suggested in the last 30 days and logs the result as suggested. Each title has its poster URL, which the agent can send to Telegram as a photo (`type: "photo"`). Without a type it asks the agent to ask the user first |
| `search` | no | Search by words of the title, director or actors and by the same filters, sorted by rating, year or relevance |
| `getMovie` | no | Full card of a title (description, cast, poster) |
| `markMovie` | history | Mark a title as `watched` or `skipped` (never suggested again), or `clear` the mark |
| `history` | no | What was suggested, watched or skipped in a period (`days`, or `from` / `to`) |
| `genres` | no | Genre and mood keys of the database |
| `openInLampa` | TV screen | Opens the card of a title in the Lampa app on a TV or player (see below); `device` names the device when several are online |
| `lampaDevices` | no | Lampa devices that are online now |
| `addBookmark` | Lampa bookmarks | Adds a title (`id` from suggest/search, or a title in words) to a Lampa list (`list`: `book` default, `like`, `wath` = later, or a mark `look`, `viewed`, `scheduled`, `continued`, `thrown`) on all devices; needs the [Lampa sync](#lampa-sync) with bookmarks |
| `removeBookmark` | Lampa bookmarks | Removes a title from one list, or from all lists but the history |
| `bookmarks` | no | The titles in the Lampa lists, newest first |
| `markWatched` | Lampa bookmarks, history | Sets the Lampa mark `viewed` on all devices and marks the title watched in MovieSwipe |

The history is shared by the household. It lives in the instance data directory and in the ioBroker file storage
(`movieswipe.N.storage/agent-history.json`), so it is part of ioBroker backups. Swipes in the app itself stay in the
browser and are not part of it.

The search runs in a worker thread that loads the database on the first request and ends after ten minutes without
requests, so the adapter does not keep the large database in memory. The first answer after a pause takes a few
seconds.

### Lampa on the TV

The agent can open the card of a suggested title in [Lampa](https://github.com/yumata/lampa-source) on an Android TV,
a Dune HD player or any other device that runs it, so the user only has to press play. No Lampac server is needed:

1. In Lampa open **Settings → Extensions → Add plugin** and enter `http://<ioBroker address>:<port>/lampa.js` (the
   address of the MovieSwipe web server, see `server.url`).
2. Restart Lampa. Under **Settings → MovieSwipe** give the device a name, for example `Living room TV` or `Dune`.
3. Ask the agent for a movie and say "open it in Lampa".

The plugin keeps a request to the adapter open and receives the command at once. Lampa finds the title on TMDB by
its original title and year (MovieSwipe uses Kinopoisk ids) and opens its card; without an exact match it shows its
search for the title. The device must have Lampa open: a TV in standby or Lampa in the background does not answer.

### Lampa sync

The same plugin keeps the Lampa data of all devices of the household the same, without a CUB account: watch progress
(time codes), bookmarks with history and marks, the "watched" marks of online sources and torrents, and the search
history. The copy lives in the file storage of ioBroker (`movieswipe.0.storage/lampa-sync.json`, next to the agent history), so backups take it along.

1. In the adapter settings, tab **Lampa sync**: switch it on, set a **sync key** (one for all devices), choose what is
   synced and save.
2. On each device add the plugin as `http://<ioBroker address>:<port>/lampa.js?key=<sync key>`, or keep the plugin
   address you already have and enter the key under **Settings → MovieSwipe → Sync key**.
3. Under **Settings → MovieSwipe** each device can choose per group: send and receive, only send, only receive, or
   off. For example a children's TV that receives bookmarks but keeps its search history to itself.

A device sends what changed a few seconds after the change and gets the changes of the other devices at once while
Lampa is open (through the request the plugin keeps open), otherwise when Lampa starts and every ten minutes.

How changes are merged:

- **Time codes:** per file the newer time code wins (Lampa stamps each one with the time of the change).
- **Bookmarks, watched marks, search history:** additions and removals are passed on; when two devices changed the same
  entry, the later change wins. Changes made while a device was offline are sent when it is back, so two devices that
  changed different things offline both keep their changes.
- **A new device** merges its data with the copy: nothing is lost, but an entry another device has removed before stays
  removed.
- Removals are remembered for 180 days; a device that stays offline longer may bring an old entry back.

The tab **Lampa sync** shows the devices with their last sync and their settings. **Reset sync copy** starts over:
with a device chosen, its data replaces the copy and then the data of the other devices (they keep their data until
that device has synced); with **All devices** the copy is built again from the data of every device. The state
`lampa.syncReset` does the same (write the device name or `all`).

**Bookmarks from the AI agent.** `addBookmark` writes into the same copy, so the bookmark shows on every device. The
copy only knows the Lampa cards (TMDB) of titles some device has bookmarked before; for a new title a device with
Lampa open looks it up on TMDB, the way `openInLampa` does, and the agent gets the answer within a few seconds. When
no Lampa is open, the bookmark waits (answer `queued`, `bookmarks` lists it as `pending`) and is added when a device
opens Lampa.

When a device is signed in to CUB, Lampa syncs its bookmarks and time codes through CUB; the plugin then leaves these
two groups alone on that device and syncs only the rest. The settings of Lampa are not synced.

**Plugins** (off by default, switch on "Plugins" in the tab): a plugin added on one device is offered to the others.

- It arrives **switched off**. When Lampa is open (and no video plays), the device asks "Новый плагин от <device>: …
  — включить?"; **Включить** switches it on and loads it at once, **Не сейчас** leaves it off (it can be switched on
  later under Settings → Extensions).
- Only additions travel: a plugin removed or switched off on one device stays as it is on the others, and the sync never
  changes the status of a plugin a device already has.
- Plugins Lampa refuses (its built-in list and `plugins_blacklist` of CUB) are neither sent nor taken.
- The MovieSwipe plugin itself is never synced, and a `key` parameter is removed from every address, so no key travels
  to other devices.
- The tab lists the plugins of the copy and the device each came from. **Remove from the copy** stops offering one to
  other devices; devices that have it keep it.

## States

### info.*
| State | Type | Description |
|-------|------|-------------|
| `info.connection` | boolean | Adapter connection status |

### sync.*
| State | Type | R/W | Description |
|-------|------|-----|-------------|
| `sync.start` | boolean | W | Start synchronization trigger (write-only button) |
| `sync.stop` | boolean | W | Stop synchronization trigger (write-only button) |
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

### lampa.*
| State | Type | R/W | Description |
|-------|------|-----|-------------|
| `lampa.syncDevices` | string | R | Devices of the Lampa sync with last sync and settings (JSON) |
| `lampa.syncLastChange` | string | R | Time of the last change of the sync copy |
| `lampa.syncReset` | string | W | Reset the sync copy: name of the device whose data is taken, or `all` |

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

### 1.4.0
- (sadam6752-tech) Lampa sync of plugins (off by default): a plugin added on one device is offered to the others, arrives switched off and is switched on only when the user agrees on the device; never removed, blacklisted plugins and the MovieSwipe plugin stay out, keys are stripped from addresses; the admin lists the plugins of the copy with their device

### 1.3.0
- (sadam6752-tech) Lampa sync: the MovieSwipe plugin keeps watch progress, bookmarks, watched marks and search history the same on all Lampa devices, with one sync key, groups chosen in the adapter and on each device, a device table and a reset in the new tab "Lampa sync"
- (sadam6752-tech) AI agents can manage the Lampa bookmarks of all devices: new commands `addBookmark`, `removeBookmark`, `bookmarks` and `markWatched`
- (sadam6752-tech) `openInLampa` searches TMDB by the original title first again (it got only the Russian title)

### 1.2.2
- (sadam6752-tech) AI agents can open the card of a title in the Lampa app on a TV or player: the adapter serves a Lampa plugin (`/lampa.js`) and answers the new commands `openInLampa` and `lampaDevices`

### 1.2.1
- (sadam6752-tech) `suggest` returns the poster URL of each title, and the help tells the agent how to send it to Telegram as a photo with a caption (the poster URLs have no file extension, so the telegram adapter needs `type: "photo"`)

### 1.2.0
- (sadam6752-tech) Answers `help` for AI agents (`common.supportedMessages.help`, js-controller PR #3638) with the commands `suggest`, `search`, `getMovie`, `markMovie`, `history` and `genres`: an agent such as ioBroker.pi-agent can search the movie database and recommend what to watch, and remembers what it suggested and what the household watched or skipped
- (sadam6752-tech) The search runs in a worker thread that is started on demand and ends after ten minutes without requests
- (sadam6752-tech) `@iobroker/testing` range raised to 6.3.2

### 1.1.6
- (sadam6752-tech) Require multer 2.5.0 or newer (security fix CVE-2026-113872 in the upload of the Backup Manager); an existing installation with multer 2.4.0 gets the fixed version with this update

## Credits

- **MovieSwipe PWA** - Original application
- **Kinopoisk API** - Movie database provider
- **ioBroker** - Smart home platform

## Support

- **GitHub Issues**: https://github.com/sadam6752-tech/ioBroker.movieswipe/issues
- **ioBroker Forum**: https://forum.iobroker.net/

---

**Made with ❤️ for ioBroker community**

## License

MIT License

Copyright (c) 2026 sadam6752-tech <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
