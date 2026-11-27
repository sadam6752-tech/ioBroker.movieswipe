'use strict';

const crypto = require('node:crypto');

/**
 * Groups of Lampa data the user switches on and off, and the categories (Lampa storage keys) they sync.
 * `cards` carries the card objects the bookmarks of `favorite` refer to.
 */
const GROUPS = {
  timeline: ['timeline'],
  favorite: ['favorite', 'cards'],
  viewed: ['online_view', 'torrents_view'],
  search: ['search_history'],
  plugins: ['plugins'],
};
/** Groups that are only synced when switched on explicitly */
const OPT_IN_GROUPS = ['plugins'];
/** The lists of the Lampa key `favorite` (bookmarks, history and the marks look/viewed/…) */
const FAVORITE_TYPES = ['like', 'wath', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];
/** Entries kept per category; Lampa itself keeps 3000 of a list and 10000 time codes */
const LIMITS = {
  timeline: 10000,
  favorite: 10000,
  cards: 10000,
  online_view: 3000,
  torrents_view: 3000,
  search_history: 3000,
  plugins: 300,
};
const TIMELINE_FIELDS = ['time', 'duration', 'percent', 'profile', 'updated', 'card', 'season', 'episode'];
/** A deletion is remembered this long, so devices that were offline learn about it */
const TOMBSTONE_MS = 180 * 24 * 3600 * 1000;
/** Clocks of TVs are often wrong: a time stamp further in the future is cut to now */
const FUTURE_MS = 60 * 1000;
const SAVE_DELAY_MS = 3000;
/** Largest JSON of one value (a card with its description) */
const MAX_VALUE = 20000;
const MAX_DEVICES = 50;
const MODES = ['both', 'send', 'receive', 'off'];
/**
 * The copy lives on the mount point `<namespace>.storage` that lib/db-store.js and lib/agent-history.js use too.
 * Not `<namespace>.lampa`: that id is the channel of the lampa.* states, and a file needs an object of type meta.
 */
const MOUNT = 'storage';
const FILE = 'lampa-sync.json';
/** Marks of Lampa: a title carries at most one of them */
const MARKS = ['look', 'viewed', 'scheduled', 'continued', 'thrown'];
/** Lists an agent may add to (history is written by Lampa itself) */
const AGENT_LISTS = FAVORITE_TYPES.filter(t => t !== 'history');
/** A bookmark of an agent that no device has resolved yet is given up after this time */
const REQUEST_MS = 30 * 24 * 3600 * 1000;
/** A request sent to a device that did not answer is sent again after this time */
const REQUEST_RESEND_MS = 60 * 1000;
const MAX_REQUESTS = 100;

/**
 * Normalizes a title for comparing (as the plugin does)
 *
 * @param {unknown} text title
 * @returns {string} normalized title
 */
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s.,:;!?'"«»()[\]\-–—&·]+/g, '');
}

/**
 * @param {Record<string, any>} card Lampa card
 * @returns {number} year of the card or 0
 */
function cardYear(card) {
  return parseInt(String(card.release_date || card.first_air_date || '').slice(0, 4), 10) || 0;
}

/**
 * Cleans a short text sent by a device (id, name)
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
 * A key of an entry: any text without control characters (search phrases keep their characters)
 *
 * @param {unknown} value value
 * @returns {string} key, empty when unusable
 */
function cleanKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  const key = String(value).replace(/[\u0000-\u001f]/g, '');
  return key.length > 500 ? '' : key;
}

/**
 * The address of a Lampa plugin as it is synced: http(s) only, without the `key` parameter (the MovieSwipe plugin
 * carries the sync key there, and no key may travel to other devices)
 *
 * @param {unknown} value address
 * @returns {string} address, empty when unusable
 */
function pluginUrl(value) {
  // the same steps as pluginUrl() of the Lampa plugin, so both compare the same strings
  let url = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > 500) {
    return '';
  }
  url = url.split('#')[0];
  const at = url.indexOf('?');
  if (at < 0) {
    return url;
  }
  const keep = url
    .slice(at + 1)
    .split('&')
    .filter(p => p && p.split('=')[0] !== 'key');
  return url.slice(0, at) + (keep.length ? `?${keep.join('&')}` : '');
}

