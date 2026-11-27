'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/** How long a poll of a Lampa device is held open when there is nothing to do */
const POLL_HOLD_MS = 25 * 1000;
/** A device that has not polled for this long is offline (the app is closed or the TV sleeps) */
const ONLINE_MS = 60 * 1000;
/** A queued command that no device fetched in this time is dropped */
const COMMAND_TTL_MS = 60 * 1000;
/** How long open() waits for the device to report what it did */
const RESULT_WAIT_MS = 15 * 1000;
const PLUGIN_FILE = path.join(__dirname, '..', 'lampa', 'movieswipe-lampa.js');
const SERIES_TYPES = ['tv-series', 'animated-series'];
/** Largest sync request (the first sync of a device sends all its time codes and bookmarks) */
const SYNC_BODY_LIMIT = '16mb';

/**
 * Cleans a value sent by a device (id, name)
 *
 * @param {unknown} value value
 * @param {number} max maximal length
 * @returns {string} cleaned value
 */
function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Connects the Lampa app on TVs and players with the adapter: the plugin lampa/movieswipe-lampa.js polls
 * /lampa/poll, gets commands (open the card of a title) and reports with /lampa/result what it did.
 * Works with any Lampa, no Lampac server is needed.
 */
class LampaBridge {
  /**
   * @param {any} adapter adapter instance (setTimeout, clearTimeout, log)
   * @param {{ holdMs?: number, onlineMs?: number, ttlMs?: number, resultMs?: number }} [times] times, for tests
   */
  constructor(adapter, times = {}) {
    this.adapter = adapter;
    this.holdMs = times.holdMs ?? POLL_HOLD_MS;
    this.onlineMs = times.onlineMs ?? ONLINE_MS;
    this.ttlMs = times.ttlMs ?? COMMAND_TTL_MS;
    this.resultMs = times.resultMs ?? RESULT_WAIT_MS;
    /** @type {Map<string, { id: string, name: string, platform: string, lastSeen: number, queue: Record<string, any>[], waiting: { res: any, timer: any } | null }>} */
    this.devices = new Map();
    /** @type {Map<string, { resolve: (r: Record<string, any>) => void, timer: any }>} */
    this.pending = new Map();
    this.stopped = false;
    /** @type {import('./lampa-sync').LampaSync | null} */
    this.sync = null;
  }

  /**
   * Adds the routes to the express app of the web server
   *
   * @param {any} app express app
   */
  routes(app) {
    app.use('/lampa', (req, res, next) => {
      // Lampa runs on its own origin (lampa.mx, a file of the app): allow it to read the answers
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-store');
      next();
    });
    app.get('/lampa.js', (req, res) => this.sendPlugin(req, res));
    app.get('/lampa/poll', (req, res) => this.poll(req.query, res));
    app.get('/lampa/result', (req, res) => {
      this.result(req.query);
      res.json({ ok: true });
    });
    // The key travels in the body (text/plain: no CORS preflight, and not in URLs or logs)
    app.post('/lampa/sync', express.text({ type: () => true, limit: SYNC_BODY_LIMIT }), (req, res) => {
      if (!this.sync || this.stopped) {
        res.status(503).json({ error: 'Lampa sync is not running' });
        return;
      }
      let body = null;
      try {
        body = JSON.parse(typeof req.body === 'string' ? req.body : '');
      } catch {
        body = null;
      }
      const answer = this.sync.handle(body);
      if (answer.code === 401) {
        this.adapter.log.warn(`Lampa sync: wrong key from device "${clean(body && body.name, 60) || '?'}"`);
      }
      res.status(answer.code).json(answer.body);
    });
  }

