'use strict';

const utils = require('@iobroker/adapter-core');
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
    const fs = require('fs');
    const path = require('path');

    const dbPath = path.join(__dirname, 'www/data/movies-poiskkino.json');
    const userDbPath = path.join(this.namespace, 'movies-poiskkino.json');
    const backupDbPath = path.join(__dirname, 'www/data/movies-poiskkino.backup.json');

    try {
      // Если preserveDatabase включен (по умолчанию true)
      if (this.config.preserveDatabase !== false) {
        this.log.info('Database preservation is enabled');

        // Проверить есть ли пользовательская база в data directory
        const userDataDir = path.dirname(userDbPath);
        
        // Создать директорию если не существует
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        }

        // Если есть пользовательская база, восстановить её
        if (fs.existsSync(userDbPath)) {
          this.log.info('Restoring user database from data directory');
          fs.copyFileSync(userDbPath, dbPath);
          this.log.info('User database restored successfully');
        } else if (fs.existsSync(dbPath)) {
          // Если это первый запуск с preserveDatabase, сохранить текущую базу
          this.log.info('Saving current database to data directory');
          fs.copyFileSync(dbPath, userDbPath);
          this.log.info('Database saved to data directory');
        }
      } else {
        this.log.info('Database preservation is disabled - using default database');
        
        // Если preserveDatabase выключен, удалить пользовательскую базу
        if (fs.existsSync(userDbPath)) {
          this.log.info('Removing user database (preservation disabled)');
          fs.unlinkSync(userDbPath);
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
        await this.syncManager.start(configWithKeys);
        
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
