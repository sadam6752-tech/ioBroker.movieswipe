'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

/**
 * Search in the movie database for AI agents (commands search, suggest, getMovie).
 *
 * The database has 80 000+ movies (about 140 MB of JSON, several hundred MB once parsed), so it is never loaded
 * into the adapter process: a worker thread loads a slim index on the first request and ends after IDLE_MS
 * without requests, which frees the memory again. The worker reloads the index when the file changed (sync,
 * upload in the Backup Manager).
 */

/** Content types an agent may ask for, mapped to `contentType` of the database */
const TYPES = {
  movie: ['movie'],
  series: ['tv-series'],
  cartoon: ['cartoon', 'animated-series'],
  anime: ['anime'],
  any: null,
};

const DESCRIPTION_CHARS = 300;
const MAX_LIMIT = 20;
const MAX_SUGGEST = 5;
const SUGGEST_POOL = 100;
const DEFAULT_MIN_RATING = 6.5;
/** suggest leaves these genres out unless they are asked for */
const SUGGEST_EXCLUDE = ['short', 'documentary', 'concert', 'talk-show'];
/** suggest offers movies of at least this many minutes unless minDuration is given */
const SUGGEST_MIN_MOVIE_MINUTES = 60;
const IDLE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

/**
 * Lower case, "ё" as "е", without punctuation
 *
 * @param {unknown} s text
 * @returns {string} normalized text
 */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The fields of a movie the search needs (descriptions are cut, posters dropped)
 *
 * @param {Record<string, any>} m movie of the database
 * @returns {Record<string, any>} slim movie
 */
