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

  async onReady() {
    this.log.info('MovieSwipe adapter starting...');

    // Установить connection в false при старте
    await this.setStateAsync('info.connection', false, true);

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
    }

    // Инициализировать sync manager
    this.syncManager = new SyncManager(this);

    // Подписаться на изменения состояний
    this.subscribeStates('sync.start');
    this.subscribeStates('sync.stop');

    this.log.info('MovieSwipe adapter ready');
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    const idParts = id.split('.');
    const stateName = idParts[idParts.length - 1];

    try {
      if (stateName === 'start' && state.val === true) {
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
