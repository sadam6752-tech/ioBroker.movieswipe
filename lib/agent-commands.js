'use strict';

const { TYPES, DEFAULT_MIN_RATING, SUGGEST_EXCLUDE, SUGGEST_MIN_MOVIE_MINUTES } = require('./movie-search');
const { REPEAT_AFTER_DAYS } = require('./agent-history');
const { AGENT_LISTS, FAVORITE_TYPES } = require('./lampa-sync');

/**
 * Commands for AI agents such as ioBroker.pi-agent, with the `help` answer of js-controller PR #3638
 * ({ help, commands: [{ command, write }] }). `write: true` changes the history of the household.
 */
const COMMANDS = [
  { command: 'help', write: false },
  { command: 'suggest', write: true },
  { command: 'search', write: false },
  { command: 'getMovie', write: false },
  { command: 'markMovie', write: true },
  { command: 'history', write: false },
  { command: 'genres', write: false },
  { command: 'openInLampa', write: true },
  { command: 'lampaDevices', write: false },
  { command: 'addBookmark', write: true },
  { command: 'removeBookmark', write: true },
  { command: 'bookmarks', write: false },
  { command: 'markWatched', write: true },
];

/** Words for the Lampa lists an agent may use, besides their own names */
const LIST_ALIASES = {
  later: 'wath',
  watchlater: 'wath',
  bookmark: 'book',
  bookmarks: 'book',
  favorite: 'like',
  favourite: 'like',
  liked: 'like',
  watching: 'look',
  watched: 'viewed',
  seen: 'viewed',
  planned: 'scheduled',
  continue: 'continued',
  dropped: 'thrown',
  abandoned: 'thrown',
};
const SERIES_TYPES = ['tv-series', 'animated-series'];

const GENRES =
  'drama, comedy, melodrama, thriller, action, crime, detective, adventure, fantasy, sci-fi, family, horror, ' +
  'historical, biography, documentary, short, war, kids, music, sport, musical, western, talk-show, concert';
const MOODS =
  'philosophical, emotional, adrenaline, light-positive, comedy, fantasy, romance, horror, energize, cozy, nostalgia';

const HELP = [
  'MovieSwipe holds a movie and series database (from Kinopoisk: title and description in Russian, originalTitle ' +
    'in the original language) and one shared history of the household: what was suggested, watched or skipped. ' +
    'Use it to find movies and to recommend what to watch. Every command takes an object as message.',
  '',
  `suggest {type, genres?, moods?, excludeGenres?, minRating? (default ${DEFAULT_MIN_RATING}), maxDuration? ` +
    '(minutes), yearFrom?, yearTo?, country?, count? (default 3, max 5)}: random well rated titles the household ' +
    `has not watched, skipped or been offered in the last ${REPEAT_AFTER_DAYS} days. type is required: ` +
    `${Object.keys(TYPES).join(', ')}. When the user did not say whether they want a movie or a series, ask them ` +
    `first; without type the command answers needType. Unless asked for, ${SUGGEST_EXCLUDE.join(', ')} are left ` +
    `out and a movie lasts at least ${SUGGEST_MIN_MOVIE_MINUTES} minutes (minDuration changes it). ` +
    'Every returned title is logged as suggested, so present ' +
    'all of them. Explain the choice from rating, genres and description and name the original title too. By ' +
    'voice name two or three titles in one or two sentences, without descriptions. Each title has the URL of ' +
    'its poster (poster) when the database has one.',
  'search {query? (words of the title, or names of the director or actors), person?, type?, genres?, moods?, ' +
    'excludeGenres?, minRating?, maxDuration?, minDuration?, yearFrom?, yearTo?, country?, sort? ' +
    '(rating | year | relevance), limit? (default 10, max 20), offset?}: finds titles; a title the household ' +
    'marked has status watched or skipped.',
  'getMovie {id}: the full card of a title (whole description, cast, poster URL).',
  'To show a title in Telegram, send its poster as a photo with a caption: send_to telegram.0 "send" {text: <poster ' +
    'URL>, type: "photo", caption: "<title> (<original title>, <year>), <rating>: <a few words on it>"}. The poster ' +
    'URLs have no file extension, so type "photo" is needed, otherwise the link arrives as text. A caption holds ' +
    'at most 1024 characters.',
  'markMovie {id, status: watched | skipped | clear}: when the user says they have seen a title, do not want it, ' +
    'or a mark was wrong (clear). Watched and skipped titles are never suggested again.',
  'history {days? (default 7) or from? and to? (YYYY-MM-DD), action? (suggested | watched | skipped), limit? ' +
    '(default 30, max 100)}: what was suggested, watched or skipped, newest first, in local time; for questions ' +
    'like "what did you suggest yesterday?".',
  'genres {}: the genre and mood keys of the database and the number of titles.',
  'openInLampa {id, device?}: opens the card of a title in the Lampa app on a TV or player (the user can then ' +
    'start it there). Offer it after suggest or search when the user wants to watch. device is the name of the ' +
    'device the user said; leave it out when only one is online, the answer names the devices when there are ' +
    'several. status opened: the card is shown; search: no exact match, Lampa shows its search for the title; ' +
    'sent: the device did not confirm. Lampa must be open on the device with the MovieSwipe plugin.',
  'lampaDevices {}: the Lampa devices that are online now.',
  'Lampa bookmarks (when the Lampa sync of bookmarks is on in the adapter): changes reach every Lampa device of the ' +
    'household at once when Lampa is open there, otherwise when it is opened. Lists: book (bookmarks, default), ' +
    'like (favourites), wath (watch later), and the marks look (watching), viewed (watched), scheduled (planned), ' +
    'continued (waiting for new episodes), thrown (dropped); a title has at most one mark. Words like later, ' +
    'watched or dropped are understood too.',
  'addBookmark {id, list?}: id is the id of a title from suggest or search, or a title in words. status added; ' +
    'already: it was there; queued: no Lampa is open now, it is added when one opens; notFound: Lampa found no ' +
    'match, tell the user.',
  'removeBookmark {id, list?}: without list the title leaves every list but the history. status removed or notFound.',
  'bookmarks {list?}: the titles in the lists, newest first (30 per list, totals has the counts); without list all ' +
    'lists but history. For "what is in my bookmarks?" name a few titles per list.',
  'markWatched {id}: the user has seen a title: sets the Lampa mark viewed on all devices and marks it watched in ' +
    'MovieSwipe (as markMovie watched).',
  '',
  `Genre keys: ${GENRES}.`,
  `Mood keys: ${MOODS}.`,
  'Map the words of the user to them: a comedy is genres comedy; something light is moods light-positive or ' +
    'cozy; with children is genres family or kids; something exciting is moods adrenaline. genres and moods ' +
    'match when a title has any of the given keys.',
  'The first request after ten minutes of rest loads the database and takes a few seconds.',
].join('\n');

