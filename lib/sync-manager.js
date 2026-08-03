'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class SyncManager {
  constructor(adapter, backupDir, backupPath) {
    this.adapter = adapter;
    this.process = null;
    this.isRunning = false;
    this.currentApiKeyIndex = 0;
    this.autoSyncTimer = null;
    this.apiKeyTimestamps = {}; // Отслеживание времени последнего поиска для каждого ключа
    // Путь к бэкапу в iobroker-data (не перезаписывается при обновлении адаптера)
    this.backupDir = backupDir;
    this.backupPath = backupPath;
  }

  /**
   * Получить ключ как строку из элемента массива (строка или объект)
   */
  getKeyString(keyItem) {
    if (typeof keyItem === 'string') return keyItem;
    if (keyItem && keyItem.key) return keyItem.key.trim();
    return '';
  }

  /**
   * Получить хеш API ключа для отслеживания
   */
  hashApiKey(apiKey) {
    const crypto = require('crypto');
    const keyString = this.getKeyString(apiKey);
    return crypto.createHash('md5').update(keyString).digest('hex').substring(0, 8);
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
        return { key: this.getKeyString(apiKeys[i]), index: i };
      }
    }
    return null; // Все ключи на кулдауне
  }

  /**
   * Вычислить миллисекунды до следующего наступления времени HH:MM
   */
  msUntilTime(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) {
      // Время сегодня уже прошло — следующий запуск завтра
      next.setDate(next.getDate() + 1);
    }
    return next - now;
  }

  /**
   * Запустить автосинхронизацию
   * Режим 1 (syncScheduled=false): повторять каждые N часов, первый запуск сразу
   * Режим 2 (syncScheduled=true):  запускать ежедневно в фиксированное время syncScheduledTime
   */
  startAutoSync(config) {
    if (this.autoSyncTimer) {
      this.adapter.log.warn('Auto sync is already scheduled');
      return;
    }

    if (config.syncScheduled && config.syncScheduledTime) {
      // ── Режим фиксированного времени ──────────────────────────────────────
      const timeStr = config.syncScheduledTime;
      const delay = this.msUntilTime(timeStr);
      const delayMin = Math.round(delay / 60000);

      this.adapter.log.info(`Auto sync scheduled daily at ${timeStr} (in ${delayMin} min)`);

      const scheduleNext = () => {
        const nextDelay = this.msUntilTime(timeStr);
        this.adapter.log.info(`Next auto sync scheduled at ${timeStr} (in ${Math.round(nextDelay / 60000)} min)`);
        this.autoSyncTimer = setTimeout(() => {
          this.performAutoSync(config);
          scheduleNext();
        }, nextDelay);
      };

      // Первый запуск — в нужное время
      this.autoSyncTimer = setTimeout(() => {
        this.performAutoSync(config);
        scheduleNext();
      }, delay);

    } else {
      // ── Режим интервала ───────────────────────────────────────────────────
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
    const validKeys = apiKeys.filter(item => {
      if (!item) return false;
      const key = typeof item === 'object' ? item.key : item;
      return key && key.trim();
    });

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
      clearTimeout(this.autoSyncTimer);
      clearInterval(this.autoSyncTimer); // на всякий случай для режима интервала
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
    const keyConfig = config.apiKeys[this.currentApiKeyIndex];
    const apiKey = typeof keyConfig === 'object' ? keyConfig.key : keyConfig;

    // Параметры конкретного ключа (или хардкод-дефолты если не заданы)
    const keyYearStart = (typeof keyConfig === 'object' && keyConfig.yearStart) ? keyConfig.yearStart : 2020;
    const keyYearEnd   = (typeof keyConfig === 'object' && keyConfig.yearEnd)   ? keyConfig.yearEnd   : new Date().getFullYear();
    const keyMinVotes  = (typeof keyConfig === 'object' && keyConfig.minVotes  != null) ? keyConfig.minVotes  : (config.minVotes  || 1000);
    const keyMinRating = (typeof keyConfig === 'object' && keyConfig.minRating != null) ? keyConfig.minRating : (config.minRating || 5);

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
    
    // Добавить фильтры контента (из настроек ключа или глобальные)
    args.push('--min-rating', keyMinRating.toString());
    args.push('--min-votes', keyMinVotes.toString());
    args.push('--year-start', keyYearStart.toString());
    args.push('--year-end', keyYearEnd.toString());

    this.adapter.log.info(`Key ${apiKeyIndex + 1} year range: ${keyYearStart}-${keyYearEnd}, minVotes: ${keyMinVotes}, minRating: ${keyMinRating}`);

    // EU-зеркало
    if (config.useEuServer === true) {
      args.push('--eu-server');
      this.adapter.log.info('Using EU mirror: https://eu-api.poiskkino.dev');
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
        // Обновить время последнего поиска для этого ключа
        this.updateApiKeyTimestamp(apiKey);
        // Сохранить бэкап
        await this.saveDatabaseToUserData();
        // Сигнал приложению перезагрузить кеш
        await this.adapter.setStateAsync('sync.reloadApp', true, true);

        // Проверить есть ли ещё доступные ключи для продолжения
        const remainingKeys = config.apiKeys.slice(this.currentApiKeyIndex + 1);
        const nextKey = this.findAvailableApiKey(remainingKeys, 0); // кулдаун 0 — берём следующий без ожидания

        if (nextKey && remainingKeys.length > 0) {
          const nextIndex = this.currentApiKeyIndex + 1 + nextKey.index;
          this.adapter.log.info(`Daily limit reached for key ${this.currentApiKeyIndex + 1}. Switching to key ${nextIndex + 1}/${config.apiKeys.length}`);
          await this.adapter.setStateAsync('sync.status', 'running', true);
          await this.adapter.setStateAsync('sync.currentStep', `Switching to API key ${nextIndex + 1}...`, true);
          // Небольшая пауза перед запуском следующего ключа
          await new Promise(resolve => setTimeout(resolve, 2000));
          await this.start(config, nextIndex);
        } else {
          await this.adapter.setStateAsync('sync.status', 'completed', true);
          await this.adapter.setStateAsync('sync.progress', 100, true);
          await this.adapter.setStateAsync('sync.lastSync', new Date().toISOString(), true);
          await this.adapter.setStateAsync('sync.currentStep', 'Completed', true);
        }
      } else if (code === null || code === 143 || code === 15) {
        // Процесс был остановлен пользователем (SIGTERM = 143, SIGKILL = 9)
        this.adapter.log.info('Synchronization stopped by user');
        await this.adapter.setStateAsync('sync.status', 'idle', true);
        await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
      } else {
        // Любой другой код - ошибка
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
        // всего: Y — это реальное количество в файле базы, всегда актуально
        await this.adapter.setStateAsync('sync.totalMovies', parseInt(savedMatch[2]), true);
      }

      // "Новых фильмов: X"
      const newMoviesMatch = output.match(/Новых фильмов: (\d+)/);
      if (newMoviesMatch) {
        await this.adapter.setStateAsync('sync.newMovies', parseInt(newMoviesMatch[1]), true);
      }

      // "Всего фильмов: X" — только из итоговой сводки, используем только если нет данных из savedMatch
      const totalMoviesMatch = output.match(/Всего фильмов: (\d+)/);
      if (totalMoviesMatch) {
        // Читаем реальное количество из файла базы, а не из счётчика скрипта
        await this.adapter.updateMovieCount();
      }

      // "Использовано запросов: X" — запросов за этот запуск
      const usedRequestsMatch = output.match(/Использовано запросов: (\d+)/);
      if (usedRequestsMatch) {
        await this.adapter.setStateAsync('sync.requestsUsed', parseInt(usedRequestsMatch[1]), true);
      }

      // "Осталось запросов сегодня: X"
      const remainingRequestsMatch = output.match(/Осталось запросов сегодня: (\d+)/);
      if (remainingRequestsMatch) {
        await this.adapter.setStateAsync('sync.requestsRemaining', parseInt(remainingRequestsMatch[1]), true);
      }

      // "Запросов сегодня: X/Y" — из строки прогресса при старте скрипта
      const todayMatch = output.match(/Запросов сегодня: (\d+)\/(\d+)/);
      if (todayMatch) {
        const used = parseInt(todayMatch[1]);
        const limit = parseInt(todayMatch[2]);
        await this.adapter.setStateAsync('sync.requestsUsed', used, true);
        await this.adapter.setStateAsync('sync.requestsRemaining', limit - used, true);
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
    try {
      if (this.adapter.config.preserveDatabase === false) {
        this.adapter.log.debug('Database preservation is disabled, skipping backup');
        return;
      }

      const dbPath = path.join(__dirname, '../www/data/movies-poiskkino.json');

      if (!fs.existsSync(dbPath)) {
        this.adapter.log.warn('Database file not found, cannot create backup');
        return;
      }

      // Создать директорию бэкапа если не существует
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }

      fs.copyFileSync(dbPath, this.backupPath);
      const stat = fs.statSync(this.backupPath);
      this.adapter.log.info(`Database backup saved to ${this.backupPath} (${Math.round(stat.size / 1024 / 1024)}MB)`);
    } catch (error) {
      this.adapter.log.error(`Error saving database backup: ${error.message}`);
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
