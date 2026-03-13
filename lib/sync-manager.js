'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class SyncManager {
  constructor(adapter) {
    this.adapter = adapter;
    this.process = null;
    this.isRunning = false;
    this.currentApiKeyIndex = 0;
    this.autoSyncTimer = null;
    this.apiKeyTimestamps = {}; // Отслеживание времени последнего поиска для каждого ключа
  }

  /**
   * Получить хеш API ключа для отслеживания
   */
  hashApiKey(apiKey) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(apiKey).digest('hex').substring(0, 8);
  }

  /**
   * Проверить, может ли ключ быть использован (прошло ли достаточно времени с последнего поиска)
   */
  canUseApiKey(apiKey, syncIntervalHours) {
    const keyHash = this.hashApiKey(apiKey);
    const lastTimestamp = this.apiKeyTimestamps[keyHash];
    
    if (!lastTimestamp) {
      return true; // Ключ еще не использовался
    }

    const now = Date.now();
    const elapsedHours = (now - lastTimestamp) / (1000 * 60 * 60);
    
    return elapsedHours >= syncIntervalHours;
  }

  /**
   * Обновить время последнего поиска для ключа
   */
  updateApiKeyTimestamp(apiKey) {
    const keyHash = this.hashApiKey(apiKey);
    this.apiKeyTimestamps[keyHash] = Date.now();
  }

  /**
   * Найти доступный API ключ для использования
   */
  findAvailableApiKey(apiKeys, syncIntervalHours) {
    for (let i = 0; i < apiKeys.length; i++) {
      if (this.canUseApiKey(apiKeys[i], syncIntervalHours)) {
        return { key: apiKeys[i], index: i };
      }
    }
    return null; // Все ключи на кулдауне
  }

  /**
   * Запустить автосинхронизацию
   */
  startAutoSync(config) {
    if (this.autoSyncTimer) {
      this.adapter.log.warn('Auto sync is already scheduled');
      return;
    }

    const syncIntervalHours = config.syncInterval || 24;
    const syncIntervalMs = syncIntervalHours * 60 * 60 * 1000;

    this.adapter.log.info(`Auto sync scheduled every ${syncIntervalHours} hours`);

    // Запустить первый поиск сразу
    this.performAutoSync(config);

    // Затем повторять через интервал
    this.autoSyncTimer = setInterval(() => {
      this.performAutoSync(config);
    }, syncIntervalMs);
  }

  /**
   * Выполнить автоматическую синхронизацию
   */
  async performAutoSync(config) {
    if (this.isRunning) {
      this.adapter.log.debug('Sync already running, skipping auto sync');
      return;
    }

    const apiKeys = config.apiKeys || [];
    const validKeys = apiKeys.filter(item => item && item.key && item.key.trim()).map(item => item.key.trim());

    if (validKeys.length === 0) {
      this.adapter.log.error('No API keys configured for auto sync');
      return;
    }

    const syncIntervalHours = config.syncInterval || 24;

    // Найти доступный ключ
    const availableKey = this.findAvailableApiKey(validKeys, syncIntervalHours);

    if (!availableKey) {
      this.adapter.log.warn(`All API keys are on cooldown. Next sync in ${syncIntervalHours} hours.`);
      return;
    }

    this.adapter.log.info(`Auto sync starting with API key ${availableKey.index + 1}/${validKeys.length}`);

    try {
      const configWithKeys = { ...config, apiKeys: validKeys };
      await this.start(configWithKeys, availableKey.index);
    } catch (error) {
      this.adapter.log.error(`Auto sync failed: ${error.message}`);
    }
  }

  /**
   * Остановить автосинхронизацию
   */
  stopAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
      this.adapter.log.info('Auto sync stopped');
    }
  }

  async start(config, apiKeyIndex = 0) {
    if (this.isRunning) {
      this.adapter.log.warn('Synchronization is already running');
      return;
    }

    // Проверить наличие API ключей
    if (!config.apiKeys || config.apiKeys.length === 0) {
      throw new Error('No API keys configured');
    }

    // Проверить наличие скрипта синхронизации
    const scriptPath = path.join(__dirname, '../scripts/poiskkino-sync.cjs');
    if (!fs.existsSync(scriptPath)) {
      throw new Error('Sync script not found');
    }

    // Получить текущий API ключ
    this.currentApiKeyIndex = apiKeyIndex;
    const apiKey = config.apiKeys[this.currentApiKeyIndex];

    // Подготовить аргументы
    const args = [
      scriptPath,
      '--api-key', apiKey
    ];

    // Добавить параметры запросов
    const maxRequestsPerRun = config.maxRequestsPerRun || 250;
    const dailyRequestLimit = config.dailyRequestLimit || 250;
    
    if (maxRequestsPerRun) {
      args.push('--max-requests', maxRequestsPerRun.toString());
    }
    
    // Передать дневной лимит скрипту
    args.push('--daily-limit', dailyRequestLimit.toString());
    
    // Добавить фильтры контента
    if (config.minRating !== undefined) {
      args.push('--min-rating', config.minRating.toString());
    }
    if (config.maxRating !== undefined) {
      args.push('--max-rating', config.maxRating.toString());
    }
    if (config.minVotes !== undefined) {
      args.push('--min-votes', config.minVotes.toString());
    }
    if (config.yearRangeStart !== undefined) {
      args.push('--year-start', config.yearRangeStart.toString());
    }
    if (config.yearRangeEnd !== undefined) {
      args.push('--year-end', config.yearRangeEnd.toString());
    }
    
    // Проверить preserveSyncProgress
    if (config.preserveSyncProgress === false) {
      // Если не сохраняем прогресс, добавляем --reset для начала с нуля
      args.push('--reset');
      this.adapter.log.info('Sync will start from the beginning (preserveSyncProgress is disabled)');
    } else {
      this.adapter.log.info('Sync will continue from last position (preserveSyncProgress is enabled)');
    }

    this.adapter.log.info(`Starting sync with API key ${this.currentApiKeyIndex + 1}/${config.apiKeys.length}`);
    this.adapter.log.info(`Max requests per run: ${maxRequestsPerRun}, Daily limit: ${dailyRequestLimit}`);

    // Обновить states
    await this.adapter.setStateAsync('sync.status', 'running', true);
    await this.adapter.setStateAsync('sync.progress', 0, true);
    await this.adapter.setStateAsync('sync.currentStep', 'Initializing...', true);
    await this.adapter.setStateAsync('sync.error', '', true);
    await this.adapter.setStateAsync('sync.foundMovies', 0, true);
    await this.adapter.setStateAsync('sync.newMovies', 0, true);

    // Запустить процесс
    this.process = spawn('node', args, {
      cwd: path.join(__dirname, '../scripts'),
      env: process.env
    });

    this.isRunning = true;

    // Обработка stdout
    this.process.stdout.on('data', async (data) => {
      const output = data.toString();
      this.adapter.log.debug(`Sync output: ${output}`);

      // Парсинг прогресса из вывода
      await this.parseOutput(output);
    });

    // Обработка stderr
    this.process.stderr.on('data', (data) => {
      const error = data.toString();
      this.adapter.log.error(`Sync error: ${error}`);
    });

    // Обработка завершения
    this.process.on('close', async (code) => {
      this.isRunning = false;
      this.process = null;

      if (code === 0) {
        this.adapter.log.info('Synchronization completed successfully');
        await this.adapter.setStateAsync('sync.status', 'completed', true);
        await this.adapter.setStateAsync('sync.progress', 100, true);
        await this.adapter.setStateAsync('sync.lastSync', new Date().toISOString(), true);
        // Обновить время последнего поиска для этого ключа
        this.updateApiKeyTimestamp(apiKey);
        // Сохранить базу в data directory если preserveDatabase включен
        await this.saveDatabaseToUserData();
        // Сигнал приложению перезагрузить кеш
        await this.adapter.setStateAsync('sync.reloadApp', true, true);
      } else if (code === null || code === 143 || code === 15) {
        // Процесс был остановлен пользователем (SIGTERM = 143, SIGKILL = 9)
        this.adapter.log.info('Synchronization stopped by user');
        await this.adapter.setStateAsync('sync.status', 'idle', true);
        await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
      } else if (code === 1) {
        // Код 1 может быть либо ошибкой, либо достижением лимита
        // Проверяем последнее сообщение об ошибке
        const lastError = await this.adapter.getStateAsync('sync.error');
        if (lastError && lastError.val && lastError.val.includes('Rate Limit')) {
          this.adapter.log.info('Synchronization stopped: API rate limit reached');
          await this.adapter.setStateAsync('sync.status', 'completed', true);
          await this.adapter.setStateAsync('sync.currentStep', 'Rate limit reached', true);
          // Обновить время последнего поиска для этого ключа
          this.updateApiKeyTimestamp(apiKey);
        } else {
          this.adapter.log.error(`Synchronization failed with code ${code}`);
          await this.adapter.setStateAsync('sync.status', 'error', true);
          await this.adapter.setStateAsync('sync.error', `Process exited with code ${code}`, true);
        }
      } else {
        this.adapter.log.error(`Synchronization failed with code ${code}`);
        await this.adapter.setStateAsync('sync.status', 'error', true);
        await this.adapter.setStateAsync('sync.error', `Process exited with code ${code}`, true);
      }
    });

    // Обработка ошибок процесса
    this.process.on('error', async (error) => {
      this.adapter.log.error(`Failed to start sync process: ${error.message}`);
      this.isRunning = false;
      this.process = null;
      await this.adapter.setStateAsync('sync.status', 'error', true);
      await this.adapter.setStateAsync('sync.error', error.message, true);
    });
  }

  async stop() {
    if (!this.isRunning || !this.process) {
      this.adapter.log.debug('No synchronization is running');
      return;
    }

    this.adapter.log.info('Stopping synchronization...');

    // Убить процесс
    this.process.kill('SIGTERM');

    // Подождать немного
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Если процесс все еще жив, убить принудительно
    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
    }

    this.isRunning = false;
    this.process = null;

    // Обновить states
    await this.adapter.setStateAsync('sync.status', 'idle', true);
    await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
  }

  async parseOutput(output) {
    try {
      // Парсинг различных сообщений из скрипта

      // "Получено X фильмов"
      const moviesMatch = output.match(/Получено (\d+) фильмов/);
      if (moviesMatch) {
        await this.adapter.setStateAsync('sync.currentStep', `Получено ${moviesMatch[1]} фильмов`, true);
      }

      // "Всего найдено в сессии: X"
      const totalFoundMatch = output.match(/Всего найдено в сессии: (\d+)/);
      if (totalFoundMatch) {
        const totalFound = parseInt(totalFoundMatch[1]);
        await this.adapter.setStateAsync('sync.foundMovies', totalFound, true);
      }

      // "Прогресс: X/Y запросов, всего: Z фильмов"
      const progressMatch = output.match(/Прогресс: (\d+)\/(\d+) запросов, всего: (\d+) фильмов/);
      if (progressMatch) {
        const current = parseInt(progressMatch[1]);
        const total = parseInt(progressMatch[2]);
        const totalMovies = parseInt(progressMatch[3]);
        const progress = Math.round((current / total) * 100);
        await this.adapter.setStateAsync('sync.progress', progress, true);
        await this.adapter.setStateAsync('sync.totalMovies', totalMovies, true);
        await this.adapter.setStateAsync('sync.currentStep', `Запрос ${current}/${total}`, true);
      }

      // "✓ Сохранено X новых фильмов (всего: Y)"
      const savedMatch = output.match(/Сохранено (\d+) новых фильмов \(всего: (\d+)\)/);
      if (savedMatch) {
        await this.adapter.setStateAsync('sync.newMovies', parseInt(savedMatch[1]), true);
        await this.adapter.setStateAsync('sync.totalMovies', parseInt(savedMatch[2]), true);
      }

      // "Новых фильмов: X"
      const newMoviesMatch = output.match(/Новых фильмов: (\d+)/);
      if (newMoviesMatch) {
        await this.adapter.setStateAsync('sync.newMovies', parseInt(newMoviesMatch[1]), true);
      }

      // "Всего фильмов: X"
      const totalMoviesMatch = output.match(/Всего фильмов: (\d+)/);
      if (totalMoviesMatch) {
        await this.adapter.setStateAsync('sync.totalMovies', parseInt(totalMoviesMatch[1]), true);
      }

      // "Использовано запросов: X"
      const usedRequestsMatch = output.match(/Использовано запросов: (\d+)/);
      if (usedRequestsMatch) {
        await this.adapter.setStateAsync('sync.requestsUsed', parseInt(usedRequestsMatch[1]), true);
      }

      // "Осталось запросов сегодня: X"
      const remainingRequestsMatch = output.match(/Осталось запросов сегодня: (\d+)/);
      if (remainingRequestsMatch) {
        await this.adapter.setStateAsync('sync.requestsRemaining', parseInt(remainingRequestsMatch[1]), true);
      }

      // "✓ Синхронизация завершена"
      if (output.includes('Синхронизация завершена')) {
        await this.adapter.setStateAsync('sync.currentStep', 'Завершено', true);
        await this.adapter.setStateAsync('sync.progress', 100, true);
      }

      // "Расширяем период: X-Y"
      const periodMatch = output.match(/Расширяем период: (\d+)-(\d+)/);
      if (periodMatch) {
        await this.adapter.setStateAsync('sync.currentStep', `Расширяем период: ${periodMatch[1]}-${periodMatch[2]}`, true);
      }

      // Ошибки
      if (output.includes('❌') || output.includes('Ошибка')) {
        const errorMatch = output.match(/❌\s*(.+)/);
        if (errorMatch) {
          await this.adapter.setStateAsync('sync.error', errorMatch[1].trim(), true);
        }
      }

    } catch (error) {
      this.adapter.log.error(`Error parsing output: ${error.message}`);
    }
  }

  async saveDatabaseToUserData() {
    const fs = require('fs');
    const path = require('path');

    try {
      // Проверить настройку preserveDatabase
      if (this.adapter.config.preserveDatabase === false) {
        this.adapter.log.debug('Database preservation is disabled, skipping save');
        return;
      }

      const dbPath = path.join(__dirname, '../www/data/movies-poiskkino.json');
      const userDbPath = path.join(this.adapter.namespace, 'movies-poiskkino.json');

      // Проверить существует ли база
      if (!fs.existsSync(dbPath)) {
        this.adapter.log.warn('Database file not found, cannot save to user data');
        return;
      }

      // Создать директорию если не существует
      const userDataDir = path.dirname(userDbPath);
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }

      // Скопировать базу в data directory
      fs.copyFileSync(dbPath, userDbPath);
      this.adapter.log.info('Database saved to user data directory');
    } catch (error) {
      this.adapter.log.error(`Error saving database to user data: ${error.message}`);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentApiKeyIndex: this.currentApiKeyIndex
    };
  }
}

module.exports = SyncManager;