const NAMES = COMMANDS.map(c => c.command);

/**
 * The message of sendTo as object (a JSON string is parsed)
 *
 * @param {unknown} message message
 * @returns {Record<string, any>} arguments
 */
function argsOf(message) {
  if (message && typeof message === 'object') {
    return /** @type {Record<string, any>} */ (message);
  }
  if (typeof message === 'string' && message.trim().startsWith('{')) {
    try {
      return JSON.parse(message);
    } catch {
      // not JSON: no arguments
    }
  }
  return {};
}

/**
 * Normalizes a title for comparing
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
 * The list of a bookmark command
 *
 * @param {unknown} value list the agent gave
 * @param {string | null} fallback list when none is given
 * @param {string[]} allowed allowed lists
 * @returns {string | null} list
 */
function listOf(value, fallback, allowed) {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (!raw) {
    return fallback;
  }
  const list = /** @type {Record<string, string>} */ (LIST_ALIASES)[raw] || raw;
  if (!allowed.includes(list)) {
    throw new Error(`list must be one of ${allowed.join(', ')}`);
  }
  return list;
}

/**
 * The title an agent means: an id of the database, or a title in words
 *
 * @param {{ search: { run: (op: string, args: Record<string, any>) => Promise<any> } }} ctx movie search
 * @param {unknown} id id or title
 * @returns {Promise<Record<string, any>>} movie (id null when the title is not in the database)
 */
async function movieOf(ctx, id) {
  const text = String(id ?? '').trim();
  if (!text) {
    throw new Error('id is missing');
  }
  const movie = await ctx.search.run('brief', { id: text });
  if (movie) {
    return movie;
  }
  const res = await ctx.search.run('search', { query: text, limit: 5, sort: 'relevance' });
  const exact = (res && res.movies ? res.movies : []).find(
    /** @param {any} m */ m => norm(m.title) === norm(text) || norm(m.originalTitle) === norm(text),
  );
  return exact || { id: null, title: text, originalTitle: '', year: null, type: '' };
}

/**
 * The Lampa sync, when bookmarks are synced
 *
 * @param {{ lampaSync?: import('./lampa-sync').LampaSync | null }} ctx context
 * @returns {import('./lampa-sync').LampaSync} sync
 */
function bookmarkSync(ctx) {
  if (!ctx.lampaSync || !ctx.lampaSync.bookmarksOn()) {
    throw new Error(
      'Lampa bookmarks need the Lampa sync with bookmarks switched on in the MovieSwipe adapter settings',
    );
  }
  return ctx.lampaSync;
}