  /**
   * Sends the plugin with the address of this server filled in
   *
   * @param {any} req request
   * @param {any} res response
   */
  sendPlugin(req, res) {
    fs.readFile(PLUGIN_FILE, 'utf8', (err, text) => {
      if (err) {
        res.status(500).send('// plugin missing');
        return;
      }
      const base = `${req.protocol}://${req.get('host')}`;
      // /lampa.js?key=<sync key> hands the key to the device; a wrong key is not filled in
      const key = this.sync && req.query && this.sync.authorized(req.query.key) ? this.sync.key : '';
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-store');
      res.type('application/javascript').send(
        text
          .replace('__MOVIESWIPE_BASE__', JSON.stringify(base).slice(1, -1))
          .replace('__MOVIESWIPE_KEY__', JSON.stringify(key).slice(1, -1)),
      );
    });
  }

  /**
   * A device asks for commands: answers at once when some are queued, otherwise holds the request
   *
   * @param {Record<string, any>} query id, name, platform
   * @param {any} res response
   * @param {number} [now] timestamp, for tests
   */
  poll(query, res, now = Date.now()) {
    const id = clean(query.id, 64);
    if (!id || this.stopped) {
      res.status(this.stopped ? 503 : 400).json({ error: this.stopped ? 'stopping' : 'id is missing' });
      return;
    }
    let device = this.devices.get(id);
    if (!device) {
      device = { id, name: '', platform: '', lastSeen: now, queue: [], waiting: null };
      this.devices.set(id, device);
    }
    const name = clean(query.name, 60) || `Lampa ${id.slice(0, 4)}`;
    if (device.name !== name) {
      this.adapter.log.info(`Lampa device "${name}" connected`);
    }
    device.name = name;
    device.platform = clean(query.platform, 30);
    device.lastSeen = now;
    // A device has one poll open: an older one (lost connection) is answered empty
    this.release(device, { commands: [] });
    device.queue = device.queue.filter(c => now - c.ts < this.ttlMs);
    if (device.queue.length) {
      const commands = device.queue.splice(0);
      res.json({ commands: commands.map(({ ts, ...c }) => c) });
      return;
    }
    const timer = this.adapter.setTimeout(() => {
      if (device.waiting && device.waiting.res === res) {
        device.waiting = null;
        device.lastSeen = Date.now();
        res.json({ commands: [] });
      }
    }, this.holdMs);
    device.waiting = { res, timer };
    res.on?.('close', () => {
      if (device.waiting && device.waiting.res === res) {
        this.adapter.clearTimeout(device.waiting.timer);
        device.waiting = null;
      }
    });
  }

  /**
   * Answers the open poll of a device
   *
   * @param {{ waiting: { res: any, timer: any } | null }} device device
   * @param {Record<string, any>} body answer
   * @returns {boolean} true when a poll was open
   */
  release(device, body) {
    if (!device.waiting) {
      return false;
    }
    const { res, timer } = device.waiting;
    device.waiting = null;
    this.adapter.clearTimeout(timer);
    if (!res.headersSent) {
      res.json(body);
    }
    return true;
  }

  /**
   * A device reports what it did with a command
   *
   * @param {Record<string, any>} query cmd (command id), status (opened | search | error), title, message
   */
  result(query) {
    const cmd = clean(query.cmd, 64);
    const pending = this.pending.get(cmd);
    if (!pending) {
      return;
    }
    this.pending.delete(cmd);
    this.adapter.clearTimeout(pending.timer);
    pending.resolve({
      status: clean(query.status, 20) || 'unknown',
      title: clean(query.title, 200) || undefined,
      message: clean(query.message, 300) || undefined,
    });
  }

  /**
   * Devices that polled recently
   *
   * @param {number} [now] timestamp, for tests
   * @returns {{ id: string, name: string, platform: string }[]} devices
   */
  online(now = Date.now()) {
    return [...this.devices.values()]
      .filter(d => d.waiting || now - d.lastSeen < this.onlineMs)
      .map(d => ({ id: d.id, name: d.name, platform: d.platform }));
  }

