'use strict';

const express = require('express');
const path = require('path');

class WebServer {
  constructor(adapter) {
    this.adapter = adapter;
    this.app = null;
    this.server = null;
    this.port = null;
  }

  async start(port, wwwPath) {
    return new Promise((resolve, reject) => {
      try {
        this.port = port;
        this.app = express();

        // Логирование запросов
        this.app.use((req, res, next) => {
          this.adapter.log.debug(`${req.method} ${req.url}`);
          next();
        });

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
        this.server = this.app.listen(port, () => {
          this.adapter.log.info(`Web server listening on port ${port}`);
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
    
    // Получить IP адрес хоста
    const hostname = this.adapter.host || 'localhost';
    return `http://${hostname}:${this.port}`;
  }

  isRunning() {
    return this.server !== null;
  }
}

module.exports = WebServer;
