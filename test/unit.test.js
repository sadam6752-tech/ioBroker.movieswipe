'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, atomicCopy, readMoviesFile } = require('../lib/fs-utils');
const SyncManager = require('../lib/sync-manager');

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
    manager = new SyncManager({ log }, dir, path.join(dir, 'backup.json'));
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
    const restarted = new SyncManager({ log }, dir, path.join(dir, 'backup.json'));
    assert.strictEqual(restarted.findAvailableApiKey(keys, 24), null);
  });
});
