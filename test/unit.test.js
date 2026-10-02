'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, atomicCopy, readMoviesFile } = require('../lib/fs-utils');
const SyncManager = require('../lib/sync-manager');
const DbStore = require('../lib/db-store');

const log = { debug() {}, info() {}, warn() {}, error() {} };

describe('fs-utils', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomicWrite writes the file and leaves no temp file behind', () => {
    const file = path.join(dir, 'db.json');
    atomicWrite(file, '{"movies":[]}');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"movies":[]}');
    assert.deepStrictEqual(fs.readdirSync(dir), ['db.json']);
  });

  it('atomicCopy copies the file', () => {
    const src = path.join(dir, 'a.json');
    const dst = path.join(dir, 'b.json');
    fs.writeFileSync(src, 'x');
    atomicCopy(src, dst);
    assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'x');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json']);
  });

  it('readMoviesFile rejects missing, broken and malformed files', () => {
    const file = path.join(dir, 'db.json');
    assert.strictEqual(readMoviesFile(file), null);
    fs.writeFileSync(file, '{"movies":[');
    assert.strictEqual(readMoviesFile(file), null);
    fs.writeFileSync(file, '{"foo":1}');
    assert.strictEqual(readMoviesFile(file), null);
    fs.writeFileSync(file, '{"movies":[{"id":1}]}');
    assert.strictEqual(readMoviesFile(file).movies.length, 1);
  });
});

describe('SyncManager', () => {
  let dir;
  let manager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-'));
    manager = new SyncManager({ log }, { dataDir: dir });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('msUntilTime is always within the next 24 hours', () => {
    const ms = manager.msUntilTime('03:00');
    assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000);
  });

  it('getKeyString handles strings and objects', () => {
    assert.strictEqual(manager.getKeyString(' abc '.trim()), 'abc');
    assert.strictEqual(manager.getKeyString({ key: ' abc ' }), 'abc');
    assert.strictEqual(manager.getKeyString(null), '');
  });

  it('findAvailableApiKey skips keys on cooldown and persists the cooldown', () => {
    const keys = [{ key: 'one' }, { key: 'two' }];
    assert.strictEqual(manager.findAvailableApiKey(keys, 24).index, 0);
    manager.updateApiKeyTimestamp(keys[0]);
    assert.strictEqual(manager.findAvailableApiKey(keys, 24).index, 1);
    manager.updateApiKeyTimestamp(keys[1]);
    assert.strictEqual(manager.findAvailableApiKey(keys, 24), null);

    // neuer Manager (= Adapter-Neustart) kennt die Cooldowns noch
    const restarted = new SyncManager({ log }, { dataDir: dir });
    assert.strictEqual(restarted.findAvailableApiKey(keys, 24), null);
  });
});

describe('DbStore', () => {
  let dir;
  let files;
  let adapter;
  let seed;
  let legacy;

  const movies = n => JSON.stringify({ movies: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieswipe-'));
    files = {};
    seed = path.join(dir, 'seed.json');
    legacy = path.join(dir, 'legacy.backup.json');
    fs.writeFileSync(seed, movies(2));
    adapter = {
      namespace: 'movieswipe.0',
      config: {},
      log,
      async setObjectNotExistsAsync() {},
      async fileExistsAsync(mount, name) {
        return `${mount}/${name}` in files;
      },
      async writeFileAsync(mount, name, data) {
        files[`${mount}/${name}`] = Buffer.from(data);
      },
      async readFileAsync(mount, name) {
        return { file: files[`${mount}/${name}`] };
      },
      async delFileAsync(mount, name) {
        delete files[`${mount}/${name}`];
      },
    };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = () => new DbStore(adapter, path.join(dir, 'data'), seed, legacy, path.join(dir, 'progress.json'));

  it('first start: copies the seed and stores it in the ioBroker file storage', async () => {
    const store = make();
    await store.init();
    assert.strictEqual(JSON.parse(fs.readFileSync(store.dbFile, 'utf8')).movies.length, 2);
    assert.ok('movieswipe.0.storage/movies-poiskkino.json' in files);
  });

  it('migrates the legacy backup instead of using the seed', async () => {
    fs.writeFileSync(legacy, movies(5));
    const store = make();
    await store.init();
    assert.strictEqual(JSON.parse(fs.readFileSync(store.dbFile, 'utf8')).movies.length, 5);
  });

  it('restores from the file storage when the working copy is missing or corrupt', async () => {
    files['movieswipe.0.storage/movies-poiskkino.json'] = Buffer.from(movies(7));
    const store = make();
    fs.mkdirSync(store.dataDir, { recursive: true });
    fs.writeFileSync(store.dbFile, '{"movies":[');
    await store.init();
    assert.strictEqual(JSON.parse(fs.readFileSync(store.dbFile, 'utf8')).movies.length, 7);
  });

  it('keeps a valid working copy (e.g. a deliberately smaller upload) over the storage', async () => {
    files['movieswipe.0.storage/movies-poiskkino.json'] = Buffer.from(movies(9));
    const store = make();
    fs.mkdirSync(store.dataDir, { recursive: true });
    fs.writeFileSync(store.dbFile, movies(3));
    await store.init();
    assert.strictEqual(JSON.parse(fs.readFileSync(store.dbFile, 'utf8')).movies.length, 3);
  });

  it('removes the stored copy when preservation is disabled', async () => {
    adapter.config.preserveDatabase = false;
    files['movieswipe.0.storage/movies-poiskkino.json'] = Buffer.from(movies(9));
    const store = make();
    await store.init();
    assert.deepStrictEqual(Object.keys(files), []);
    assert.strictEqual(JSON.parse(fs.readFileSync(store.dbFile, 'utf8')).movies.length, 2);
  });
});
