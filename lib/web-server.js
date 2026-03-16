'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

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
    const os = require('os');
    if (!bind || bind === '0.0.0.0' || bind === '::') return '0.0.0.0';
    // Уже IP адрес?
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bind) || bind.includes(':')) return bind;
    // Имя интерфейса — найти его IP
    const ifaces = os.networkInterfaces();
    const iface = ifaces[bind];
    if (iface) {
      const ipv4 = iface.find(a => a.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    this.adapter.log.warn(`Cannot resolve interface "${bind}" to IP, falling back to 0.0.0.0`);
    return '0.0.0.0';
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

        // Fallback для SPA (все маршруты возвращают index.html)
        this.app.get('*', (req, res) => {
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
    } catch (e) {
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
          } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON file' });
          }

          if (!parsed.movies || !Array.isArray(parsed.movies)) {
            return res.status(400).json({ error: 'Invalid database format: missing movies array' });
          }

          // Создать бэкап текущей базы перед заменой
          if (fs.existsSync(dbPath)) {
            const backupBeforeUpload = dbPath.replace('.json', '.before-upload.json');
            fs.copyFileSync(dbPath, backupBeforeUpload);
            this.adapter.log.info(`Created pre-upload backup at ${backupBeforeUpload}`);
          }

          // Записать новую базу
          fs.writeFileSync(dbPath, req.file.buffer);
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

    // GET /api/db/info — информация о базе данных
    app.get('/api/db/info', (req, res) => {
      try {
        if (!fs.existsSync(dbPath)) {
          return res.json({ exists: false });
        }
        const stat = fs.statSync(dbPath);
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        res.json({
          exists: true,
          movies: data.movies ? data.movies.length : 0,
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

  getUrl() {
    if (!this.port) return '';
    const hostname = this.adapter.host || 'localhost';
    return `http://${hostname}:${this.port}`;
  }

  isRunning() {
    return this.server !== null;
  }
}

module.exports = WebServer;
