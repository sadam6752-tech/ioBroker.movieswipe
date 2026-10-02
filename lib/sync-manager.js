'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite } = require('./fs-utils');

class SyncManager {
  constructor(adapter, dbStore) {
    this.adapter = adapter;
    this.process = null;
    this.isRunning = false;
    this.currentApiKeyIndex = 0;
    this.autoSyncTimer = null;
    this.stopRequested = false;
    // Отслеживание времени последнего поиска для каждого ключа (переживает перезапуск адаптера)
    this.cooldownFile = path.join(dbStore.dataDir, 'key-cooldowns.json');
    this.apiKeyTimestamps = this.loadTimestamps();
    this.dbStore = dbStore;
  }

  loadTimestamps() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cooldownFile, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  saveTimestamps() {
    try {
      fs.mkdirSync(this.dbStore.dataDir, { recursive: true });
      atomicWrite(this.cooldownFile, JSON.stringify(this.apiKeyTimestamps));
    } catch (error) {
      this.adapter.log.warn(`Could not persist API key cooldowns: ${error.message}`);
    }
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
    const crypto = require('node:crypto');
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
    this.saveTimestamps();
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
      let timeStr = String(config.syncScheduledTime).trim();
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(timeStr)) {
        this.adapter.log.error(`Invalid scheduled sync time "${config.syncScheduledTime}" (expected HH:MM), using 03:00`);
        timeStr = '03:00';
      }

      const scheduleNext = () => {
        let nextDelay = this.msUntilTime(timeStr);
        // setTimeout может сработать чуть раньше — не допускаем повторного запуска в ту же минуту
        if (nextDelay < 60 * 1000) nextDelay += 24 * 60 * 60 * 1000;
        this.adapter.log.info(`Next auto sync scheduled daily at ${timeStr} (in ${Math.round(nextDelay / 60000)} min)`);
        this.autoSyncTimer = this.adapter.setTimeout(() => {
          this.performAutoSync(config);
          scheduleNext();
        }, nextDelay);
      };

      scheduleNext();

    } else {
      // ── Режим интервала ───────────────────────────────────────────────────
      const syncIntervalHours = config.syncInterval || 24;
      const syncIntervalMs = syncIntervalHours * 60 * 60 * 1000;

      this.adapter.log.info(`Auto sync scheduled every ${syncIntervalHours} hours`);

      // Запустить первый поиск сразу
      this.performAutoSync(config);

      // Затем повторять через интервал
      this.autoSyncTimer = this.adapter.setInterval(() => {
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
      this.adapter.clearTimeout(this.autoSyncTimer);
      this.adapter.clearInterval(this.autoSyncTimer); // на всякий случай для режима интервала
      this.autoSyncTimer = null;
      this.adapter.log.info('Auto sync stopped');
    }
  }

  async start(config, apiKeyIndex = 0) {
    if (this.isRunning) {
      this.adapter.log.warn('Synchronization is already running');
      return;
    }
    this.stopRequested = false;

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
    const apiKey = this.getKeyString(keyConfig);

    // Параметры конкретного ключа. Задаются в таблице API-ключей; хардкод-дефолты
    // ниже совпадают с дефолтами колонок этой таблицы и нужны только для строк,
    // где поле оставили пустым.
    const keyYearStart = (typeof keyConfig === 'object' && keyConfig.yearStart) ? keyConfig.yearStart : 2020;
    const keyYearEnd   = (typeof keyConfig === 'object' && keyConfig.yearEnd)   ? keyConfig.yearEnd   : new Date().getFullYear();
    const keyMinVotes  = (typeof keyConfig === 'object' && keyConfig.minVotes  != null) ? keyConfig.minVotes  : 1000;
    const keyMinRating = (typeof keyConfig === 'object' && keyConfig.minRating != null) ? keyConfig.minRating : 5;

    // Подготовить аргументы
    // API-ключ передаётся через переменную окружения, а не аргумент командной строки
    // (аргументы видны в списке процессов)
    const args = [scriptPath];

    // Параметры запросов. Дефолты совпадают с дефолтами полей в jsonConfig,
    // ?? вместо || — чтобы явно заданное значение не подменялось.
    const maxRequestsPerRun = config.maxRequestsPerRun ?? 250;
    const dailyRequestLimit = config.dailyRequestLimit ?? 200;

    args.push('--max-requests', maxRequestsPerRun.toString());
    args.push('--daily-limit', dailyRequestLimit.toString());
    
    // Добавить фильтры контента (из настроек конкретного ключа)
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
      env: { ...process.env, MOVIESWIPE_API_KEY: apiKey, MOVIESWIPE_DATA_DIR: this.dbStore.dataDir }
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
        await this.dbStore.pushToStorage();
        // Сигнал приложению перезагрузить кеш
        await this.adapter.setStateAsync('sync.reloadApp', true, true);

        // Проверить есть ли ещё доступные ключи для продолжения
        const remainingKeys = config.apiKeys.slice(this.currentApiKeyIndex + 1);
        const nextKey = this.findAvailableApiKey(remainingKeys, 0); // кулдаун 0 — берём следующий без ожидания

        if (this.stopRequested) {
          await this.adapter.setStateAsync('sync.status', 'idle', true);
          await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
        } else if (nextKey && remainingKeys.length > 0) {
          const nextIndex = this.currentApiKeyIndex + 1 + nextKey.index;
          this.adapter.log.info(`Daily limit reached for key ${this.currentApiKeyIndex + 1}. Switching to key ${nextIndex + 1}/${config.apiKeys.length}`);
          await this.adapter.setStateAsync('sync.status', 'running', true);
          await this.adapter.setStateAsync('sync.currentStep', `Switching to API key ${nextIndex + 1}...`, true);
          // Небольшая пауза перед запуском следующего ключа
          await delay(2000);
          if (this.stopRequested) {
            await this.adapter.setStateAsync('sync.status', 'idle', true);
            await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
            return;
          }
          try {
            await this.start(config, nextIndex);
          } catch (error) {
            this.adapter.log.error(`Could not switch to API key ${nextIndex + 1}: ${error.message}`);
            await this.adapter.setStateAsync('sync.status', 'error', true);
            await this.adapter.setStateAsync('sync.error', error.message, true);
          }
        } else {
          await this.adapter.setStateAsync('sync.status', 'completed', true);
          await this.adapter.setStateAsync('sync.progress', 100, true);
          await this.adapter.setStateAsync('sync.lastSync', new Date().toISOString(), true);
          await this.adapter.setStateAsync('sync.currentStep', 'Completed', true);
        }
      } else if (code === null || code === 143 || code === 15 || this.stopRequested) {
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
    this.stopRequested = true;

    if (!this.isRunning || !this.process) {
      this.adapter.log.debug('No synchronization is running');
      return;
    }

    this.adapter.log.info('Stopping synchronization...');

    const proc = this.process;
    const exited = new Promise(resolve => proc.once('exit', resolve));

    proc.kill('SIGTERM');

    // Ждём реального завершения; если процесс не ответил — убиваем принудительно.
    // (proc.killed становится true сразу после отправки сигнала, поэтому его проверять нельзя)
    const result = await Promise.race([exited.then(() => 'exited'), delay(5000, 'timeout')]);
    if (result === 'timeout' && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exited;
    }
    // Статусы выставляет обработчик 'close'
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
}

module.exports = SyncManager;
