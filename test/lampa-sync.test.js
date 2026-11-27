'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LampaSync } = require('../lib/lampa-sync');
const { LampaBridge } = require('../lib/lampa-bridge');
const { runCommand, COMMANDS } = require('../lib/agent-commands');

const KEY = 'secret-key';
const NOW = 1_800_000_000_000;

function fakeAdapter() {
  return {
    log: { info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
  };
}

function newSync(groups) {
  return new LampaSync(fakeAdapter(), { key: KEY, groups });
}

/** A request of a device that already knows the epoch */
function req(sync, device, extra = {}) {
  return sync.handle({ key: KEY, device, name: device, epoch: sync.state.epoch, since: 0, ...extra }, extra.now ?? NOW);
}

describe('Lampa sync copy', () => {
  it('refuses requests without the key and when it is off', () => {
    assert.strictEqual(new LampaSync(fakeAdapter(), { key: '' }).handle({ key: '' }).code, 403);
    const sync = newSync();
    assert.strictEqual(sync.handle({ key: 'wrong', device: 'a' }).code, 401);
    assert.strictEqual(sync.handle({ key: KEY }).code, 400);
  });

  it('a device with another epoch starts over', () => {
    const sync = newSync();
    const r = sync.handle({ key: KEY, device: 'a', epoch: '' }, NOW);
    assert.strictEqual(r.body.stale, true);
    assert.strictEqual(r.body.replace, false);
    assert.strictEqual(r.body.epoch, sync.state.epoch);
  });

  it('time codes: the newer `updated` wins', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { timeline: [{ k: 'h1', v: { time: 100, percent: 10, updated: NOW - 1000 }, ts: NOW - 1000 }] } });
    // older from b is ignored
    req(sync, 'b', { changes: { timeline: [{ k: 'h1', v: { time: 50, percent: 5, updated: NOW - 5000 }, ts: NOW - 5000 }] } });
    assert.strictEqual(sync.state.data.timeline.h1.v.time, 100);
    // newer from b wins and a gets it
    req(sync, 'b', { changes: { timeline: [{ k: 'h1', v: { time: 900, percent: 90, updated: NOW }, ts: NOW }] } });
    const r = req(sync, 'a', { since: 1 });
    assert.deepStrictEqual(r.body.changes.timeline.map(e => e.v.time), [900]);
  });

  it('bookmarks: a deletion wins over an older addition and is passed on', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { favorite: [{ k: 'book:42', v: { type: 'book', id: 42 }, ts: NOW - 100 }] } });
    req(sync, 'b', { changes: { favorite: [{ k: 'book:42', ts: NOW, del: true }] } });
    const r = req(sync, 'a', { since: 0 });
    assert.deepStrictEqual(r.body.changes.favorite, [{ k: 'book:42', ts: NOW, del: true }]);
    // added again later
    req(sync, 'a', { changes: { favorite: [{ k: 'book:42', v: { type: 'book', id: 42 }, ts: NOW + 10 }] }, now: NOW + 10 });
    assert.strictEqual(sync.state.data.favorite['book:42'].del, undefined);
  });

  it('rejects malformed entries', () => {
    const sync = newSync();
    req(sync, 'a', {
      changes: {
        favorite: [
          { k: 'evil:1', v: { type: 'evil', id: 1 }, ts: NOW },
          { k: 'book:1', v: { type: 'book', id: 2 }, ts: NOW },
          'nonsense',
        ],
        cards: [{ k: '5', v: { id: 6 }, ts: NOW }],
        timeline: [{ k: 'h', v: 'x', ts: NOW }],
        unknown: [{ k: 'x', ts: NOW }],
      },
    });
    assert.deepStrictEqual(sync.state.data.favorite, {});
    assert.deepStrictEqual(sync.state.data.cards, {});
    assert.deepStrictEqual(sync.state.data.timeline, {});
    assert.strictEqual(sync.state.data.unknown, undefined);
  });

  it('the first sync of a device does not override what the copy knows', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { favorite: [{ k: 'like:7', ts: NOW - 50, del: true, v: { type: 'like', id: 7 } }] } });
    req(sync, 'b', {
      initial: true,
      changes: {
        favorite: [
          { k: 'like:7', v: { type: 'like', id: 7 }, ts: NOW },
          { k: 'like:8', v: { type: 'like', id: 8 }, ts: NOW },
        ],
        timeline: [{ k: 'h', v: { time: 1, updated: NOW }, ts: NOW }],
      },
    });
    assert.strictEqual(sync.state.data.favorite['like:7'].del, true);
    assert.ok(sync.state.data.favorite['like:8'].v);
    assert.ok(sync.state.data.timeline.h);
  });

  it('cuts time stamps from the future to now', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { search_history: [{ k: 'matrix', ts: NOW + 86400000 }] } });
    assert.strictEqual(sync.state.data.search_history.matrix.ts, NOW);
  });

  it('only syncs the groups switched on', () => {
    const sync = newSync(['search']);
    const r = req(sync, 'a', {
      changes: { search_history: [{ k: 'a', ts: NOW }], timeline: [{ k: 'h', v: { time: 1 }, ts: NOW }] },
    });
    assert.deepStrictEqual(r.body.cats, ['search_history']);
    assert.strictEqual(sync.state.data.timeline, undefined);
  });

  it('answers in full when old deletions were forgotten', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { online_view: [{ k: 'x', ts: NOW - 200 * 86400000, del: true }, { k: 'y', ts: NOW }] } });
    sync.prune(NOW);
    assert.strictEqual(sync.state.data.online_view.x, undefined);
    const r = req(sync, 'b', { since: sync.state.rev });
    assert.strictEqual(r.body.full, false);
    const r2 = req(sync, 'b', { since: sync.state.prunedRev - 1 });
    assert.strictEqual(r2.body.full, true);
  });

  it('drops cards no bookmark refers to', () => {
    const sync = newSync();
    req(sync, 'a', {
      changes: {
        favorite: [{ k: 'book:1', v: { type: 'book', id: 1 }, ts: NOW }],
        cards: [
          { k: '1', v: { id: 1, title: 'A' }, ts: NOW },
          { k: '2', v: { id: 2, title: 'B' }, ts: NOW },
        ],
      },
    });
    sync.prune(NOW);
    assert.deepStrictEqual(Object.keys(sync.state.data.cards), ['1']);
  });

  it('reset from one device: the others wait, then take its data', () => {
    const sync = newSync();
    req(sync, 'a', { changes: { search_history: [{ k: 'old', ts: NOW }] } });
    req(sync, 'b', {});
    const oldEpoch = sync.state.epoch;
    assert.deepStrictEqual(sync.reset('b'), { source: 'b' });
    assert.notStrictEqual(sync.state.epoch, oldEpoch);
    assert.deepStrictEqual(sync.state.data, {});
    // a has to wait until b sent its data
    assert.strictEqual(sync.handle({ key: KEY, device: 'a', epoch: oldEpoch }, NOW).body.wait, true);
    // b learns the new epoch and sends everything
    assert.strictEqual(sync.handle({ key: KEY, device: 'b', epoch: oldEpoch }, NOW).body.stale, true);
    req(sync, 'b', { initial: true, changes: { search_history: [{ k: 'new', ts: NOW }] } });
    // now a takes the copy over
    const stale = sync.handle({ key: KEY, device: 'a', epoch: oldEpoch }, NOW).body;
    assert.deepStrictEqual([stale.stale, stale.replace], [true, true]);
    const r = req(sync, 'a', { since: 0 });
    assert.deepStrictEqual(r.body.changes.search_history.map(e => e.k), ['new']);
    assert.strictEqual(sync.state.reset, null);
    assert.throws(() => sync.reset('nobody'), /No Lampa devices/);
  });
});

