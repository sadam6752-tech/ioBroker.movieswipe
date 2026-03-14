'use strict';

const utils = require('@iobroker/adapter-core');
const path = require('path');
const fs = require('fs');
const WebServer = require('./lib/web-server');
const SyncManager = require('./lib/sync-manager');

class MovieSwipe extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'movieswipe',
    });

    this.webServer = null;
    this.syncManager = null;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async handleDatabasePreservation() {
    const dbPath = path.join(__dirname, 'www/data/movies-poiskkino.json');
    const backupPath = path.join(__dirname, 'www/data/movies-poiskkino.backup.json');

    try {
      if (this.config.preserveDatabase !== false) {
        // Если есть резервная копия — восстановить если она новее/больше текущей базы
        if (fs.existsSync(backupPath)) {
          const backupStat = fs.statSync(backupPath);
          const dbStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;

          // Восстанавливаем если резервная копия новее или больше текущей базы
          if (!dbStat || backupStat.size > dbStat.size || backupStat.mtimeMs > dbStat.mtimeMs) {
            this.log.info(`Restoring database from backup (backup: ${Math.round(backupStat.size / 1024 / 1024)}MB)`);
            fs.copyFileSync(backupPath, dbPath);
            this.log.info('Database restored from backup successfully');
          } else {
            this.log.info('Current database is up to date, backup not needed');
          }
        } else {
          this.log.info('No backup found, will create one after first sync');
        }
      } else {
        this.log.info('Database preservation is disabled');
        // Удалить резервную копию если preservation выключен
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      }
    } catch (error) {
      this.log.error(`Error handling database preservation: ${error.message}`);
    }
  }

  async onReady() {
    this.log.info('MovieSwipe adapter starting...');

    // Установить connection в false при старте
    await this.setStateAsync('info.connection', false, true);

    // Проверить и сохранить пользовательскую базу данных если нужно
    await this.handleDatabasePreservation();

    // Инициализировать веб-сервер
    try {
      const port = this.config.port || 3000;
      const wwwPath = `${__dirname}/www`;

      this.webServer = new WebServer(this);
      await this.webServer.start(port, wwwPath);

      // Обновить states сервера
      await this.setStateAsync('server.port', port, true);
      await this.setStateAsync('server.url', this.webServer.getUrl(), true);
      await this.setStateAsync('server.running', true, true);
      await this.setStateAsync('info.connection', true, true);

      this.log.info(`Web server started at ${this.webServer.getUrl()}`);
    } catch (error) {
      this.log.error(`Failed to start web server: ${error.message}`);
      await this.setStateAsync('server.running', false, true);
      // Продолжить работу адаптера даже если веб-сервер не запустился
    }

    // Инициализировать sync manager
    try {
      this.syncManager = new SyncManager(this);
    } catch (error) {
      this.log.error(`Failed to initialize sync manager: ${error.message}`);
    }

    // Подписаться на изменения состояний
    this.subscribeStates('sync.start');
    this.subscribeStates('sync.stop');

    // Запустить автосинхронизацию если включена
    if (this.config.autoSync && this.syncManager) {
      try {
        this.log.info('Auto sync is enabled, starting scheduler...');
        this.syncManager.startAutoSync(this.config);
      } catch (error) {
        this.log.error(`Failed to start auto sync: ${error.message}`);
      }
    }

    this.log.info('MovieSwipe adapter ready');
    
    // Обновить количество фильмов в базе
    this.updateMovieCount();
  }

  /**
   * Обновить количество фильмов в базе данных
   */
  async updateMovieCount() {
    try {
      const dbPath = path.join(__dirname, 'www/data/movies-poiskkino.json');
      
      if (fs.existsSync(dbPath)) {
        const data = fs.readFileSync(dbPath, 'utf8');
        const json = JSON.parse(data);
        const movieCount = json.movies ? json.movies.length : 0;
        
        await this.setStateAsync('sync.totalMovies', movieCount, true);
        this.log.info(`Database contains ${movieCount} movies`);
      } else {
        await this.setStateAsync('sync.totalMovies', 0, true);
        this.log.warn('Database file not found');
      }
    } catch (error) {
      this.log.error(`Error reading database: ${error.message}`);
      await this.setStateAsync('sync.totalMovies', 0, true);
    }
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    const idParts = id.split('.');
    const stateName = idParts[idParts.length - 1];

    try {
      if (stateName === 'start' && state.val === true) {
        if (!this.syncManager) {
          this.log.error('Sync manager not initialized');
          await this.setStateAsync('sync.status', 'error', true);
          await this.setStateAsync('sync.error', 'Sync manager not initialized', true);
          return;
        }

        this.log.info('Starting synchronization...');
        
        // Проверить наличие API ключей
        const apiKeys = this.config.apiKeys || [];
        const validKeys = apiKeys.filter(item => item && item.key && item.key.trim()).map(item => item.key.trim());
        
        if (validKeys.length === 0) {
          this.log.error('No API keys configured');
          await this.setStateAsync('sync.status', 'error', true);
          await this.setStateAsync('sync.error', 'No API keys configured', true);
          return;
        }

        // Запустить синхронизацию с преобразованными ключами
        const configWithKeys = { ...this.config, apiKeys: validKeys };
        
        // Найти доступный API ключ (с учетом кулдауна)
        const syncIntervalHours = this.config.syncInterval || 24;
        const availableKey = this.syncManager.findAvailableApiKey(validKeys, syncIntervalHours);
        
        if (!availableKey) {
          this.log.warn('All API keys are on cooldown. Please wait or add more keys.');
          await this.setStateAsync('sync.status', 'error', true);
          await this.setStateAsync('sync.error', 'All API keys are on cooldown', true);
          return;
        }
        
        this.log.info(`Using API key ${availableKey.index + 1}/${validKeys.length}`);
        await this.syncManager.start(configWithKeys, availableKey.index);
        
        // Сбросить триггер
        await this.setStateAsync('sync.start', false, true);
      } else if (stateName === 'stop' && state.val === true) {
        if (!this.syncManager) {
          this.log.error('Sync manager not initialized');
          return;
        }

        this.log.info('Stopping synchronization...');
        
        await this.syncManager.stop();
        
        // Сбросить триггер
        await this.setStateAsync('sync.stop', false, true);
      }
    } catch (error) {
      this.log.error(`Error handling state change: ${error.message}`);
    }
  }

  async onUnload(callback) {
    try {
      this.log.info('Cleaning up...');

      // Остановить автосинхронизацию
      if (this.syncManager) {
        this.syncManager.stopAutoSync();
      }

      // Остановить синхронизацию
      if (this.syncManager) {
        await this.syncManager.stop();
      }

      // Остановить веб-сервер
      if (this.webServer) {
        await this.webServer.stop();
      }

      // Обновить states
      await this.setStateAsync('info.connection', false, true);
      await this.setStateAsync('server.running', false, true);

      this.log.info('Cleanup complete');
      callback();
    } catch (error) {
      this.log.error(`Error during cleanup: ${error.message}`);
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new MovieSwipe(options);
} else {
  new MovieSwipe();
}
