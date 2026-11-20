'use strict';

/**
 * Worker thread of lib/movie-search.js: holds the slim index of the movie database while it runs.
 */

const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const { slim, collectKeys, search, suggest } = require('./movie-search');

/** @type {{ file: string, mtimeMs: number, size: number, index: Record<string, any>[], byId: Map<string, Record<string, any>>, keys: { genres: Set<string>, moods: Set<string> } } | null} */
let cache = null;

/**
 * Reads and parses the whole database
 *
 * @param {string} file path
 * @returns {Record<string, any>[]} movies
 */
function readMovies(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json || !Array.isArray(json.movies)) {
    throw new Error('The movie database is invalid');
  }
  return json.movies;
}

/**
 * The index of the database, loaded again when the file changed
 *
 * @param {string} file path
 * @returns {NonNullable<typeof cache>} index
 */
function load(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error('The movie database does not exist yet');
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache;
  }
  cache = null;
  const index = readMovies(file)
    .filter(m => m && m.id)
    .map(slim);
  cache = {
    file,
    mtimeMs: st.mtimeMs,
    size: st.size,
    index,
    byId: new Map(index.map(s => [s.id, s])),
    keys: collectKeys(index),
  };
  return cache;
}

/**
 * The full record of a movie (read from the file, the index holds a short description only)
 *
 * @param {string} file path
 * @param {string} id movie id
 * @returns {Record<string, any> | null} movie
 */
function getFull(file, id) {
  const { byId } = load(file);
  if (!byId.has(id)) {
    return null;
  }
  const m = readMovies(file).find(x => x && String(x.id) === id);
  if (!m) {
    return null;
  }
  const s = byId.get(id);
  return {
    id: s.id,
    title: s.title,
    originalTitle: s.originalTitle,
    year: s.year,
    type: s.type,
    rating: s.rating,
    duration: s.duration,
    genres: s.genres,
    moods: s.moods,
    countries: s.countries,
    director: s.director,
    cast: Array.isArray(m.cast) ? m.cast : [],
    description: m.description || '',
    poster: m.poster || '',
  };
}

parentPort.on('message', ({ id, file, op, args, exclude }) => {
  try {
    let result;
    if (op === 'search') {
      const c = load(file);
      result = search(c.index, c.keys, args || {});
    } else if (op === 'suggest') {
      const c = load(file);
      result = suggest(c.index, c.keys, args || {}, exclude || []);
    } else if (op === 'get') {
      result = getFull(file, String(args?.id ?? ''));
    } else if (op === 'brief') {
      const c = load(file);
      const s = c.byId.get(String(args?.id ?? ''));
      result = s ? { id: s.id, title: s.title, year: s.year, type: s.type } : null;
    } else if (op === 'keys') {
      const c = load(file);
      result = { genres: [...c.keys.genres].sort(), moods: [...c.keys.moods].sort(), movies: c.index.length };
    } else {
      throw new Error(`Unknown operation ${op}`);
    }
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