describe('Lampa bridge with sync', () => {
  it('the sync route answers and other devices get a sync command', () => {
    const bridge = new LampaBridge(fakeAdapter(), { holdMs: 1000 });
    const sync = newSync();
    bridge.sync = sync;
    sync.onChange = (rev, from) => bridge.broadcast({ action: 'sync', rev }, from);
    const routes = {};
    const app = {
      use() {},
      get(p, fn) {
        routes[`GET ${p}`] = fn;
      },
      post(p, mw, fn) {
        routes[`POST ${p}`] = fn;
      },
    };
    bridge.routes(app);
    const polls = {};
    for (const id of ['a', 'b']) {
      polls[id] = { body: undefined, headersSent: false, status() { return this; }, json(b) { this.body = b; this.headersSent = true; }, on() {} };
      bridge.poll({ id, name: id }, polls[id]);
    }
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    const body = { key: KEY, device: 'a', epoch: sync.state.epoch, since: 0, changes: { search_history: [{ k: 'dune', ts: Date.now() }] } };
    routes['POST /lampa/sync']({ body: JSON.stringify(body) }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.rev, 1);
    assert.deepStrictEqual(polls.b.body, { commands: [{ action: 'sync', rev: 1 }] });
    assert.strictEqual(polls.a.body, undefined);
    routes['POST /lampa/sync']({ body: 'not json' }, res);
    assert.strictEqual(res.code, 401);
    bridge.stop();
  });

  it('fills the key into the plugin only for the right key', done => {
    const bridge = new LampaBridge(fakeAdapter());
    bridge.sync = newSync();
    const routes = {};
    bridge.routes({ use() {}, post() {}, get: (p, fn) => (routes[p] = fn) });
    const res = { set() {}, type() { return this; }, status() { return this; } };
    let n = 0;
    const check = (key, expected) =>
      routes['/lampa.js']({ protocol: 'http', get: () => 'x:3000', query: { key } }, {
        ...res,
        send(text) {
          assert.strictEqual(text.includes(`var EMBED_KEY = '${expected}'`), true);
          if (++n === 2) {
            bridge.stop();
            done();
          }
        },
      });
    check(KEY, KEY);
    check('wrong', '');
  });
});

