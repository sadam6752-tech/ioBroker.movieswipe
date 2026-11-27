'use strict';

const utils = require('@iobroker/adapter-core');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebServer = require('./lib/web-server');
const SyncManager = require('./lib/sync-manager');
const DbStore = require('./lib/db-store');
const { findLanAddress } = require('./lib/net-utils');
const { MovieSearch } = require('./lib/movie-search');
const { AgentHistory } = require('./lib/agent-history');
const { NAMES: AGENT_COMMANDS, runCommand } = require('./lib/agent-commands');
const { LampaBridge } = require('./lib/lampa-bridge');
const { LampaSync, MOUNT: LAMPA_SYNC_MOUNT, GROUPS: LAMPA_GROUPS, OPT_IN_GROUPS } = require('./lib/lampa-sync');

/** Commands of the admin page for the Lampa sync */
const LAMPA_SYNC_COMMANDS = ['lampaSyncInfo', 'lampaSyncDevices', 'lampaSyncReset', 'lampaSyncPlugins', 'lampaSyncRemovePlugin'];
/** Settings that switch the groups of the Lampa sync on */
const LAMPA_GROUP_SETTINGS = {
  timeline: 'lampaSyncTimeline',
  favorite: 'lampaSyncFavorite',
  viewed: 'lampaSyncViewed',
  search: 'lampaSyncSearch',
  plugins: 'lampaSyncPlugins',
};

/**
 * @param {unknown} text text
 * @returns {string} text for HTML
 */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

