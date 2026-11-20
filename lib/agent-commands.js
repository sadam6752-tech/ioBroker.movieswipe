'use strict';

const { TYPES, DEFAULT_MIN_RATING, SUGGEST_EXCLUDE, SUGGEST_MIN_MOVIE_MINUTES } = require('./movie-search');
const { REPEAT_AFTER_DAYS } = require('./agent-history');

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
];

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
    'voice name two or three titles in one or two sentences, without descriptions.',
  'search {query? (words of the title, or names of the director or actors), person?, type?, genres?, moods?, ' +
    'excludeGenres?, minRating?, maxDuration?, minDuration?, yearFrom?, yearTo?, country?, sort? ' +
    '(rating | year | relevance), limit? (default 10, max 20), offset?}: finds titles; a title the household ' +
    'marked has status watched or skipped.',
  'getMovie {id}: the full card of a title (whole description, cast, poster URL).',
  'markMovie {id, status: watched | skipped | clear}: when the user says they have seen a title, do not want it, ' +
    'or a mark was wrong (clear). Watched and skipped titles are never suggested again.',
  'history {days? (default 7) or from? and to? (YYYY-MM-DD), action? (suggested | watched | skipped), limit? ' +
    '(default 30, max 100)}: what was suggested, watched or skipped, newest first, in local time; for questions ' +
    'like "what did you suggest yesterday?".',
  'genres {}: the genre and mood keys of the database and the number of titles.',
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
 * @param {{ search: { run: (op: string, args: Record<string, any>, exclude?: string[]) => Promise<any> }, history: import('./agent-history').AgentHistory }} ctx movie search and history
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
    default:
      throw new Error(`Unknown command ${command}`);
  }
}

module.exports = { COMMANDS, HELP, NAMES, runCommand, argsOf };