const source = fs
  .readFileSync(path.join(__dirname, '..', 'lampa', 'movieswipe-lampa.js'), 'utf8')
  .replace('__MOVIESWIPE_BASE__', 'http://x:3000')
  .replace('syncState.period = setTimeout(tick, 3000);', 'syncState.period = null;');

/** A device with Lampa and the plugin, wired to the sync copy */
function device(sync, name, data = {}, opts = {}) {
  const store = { movieswipe_sync_key: KEY, movieswipe_device: name, ...JSON.parse(JSON.stringify(data)) };
  const listeners = [];
  class XHR {
    open(method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body) {
      if (!this.url.includes('/lampa/sync')) return; // polls stay open
      const r = sync.handle(JSON.parse(body));
      this.status = r.code;
      this.responseText = JSON.stringify(r.body);
      setImmediate(() => this.onload());
    }
    abort() {}
  }
  const parse = d => (typeof d === 'string' && (d[0] === '{' || d[0] === '[') ? JSON.parse(d) : d);
  const Lampa = {
    Storage: {
      get: (k, d) => (k in store ? store[k] : parse(d)),
      set: (k, v, nolisten) => {
        store[k] = JSON.parse(JSON.stringify(v));
        if (!nolisten) listeners.forEach(fn => fn({ name: k, value: v }));
      },
      listener: { follow: (ev, fn) => listeners.push(fn) },
    },
    Platform: { get: () => 'android' },
    Listener: { follow() {} },
    Noty: { show() {} },
    Timeline: { filename: () => 'file_view', read() {} },
    Favorite: { read() {} },
    Manifest: { app_version: '3.0' },
    Account: { Permit: { sync: !!opts.cub } },
    Api: { search: (p, cb) => setImmediate(() => cb(opts.search ? opts.search(decodeURIComponent(p.query)) : {})) },
  };
  const window = { appready: true };
  vm.runInNewContext(source, {
    window,
    Lampa,
    XMLHttpRequest: XHR,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    JSON,
    Math,
    Date,
    String,
    Object,
    parseInt,
  });
  return {
    store,
    async sync() {
      window.movieswipe_lampa_sync();
      await new Promise(r => setTimeout(r, 60));
    },
  };
}

