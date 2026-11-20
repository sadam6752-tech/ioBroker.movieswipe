'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./fs-utils');

const FILE = 'agent-history.json';
const MAX_ENTRIES = 5000;
/** A suggestion without an answer is not repeated for this many days */
const REPEAT_AFTER_DAYS = 30;
const ACTIONS = ['suggested', 'watched', 'skipped', 'cleared'];
const DAY = 24 * 60 * 60 * 1000;

/**
 * Local date and time of a timestamp, e.g. "2026-11-20 19:30"
 *
 * @param {number} ts timestamp
 * @returns {string} local time
 */
function localTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Start of a local day given as YYYY-MM-DD
 *
 * @param {unknown} s date
 * @param {boolean} end true for the end of the day
 * @returns {number | undefined} timestamp
 */
function parseDay(s, end) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) {
    return undefined;
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return end ? d.getTime() + DAY - 1 : d.getTime();
}

/**
 * What the agent suggested and what the household watched or skipped (one shared history).
 * Kept in the instance data directory and copied into the ioBroker file storage (`<namespace>.storage`), so it
 * is part of ioBroker backups and survives a reinstallation.
 */
class AgentHistory {
  /**
   * @param {any} adapter adapter instance
   * @param {string} dataDir data directory of the instance
   */
  constructor(adapter, dataDir) {
    this.adapter = adapter;
    this.file = path.join(dataDir, FILE);
    this.mount = `${adapter.namespace}.storage`;
    /** @type {{ ts: number, id: string, title: string, year: number | null, type: string, action: string }[]} */
    this.entries = [];
  }

  async init() {
    let text = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      try {
        if (await this.adapter.fileExistsAsync(this.mount, FILE)) {
          const { file } = await this.adapter.readFileAsync(this.mount, FILE);
          text = Buffer.isBuffer(file) ? file.toString('utf8') : String(file);
          this.adapter.log.info('Agent history restored from the ioBroker file storage');
        }
      } catch (e) {
        this.adapter.log.warn(`Could not read the agent history from the file storage: ${e.message}`);
      }
    }
    if (text) {
      try {
        const json = JSON.parse(text);
        this.entries = Array.isArray(json.entries) ? json.entries.filter(e => e && e.id && e.ts) : [];
      } catch (e) {
        this.adapter.log.warn(`Agent history is invalid and starts empty: ${e.message}`);
      }
    }
  }

  /**
   * Adds entries and saves the history
   *
   * @param {{ id: string, title?: string, year?: number | null, type?: string }[]} movies movies
   * @param {string} action suggested | watched | skipped | cleared
   * @param {number} [now] timestamp, for tests
   */
  async add(movies, action, now = Date.now()) {
    if (!ACTIONS.includes(action)) {
      throw new Error(`Unknown status "${action}"`);
    }
    for (const m of movies) {
      this.entries.push({
        ts: now,
        id: String(m.id),
        title: m.title || '',
        year: m.year ?? null,
        type: m.type || '',
        action,
      });
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    await this.save();
  }

  async save() {
    const data = JSON.stringify({ entries: this.entries });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      atomicWrite(this.file, data);
    } catch (e) {
      this.adapter.log.warn(`Could not save the agent history: ${e.message}`);
    }
    try {
      await this.adapter.writeFileAsync(this.mount, FILE, data);
    } catch (e) {
      this.adapter.log.warn(`Could not copy the agent history to the file storage: ${e.message}`);
    }
  }

  /**
   * The current status of each movie that was marked: watched or skipped ("cleared" removes it)
   *
   * @returns {Map<string, { status: string, ts: number }>} status by id
   */
  statuses() {
    const map = new Map();
    for (const e of this.entries) {
      if (e.action === 'watched' || e.action === 'skipped') {
        map.set(e.id, { status: e.action, ts: e.ts });
      } else if (e.action === 'cleared') {
        map.delete(e.id);
      }
    }
    return map;
  }

  /**
   * Ids suggest must leave out: watched, skipped, and suggested within the last REPEAT_AFTER_DAYS days
   *
   * @param {number} [now] timestamp, for tests
   * @returns {string[]} ids
   */
  excluded(now = Date.now()) {
    const ids = new Set(this.statuses().keys());
    const since = now - REPEAT_AFTER_DAYS * DAY;
    for (const e of this.entries) {
      if (e.action === 'suggested' && e.ts >= since) {
        ids.add(e.id);
      }
    }
    return [...ids];
  }

  /**
   * Entries of a period, newest first
   *
   * @param {Record<string, any>} args days (default 7) or from/to (YYYY-MM-DD), action, limit
   * @param {number} [now] timestamp, for tests
   * @returns {{ total: number, entries: Record<string, any>[] }} answer
   */
  query(args = {}, now = Date.now()) {
    let from = parseDay(args.from, false);
    const to = parseDay(args.to, true) ?? now;
    if (from === undefined) {
      const days = Number(args.days);
      from = now - (Number.isFinite(days) && days > 0 ? days : 7) * DAY;
    }
    const action = args.action ? String(args.action).toLowerCase() : '';
    if (action && !ACTIONS.includes(action)) {
      throw new Error(`Unknown action "${args.action}", use one of: ${ACTIONS.join(', ')}`);
    }
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    const hits = this.entries.filter(e => e.ts >= from && e.ts <= to && (!action || e.action === action)).reverse();
    return {
      total: hits.length,
      entries: hits.slice(0, limit).map(e => ({
        time: localTime(e.ts),
        action: e.action,
        id: e.id,
        title: e.title,
        year: e.year,
        type: e.type,
      })),
    };
  }
}

module.exports = { AgentHistory, REPEAT_AFTER_DAYS, localTime, parseDay };