class MovieSwipe extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'movieswipe',
    });

    this.webServer = null;
    this.syncManager = null;
    this.dbStore = null;
    this.movieSearch = null;
    this.history = null;
    this.lampa = null;
    this.lampaSync = null;
    this.lampaStatesTimer = null;
    this.lampaChanged = false;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  /**
   * Резолвить IP адрес из имени интерфейса или вернуть как есть если уже IP
   */
  resolveBindAddress(bind) {
    if (!bind || bind === '0.0.0.0' || bind === '::') {
      // Слушаем на всех — вернуть первый не-loopback IPv4 (для отображения)
      return findLanAddress() || '127.0.0.1';
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

    // Подготовить базу данных: рабочая копия в каталоге данных экземпляра,
    // долговременная — в файловом хранилище ioBroker
    try {
      const dataDir = utils.getAbsoluteInstanceDataDir(this);
      this.dbStore = new DbStore(
        this,
        dataDir,
        path.join(__dirname, 'www/data/movies-poiskkino.json'),
        path.join(utils.getAbsoluteDefaultDataDir(), this.namespace, 'movies-poiskkino.backup.json'),
        path.join(__dirname, 'scripts/.sync-progress.json'),
      );
      await this.dbStore.init();
      this.movieSearch = new MovieSearch(this, this.dbStore.dbFile);
      this.history = new AgentHistory(this, dataDir);
      await this.history.init();
    } catch (error) {
      this.log.error(`Error preparing database: ${error.message}`);
      this.terminate(11);
      return;
    }

    // Инициализировать веб-сервер
    try {
      const port = this.config.port || 3000;
      const bind = this.config.bind || '';
      const resolvedIp = this.resolveBindAddress(bind);
      const wwwPath = `${__dirname}/www`;

      this.webServer = new WebServer(this);
      this.lampa = new LampaBridge(this);
      await this.startLampaSync();
      await this.webServer.start(port, wwwPath, bind, this.dbStore, this.lampa);

      // Обновить states сервера
      await this.setStateAsync('server.port', port, true);
      await this.setStateAsync('server.ip', resolvedIp, true);
      await this.setStateAsync('server.url', `http://${resolvedIp}:${port}`, true);
      await this.setStateAsync('server.running', true, true);
      await this.setStateAsync('info.connection', true, true);

      this.log.info(`Web server started at http://${resolvedIp}:${port} (bind: ${bind})`);
    } catch (error) {
      this.log.error(`Failed to start web server: ${error.message}`);
      this.lampa = null;
      await this.setStateAsync('server.running', false, true);
      // Продолжить работу адаптера даже если веб-сервер не запустился
    }

    // Инициализировать sync manager
    try {
      this.syncManager = new SyncManager(this, this.dbStore);
    } catch (error) {
      this.log.error(`Failed to initialize sync manager: ${error.message}`);
    }

    // Подписаться на изменения состояний
    this.subscribeStates('sync.start');
    this.subscribeStates('sync.stop');
    this.subscribeStates('lampa.syncReset');

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
   * Starts the sync of Lampa data between devices (lib/lampa-sync.js) when it is switched on and has a key
   */
  async startLampaSync() {
    if (!this.config.lampaSync) {
      return;
    }
    const key = typeof this.config.lampaSyncKey === 'string' ? this.config.lampaSyncKey.trim() : '';
    if (!key) {
      this.log.warn('Lampa sync is switched on but has no sync key: set "Sync key" in the adapter settings');
      return;
    }
    // the plugins group is only on when switched on explicitly, the others unless switched off
    const groups = Object.keys(LAMPA_GROUPS).filter(g => {
      const value = this.config[LAMPA_GROUP_SETTINGS[g]];
      return OPT_IN_GROUPS.includes(g) ? value === true : value !== false;
    });
    const sync = new LampaSync(this, {
      key,
      groups,
      mount: `${this.namespace}.${LAMPA_SYNC_MOUNT}`,
      ownPort: this.config.port || 3000,
    });
    try {
      await sync.load();
    } catch (error) {
      this.log.warn(`Lampa sync: cannot prepare the file storage: ${error.message}`);
      return;
    }
    sync.onChange = (rev, from) => {
      if (this.lampa) {
        this.lampa.broadcast({ action: 'sync', rev }, from);
      }
      this.scheduleLampaStates(true);
    };
    sync.onDevice = () => this.scheduleLampaStates(false);
    this.lampaSync = sync;
    if (this.lampa) {
      this.lampa.sync = sync;
    }
    this.log.info(`Lampa sync is on: ${groups.join(', ') || 'no groups'}`);
    this.scheduleLampaStates(false);
  }

  /**
   * Publishes the devices and the last change of the Lampa sync, at most every few seconds
   *
   * @param {boolean} changed true when the copy changed
   */
  scheduleLampaStates(changed) {
    if (changed) {
      this.lampaChanged = true;
    }
    if (this.lampaStatesTimer) {
      return;
    }
    this.lampaStatesTimer = this.setTimeout(async () => {
      this.lampaStatesTimer = null;
      if (!this.lampaSync) {
        return;
      }
      try {
        await this.setStateAsync('lampa.syncDevices', JSON.stringify(this.lampaSync.devices()), true);
        if (this.lampaChanged) {
          this.lampaChanged = false;
          await this.setStateAsync('lampa.syncLastChange', new Date().toISOString(), true);
        }
      } catch (error) {
        this.log.debug(`Lampa sync states: ${error.message}`);
      }
    }, 5000);
  }

  /**
   * Resets the Lampa sync copy (state lampa.syncReset or the admin button)
   *
   * @param {unknown} target name or id of the device whose data is taken, or empty / "all"
   * @returns {string} what happens now
   */
  resetLampaSync(target) {
    if (!this.lampaSync) {
      throw new Error('Lampa sync is off');
    }
    const { source } = this.lampaSync.reset(target);
    return source
      ? `The data of "${source}" replaces the copy as soon as it syncs; then the other devices take it over.`
      : 'The copy is built again from the data of all devices as they sync.';
  }

  /**
   * Answers the admin page about the Lampa sync
   *
   * @param {ioBroker.Message} obj message
   */
  onLampaSyncCommand(obj) {
    /** @type {any} */
    let answer;
    const sync = this.lampaSync;
    try {
      if (obj.command === 'lampaSyncDevices') {
        answer = [{ label: 'All devices (merge)', value: 'all' }].concat(
          sync ? sync.devices().map(d => ({ label: d.name, value: d.id })) : [],
        );
      } else if (obj.command === 'lampaSyncPlugins') {
        answer = sync ? sync.plugins().map(p => ({ label: p.name ? `${p.name} (${p.url})` : p.url, value: p.url })) : [];
      } else if (obj.command === 'lampaSyncRemovePlugin') {
        const message = /** @type {any} */ (obj.message) || {};
        if (!sync) {
          throw new Error('Lampa sync is off');
        }
        answer = sync.removePlugin(message.url)
          ? { result: 'Removed from the copy: devices that have it keep it, others are not offered it any more.' }
          : { error: 'This plugin is not in the copy' };
      } else if (obj.command === 'lampaSyncReset') {
        const message = /** @type {any} */ (obj.message) || {};
        answer = { result: this.resetLampaSync(message.device) };
      } else {
        answer = this.lampaSyncHtml();
      }
    } catch (error) {
      answer = obj.command === 'lampaSyncInfo' ? `<p>${escapeHtml(error.message)}</p>` : { error: error.message };
    }
    if (obj.callback) this.sendTo(obj.from, obj.command, answer, obj.callback);
  }

  /** @returns {string} the devices of the Lampa sync as HTML table for the admin page */
  lampaSyncHtml() {
    const sync = this.lampaSync;
    if (!sync) {
      return '<p>Lampa sync is off: switch it on, set a sync key and save the settings.</p>';
    }
    const counts = sync.counts();
    const rows = sync
      .devices()
      .map(d => {
        const modes = Object.keys(d.modes || {})
          .map(g => `${g}: ${d.modes[g]}`)
          .join(', ');
        const cells = [d.name, d.platform || '', new Date(d.lastSync).toLocaleString(), modes];
        return `<tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
      })
      .join('');
    const pending = sync.pendingSource();
    const head = ['Device', 'Platform', 'Last sync', 'On the device'].map(h => `<th align="left">${h}</th>`).join('');
    const plugins = sync.plugins();
    const pluginRows = plugins
      .map(p => {
        const cells = [p.name || '', p.url, p.from || '', new Date(p.ts).toLocaleString()];
        return `<tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
      })
      .join('');
    const pluginHead = ['Plugin', 'Address', 'From device', 'Added'].map(h => `<th align="left">${h}</th>`).join('');
    const pluginTable = sync.categories().includes('plugins')
      ? pluginRows
        ? `<p><b>Plugins in the copy</b></p><table style="border-collapse:collapse" cellpadding="4"><tr>${pluginHead}</tr>${pluginRows}</table>`
        : '<p>No plugin in the copy yet.</p>'
      : '';
    return (
      `<p>${Object.keys(counts)
        .map(c => `${escapeHtml(c)}: ${counts[c]}`)
        .join(' · ')}</p>` +
      (pending ? `<p>Reset: waiting for "${escapeHtml(pending)}" to sync.</p>` : '') +
      (rows
        ? `<table style="border-collapse:collapse" cellpadding="4"><tr>${head}</tr>${rows}</table>`
        : '<p>No device has synced yet.</p>') +
      pluginTable
    );
  }

  /**
   * Обновить количество фильмов в базе данных
   */
  async updateMovieCount() {
    try {
      const dbPath = this.dbStore.dbFile;
      
      if (fs.existsSync(dbPath)) {
        const data = await fs.promises.readFile(dbPath, 'utf8');
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
      if (stateName === 'syncReset') {
        try {
          this.log.info(this.resetLampaSync(state.val));
        } catch (error) {
          this.log.warn(`Lampa sync reset: ${error.message}`);
        }
        await this.setStateAsync('lampa.syncReset', '', true);
      } else if (stateName === 'start' && state.val === true) {
        if (!this.syncManager) {
          this.log.error('Sync manager not initialized');
          await this.setStateAsync('sync.status', 'error', true);
          await this.setStateAsync('sync.error', 'Sync manager not initialized', true);
          return;
        }

        this.log.info('Starting synchronization...');
        
        // Проверить наличие API ключей
        const apiKeys = this.config.apiKeys || [];
        const validKeys = apiKeys.filter(item => {
          if (!item) return false;
          if (typeof item === 'string') return item.trim();
          return item.key && item.key.trim();
        });
        
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
      const bind = this.config.bind || '';
      const ip = this.resolveBindAddress(bind);
      const url = `http://${ip}:${port}`;
      if (obj.callback) this.sendTo(obj.from, obj.command, { url, ip, port }, obj.callback);
    } else if (LAMPA_SYNC_COMMANDS.includes(obj.command)) {
      this.onLampaSyncCommand(obj);
    } else if (AGENT_COMMANDS.includes(obj.command)) {
      this.onAgentCommand(obj);
    }
  }

  /**
   * A command of an AI agent (help, suggest, search, getMovie, markMovie, history, genres, openInLampa, lampaDevices, addBookmark, removeBookmark, bookmarks, markWatched), see lib/agent-commands.js
   *
   * @param {ioBroker.Message} obj message
   */
  async onAgentCommand(obj) {
    let answer;
    try {
      if (!this.movieSearch || !this.history) {
        throw new Error('The adapter is not ready yet');
      }
      answer = await runCommand(obj.command, obj.message, {
        search: this.movieSearch,
        history: this.history,
        lampa: this.lampa,
        lampaSync: this.lampaSync,
      });
      this.log.debug(`Agent command ${obj.command}: ${JSON.stringify(answer).slice(0, 200)}`);
    } catch (error) {
      this.log.debug(`Agent command ${obj.command} failed: ${error.message}`);
      answer = { error: error.message };
    }
    if (obj.callback) this.sendTo(obj.from, obj.command, answer, obj.callback);
  }

  async onUnload(callback) {
    try {
      this.log.debug('Cleaning up...');

      if (this.syncManager) {
        this.syncManager.stopAutoSync();
        await this.syncManager.stop();
        this.syncManager = null;
      }

      if (this.movieSearch) {
        this.movieSearch.stop();
        this.movieSearch = null;
      }

      if (this.lampa) {
        this.lampa.stop();
      }

      if (this.lampaStatesTimer) {
        this.clearTimeout(this.lampaStatesTimer);
        this.lampaStatesTimer = null;
      }

      if (this.lampaSync) {
        await this.lampaSync.flush();
        this.lampaSync = null;
      }

      if (this.webServer) {
        await this.webServer.stop();
        this.webServer = null;
      }

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