describe('Lampa plugin sync between two devices', () => {
  const card = id => ({ id, title: `Film ${id}`, source: 'tmdb' });

  it('merges two devices, passes deletions on and keeps the newer time code', async () => {
    const sync = newSync();
    const a = device(sync, 'TV', {
      favorite: { book: [1], like: [], card: [card(1)] },
      file_view: { h1: { time: 100, duration: 1000, percent: 10, updated: 1000 } },
      search_history: ['dune'],
    });
    const b = device(sync, 'Dune', {
      favorite: { book: [2], card: [card(2)] },
      file_view: { h1: { time: 500, duration: 1000, percent: 50, updated: 2000 } },
    });
    await a.sync();
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      assert.deepStrictEqual([...d.store.favorite.book].sort(), [1, 2]);
      assert.deepStrictEqual(d.store.favorite.card.map(c => c.id).sort(), [1, 2]);
      assert.strictEqual(d.store.file_view.h1.time, 500);
      assert.deepStrictEqual(d.store.search_history, ['dune']);
    }

    // b removes bookmark 1 and watches on; a gets both
    b.store.favorite.book = [2];
    b.store.file_view.h1 = { time: 800, duration: 1000, percent: 80, updated: Date.now() };
    await b.sync();
    await a.sync();
    assert.deepStrictEqual(a.store.favorite.book, [2]);
    assert.strictEqual(a.store.file_view.h1.time, 800);
  });

  it('two devices changed offline: both changes survive', async () => {
    const sync = newSync();
    const a = device(sync, 'TV');
    const b = device(sync, 'PC');
    await a.sync();
    await b.sync();
    a.store.online_view = ['a1'];
    b.store.online_view = ['b1'];
    a.store.favorite = { like: [10], card: [card(10)] };
    b.store.favorite = { wath: [20], card: [card(20)] };
    await a.sync();
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      assert.deepStrictEqual([...d.store.online_view].sort(), ['a1', 'b1']);
      assert.deepStrictEqual(d.store.favorite.like, [10]);
      assert.deepStrictEqual(d.store.favorite.wath, [20]);
    }
  });

  it('a device that only receives does not send', async () => {
    const sync = newSync();
    const a = device(sync, 'TV', { movieswipe_sync_search: 'receive', search_history: ['secret'] });
    await a.sync();
    assert.deepStrictEqual(sync.state.data.search_history || {}, {});
    const b = device(sync, 'PC', { search_history: ['matrix'] });
    await b.sync();
    await a.sync();
    assert.deepStrictEqual([...a.store.search_history].sort(), ['matrix', 'secret']);
    assert.strictEqual(sync.devices().find(d => d.name === 'TV').modes.search, 'receive');
  });

  it('does not sync bookmarks and time codes while signed in to CUB', async () => {
    const sync = newSync();
    const a = device(sync, 'TV', { favorite: { book: [1], card: [card(1)] }, search_history: ['x'] }, { cub: true });
    await a.sync();
    assert.deepStrictEqual(Object.keys(sync.state.data.search_history), ['x']);
    assert.strictEqual(sync.state.data.favorite, undefined);
    assert.deepStrictEqual(sync.devices()[0].modes.favorite, 'off');
  });

  it('reset from one device replaces the data of the others', async () => {
    const sync = newSync();
    const a = device(sync, 'TV', { search_history: ['a-only'] });
    const b = device(sync, 'PC', { search_history: ['b-only'] });
    await a.sync();
    await b.sync();
    await a.sync();
    assert.deepStrictEqual([...a.store.search_history].sort(), ['a-only', 'b-only']);
    b.store.search_history = ['b-only'];
    sync.reset('PC');
    await a.sync(); // waits
    assert.deepStrictEqual([...a.store.search_history].sort(), ['a-only', 'b-only']);
    await b.sync();
    await a.sync();
    assert.deepStrictEqual(a.store.search_history, ['b-only']);
  });
});

