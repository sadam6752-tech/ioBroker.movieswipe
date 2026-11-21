'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LampaBridge } = require('../lib/lampa-bridge');
const { runCommand } = require('../lib/agent-commands');

function fakeAdapter() {
  return {
    log: { info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
  };
}

/** A response of express that records what was sent */
function fakeRes() {
  const res = {
    body: undefined,
    code: 200,
    headersSent: false,
    handlers: {},
    status(c) {
      res.code = c;
      return res;
    },
    json(b) {
      res.body = b;
      res.headersSent = true;
      return res;
    },
    on(ev, fn) {
      res.handlers[ev] = fn;
    },
  };
  return res;
}

const MOVIE = { id: 'kp-1', title: 'Джентльмены', originalTitle: 'The Gentlemen', year: 2019, type: 'movie' };

describe('Lampa bridge', () => {
  let bridge;
  beforeEach(() => {
    bridge = new LampaBridge(fakeAdapter(), { holdMs: 50, resultMs: 100 });
  });
  afterEach(() => bridge.stop());

  it('holds a poll and answers it empty after the hold time', async () => {
    const res = fakeRes();
    bridge.poll({ id: 'tv1', name: 'ТВ гостиная', platform: 'android' }, res);
    assert.strictEqual(res.body, undefined);
    assert.deepStrictEqual(bridge.online(), [{ id: 'tv1', name: 'ТВ гостиная', platform: 'android' }]);
    await new Promise(r => setTimeout(r, 80));
    assert.deepStrictEqual(res.body, { commands: [] });
  });

  it('a poll without an id is refused', () => {
    const res = fakeRes();
    bridge.poll({}, res);
    assert.strictEqual(res.code, 400);
  });

  it('open sends the command to the waiting poll and returns what the device reported', async () => {
    const res = fakeRes();
    bridge.poll({ id: 'tv1', name: 'ТВ' }, res);
    const answer = bridge.open(MOVIE);
    const cmd = res.body.commands[0];
    assert.strictEqual(cmd.action, 'open');
    assert.strictEqual(cmd.originalTitle, 'The Gentlemen');
    assert.strictEqual(cmd.year, 2019);
    assert.strictEqual(cmd.series, false);
    bridge.result({ cmd: cmd.cmd, status: 'opened', title: 'The Gentlemen' });
    const r = await answer;
    assert.strictEqual(r.status, 'opened');
    assert.strictEqual(r.device, 'ТВ');
    assert.strictEqual(r.title, 'Джентльмены');
    assert.strictEqual(r.lampaTitle, 'The Gentlemen');
    assert.strictEqual(r.note, undefined);
  });

  it('a command for a device between two polls is queued and picked up by the next poll', async () => {
    const first = fakeRes();
    bridge.poll({ id: 'tv1', name: 'ТВ' }, first);
    await new Promise(r => setTimeout(r, 80));
    const answer = bridge.open({ ...MOVIE, type: 'tv-series' });
    const next = fakeRes();
    bridge.poll({ id: 'tv1', name: 'ТВ' }, next);
    assert.strictEqual(next.body.commands.length, 1);
    assert.strictEqual(next.body.commands[0].series, true);
    assert.ok(!('ts' in next.body.commands[0]));
    const r = await answer;
    assert.strictEqual(r.status, 'sent');
    assert.match(r.note, /did not confirm/);
  });

  it('a second poll of the same device answers the older one empty', () => {
    const a = fakeRes();
    const b = fakeRes();
    bridge.poll({ id: 'tv1' }, a);
    bridge.poll({ id: 'tv1' }, b);
    assert.deepStrictEqual(a.body, { commands: [] });
    assert.strictEqual(b.body, undefined);
    assert.strictEqual(bridge.online()[0].name, 'Lampa tv1');
  });

  it('pick: none online, one, several, by name', () => {
    assert.throws(() => bridge.pick(), /No Lampa device is online/);
    bridge.poll({ id: 'a', name: 'ТВ гостиная' }, fakeRes());
    assert.strictEqual(bridge.pick().name, 'ТВ гостиная');
    bridge.poll({ id: 'b', name: 'Dune' }, fakeRes());
    assert.throws(() => bridge.pick(), /Several Lampa devices are online.*ТВ гостиная, Dune/);
    assert.strictEqual(bridge.pick('dune').name, 'Dune');
    assert.strictEqual(bridge.pick('гостин').name, 'ТВ гостиная');
    assert.throws(() => bridge.pick('кухня'), /No Lampa devices match/);
  });

  it('a device that stopped polling goes offline', () => {
    const now = Date.now();
    const res = fakeRes();
    bridge.poll({ id: 'a', name: 'ТВ' }, res, now - 120000);
    bridge.release(bridge.devices.get('a'), { commands: [] });
    assert.deepStrictEqual(bridge.online(now), []);
  });

  it('stop answers open polls and pending commands', async () => {
    const res = fakeRes();
    bridge.poll({ id: 'a', name: 'ТВ' }, res);
    const answer = bridge.open(MOVIE);
    bridge.stop();
    assert.strictEqual((await answer).status, 'sent');
    const late = fakeRes();
    bridge.poll({ id: 'a' }, late);
    assert.strictEqual(late.code, 503);
  });

  it('serves the plugin with the address of the server filled in', done => {
    const res = fakeRes();
    res.set = () => res;
    res.type = () => res;
    res.send = text => {
      assert.ok(text.includes("var BASE = 'http://192.168.1.5:3000';"));
      assert.ok(!text.includes('__MOVIESWIPE_BASE__'));
      done();
    };
    bridge.sendPlugin({ protocol: 'http', get: () => '192.168.1.5:3000' }, res);
  });
});

describe('Lampa plugin', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lampa', 'movieswipe-lampa.js'), 'utf8');

  /** Runs the plugin in a fake Lampa and gives back what it opened and reported */
  function runPlugin(searchResults, command) {
    const out = { opened: null, search: null, reports: [], polls: 0 };
    const store = {};
    const results = [...searchResults];
    let pollDone = false;
    class XHR {
      open(method, url) {
        this.url = url;
      }
      send() {
        if (this.url.includes('/lampa/poll')) {
          out.polls++;
          if (pollDone) return; // keep the second poll open
          pollDone = true;
          this.status = 200;
          this.responseText = JSON.stringify({ commands: [command] });
        } else {
          out.reports.push(Object.fromEntries(new URL(this.url).searchParams));
          this.status = 200;
          this.responseText = '{}';
        }
        setImmediate(() => this.onload());
      }
      abort() {}
    }
    const Lampa = {
      Storage: { get: (k, d) => store[k] ?? d, set: (k, v) => (store[k] = v) },
      Platform: { get: () => 'android' },
      Listener: { follow() {} },
      Noty: { show() {} },
      Api: { search: (p, cb) => setImmediate(() => cb(results.shift() || {})) },
      Router: { call: (name, card) => (out.opened = { name, card }) },
      Search: { open: p => (out.search = p) },
      Activity: { push() {} },
    };
    const sandbox = { window: { appready: true }, Lampa, XMLHttpRequest: XHR, setTimeout, encodeURIComponent, JSON, Math, Date, String, parseInt };
    vm.runInNewContext(source.replace('__MOVIESWIPE_BASE__', 'http://x:3000'), sandbox);
    return new Promise(r => setTimeout(() => r(out), 300));
  }

  const command = { cmd: 'c1', action: 'open', title: 'Джентльмены', originalTitle: 'The Gentlemen', year: 2019, series: false };

  it('opens the matching card found by the original title', async () => {
    const out = await runPlugin(
      [
        {
          movie: {
            results: [
              { id: 1, title: 'Джентльмены удачи', original_title: 'Dzhentlmeny udachi', release_date: '1971-12-13' },
              { id: 522627, title: 'Джентльмены', original_title: 'The Gentlemen', release_date: '2020-01-01' },
            ],
          },
          tv: { results: [{ id: 9, name: 'The Gentlemen', original_name: 'The Gentlemen', first_air_date: '2024-03-07' }] },
        },
      ],
      command,
    );
    assert.strictEqual(out.opened.name, 'full');
    assert.strictEqual(out.opened.card.id, 522627);
    assert.strictEqual(out.opened.card.source, 'tmdb');
    assert.deepStrictEqual(
      { cmd: out.reports[0].cmd, status: out.reports[0].status },
      { cmd: 'c1', status: 'opened' },
    );
  });

  it('falls back to the Russian title and then to the search of Lampa', async () => {
    const out = await runPlugin([{ movie: { results: [] } }, { movie: { results: [] } }], command);
    assert.strictEqual(out.opened, null);
    assert.strictEqual(out.search.input, 'Джентльмены');
    assert.strictEqual(out.reports[0].status, 'search');
  });

  it('prefers the series when the title is one', async () => {
    const out = await runPlugin(
      [
        {
          movie: { results: [{ id: 5, title: 'Friends', original_title: 'Friends', release_date: '1994-05-01' }] },
          tv: { results: [{ id: 1668, name: 'Друзья', original_name: 'Friends', first_air_date: '1994-09-22' }] },
        },
      ],
      { cmd: 'c2', action: 'open', title: 'Друзья', originalTitle: 'Friends', year: 1994, series: true },
    );
    assert.strictEqual(out.opened.card.id, 1668);
  });
});