/**
 * Adds the status of the household to movies
 *
 * @param {Record<string, any>[]} movies movies
 * @param {Map<string, { status: string }>} statuses status by id
 * @returns {Record<string, any>[]} movies
 */
function withStatus(movies, statuses) {
  return movies.map(m => (statuses.has(m.id) ? { ...m, status: statuses.get(m.id).status } : m));
}

/**
 * Runs a command of an agent
 *
 * @param {string} command command
 * @param {unknown} message message of sendTo
 * @param {{ search: { run: (op: string, args: Record<string, any>, exclude?: string[]) => Promise<any> }, history: import('./agent-history').AgentHistory, lampa?: import('./lampa-bridge').LampaBridge | null, lampaSync?: import('./lampa-sync').LampaSync | null }} ctx movie search, history, Lampa devices and Lampa sync
 * @returns {Promise<Record<string, any>>} answer
 */
async function runCommand(command, message, ctx) {
  const args = argsOf(message);
  switch (command) {
    case 'help':
      return { help: HELP, commands: COMMANDS };
    case 'search': {
      const res = await ctx.search.run('search', args);
      return { ...res, movies: withStatus(res.movies, ctx.history.statuses()) };
    }
    case 'suggest': {
      if (!args.type) {
        return {
          needType: true,
          question: `Ask the user what to watch: ${Object.keys(TYPES).join(', ')}; then call suggest with type.`,
        };
      }
      const res = await ctx.search.run('suggest', args, ctx.history.excluded());
      if (res.movies.length) {
        await ctx.history.add(res.movies, 'suggested');
      }
      return res.movies.length
        ? res
        : { ...res, hint: 'Nothing new matches: loosen the filters (genres, minRating, maxDuration, years).' };
    }
    case 'getMovie': {
      if (!args.id) {
        throw new Error('id is missing');
      }
      const movie = await ctx.search.run('get', { id: args.id });
      if (!movie) {
        throw new Error(`No title with id ${args.id}`);
      }
      return withStatus([movie], ctx.history.statuses())[0];
    }
    case 'markMovie': {
      const status = String(args.status || '').toLowerCase();
      const action = status === 'clear' ? 'cleared' : status;
      if (!['watched', 'skipped', 'cleared'].includes(action)) {
        throw new Error('status must be watched, skipped or clear');
      }
      if (!args.id) {
        throw new Error('id is missing');
      }
      const movie = await ctx.search.run('brief', { id: args.id });
      if (!movie) {
        throw new Error(`No title with id ${args.id}`);
      }
      await ctx.history.add([movie], action);
      return { ok: true, id: movie.id, title: movie.title, status: status === 'clear' ? null : action };
    }
    case 'history':
      return ctx.history.query(args);
    case 'genres':
      return ctx.search.run('keys', {});
    case 'openInLampa': {
      if (!args.id) {
        throw new Error('id is missing');
      }
      if (!ctx.lampa) {
        throw new Error('The Lampa connection needs the web server of the adapter, which is not running');
      }
      ctx.lampa.pick(args.device);
      const movie = await ctx.search.run('brief', { id: args.id });
      if (!movie) {
        throw new Error(`No title with id ${args.id}`);
      }
      return ctx.lampa.open(movie, args.device);
    }
    case 'lampaDevices':
      return { devices: ctx.lampa ? ctx.lampa.online().map(d => ({ name: d.name, platform: d.platform })) : [] };
    case 'addBookmark':
    case 'markWatched': {
      const sync = bookmarkSync(ctx);
      const list = command === 'markWatched' ? 'viewed' : listOf(args.list, 'book', AGENT_LISTS);
      const movie = await movieOf(ctx, args.id);
      const online = !!(ctx.lampa && ctx.lampa.online().length);
      const answer = await sync.addBookmark(movie, /** @type {string} */ (list), {
        online,
        series: SERIES_TYPES.includes(movie.type || ''),
      });
      if (command === 'markWatched' && movie.id && ctx.history) {
        await ctx.history.add([movie], 'watched');
      }
      return movie.id ? { id: movie.id, ...answer } : answer;
    }
    case 'removeBookmark': {
      const sync = bookmarkSync(ctx);
      const list = listOf(args.list, null, FAVORITE_TYPES);
      return sync.removeBookmark(await movieOf(ctx, args.id), list);
    }
    case 'bookmarks':
      return bookmarkSync(ctx).bookmarks(listOf(args.list, null, FAVORITE_TYPES));
    default:
      throw new Error(`Unknown command ${command}`);
  }
}

module.exports = { COMMANDS, HELP, NAMES, runCommand, argsOf };
