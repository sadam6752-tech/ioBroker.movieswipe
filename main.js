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
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  getBackupPath() {
    // Хранить бэкап в iobroker-data — эта директория НЕ перезаписывается при обновлении адаптера
    const dataDir = utils.getAbsoluteDefaultDataDir();
    const backupDir = path.join(dataDir, this.namespace);
    return { backupDir, backupPath: path.join(backupDir, 'movies-poiskkino.backup.json') };
  }

  async handleDatabasePreservation() {
    const dbPath = path.join(__dirname, 'www/data/movies-poiskkino.json');
    const { backupDir, backupPath } = this.getBackupPath();

    try {
      if (this.config.preserveDatabase !== false) {
        // Если есть резервная копия — восстановить если она новее/больше текущей базы
        if (fs.existsSync(backupPath)) {
          const backupStat = fs.statSync(backupPath);
          const dbStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;

          // Восстанавливаем если резервная копия новее или больше текущей базы
          if (!dbStat || backupStat.size > dbStat.size || backupStat.mtimeMs > dbStat.mtimeMs) {
            this.log.debug(`Restoring database from backup (${Math.round(backupStat.size / 1024 / 1024)}MB) at ${backupPath}`);
            fs.copyFileSync(backupPath, dbPath);
            this.log.debug('Database restored from backup successfully');
          } else {
            this.log.debug('Current database is up to date, backup not needed');
          }
        } else {
          this.log.debug(`No backup found at ${backupPath}, will create one after first sync`);
        }
      } else {
        this.log.debug('Database preservation is disabled');
        // Удалить резервную копию если preservation выключен
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      }
    } catch (error) {
      this.log.error(`Error handling database preservation: ${error.message}`);
    }
  }

  /**
   * Резолвить IP адрес из имени интерфейса или вернуть как есть если уже IP
   */
  resolveBindAddress(bind) {
    const os = require('os');
    if (!bind || bind === '0.0.0.0' || bind === '::') {
      // Слушаем на всех — вернуть первый не-loopback IPv4
      const interfaces = os.networkInterfaces();
      for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
          if (addr.family === 'IPv4' && !addr.internal) {
            return addr.address;
          }
        }
      }
      return '127.0.0.1';
    }
    // Проверить — это уже IP адрес?
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bind) || bind.includes(':')) {
      return bind;
    }
    // Это имя интерфейса — найти его IP
    const interfaces = os.networkInterfaces();
    const iface = interfaces[bind];
    if (iface) {
      const ipv4 = iface.find(a => a.family === 'IPv4');
      if (ipv4) return ipv4.address;
      const ipv6 = iface.find(a => a.family === 'IPv6' && !a.internal);
      if (ipv6) return ipv6.address;
    }
    this.log.warn(`Could not resolve IP for interface "${bind}", falling back to 0.0.0.0`);
    return '0.0.0.0';
  }

  async onReady() {
    this.log.debug('MovieSwipe adapter starting...');

    // Установить connection в false при старте
    await this.setStateAsync('info.connection', false, true);

    // Проверить и сохранить пользовательскую базу данных если нужно
    await this.handleDatabasePreservation();

    // Инициализировать веб-сервер
    try {
      const port = this.config.port || 3000;
      const bind = this.config.bind || '0.0.0.0';
      const resolvedIp = this.resolveBindAddress(bind);
      const wwwPath = `${__dirname}/www`;

      this.webServer = new WebServer(this);
      await this.webServer.start(port, wwwPath, bind);

      // Обновить states сервера
      await this.setStateAsync('server.port', port, true);
      await this.setStateAsync('server.ip', resolvedIp, true);
      await this.setStateAsync('server.url', `http://${resolvedIp}:${port}`, true);
      await this.setStateAsync('server.running', true, true);
      await this.setStateAsync('info.connection', true, true);

      this.log.info(`Web server started at http://${resolvedIp}:${port} (bind: ${bind})`);
    } catch (error) {
      this.log.error(`Failed to start web server: ${error.message}`);
      await this.setStateAsync('server.running', false, true);
      // Продолжить работу адаптера даже если веб-сервер не запустился
    }

    // Инициализировать sync manager
    try {
      const { backupDir, backupPath } = this.getBackupPath();
      this.syncManager = new SyncManager(this, backupDir, backupPath);
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

    this.log.debug('MovieSwipe adapter ready');
    
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
        this.log.debug(`Database contains ${movieCount} movies`);
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

  onMessage(obj) {
    if (!obj || !obj.command) return;
    if (obj.command === 'getServerUrl') {
      const port = this.config.port || 3000;
      const bind = this.config.bind || '0.0.0.0';
      const ip = this.resolveBindAddress(bind);
      const url = `http://${ip}:${port}`;
      if (obj.callback) this.sendTo(obj.from, obj.command, { url, ip, port }, obj.callback);
    }
  }

  async onUnload(callback) {
    try {
      this.log.debug('Cleaning up...');

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

      this.log.debug('Cleanup complete');
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
