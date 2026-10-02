'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWrite, atomicCopy } = require('./fs-utils');
const { findLanAddress } = require('./net-utils');

class WebServer {
  constructor(adapter) {
    this.adapter = adapter;
    this.app = null;
    this.server = null;
    this.port = null;
  }

  /**
   * Резолвить имя сетевого интерфейса в IP адрес.
   * Тип `interface` в jsonConfig сохраняет имя интерфейса (ovs_eth0), а не IP.
   */
  _resolveBindAddress(bind) {
    const os = require('node:os');
    // Пусто — безопасный дефолт: только LAN-интерфейс (или loopback, если LAN нет).
    // Слушать на всех интерфейсах — только если это явно выбрано (0.0.0.0).
    if (!bind) {
      const lan = findLanAddress();
      if (!lan) this.adapter.log.warn('No LAN address found, web server will only listen on 127.0.0.1');
      return lan || '127.0.0.1';
    }
    if (bind === '0.0.0.0' || bind === '::') return '0.0.0.0';
    // Уже IP адрес?
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bind) || bind.includes(':')) return bind;
    // Имя интерфейса — найти его IP
    const ifaces = os.networkInterfaces();
    const iface = ifaces[bind];
    if (iface) {
      const ipv4 = iface.find(a => a.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    const lan = findLanAddress() || '127.0.0.1';
    this.adapter.log.warn(`Cannot resolve interface "${bind}" to IP, falling back to ${lan}`);
    return lan;
  }

  async start(port, wwwPath, bind) {
    return new Promise((resolve, reject) => {
      try {
        this.port = port;
        this.bind = this._resolveBindAddress(bind);
        this.app = express();

        // Логирование запросов
        this.app.use((req, res, next) => {
          this.adapter.log.debug(`${req.method} ${req.url}`);
          next();
        });

        // API для управления базой данных
        this._setupDatabaseApi(this.app);

        // Раздача статических файлов
        this.app.use(express.static(wwwPath));

        // Fallback для SPA (все маршруты возвращают index.html).
        // Express 5 использует path-to-regexp v8: голый '*' невалиден,
        // нужен именованный wildcard. Фигурные скобки делают его опциональным,
        // чтобы совпадал и корень '/'.
        this.app.get('/{*splat}', (req, res) => {
          const indexPath = path.join(wwwPath, 'index.html');
          res.sendFile(indexPath, (err) => {
            if (err) {
              this.adapter.log.debug(`Could not send index.html: ${err.message}`);
              res.status(404).send('Not Found');
            }
          });
        });

        // Обработка ошибок
        this.app.use((err, req, res, _next) => {
          this.adapter.log.error(`Server error: ${err.message}`);
          res.status(500).send('Internal Server Error');
        });

        // Запуск сервера
        this.server = this.app.listen(port, this.bind, () => {
          this.adapter.log.info(`Web server listening on ${this.bind}:${port}`);
          resolve();
        });

        this.server.on('error', (error) => {
          if (error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${port} is already in use`));
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  _setupDatabaseApi(app) {
    const dbPath = path.join(__dirname, '../www/data/movies-poiskkino.json');

    // Защита /api/db/*: если задан токен, он должен прийти в заголовке X-Db-Token
    const token = typeof this.adapter.config.dbToken === 'string' ? this.adapter.config.dbToken.trim() : '';
    if (!token) {
      this.adapter.log.warn('No database API token configured: /api/db/* (download/upload) is open to everyone who can reach the web server. Set "Backup access token" in the adapter settings.');
    }
    const expected = crypto.createHash('sha256').update(token).digest();
    app.use('/api/db', (req, res, next) => {
      if (!token) return next();
      const given = crypto.createHash('sha256').update(String(req.get('x-db-token') || '')).digest();
      if (crypto.timingSafeEqual(given, expected)) return next();
      res.status(401).json({ error: 'Invalid or missing token' });
    });

    // GET /api/db/download — скачать текущую базу данных
    app.get('/api/db/download', (req, res) => {
      try {
        if (!fs.existsSync(dbPath)) {
          return res.status(404).json({ error: 'Database file not found' });
        }
        this.adapter.log.info('Database download requested');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="movies-poiskkino-backup-${new Date().toISOString().slice(0, 10)}.json"`);
        res.sendFile(dbPath);
      } catch (error) {
        this.adapter.log.error(`Error downloading database: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/db/upload — загрузить базу данных из файла
    let multerUpload = null;
    try {
      const multer = require('multer');
      multerUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 200 * 1024 * 1024 } // 200 MB max
      });
    } catch {
      this.adapter.log.warn('multer not installed, upload endpoint disabled. Run: npm install multer');
    }

    if (multerUpload) {
      app.post('/api/db/upload', multerUpload.single('database'), async (req, res) => {
        try {
          if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
          }

          // Валидация JSON
          let parsed;
          try {
            parsed = JSON.parse(req.file.buffer.toString('utf8'));
          } catch {
            return res.status(400).json({ error: 'Invalid JSON file' });
          }

          if (!parsed || !Array.isArray(parsed.movies)) {
            return res.status(400).json({ error: 'Invalid database format: missing movies array' });
          }
          if (parsed.movies.some(m => !m || typeof m !== 'object' || m.id == null)) {
            return res.status(400).json({ error: 'Invalid database format: every movie needs an id' });
          }

          // Создать бэкап текущей базы перед заменой
          if (fs.existsSync(dbPath)) {
            const backupBeforeUpload = dbPath.replace('.json', '.before-upload.json');
            atomicCopy(dbPath, backupBeforeUpload);
            this.adapter.log.info(`Created pre-upload backup at ${backupBeforeUpload}`);
          }

          // Записать новую базу
          atomicWrite(dbPath, req.file.buffer);

          // Бэкап обновляем сразу, иначе при следующем старте адаптера
          // более крупная старая копия перезапишет загруженную базу
          if (this.adapter.config.preserveDatabase !== false) {
            const { backupDir, backupPath } = this.adapter.getBackupPath();
            fs.mkdirSync(backupDir, { recursive: true });
            atomicCopy(dbPath, backupPath);
          }
          this.adapter.log.info(`Database uploaded: ${parsed.movies.length} movies (${Math.round(req.file.size / 1024 / 1024)}MB)`);

          // Обновить счётчик фильмов
          await this.adapter.setStateAsync('sync.totalMovies', parsed.movies.length, true);

          res.json({ success: true, movies: parsed.movies.length });
        } catch (error) {
          this.adapter.log.error(`Error uploading database: ${error.message}`);
          res.status(500).json({ error: error.message });
        }
      });
    }

    // GET /api/db/info — информация о базе данных (счётчик кешируется по mtime)
    let infoCache = null;
    app.get('/api/db/info', async (req, res) => {
      try {
        if (!fs.existsSync(dbPath)) {
          return res.json({ exists: false });
        }
        const stat = fs.statSync(dbPath);
        if (!infoCache || infoCache.mtimeMs !== stat.mtimeMs || infoCache.size !== stat.size) {
          const data = JSON.parse(await fs.promises.readFile(dbPath, 'utf8'));
          infoCache = { mtimeMs: stat.mtimeMs, size: stat.size, movies: Array.isArray(data.movies) ? data.movies.length : 0 };
        }
        res.json({
          exists: true,
          movies: infoCache.movies,
          size: stat.size,
          sizeMB: Math.round(stat.size / 1024 / 1024 * 10) / 10,
          modified: stat.mtime
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.adapter.log.info('Web server stopped');
          this.server = null;
          this.app = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = WebServer;
