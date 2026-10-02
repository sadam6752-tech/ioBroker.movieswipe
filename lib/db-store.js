'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { atomicWrite, atomicCopy, readMoviesFile } = require('./fs-utils');

const DB_NAME = 'movies-poiskkino.json';

/**
 * Хранилище базы фильмов.
 *
 * - Рабочая копия лежит в каталоге данных экземпляра (iobroker-data/movieswipe.N/):
 *   её читает веб-сервер, в неё пишет скрипт синхронизации. Обновление адаптера её не затрагивает.
 * - Долговременная копия — в файловом хранилище ioBroker под точкой монтирования
 *   `<namespace>.storage` (type "meta"): она попадает в бэкап ioBroker и переживает переустановку.
 */
class DbStore {
  /**
   * @param adapter экземпляр адаптера
   * @param dataDir каталог данных экземпляра (рабочая копия, прогресс, кулдауны)
   * @param seedFile база, поставляемая с пакетом (используется только при первом запуске)
   * @param legacyBackupFile старый бэкап из iobroker-data (миграция с версий <= 1.1.3)
   * @param legacyProgressFile старый файл прогресса рядом со скриптом
   */
  constructor(adapter, dataDir, seedFile, legacyBackupFile, legacyProgressFile) {
    this.adapter = adapter;
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, DB_NAME);
    this.seedFile = seedFile;
    this.legacyBackupFile = legacyBackupFile;
    this.legacyProgressFile = legacyProgressFile;
    this.mount = `${adapter.namespace}.storage`;
  }

  get persistent() {
    return this.adapter.config.preserveDatabase !== false;
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });

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

    this.migrateProgress();

    if (!this.persistent) {
      this.adapter.log.debug('Database preservation is disabled');
      await this.removeFromStorage();
      this.ensureLocalFromSeed();
      return;
    }

    // Рабочая копия — основная, если она валидна
    if (readMoviesFile(this.dbFile)) {
      await this.pushToStorage({ onlyIfMissing: true });
      return;
    }

    if (fs.existsSync(this.dbFile)) {
      this.adapter.log.warn('Working database is corrupt, trying to restore it');
    }

    // 1) хранилище ioBroker (например, после восстановления из бэкапа ioBroker)
    if (await this.pullFromStorage()) {
      this.adapter.log.info('Database restored from ioBroker file storage');
      return;
    }

    // 2) старый бэкап (миграция)
    if (readMoviesFile(this.legacyBackupFile)) {
      atomicCopy(this.legacyBackupFile, this.dbFile);
      this.adapter.log.info(`Database migrated from ${this.legacyBackupFile}`);
      await this.pushToStorage();
      return;
    }

    // 3) база из пакета
    this.ensureLocalFromSeed();
    await this.pushToStorage();
  }

  ensureLocalFromSeed() {
    if (readMoviesFile(this.dbFile)) return;
    if (readMoviesFile(this.seedFile)) {
      atomicCopy(this.seedFile, this.dbFile);
      this.adapter.log.info('Initial database copied from the adapter package');
    } else {
      this.adapter.log.warn('No database available (seed file missing or invalid)');
    }
  }

  /** Перенести файл прогресса синхронизации из каталога адаптера (при обновлении он терялся) */
  migrateProgress() {
    const target = path.join(this.dataDir, '.sync-progress.json');
    try {
      if (!fs.existsSync(target) && fs.existsSync(this.legacyProgressFile)) {
        atomicCopy(this.legacyProgressFile, target);
        this.adapter.log.info('Sync progress migrated to the instance data directory');
      }
    } catch (error) {
      this.adapter.log.warn(`Could not migrate sync progress: ${error.message}`);
    }
  }

  /**
   * Скопировать рабочую базу в файловое хранилище ioBroker.
   * @param opts.onlyIfMissing не перезаписывать, если файл в хранилище уже есть
   */
  async pushToStorage(opts = {}) {
    if (!this.persistent) return;
    try {
      if (opts.onlyIfMissing && (await this.adapter.fileExistsAsync(this.mount, DB_NAME))) return;
      const buffer = await fs.promises.readFile(this.dbFile);
      await this.adapter.writeFileAsync(this.mount, DB_NAME, buffer);
      this.adapter.log.info(`Database saved to ioBroker file storage (${Math.round(buffer.length / 1024 / 1024)}MB)`);
    } catch (error) {
      this.adapter.log.error(`Could not save database to ioBroker file storage: ${error.message}`);
    }
  }

  /** Восстановить рабочую базу из хранилища. Возвращает true при успехе. */
  async pullFromStorage() {
    try {
      if (!(await this.adapter.fileExistsAsync(this.mount, DB_NAME))) return false;
      const { file } = await this.adapter.readFileAsync(this.mount, DB_NAME);
      const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!parsed || !Array.isArray(parsed.movies)) {
        this.adapter.log.error('Database in ioBroker file storage is invalid, ignoring it');
        return false;
      }
      atomicWrite(this.dbFile, buffer);
      return true;
    } catch (error) {
      this.adapter.log.error(`Could not read database from ioBroker file storage: ${error.message}`);
      return false;
    }
  }

  async removeFromStorage() {
    try {
      if (await this.adapter.fileExistsAsync(this.mount, DB_NAME)) {
        await this.adapter.delFileAsync(this.mount, DB_NAME);
      }
    } catch (error) {
      this.adapter.log.warn(`Could not remove database from ioBroker file storage: ${error.message}`);
    }
  }
}

module.exports = DbStore;
module.exports.DB_NAME = DB_NAME;
