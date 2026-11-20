'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MovieSearch, slim, collectKeys, search, suggest } = require('../lib/movie-search');
const { AgentHistory, REPEAT_AFTER_DAYS } = require('../lib/agent-history');
const { runCommand, COMMANDS, HELP } = require('../lib/agent-commands');

const DAY = 24 * 60 * 60 * 1000;

const MOVIES = [
  { id: 'kp-1', title: 'Джентльмены', originalTitle: 'The Gentlemen', year: 2019, contentType: 'movie', rating: 8.5, duration: 113, genres: ['crime', 'comedy', 'action'], moods: ['adrenaline', 'comedy'], countries: ['Великобритания', 'США'], director: 'Гай Ричи', cast: ['Мэттью Макконахи', 'Чарли Ханнэм', 'Генри Голдинг', 'Хью Грант'], description: 'x'.repeat(500), poster: 'p1' },
  { id: 'kp-2', title: 'Ёлки', originalTitle: '', year: 2010, contentType: 'movie', rating: 7.1, duration: 90, genres: ['comedy', 'family'], moods: ['cozy', 'light-positive'], countries: ['Россия'], director: 'Тимур Бекмамбетов', cast: ['Иван Ургант'], description: 'Новогодняя комедия', poster: 'p2' },
  { id: 'kp-3', title: 'Друзья', originalTitle: 'Friends', year: 1994, contentType: 'tv-series', rating: 9.2, duration: 22, genres: ['comedy', 'melodrama'], moods: ['light-positive'], countries: ['США'], director: '', cast: ['Дженнифер Энистон'], description: 'Ситком', poster: 'p3' },
  { id: 'kp-4', title: 'Короткий смех', originalTitle: 'Short Laugh', year: 2020, contentType: 'movie', rating: 9.5, duration: 15, genres: ['comedy', 'short'], moods: ['comedy'], countries: ['США'], director: 'X', cast: [], description: '', poster: '' },
  { id: 'kp-5', title: 'Стендап', originalTitle: 'Stand-up', year: 2021, contentType: 'movie', rating: 9.0, duration: 70, genres: ['comedy', 'concert'], moods: ['comedy'], countries: ['США'], director: 'Y', cast: [], description: '', poster: '' },
  { id: 'kp-6', title: 'Слабая комедия', originalTitle: 'Weak Comedy', year: 2015, contentType: 'movie', rating: 5.0, duration: 95, genres: ['comedy'], moods: ['comedy'], countries: ['США'], director: 'Z', cast: [], description: '', poster: '' },
  { id: 'kp-7', title: 'Шерлок Холмс', originalTitle: 'Sherlock Holmes', year: 2009, contentType: 'movie', rating: 8.1, duration: 128, genres: ['detective', 'action', 'comedy'], moods: ['adrenaline'], countries: ['США', 'Великобритания'], director: 'Гай Ричи', cast: ['Роберт Дауни мл.'], description: 'Детектив', poster: 'p7' },
];

const index = MOVIES.map(slim);
const keys = collectKeys(index);

