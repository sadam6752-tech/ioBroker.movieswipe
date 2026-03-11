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
  }

  async start(config) {
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
    const apiKey = config.apiKeys[this.currentApiKeyIndex];

    // Подготовить аргументы
    const args = [
      scriptPath,
      '--api-key', apiKey
    ];

    // Добавить опциональные параметры
    if (config.maxRequests) {
      args.push('--max-requests', config.maxRequests.toString());
    }
    if (config.minRating !== undefined) {
      args.push('--min-rating', config.minRating.toString());
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

    this.adapter.log.info(`Starting sync with API key ${this.currentApiKeyIndex + 1}/${config.apiKeys.length}`);

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
        // Сигнал приложению перезагрузить кеш
        await this.adapter.setStateAsync('sync.reloadApp', true, true);
      } else if (code === null || code === 143 || code === 15) {
        // Процесс был остановлен пользователем (SIGTERM = 143, SIGKILL = 9)
        this.adapter.log.info('Synchronization stopped by user');
        await this.adapter.setStateAsync('sync.status', 'idle', true);
        await this.adapter.setStateAsync('sync.currentStep', 'Stopped by user', true);
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
        const foundCount = parseInt(moviesMatch[1]);
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

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentApiKeyIndex: this.currentApiKeyIndex
    };
  }
}

module.exports = SyncManager;