  /**
   * Picks the device for a command
   *
   * @param {unknown} wanted name (or part of it) the user said; may be empty when one device is online
   * @param {number} [now] timestamp, for tests
   * @returns {{ id: string, name: string }} device
   */
  pick(wanted, now = Date.now()) {
    const list = this.online(now);
    if (!list.length) {
      throw new Error(
        'No Lampa device is online: Lampa must be open on the TV with the MovieSwipe plugin (a TV in standby or ' +
          'Lampa in the background does not answer)',
      );
    }
    const want = clean(wanted, 60).toLowerCase();
    if (!want) {
      if (list.length > 1) {
        throw new Error(`Several Lampa devices are online, ask the user which one: ${list.map(d => d.name).join(', ')}`);
      }
      return list[0];
    }
    const exact = list.filter(d => d.name.toLowerCase() === want);
    const hits = exact.length ? exact : list.filter(d => d.name.toLowerCase().includes(want));
    if (hits.length !== 1) {
      throw new Error(
        `${hits.length ? 'Several' : 'No'} Lampa devices match "${wanted}"; online: ${list.map(d => d.name).join(', ')}`,
      );
    }
    return hits[0];
  }

  /**
   * Opens the card of a title in Lampa on a device and waits for the device to report what it did
   *
   * @param {{ id: string, title?: string, originalTitle?: string, year?: number | null, type?: string }} movie movie
   * @param {unknown} [device] name of the device
   * @param {number} [now] timestamp, for tests
   * @returns {Promise<Record<string, any>>} answer
   */
  async open(movie, device, now = Date.now()) {
    const target = this.pick(device, now);
    const cmd = crypto.randomUUID();
    const command = {
      cmd,
      action: 'open',
      title: movie.title || '',
      originalTitle: movie.originalTitle || '',
      year: movie.year ?? null,
      series: SERIES_TYPES.includes(movie.type || ''),
      kinopoiskId: movie.id,
    };
    const d = /** @type {any} */ (this.devices.get(target.id));
    const done = new Promise(resolve => {
      const timer = this.adapter.setTimeout(() => {
        this.pending.delete(cmd);
        resolve({ status: 'sent' });
      }, this.resultMs);
      this.pending.set(cmd, { resolve, timer });
    });
    if (!this.release(d, { commands: [command] })) {
      d.queue.push({ ...command, ts: now });
    }
    const { title: lampaTitle, ...r } = /** @type {Record<string, any>} */ (await done);
    /** @type {Record<string, any>} */
    const answer = { device: target.name, title: movie.title, year: movie.year ?? null, ...r };
    if (lampaTitle && lampaTitle !== movie.title) {
      answer.lampaTitle = lampaTitle;
    }
    if (r.status === 'sent') {
      answer.note = 'Sent to Lampa, but the device did not confirm; it may be busy or in the background.';
    } else if (r.status === 'search') {
      answer.note = 'Lampa found no exact match and shows its search for the title.';
    }
    return answer;
  }

  /**
   * Tells the online devices that the sync copy changed, so they fetch the change at once
   *
   * @param {Record<string, any>} command command, e.g. {action: 'sync', rev}
   * @param {string | null} [except] id of the device that made the change
   * @param {number} [now] timestamp, for tests
   */
  broadcast(command, except = null, now = Date.now()) {
    for (const d of this.devices.values()) {
      if (d.id === except || !(d.waiting || now - d.lastSeen < this.onlineMs)) {
        continue;
      }
      if (!this.release(d, { commands: [command] })) {
        d.queue = d.queue.filter(c => c.action !== command.action);
        d.queue.push({ ...command, ts: now });
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const d of this.devices.values()) {
      this.release(d, { commands: [] });
    }
    for (const [cmd, p] of this.pending) {
      this.adapter.clearTimeout(p.timer);
      p.resolve({ status: 'sent' });
      this.pending.delete(cmd);
    }
  }
}

module.exports = { LampaBridge, SERIES_TYPES };