describe('agent commands for Lampa bookmarks', () => {
  const MOVIES = {
    'kp-1': { id: 'kp-1', title: 'Джентльмены', originalTitle: 'The Gentlemen', year: 2019, type: 'movie' },
    'kp-2': { id: 'kp-2', title: 'Дюна', originalTitle: 'Dune', year: 2021, type: 'movie' },
  };
  const search = {
    run: async (op, args) => {
      if (op === 'brief') return MOVIES[args.id] || null;
      if (op === 'search') return { movies: Object.values(MOVIES).filter(m => m.title.toLowerCase() === String(args.query).toLowerCase()) };
      return null;
    },
  };
  const watched = [];
  const history = { add: async (movies, action) => watched.push(...movies.map(m => `${m.id}:${action}`)) };
  const gentlemen = { id: 522627, title: 'Джентльмены', original_title: 'The Gentlemen', release_date: '2019-12-03' };
  const tmdb = q => (/gentlemen|джентльмены/i.test(q) ? { movie: { results: [gentlemen] } } : { movie: { results: [] } });
  const ctxOf = (sync, online = false) => ({ search, history, lampa: { online: () => (online ? [{ name: 'TV' }] : []) }, lampaSync: sync });

  it('declares the commands with their write flags', () => {
    const flags = Object.fromEntries(COMMANDS.map(c => [c.command, c.write]));
    assert.deepStrictEqual(
      [flags.addBookmark, flags.removeBookmark, flags.bookmarks, flags.markWatched],
      [true, true, false, true],
    );
  });

  it('explains that the sync of bookmarks is off', async () => {
    await assert.rejects(runCommand('bookmarks', {}, { search, history, lampaSync: null }), /sync with bookmarks/);
    await assert.rejects(runCommand('bookmarks', {}, { search, history, lampaSync: newSync(['timeline']) }), /sync with bookmarks/);
  });

  it('a card the copy knows: add, already, marks, list and remove at once', async () => {
    const sync = newSync();
    req(sync, 'a', { changes: { cards: [{ k: '522627', v: gentlemen, ts: NOW }] } });
    const ctx = ctxOf(sync);
    assert.deepStrictEqual(await runCommand('addBookmark', { id: 'kp-1', list: 'later' }, ctx), {
      id: 'kp-1',
      status: 'added',
      title: 'Джентльмены',
      list: 'wath',
    });
    assert.strictEqual((await runCommand('addBookmark', { id: 'kp-1', list: 'wath' }, ctx)).status, 'already');
    await assert.rejects(runCommand('addBookmark', { id: 'kp-1', list: 'history' }, ctx), /list must be one of/);
    await runCommand('addBookmark', { id: 'The Gentlemen', list: 'watching' }, ctx);
    const r = await runCommand('markWatched', { id: 'kp-1' }, ctx);
    assert.strictEqual(r.list, 'viewed');
    assert.deepStrictEqual(sync.listsOf(522627), ['wath', 'viewed']); // look was replaced by viewed
    assert.ok(watched.includes('kp-1:watched'));
    assert.deepStrictEqual(await runCommand('bookmarks', { list: 'later' }, ctx), {
      lists: { wath: [{ title: 'Джентльмены', originalTitle: 'The Gentlemen', year: 2019 }] },
      totals: { wath: 1 },
    });
    assert.deepStrictEqual(await runCommand('removeBookmark', { id: 'kp-1' }, ctx), {
      status: 'removed',
      title: 'Джентльмены',
      lists: ['wath', 'viewed'],
    });
    assert.strictEqual((await runCommand('removeBookmark', { id: 'kp-1' }, ctx)).status, 'notFound');
  });

  it('an unknown card waits for a device; a second device gets the bookmark', async () => {
    const sync = newSync();
    const tv = device(sync, 'TV', {}, { search: tmdb });
    const pc = device(sync, 'PC');
    await tv.sync();
    await pc.sync();
    const answer = runCommand('addBookmark', { id: 'kp-1' }, ctxOf(sync, true));
    await new Promise(r => setTimeout(r, 10)); // in the adapter the broadcast makes the device sync
    await tv.sync(); // gets the request, finds the card on TMDB and sends it
    assert.deepStrictEqual(await answer, { id: 'kp-1', status: 'added', title: 'Джентльмены', list: 'book' });
    assert.deepStrictEqual(tv.store.favorite.book, [522627]);
    await pc.sync();
    assert.deepStrictEqual(pc.store.favorite.book, [522627]);
    assert.strictEqual(pc.store.favorite.card[0].original_title, 'The Gentlemen');
  });

  it('without a device the bookmark is queued; notFound when Lampa has no match', async () => {
    const sync = newSync();
    const queued = await runCommand('addBookmark', { id: 'kp-2' }, ctxOf(sync, false));
    assert.strictEqual(queued.status, 'queued');
    assert.deepStrictEqual((await runCommand('bookmarks', {}, ctxOf(sync))).pending, [{ title: 'Дюна', list: 'book' }]);
    const tv = device(sync, 'TV', {}, { search: tmdb });
    await tv.sync();
    await tv.sync();
    assert.deepStrictEqual(sync.state.requests, []);
    assert.strictEqual(tv.store.favorite, undefined);
  });
});