function slim(m) {
  const cast = Array.isArray(m.cast) ? m.cast : [];
  const description = String(m.description || '');
  return {
    id: String(m.id),
    title: m.title || '',
    originalTitle: m.originalTitle || '',
    year: m.year || null,
    type: m.contentType || '',
    rating: typeof m.rating === 'number' ? Math.round(m.rating * 10) / 10 : null,
    duration: m.duration || null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    moods: Array.isArray(m.moods) ? m.moods : [],
    countries: Array.isArray(m.countries) ? m.countries : [],
    director: m.director || '',
    cast: cast.slice(0, 3),
    description: description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS)}…` : description,
    _title: ` ${norm(m.title)} ${norm(m.originalTitle)} `,
    _people: ` ${norm(m.director)} ${norm(cast.join(' '))} `,
    _countries: norm((m.countries || []).join(' ')),
  };
}

/**
 * A movie for the answer: the slim movie without the search helpers
 *
 * @param {Record<string, any>} s slim movie
 * @returns {Record<string, any>} movie for the answer
 */
function brief(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!k.startsWith('_')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A list argument: array, or a comma separated string
 *
 * @param {unknown} v value
 * @returns {string[]} list in lower case
 */
function list(v) {
  if (v === undefined || v === null || v === '') {
    return [];
  }
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(x => String(x).trim().toLowerCase()).filter(Boolean);
}

/**
 * A number argument, or undefined
 *
 * @param {unknown} v value
 * @returns {number | undefined} number
 */
function num(v) {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Checks the arguments and turns them into a filter. Throws with a message for the agent on a wrong argument.
 *
 * @param {Record<string, any>} args arguments of the command
 * @param {{ genres: Set<string>, moods: Set<string> }} keys genre and mood keys of the database
 * @returns {Record<string, any>} filter
 */
function makeFilter(args, keys) {
  const f = {};
  if (args.type !== undefined && args.type !== null && args.type !== '') {
    const t = String(args.type).toLowerCase();
    if (!(t in TYPES)) {
      throw new Error(`Unknown type "${args.type}", use one of: ${Object.keys(TYPES).join(', ')}`);
    }
    f.types = TYPES[t];
  }
  f.genres = list(args.genres ?? args.genre);
  f.moods = list(args.moods ?? args.mood);
  /**
   * @param {string} name genre or mood
   * @param {string[]} values asked keys
   * @param {Set<string>} known keys of the database
   */
  const check = (name, values, known) => {
    const unknown = values.filter(v => !known.has(v));
    if (unknown.length) {
      throw new Error(`Unknown ${name} "${unknown.join(', ')}", use one of: ${[...known].sort().join(', ')}`);
    }
  };
  check('genre', f.genres, keys.genres);
  check('mood', f.moods, keys.moods);
  f.excludeGenres = list(args.excludeGenres);
  f.yearFrom = num(args.yearFrom);
  f.yearTo = num(args.yearTo);
  f.minRating = num(args.minRating);
  f.maxDuration = num(args.maxDuration);
  f.minDuration = num(args.minDuration);
  f.country = norm(args.country);
  f.query = norm(args.query);
  f.person = norm(args.person);
  return f;
}

/**
 * Whether a movie passes the filter
 *
 * @param {Record<string, any>} s slim movie
 * @param {Record<string, any>} f filter
 * @returns {boolean} true when it matches
 */
function matches(s, f) {
  if (f.types && !f.types.includes(s.type)) {
    return false;
  }
  if (f.genres.length && !f.genres.some(g => s.genres.includes(g))) {
    return false;
  }
  if (f.moods.length && !f.moods.some(m => s.moods.includes(m))) {
    return false;
  }
  if (f.excludeGenres.length && f.excludeGenres.some(g => s.genres.includes(g))) {
    return false;
  }
  if (f.yearFrom !== undefined && !(s.year >= f.yearFrom)) {
    return false;
  }
  if (f.yearTo !== undefined && !(s.year <= f.yearTo)) {
    return false;
  }
  if (f.minRating !== undefined && !(s.rating >= f.minRating)) {
    return false;
  }
  if (f.maxDuration !== undefined && !(s.duration > 0 && s.duration <= f.maxDuration)) {
    return false;
  }
  if (f.minDuration !== undefined && !(s.duration >= f.minDuration)) {
    return false;
  }
  if (f.country && !s._countries.includes(f.country)) {
    return false;
  }
  if (f.query && !f.query.split(' ').every(w => s._title.includes(w) || s._people.includes(w))) {
    return false;
  }
  if (f.person && !f.person.split(' ').every(w => s._people.includes(w))) {
    return false;
  }
  return true;
}

/**
 * The genre and mood keys of a slim index
 *
 * @param {Record<string, any>[]} index slim movies
 * @returns {{ genres: Set<string>, moods: Set<string> }} keys
 */
function collectKeys(index) {
  const genres = new Set();
  const moods = new Set();
  for (const s of index) {
    s.genres.forEach(g => genres.add(g));
    s.moods.forEach(m => moods.add(m));
  }
  return { genres, moods };
}

/**
 * Command search: filter, sort, page
 *
 * @param {Record<string, any>[]} index slim movies
 * @param {{ genres: Set<string>, moods: Set<string> }} keys keys of the index
 * @param {Record<string, any>} args arguments
 * @returns {{ total: number, offset: number, movies: Record<string, any>[] }} answer
 */
function search(index, keys, args) {
  const f = makeFilter(args, keys);
  const hits = index.filter(s => matches(s, f));
  const sort = String(args.sort || (f.query ? 'relevance' : 'rating')).toLowerCase();
  const byRating = (a, b) => (b.rating || 0) - (a.rating || 0);
  if (sort === 'year') {
    hits.sort((a, b) => (b.year || 0) - (a.year || 0) || byRating(a, b));
  } else if (sort === 'relevance' && f.query) {
    // an exact title first, then the titles that start with the query, then the rest by rating
    const rank = s => (s._title.includes(` ${f.query} `) ? 0 : s._title.includes(` ${f.query}`) ? 1 : 2);
    hits.sort((a, b) => rank(a) - rank(b) || byRating(a, b));
  } else {
    hits.sort(byRating);
  }
  const limit = Math.min(Math.max(num(args.limit) ?? 10, 1), MAX_LIMIT);
  const offset = Math.max(num(args.offset) ?? 0, 0);
  return { total: hits.length, offset, movies: hits.slice(offset, offset + limit).map(brief) };
}

/**
 * Command suggest: random movies from the best rated matches that are not excluded
 *
 * @param {Record<string, any>[]} index slim movies
 * @param {{ genres: Set<string>, moods: Set<string> }} keys keys of the index
 * @param {Record<string, any>} args arguments (type is required by the caller)
 * @param {string[]} exclude ids not to suggest
 * @param {() => number} [random] random source, for tests
 * @returns {{ total: number, movies: Record<string, any>[] }} answer
 */
function suggest(index, keys, args, exclude, random = Math.random) {
  const f = makeFilter(args, keys);
  if (f.minRating === undefined) {
    f.minRating = DEFAULT_MIN_RATING;
  }
  f.excludeGenres = [...new Set([...f.excludeGenres, ...SUGGEST_EXCLUDE.filter(g => !f.genres.includes(g))])];
  if (f.minDuration === undefined && f.types && f.types.includes('movie')) {
    f.minDuration = SUGGEST_MIN_MOVIE_MINUTES;
  }
  const skip = new Set(exclude);
  const hits = index.filter(s => !skip.has(s.id) && matches(s, f));
  hits.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const pool = hits.slice(0, SUGGEST_POOL);
  const count = Math.min(Math.max(num(args.count) ?? 3, 1), MAX_SUGGEST);
  const picked = [];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return { total: hits.length, movies: picked.map(brief) };
}

/**
 * Runs the search in a worker thread that loads the database on the first request and ends when idle.
 */
class MovieSearch {
  /**
   * @param {any} adapter adapter instance (log, setTimeout)
   * @param {string} file path of the movie database
   * @param {number} [idleMs] end the worker after this time without requests
   */
  constructor(adapter, file, idleMs = IDLE_MS) {
    this.adapter = adapter;
    this.file = file;
    this.idleMs = idleMs;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.idleTimer = null;
  }

  /**
   * Runs an operation in the worker
   *
   * @param {string} op search | suggest | get
   * @param {Record<string, any>} args arguments
   * @param {string[]} [exclude] ids not to suggest
   * @returns {Promise<any>} result
   */
  run(op, args, exclude = []) {
    this.startWorker();
    this.touch();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = this.adapter.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The movie search did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, file: this.file, op, args, exclude });
    });
  }

  startWorker() {
    if (this.worker) {
      return;
    }
    const worker = new Worker(path.join(__dirname, 'movie-search-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    worker.on('message', ({ id, result, error }) => {
      const p = this.pending.get(id);
      if (!p) {
        return;
      }
      this.pending.delete(id);
      this.adapter.clearTimeout(p.timer);
      if (error) {
        p.reject(new Error(error));
      } else {
        p.resolve(result);
      }
    });
    const fail = err => {
      if (this.worker !== worker) {
        return;
      }
      this.worker = null;
      for (const p of this.pending.values()) {
        this.adapter.clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    worker.on('error', err => {
      this.adapter.log.warn(`Movie search worker failed: ${err.message}`);
      fail(err);
    });
    worker.on('exit', () => fail(new Error('The movie search stopped')));
    this.worker = worker;
    this.adapter.log.debug('Movie search worker started');
  }

  /** Restarts the idle timer */
  touch() {
    if (this.idleTimer) {
      this.adapter.clearTimeout(this.idleTimer);
    }
    this.idleTimer = this.adapter.setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size) {
        this.touch();
        return;
      }
      this.adapter.log.debug('Movie search idle, worker ended');
      this.stop();
    }, this.idleMs);
  }

  /** Ends the worker and frees its memory */
  stop() {
    if (this.idleTimer) {
      this.adapter.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) {
      this.adapter.clearTimeout(p.timer);
      p.reject(new Error('The movie search stopped'));
    }
    this.pending.clear();
    if (worker) {
      worker.terminate().catch(() => {});
    }
  }
}

module.exports = {
  MovieSearch,
  TYPES,
  DEFAULT_MIN_RATING,
  SUGGEST_EXCLUDE,
  SUGGEST_MIN_MOVIE_MINUTES,
  norm,
  slim,
  brief,
  makeFilter,
  matches,
  collectKeys,
  search,
  suggest,
};