describe('movie search', () => {
  it('slim cuts the description and keeps three actors', () => {
    assert.strictEqual(index[0].description.length, 301);
    assert.deepStrictEqual(index[0].cast, ['Мэттью Макконахи', 'Чарли Ханнэм', 'Генри Голдинг']);
    assert.strictEqual(index[0].rating, 8.5);
  });

  it('search finds by director and sorts by rating', () => {
    const res = search(index, keys, { query: 'гай ричи' });
    assert.deepStrictEqual(
      res.movies.map(m => m.id),
      ['kp-1', 'kp-7'],
    );
    assert.ok(!('_title' in res.movies[0]));
  });

  it('search treats ё as е and finds the original title', () => {
    assert.strictEqual(search(index, keys, { query: 'елки' }).movies[0].id, 'kp-2');
    assert.strictEqual(search(index, keys, { query: 'gentlemen' }).movies[0].id, 'kp-1');
  });

  it('search filters by type, genre, mood, rating, duration, years and country', () => {
    const ids = args => search(index, keys, args).movies.map(m => m.id);
    assert.deepStrictEqual(ids({ type: 'series' }), ['kp-3']);
    assert.deepStrictEqual(ids({ genres: 'family' }), ['kp-2']);
    assert.deepStrictEqual(ids({ moods: ['cozy'] }), ['kp-2']);
    assert.deepStrictEqual(ids({ genres: 'comedy', minRating: 9.1 }), ['kp-4', 'kp-3']);
    assert.deepStrictEqual(ids({ type: 'movie', maxDuration: 92, minDuration: 60 }), ['kp-5', 'kp-2']);
    assert.deepStrictEqual(ids({ yearFrom: 2019, yearTo: 2019 }), ['kp-1']);
    assert.deepStrictEqual(ids({ country: 'россия' }), ['kp-2']);
  });

  it('search pages with limit and offset', () => {
    const res = search(index, keys, { limit: 2, offset: 1 });
    assert.strictEqual(res.total, 7);
    assert.strictEqual(res.movies.length, 2);
  });

  it('search rejects unknown types, genres and moods with the allowed values', () => {
    assert.throws(() => search(index, keys, { type: 'film' }), /movie, series/);
    assert.throws(() => search(index, keys, { genres: 'komedia' }), /comedy/);
    assert.throws(() => search(index, keys, { moods: 'sad' }), /cozy/);
  });

  it('suggest leaves out shorts, concerts, weak and too short movies and excluded ids', () => {
    const res = suggest(index, keys, { type: 'movie', genres: 'comedy', count: 5 }, ['kp-7']);
    assert.deepStrictEqual(res.movies.map(m => m.id).sort(), ['kp-1', 'kp-2']);
  });

  it('suggest offers a short when it is asked for', () => {
    const res = suggest(index, keys, { type: 'movie', genres: 'short', minDuration: 0 }, []);
    assert.deepStrictEqual(
      res.movies.map(m => m.id),
      ['kp-4'],
    );
  });

  it('suggest picks randomly and never twice', () => {
    const res = suggest(index, keys, { type: 'any', count: 3 }, [], () => 0.99);
    assert.strictEqual(new Set(res.movies.map(m => m.id)).size, res.movies.length);
    assert.strictEqual(res.movies.length, 3);
  });
});

/** An adapter with a file storage in memory */
function fakeAdapter() {
  const files = {};
  return {
    files,
    namespace: 'movieswipe.0',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: t => clearTimeout(t),
    fileExistsAsync: async (_m, f) => f in files,
    readFileAsync: async (_m, f) => ({ file: files[f] }),
    writeFileAsync: async (_m, f, d) => {
      files[f] = d;
    },
  };
}