describe('Lampa sync file storage', () => {
  const { MOUNT, FILE } = require('../lib/lampa-sync');
  const io = require('../io-package.json');

  /** An adapter with an objects database and a file storage in memory */
  function storageAdapter(objects = {}) {
    const files = {};
    return {
      ...fakeAdapter(),
      namespace: 'movieswipe.0',
      objects,
      files,
      getForeignObjectAsync: async id => objects[id] || null,
      setObjectNotExistsAsync: async (id, obj) => {
        objects[id] = objects[id] || { ...obj, _id: id };
      },
      fileExistsAsync: async (mount, name) => `${mount}/${name}` in files,
      readFileAsync: async (mount, name) => ({ file: files[`${mount}/${name}`] }),
      writeFileAsync: async (mount, name, data) => {
        if (!objects[mount] || objects[mount].type !== 'meta') {
          throw new Error(`${mount} is not an object of type "meta"`);
        }
        files[`${mount}/${name}`] = data;
      },
    };
  }

  it('the mount point is not the channel of the lampa states', () => {
    const ids = io.instanceObjects.map(o => o._id);
    assert.ok(ids.includes('lampa'));
    assert.ok(!ids.includes(MOUNT));
    assert.ok(!ids.some(id => id.startsWith(`${MOUNT}.`)));
    assert.strictEqual(FILE, 'lampa-sync.json');
  });

  it('creates the meta object, saves the copy there and reads it back', async () => {
    const adapter = storageAdapter({ 'movieswipe.0.lampa': { type: 'channel' } });
    const mount = `${adapter.namespace}.${MOUNT}`;
    const sync = new LampaSync(adapter, { key: KEY, mount });
    await sync.load();
    assert.strictEqual(adapter.objects[mount].type, 'meta');
    assert.strictEqual(adapter.objects[mount].common.type, 'meta.user');
    req(sync, 'a', { changes: { search_history: [{ k: 'dune', ts: NOW }] } });
    await sync.save(NOW);
    assert.ok(adapter.files[`${mount}/${FILE}`]);
    const again = new LampaSync(adapter, { key: KEY, mount });
    await again.load();
    assert.deepStrictEqual(Object.keys(again.state.data.search_history), ['dune']);
  });

  it('refuses a mount point that is not a meta object', async () => {
    const adapter = storageAdapter({ 'movieswipe.0.lampa': { type: 'channel' } });
    await assert.rejects(new LampaSync(adapter, { key: KEY, mount: 'movieswipe.0.lampa' }).load(), /channel, not a file storage/);
  });
});