describe('agent commands for Lampa', () => {
  const search = { run: async (op, args) => (op === 'brief' && args.id === 'kp-1' ? MOVIE : null) };

  it('openInLampa without a device online explains what is missing', async () => {
    const lampa = new LampaBridge(fakeAdapter());
    await assert.rejects(runCommand('openInLampa', { id: 'kp-1' }, { search, history: null, lampa }), /No Lampa device/);
    await assert.rejects(runCommand('openInLampa', {}, { search, history: null, lampa }), /id is missing/);
    lampa.stop();
  });

  it('openInLampa opens the title on the only device and lampaDevices lists it', async () => {
    const lampa = new LampaBridge(fakeAdapter(), { resultMs: 100 });
    const res = fakeRes();
    lampa.poll({ id: 'a', name: 'Dune', platform: 'android' }, res);
    const devices = await runCommand('lampaDevices', {}, { search, history: null, lampa });
    assert.deepStrictEqual(devices, { devices: [{ name: 'Dune', platform: 'android' }] });
    const answer = runCommand('openInLampa', '{"id":"kp-1"}', { search, history: null, lampa });
    await new Promise(r => setImmediate(r));
    lampa.result({ cmd: res.body.commands[0].cmd, status: 'search' });
    const r = await answer;
    assert.strictEqual(r.status, 'search');
    assert.match(r.note, /search/);
    await assert.rejects(runCommand('openInLampa', { id: 'kp-9' }, { search, history: null, lampa }), /No title/);
    lampa.stop();
  });
});