describe('agent history', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-h-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('excludes watched and skipped for good and suggestions for 30 days', async () => {
    const h = new AgentHistory(fakeAdapter(), dir);
    await h.init();
    const now = Date.now();
    await h.add([{ id: 'a' }], 'suggested', now - (REPEAT_AFTER_DAYS + 1) * DAY);
    await h.add([{ id: 'b' }], 'suggested', now - DAY);
    await h.add([{ id: 'c' }], 'watched', now - 400 * DAY);
    await h.add([{ id: 'd' }], 'skipped', now);
    await h.add([{ id: 'e' }], 'watched', now - DAY);
    await h.add([{ id: 'e' }], 'cleared', now);
    assert.deepStrictEqual(h.excluded(now).sort(), ['b', 'c', 'd']);
    assert.deepStrictEqual([...h.statuses().keys()].sort(), ['c', 'd']);
  });

  it('answers periods newest first and filters by action', async () => {
    const h = new AgentHistory(fakeAdapter(), dir);
    const now = new Date(2026, 10, 20, 20, 0).getTime();
    await h.add([{ id: 'a', title: 'A' }], 'suggested', now - DAY);
    await h.add([{ id: 'b', title: 'B' }], 'watched', now - 10 * DAY);
    await h.add([{ id: 'c', title: 'C' }], 'suggested', now);
    assert.deepStrictEqual(
      h.query({}, now).entries.map(e => e.id),
      ['c', 'a'],
    );
    const yesterday = h.query({ from: '2026-11-19', to: '2026-11-19' }, now);
    assert.deepStrictEqual(
      yesterday.entries.map(e => [e.id, e.time]),
      [['a', '2026-11-19 20:00']],
    );
    assert.deepStrictEqual(
      h.query({ days: 30, action: 'watched' }, now).entries.map(e => e.id),
      ['b'],
    );
    assert.throws(() => h.query({ action: 'liked' }, now), /suggested/);
  });

  it('is saved locally and in the file storage, and restored from the storage', async () => {
    const adapter = fakeAdapter();
    const h = new AgentHistory(adapter, dir);
    await h.add([{ id: 'a', title: 'A' }], 'watched');
    assert.ok(fs.existsSync(path.join(dir, 'agent-history.json')));
    assert.ok('agent-history.json' in adapter.files);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-h-'));
    try {
      const restored = new AgentHistory(adapter, fresh);
      await restored.init();
      assert.strictEqual(restored.statuses().get('a').status, 'watched');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('agent commands with the worker', () => {
  let dir;
  let ctx;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-c-'));
    const file = path.join(dir, 'movies.json');
    fs.writeFileSync(file, JSON.stringify({ movies: MOVIES }));
    const adapter = fakeAdapter();
    ctx = { search: new MovieSearch(adapter, file, 60000), history: new AgentHistory(adapter, dir) };
    await ctx.history.init();
  });
  after(() => {
    ctx.search.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('help lists every command with its write flag', async () => {
    const res = await runCommand('help', undefined, ctx);
    assert.strictEqual(res.help, HELP);
    assert.deepStrictEqual(res.commands, COMMANDS);
    assert.ok(COMMANDS.every(c => typeof c.write === 'boolean'));
  });

  it('suggest without a type asks for one and logs nothing', async () => {
    const res = await runCommand('suggest', { genres: 'comedy' }, ctx);
    assert.strictEqual(res.needType, true);
    assert.strictEqual(ctx.history.entries.length, 0);
  });

  it('suggest logs its titles and does not repeat them', async () => {
    const first = await runCommand('suggest', { type: 'movie', genres: 'comedy', count: 5 }, ctx);
    assert.strictEqual(first.movies.length, 3);
    assert.strictEqual(ctx.history.query({ action: 'suggested' }).total, 3);
    const second = await runCommand('suggest', '{"type":"movie","genres":"comedy"}', ctx);
    assert.strictEqual(second.movies.length, 0);
    assert.match(second.hint, /loosen/);
  });

  it('markMovie marks a title, search shows it, clear removes it', async () => {
    const res = await runCommand('markMovie', { id: 'kp-3', status: 'watched' }, ctx);
    assert.deepStrictEqual(res, { ok: true, id: 'kp-3', title: 'Друзья', status: 'watched' });
    const found = await runCommand('search', { type: 'series' }, ctx);
    assert.strictEqual(found.movies[0].status, 'watched');
    await runCommand('markMovie', { id: 'kp-3', status: 'clear' }, ctx);
    assert.ok(!ctx.history.statuses().has('kp-3'));
    await assert.rejects(runCommand('markMovie', { id: 'kp-3', status: 'liked' }, ctx), /watched, skipped/);
    await assert.rejects(runCommand('markMovie', { id: 'kp-99', status: 'watched' }, ctx), /No title/);
  });

  it('getMovie returns the whole description and cast', async () => {
    const m = await runCommand('getMovie', { id: 'kp-1' }, ctx);
    assert.strictEqual(m.description.length, 500);
    assert.strictEqual(m.cast.length, 4);
    assert.strictEqual(m.poster, 'p1');
    await assert.rejects(runCommand('getMovie', { id: 'kp-99' }, ctx), /No title/);
  });

  it('genres lists the keys and the number of titles', async () => {
    const res = await runCommand('genres', {}, ctx);
    assert.strictEqual(res.movies, MOVIES.length);
    assert.ok(res.genres.includes('comedy'));
    assert.ok(res.moods.includes('cozy'));
  });

  it('the worker reloads a changed database', async () => {
    fs.writeFileSync(ctx.search.file, JSON.stringify({ movies: [...MOVIES, { ...MOVIES[1], id: 'kp-8' }] }));
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(ctx.search.file, later, later);
    const res = await runCommand('genres', {}, ctx);
    assert.strictEqual(res.movies, MOVIES.length + 1);
  });

  it('the worker ends when idle and starts again', async () => {
    const adapter = fakeAdapter();
    const s = new MovieSearch(adapter, ctx.search.file, 50);
    await s.run('keys', {});
    assert.ok(s.worker);
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(s.worker, null);
    const res = await s.run('keys', {});
    assert.ok(res.movies > 0);
    s.stop();
  });
});