/**
 * @param {string} url address from pluginUrl()
 * @param {number | null} ownPort port of the MovieSwipe web server
 * @returns {boolean} true for the MovieSwipe plugin itself
 */
function isOwnPlugin(url, ownPort) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return u.pathname === '/lampa.js' && (!ownPort || port === ownPort);
}

/** @returns {string} a new random epoch; it changes when the copy on the server is reset */
function newEpoch() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Keeps the data of Lampa (time codes, bookmarks, watched lists, search history) of all devices of the household in
 * one copy in the file storage of ioBroker. A device sends what changed since its last sync and gets what other devices
 * changed since then (POST /lampa/sync, one round trip). Every entry carries a time stamp and a deletion mark; the
 * newer one wins. See README "Lampa sync".
 */
class LampaSync {
  /**
   * @param {any} adapter adapter instance (log, setTimeout, clearTimeout, file API)
   * @param {{ key?: string, groups?: string[], mount?: string | null, saveDelay?: number, ownPort?: number }} [options]
   *   sync key, enabled groups (plugins only when named), mount point of the file storage (none in tests), delay of
   *   saving, port of the web server (to recognize the MovieSwipe plugin)
   */
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.key = String(options.key || '').trim();
    this.groups = (options.groups || Object.keys(GROUPS).filter(g => !OPT_IN_GROUPS.includes(g))).filter(g => GROUPS[g]);
    this.ownPort = options.ownPort || null;
    this.mount = options.mount || null;
    this.saveDelay = options.saveDelay ?? SAVE_DELAY_MS;
    /** Called after the copy changed or was reset: (rev, id of the device that changed it or null) */
    this.onChange = null;
    /** Called after a device synced */
    this.onDevice = null;
    this.state = LampaSync.empty();
    this.saveTimer = null;
    /** @type {Map<string, { resolve: (r: Record<string, any>) => void, timer: any }>} */
    this.waiters = new Map();
    this.expected = crypto.createHash('sha256').update(this.key).digest();
  }

  /** @returns {Record<string, any>} an empty copy */
  static empty() {
    return { version: 1, epoch: newEpoch(), rev: 0, prunedRev: 0, data: {}, devices: {}, reset: null, requests: [] };
  }

  /** @returns {string[]} the categories that are synced */
  categories() {
    return this.groups.flatMap(g => GROUPS[g]);
  }

  /** @returns {boolean} true when a key is set and at least one group is switched on */
  enabled() {
    return !!this.key && this.groups.length > 0;
  }

  /**
   * @param {unknown} key key sent by a device
   * @returns {boolean} true when it is the sync key
   */
  authorized(key) {
    const given = crypto.createHash('sha256').update(String(key ?? '')).digest();
    return !!this.key && crypto.timingSafeEqual(given, this.expected);
  }

  /** Reads the copy from the file storage; creates the mount point */
  async load() {
    if (!this.mount) {
      return;
    }
    const existing = await this.adapter.getForeignObjectAsync(this.mount);
    if (existing && existing.type !== 'meta') {
      throw new Error(`${this.mount} is a ${existing.type}, not a file storage (type meta)`);
    }
    await this.adapter.setObjectNotExistsAsync(this.mount, {
      type: 'meta',
      common: {
        name: {
          en: 'File storage',
          de: 'Dateiablage',
          ru: 'Файловое хранилище',
          pt: 'Armazenamento de ficheiros',
          nl: 'Bestandsopslag',
          fr: 'Stockage de fichiers',
          it: 'Archivio file',
          es: 'Almacenamiento de archivos',
          pl: 'Magazyn plików',
          uk: 'Файлове сховище',
          'zh-cn': '文件存储',
        },
        type: 'meta.user',
      },
      native: {},
    });
    try {
      if (!(await this.adapter.fileExistsAsync(this.mount, FILE))) {
        return;
      }
      const { file } = await this.adapter.readFileAsync(this.mount, FILE);
      const state = JSON.parse(String(file));
      if (state && state.version === 1 && state.epoch && state.data && state.devices) {
        this.state = { ...LampaSync.empty(), ...state };
      }
    } catch (e) {
      this.adapter.log.warn(`Cannot read the Lampa sync copy, starting empty: ${e.message}`);
    }
  }

  /** Saves the copy after a short delay */
  scheduleSave() {
    if (!this.mount || this.saveTimer) {
      return;
    }
    this.saveTimer = this.adapter.setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => {});
    }, this.saveDelay);
  }

  /**
   * Prunes and writes the copy now
   *
   * @param {number} [now] timestamp, for tests
   */
  async save(now = Date.now()) {
    this.prune(now);
    if (!this.mount) {
      return;
    }
    try {
      await this.adapter.writeFileAsync(this.mount, FILE, JSON.stringify(this.state));
    } catch (e) {
      this.adapter.log.warn(`Cannot write the Lampa sync copy: ${e.message}`);
    }
  }

  /** Writes a pending change at once (adapter stops) */
  async flush() {
    if (this.saveTimer) {
      this.adapter.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    }
  }

  /**
   * Answers a sync request of a device: applies its changes and returns the changes since its last sync
   *
   * @param {Record<string, any>} body key, device, name, platform, lampa (version), epoch, since, initial, changes, settings
   * @param {number} [now] timestamp, for tests
   * @returns {{ code: number, body: Record<string, any> }} answer
   */
  handle(body, now = Date.now()) {
    if (!this.enabled()) {
      return { code: 403, body: { error: 'Lampa sync is off: set a sync key and categories in the adapter settings' } };
    }
    if (!body || typeof body !== 'object' || !this.authorized(body.key)) {
      return { code: 401, body: { error: 'Wrong sync key' } };
    }
    const id = clean(body.device, 64);
    if (!id) {
      return { code: 400, body: { error: 'device is missing' } };
    }
    const s = this.state;
    this.touch(id, body, now);
    const base = { epoch: s.epoch, cats: this.categories() };
    const reset = s.reset;

    if (reset && !reset.sourceDone && id !== reset.source) {
      // the copy is replaced by the data of one device that has not synced yet: the others keep their data meanwhile
      return { code: 200, body: { ...base, wait: true } };
    }
    if (body.epoch !== s.epoch) {
      // first sync of the device, or the copy was reset: it starts over (sends everything or takes the copy)
      const replace = !!(reset && reset.sourceDone && reset.replace.includes(id));
      return { code: 200, body: { ...base, stale: true, replace } };
    }

    let changed = this.apply(body.changes, body.initial === true, now, s.devices[id].name);
    if (Array.isArray(body.resolved) && this.resolved(body.resolved, now)) {
      changed = true;
    }
    if (reset && id === reset.source && !reset.sourceDone) {
      reset.sourceDone = true;
      this.adapter.log.info(`Lampa sync: the copy now holds the data of "${s.devices[id].name}"`);
    } else if (reset && reset.sourceDone) {
      reset.replace = reset.replace.filter(/** @param {string} d */ d => d !== id);
    }
    if (reset && reset.sourceDone && !reset.replace.length) {
      s.reset = null;
    }
    const since = Number(body.since) || 0;
    const full = since < s.prunedRev || since > s.rev;
    const changes = this.collect(full ? 0 : since);
    s.devices[id].rev = s.rev;
    if (changed || reset) {
      this.scheduleSave();
    }
    if (changed && this.onChange) {
      this.onChange(s.rev, id);
    }
    if (this.onDevice) {
      this.onDevice();
    }
    const requests = this.requestsFor(id, now);
    return { code: 200, body: { ...base, rev: s.rev, full, changes, ...(requests.length ? { requests } : {}) } };
  }

  /**
   * Remembers a device and its settings
   *
   * @param {string} id device id
   * @param {Record<string, any>} body request
   * @param {number} now timestamp
   */
  touch(id, body, now) {
    const devices = this.state.devices;
    /** @type {Record<string, string>} */
    const modes = {};
    for (const g of Object.keys(GROUPS)) {
      const m = body.settings && body.settings[g];
      if (MODES.includes(m)) {
        modes[g] = m;
      }
    }
    const old = devices[id] || {};
    devices[id] = {
      ...old,
      name: clean(body.name, 60) || old.name || `Lampa ${id.slice(0, 4)}`,
      platform: clean(body.platform, 30),
      lampa: clean(body.lampa, 20),
      modes,
      lastSync: now,
    };
    const ids = Object.keys(devices);
    if (ids.length > MAX_DEVICES) {
      ids.sort((a, b) => devices[a].lastSync - devices[b].lastSync);
      for (const d of ids.slice(0, ids.length - MAX_DEVICES)) {
        delete devices[d];
      }
    }
  }

  /**
   * Checks one entry sent by a device
   *
   * @param {string} cat category
   * @param {any} raw entry {k, v, ts, del}
   * @param {number} now timestamp
   * @returns {{ k: string, v?: any, ts: number, del: boolean } | null} entry or null when unusable
   */
  entry(cat, raw, now) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    if (cat === 'plugins') {
      // devices only add plugins: a removal on one device is not passed on
      const url = pluginUrl(raw.v && raw.v.url);
      if (raw.del === true || !url || isOwnPlugin(url, this.ownPort)) {
        return null;
      }
      const name = clean(raw.v.name, 100);
      return { k: url, v: name ? { url, name } : { url }, ts: Math.min(Number(raw.ts) || now, now), del: false };
    }
    const k = cleanKey(raw.k);
    if (!k) {
      return null;
    }
    let ts = Number(raw.ts) || 0;
    if (ts <= 0 || ts > now + FUTURE_MS) {
      ts = now;
    }
    const del = raw.del === true;
    if (cat === 'timeline') {
      if (del) {
        return { k, ts, del };
      }
      if (!raw.v || typeof raw.v !== 'object') {
        return null;
      }
      /** @type {Record<string, any>} */
      const v = {};
      for (const f of TIMELINE_FIELDS) {
        const x = raw.v[f];
        if (typeof x === 'number' || (typeof x === 'string' && x.length <= 100)) {
          v[f] = x;
        }
      }
      return { k, v, ts, del };
    }
    if (cat === 'favorite') {
      const type = k.slice(0, k.indexOf(':'));
      if (!FAVORITE_TYPES.includes(type)) {
        return null;
      }
      if (del) {
        return { k, ts, del };
      }
      const id = raw.v && raw.v.id;
      if ((typeof id !== 'number' && typeof id !== 'string') || k !== `${type}:${id}`) {
        return null;
      }
      return { k, v: { type, id }, ts, del };
    }
    if (cat === 'cards') {
      if (del || !raw.v || typeof raw.v !== 'object' || String(raw.v.id) !== k) {
        return null;
      }
      return JSON.stringify(raw.v).length > MAX_VALUE ? null : { k, v: raw.v, ts, del: false };
    }
    return { k, ts, del };
  }

  /**
   * Merges the changes of a device: per entry the newer time stamp wins
   *
   * @param {any} changes {category: [{k, v, ts, del}]}
   * @param {boolean} initial true for the first sync of a device: its data does not override what the copy knows
   * @param {number} now timestamp
   * @param {string} [from] name of the device that sends them
   * @returns {boolean} true when the copy changed
   */
  apply(changes, initial, now, from) {
    if (!changes || typeof changes !== 'object') {
      return false;
    }
    const s = this.state;
    let changed = false;
    for (const cat of this.categories()) {
      const list = changes[cat];
      if (!Array.isArray(list)) {
        continue;
      }
      const map = (s.data[cat] = s.data[cat] || {});
      for (const raw of list.slice(0, LIMITS[cat] * 2)) {
        const e = this.entry(cat, raw, now);
        if (!e) {
          continue;
        }
        const old = map[e.k];
        if (cat === 'plugins' && old) {
          // union by address: a known plugin (or one removed in the admin) stays as it is
          continue;
        }
        if (cat === 'plugins' && from) {
          e.v.from = from;
        }
        if (old && ((initial && cat !== 'timeline') || old.ts >= e.ts)) {
          continue;
        }
        if (!old && e.del && initial) {
          continue;
        }
        s.rev++;
        /** @type {Record<string, any>} */
        const stored = { ts: e.ts, rev: s.rev };
        if (e.del) {
          stored.del = true;
        } else if (e.v !== undefined) {
          stored.v = e.v;
        }
        map[e.k] = stored;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The entries changed after a revision
   *
   * @param {number} since revision
   * @returns {Record<string, { k: string, v?: any, ts: number, del?: boolean }[]>} changes per category
   */
  collect(since) {
    /** @type {Record<string, any[]>} */
    const out = {};
    for (const cat of this.categories()) {
      const map = this.state.data[cat] || {};
      const list = [];
      for (const k of Object.keys(map)) {
        const e = map[k];
        if (e.rev > since) {
          list.push(e.del ? { k, ts: e.ts, del: true } : e.v === undefined ? { k, ts: e.ts } : { k, v: e.v, ts: e.ts });
        }
      }
      if (list.length) {
        // oldest first: a device inserting at the front ends with the newest on top
        list.sort((a, b) => a.ts - b.ts);
        out[cat] = list;
      }
    }
    return out;
  }

  /**
   * Forgets old deletions, keeps the limits and drops cards no bookmark refers to
   *
   * @param {number} now timestamp
   */
  prune(now) {
    const s = this.state;
    for (const cat of Object.keys(s.data)) {
      const map = s.data[cat];
      const live = [];
      for (const k of Object.keys(map)) {
        if (map[k].del && now - map[k].ts > TOMBSTONE_MS) {
          s.prunedRev = Math.max(s.prunedRev, map[k].rev);
          delete map[k];
        } else if (!map[k].del) {
          live.push(k);
        }
      }
      const limit = LIMITS[cat] || 3000;
      if (live.length > limit) {
        live.sort((a, b) => map[a].ts - map[b].ts);
        for (const k of live.slice(0, live.length - limit)) {
          s.prunedRev = Math.max(s.prunedRev, map[k].rev);
          delete map[k];
        }
      }
    }
    s.requests = (s.requests || []).filter(/** @param {any} r */ r => now - r.ts < REQUEST_MS);
    const cards = s.data.cards;
    if (cards) {
      const used = new Set();
      for (const e of Object.values(s.data.favorite || {})) {
        if (!e.del && e.v) {
          used.add(String(e.v.id));
        }
      }
      for (const k of Object.keys(cards)) {
        if (!used.has(k)) {
          delete cards[k];
        }
      }
    }
  }

  /**
   * Resets the copy. Without a device the copy is built again from the data of all devices (merged); with a device
   * its data replaces the copy and then the data of all other devices.
   *
   * @param {unknown} target name or id of a device, or empty / "all"
   * @returns {{ source: string | null }} name of the device whose data is taken, or null
   */
  reset(target) {
    const s = this.state;
    const want = clean(target, 64).toLowerCase();
    let source = null;
    if (want && want !== 'all') {
      const hits = Object.keys(s.devices).filter(id => id.toLowerCase() === want || s.devices[id].name.toLowerCase() === want);
      if (hits.length !== 1) {
        throw new Error(`${hits.length ? 'Several' : 'No'} Lampa devices are called "${clean(target, 64)}"`);
      }
      source = hits[0];
    }
    this.state = {
      ...LampaSync.empty(),
      rev: s.rev + 1,
      devices: s.devices,
      requests: s.requests || [],
      reset: source
        ? { source, sourceDone: false, replace: Object.keys(s.devices).filter(id => id !== source) }
        : null,
    };
    this.adapter.log.info(
      source
        ? `Lampa sync reset: the data of "${s.devices[source].name}" replaces the copy and the other devices`
        : 'Lampa sync reset: the copy is built again from the data of all devices',
    );
    this.scheduleSave();
    if (this.onChange) {
      this.onChange(this.state.rev, null);
    }
    if (this.onDevice) {
      this.onDevice();
    }
    return { source: source ? s.devices[source].name : null };
  }

  /**
   * The devices for the admin and the states
   *
   * @returns {{ id: string, name: string, platform: string, lampa: string, modes: Record<string, string>, lastSync: number }[]} devices, last synced first
   */
  devices() {
    const d = this.state.devices;
    return Object.keys(d)
      .map(id => ({ id, ...d[id] }))
      .sort((a, b) => b.lastSync - a.lastSync)
      .map(({ id, name, platform, lampa, modes, lastSync }) => ({ id, name, platform, lampa, modes, lastSync }));
  }

  /** @returns {Record<string, number>} live entries per category */
  counts() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const cat of this.categories()) {
      out[cat] = Object.values(this.state.data[cat] || {}).filter(e => !e.del).length;
    }
    return out;
  }

  /**
   * Changes the copy on behalf of an agent and tells the devices
   *
   * @param {Record<string, any[]>} changes changes as a device sends them
   * @param {number} now timestamp
   * @returns {boolean} true when the copy changed
   */
  change(changes, now) {
    // a change of an agent is the latest one, also against an entry written in the same millisecond
    for (const cat of Object.keys(changes)) {
      const map = this.state.data[cat] || {};
      for (const e of changes[cat]) {
        if (map[e.k] && map[e.k].ts >= e.ts) {
          e.ts = map[e.k].ts + 1;
        }
      }
    }
    const changed = this.apply(changes, false, now + FUTURE_MS);
    if (changed) {
      this.scheduleSave();
      if (this.onChange) {
        this.onChange(this.state.rev, null);
      }
    }
    return changed;
  }

  /** @returns {boolean} true when bookmarks are synced */
  bookmarksOn() {
    return this.enabled() && this.groups.includes('favorite');
  }

  /**
   * Finds the Lampa card of a title among the cards of the copy
   *
   * @param {{ title?: string, originalTitle?: string, year?: number | null }} movie title
   * @returns {Record<string, any> | null} card
   */
  findCard(movie) {
    const names = [norm(movie.originalTitle), norm(movie.title)].filter(Boolean);
    let best = null;
    for (const e of Object.values(this.state.data.cards || {})) {
      const card = e.v;
      const titles = [card.original_title, card.original_name, card.title, card.name].map(norm);
      if (!titles.some(t => t && names.includes(t))) {
        continue;
      }
      const y = cardYear(card);
      if (movie.year && y && Math.abs(y - movie.year) > 1) {
        continue;
      }
      if (!best || (movie.year && y === movie.year)) {
        best = card;
      }
    }
    return best;
  }

  /**
   * The lists of the copy a card is in
   *
   * @param {string | number} id card id
   * @returns {string[]} lists
   */
  listsOf(id) {
    const fav = this.state.data.favorite || {};
    return FAVORITE_TYPES.filter(t => fav[`${t}:${id}`] && !fav[`${t}:${id}`].del);
  }

  /**
   * Writes a bookmark of a known card into the copy
   *
   * @param {Record<string, any>} card Lampa card
   * @param {string} list list
   * @param {number} now timestamp
   * @returns {boolean} true when it was not there yet
   */
  writeBookmark(card, list, now) {
    const lists = this.listsOf(card.id);
    /** @type {Record<string, any[]>} */
    const changes = {
      favorite: [{ k: `${list}:${card.id}`, v: { type: list, id: card.id }, ts: now }],
      cards: [{ k: String(card.id), v: card, ts: now }],
    };
    if (MARKS.includes(list)) {
      for (const m of MARKS) {
        if (m !== list && lists.includes(m)) {
          changes.favorite.push({ k: `${m}:${card.id}`, ts: now, del: true });
        }
      }
    }
    this.change(changes, now);
    return !lists.includes(list);
  }

  /**
   * Adds a title to a list. With a known card at once; otherwise a device with Lampa looks the title up on TMDB (the
   * copy only knows cards Lampa has seen), and the answer waits for it a while.
   *
   * @param {{ id?: string | null, title?: string, originalTitle?: string, year?: number | null, type?: string }} movie title
   * @param {string} list list (see AGENT_LISTS)
   * @param {{ online?: boolean, timeoutMs?: number, now?: number, series?: boolean }} [options] online: a device can answer now
   * @returns {Promise<Record<string, any>>} answer
   */
  async addBookmark(movie, list, options = {}) {
    const now = options.now ?? Date.now();
    const card = this.findCard(movie);
    if (card) {
      const added = this.writeBookmark(card, list, now);
      return { status: added ? 'added' : 'already', title: card.title || card.name || movie.title, list };
    }
    const s = this.state;
    s.requests = s.requests || [];
    const known = s.requests.find(
      /** @param {any} r */ r => r.list === list && norm(r.title) === norm(movie.title) && r.year === (movie.year ?? null),
    );
    const rid = known ? known.rid : crypto.randomUUID();
    if (!known) {
      s.requests.push({
        rid,
        list,
        title: String(movie.title || ''),
        originalTitle: String(movie.originalTitle || ''),
        year: movie.year ?? null,
        series: !!options.series,
        kinopoiskId: movie.id || null,
        ts: now,
        sentAt: 0,
      });
      if (s.requests.length > MAX_REQUESTS) {
        s.requests.splice(0, s.requests.length - MAX_REQUESTS);
      }
      this.scheduleSave();
    } else {
      known.sentAt = 0;
    }
    if (this.onChange) {
      this.onChange(s.rev, null);
    }
    const queued = {
      status: 'queued',
      title: movie.title,
      list,
      note: 'No Lampa device is open now: the bookmark is added on all devices when Lampa is opened on one of them.',
    };
    if (!options.online) {
      return queued;
    }
    return new Promise(resolve => {
      const timer = this.adapter.setTimeout(() => {
        this.waiters.delete(rid);
        resolve({ ...queued, note: 'Lampa did not answer yet: the bookmark is added on all devices as soon as it does.' });
      }, options.timeoutMs ?? 20000);
      this.waiters.set(rid, { resolve, timer });
    });
  }

  /**
   * Requests of agents a device should resolve now
   *
   * @param {string} id device id
   * @param {number} now timestamp
   * @returns {Record<string, any>[]} requests
   */
  requestsFor(id, now) {
    const out = [];
    for (const r of this.state.requests || []) {
      if (now - r.sentAt < REQUEST_RESEND_MS) {
        continue;
      }
      r.sentAt = now;
      r.sentTo = id;
      out.push({ rid: r.rid, title: r.title, originalTitle: r.originalTitle, year: r.year, series: r.series });
      if (out.length >= 10) {
        break;
      }
    }
    return out;
  }

  /**
   * Cards a device found for requests of agents
   *
   * @param {any[]} list [{rid, card}] or [{rid, error}]
   * @param {number} now timestamp
   * @returns {boolean} true when the copy changed
   */
  resolved(list, now) {
    const s = this.state;
    let changed = false;
    for (const x of list.slice(0, 20)) {
      const at = (s.requests || []).findIndex(/** @param {any} r */ r => x && r.rid === x.rid);
      if (at < 0) {
        continue;
      }
      const [req] = s.requests.splice(at, 1);
      const card = x.card && typeof x.card === 'object' && this.entry('cards', { k: String(x.card.id), v: x.card }, now);
      /** @type {Record<string, any>} */
      let answer;
      if (card && card.v && (typeof card.v.id === 'number' || typeof card.v.id === 'string')) {
        const added = this.writeBookmark(card.v, req.list, now);
        changed = true;
        answer = { status: added ? 'added' : 'already', title: card.v.title || card.v.name || req.title, list: req.list };
      } else {
        this.adapter.log.info(`Lampa sync: no TMDB card found for "${req.title}", bookmark not added`);
        answer = { status: 'notFound', title: req.title, list: req.list, note: 'Lampa found no exact match on TMDB.' };
      }
      this.scheduleSave();
      const w = this.waiters.get(req.rid);
      if (w) {
        this.waiters.delete(req.rid);
        this.adapter.clearTimeout(w.timer);
        w.resolve(answer);
      }
    }
    return changed;
  }

  /**
   * Removes a title from a list, or from all lists but the history
   *
   * @param {{ title?: string, originalTitle?: string, year?: number | null }} movie title
   * @param {string | null} list list or null
   * @param {number} [now] timestamp
   * @returns {Record<string, any>} answer
   */
  removeBookmark(movie, list, now = Date.now()) {
    const card = this.findCard(movie);
    const lists = card ? this.listsOf(card.id).filter(l => (list ? l === list : l !== 'history')) : [];
    if (!card || !lists.length) {
      return { status: 'notFound', title: movie.title, list: list || undefined };
    }
    this.change({ favorite: lists.map(l => ({ k: `${l}:${card.id}`, ts: now, del: true })) }, now);
    return { status: 'removed', title: card.title || card.name || movie.title, lists };
  }

  /**
   * The bookmarks of the copy, newest first
   *
   * @param {string | null} list one list, or null for all lists but the history
   * @param {number} [limit] titles per list
   * @returns {Record<string, any>} answer
   */
  bookmarks(list, limit = 30) {
    const fav = this.state.data.favorite || {};
    const cards = this.state.data.cards || {};
    /** @type {Record<string, any[]>} */
    const lists = {};
    /** @type {Record<string, number>} */
    const totals = {};
    const entries = Object.keys(fav)
      .filter(k => !fav[k].del && fav[k].v)
      .sort((a, b) => fav[b].ts - fav[a].ts);
    for (const k of entries) {
      const { type, id } = fav[k].v;
      if (list ? type !== list : type === 'history') {
        continue;
      }
      totals[type] = (totals[type] || 0) + 1;
      if (totals[type] > limit) {
        continue;
      }
      const card = (cards[String(id)] || {}).v || {};
      const title = card.title || card.name || `TMDB ${id}`;
      const original = card.original_title || card.original_name;
      /** @type {Record<string, any>} */
      const item = { title };
      if (original && original !== title) {
        item.originalTitle = original;
      }
      if (cardYear(card)) {
        item.year = cardYear(card);
      }
      if (card.name !== undefined && card.title === undefined) {
        item.series = true;
      }
      (lists[type] = lists[type] || []).push(item);
    }
    const pending = (this.state.requests || [])
      .filter(/** @param {any} r */ r => !list || r.list === list)
      .map(/** @param {any} r */ r => ({ title: r.title, list: r.list }));
    return { lists, totals, ...(pending.length ? { pending } : {}) };
  }

  /**
   * The plugins of the copy for the admin
   *
   * @returns {{ url: string, name?: string, from?: string, ts: number }[]} plugins, newest first
   */
  plugins() {
    const map = this.state.data.plugins || {};
    return Object.keys(map)
      .filter(k => !map[k].del)
      .map(k => ({ ...map[k].v, ts: map[k].ts }))
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * Removes a plugin from the copy: devices that have it keep it, but it is no longer offered to others
   *
   * @param {unknown} url address
   * @param {number} [now] timestamp
   * @returns {boolean} true when it was in the copy
   */
  removePlugin(url, now = Date.now()) {
    const map = this.state.data.plugins || {};
    const k = pluginUrl(url);
    if (!k || !map[k] || map[k].del) {
      return false;
    }
    this.state.rev++;
    map[k] = { ts: now, rev: this.state.rev, del: true };
    this.scheduleSave();
    if (this.onDevice) {
      this.onDevice();
    }
    return true;
  }

  /** @returns {string | null} name of the device a reset waits for */
  pendingSource() {
    const r = this.state.reset;
    return r && !r.sourceDone ? (this.state.devices[r.source] || {}).name || r.source : null;
  }
}

module.exports = { LampaSync, MOUNT, FILE, GROUPS, OPT_IN_GROUPS, pluginUrl, FAVORITE_TYPES, AGENT_LISTS, MARKS, LIMITS, MODES };
