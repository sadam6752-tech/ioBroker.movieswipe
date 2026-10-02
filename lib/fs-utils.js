'use strict';

const fs = require('node:fs');

/**
 * Атомарная запись: сначала во временный файл, затем rename.
 * Прерванная запись не оставляет повреждённый целевой файл.
 */
function atomicWrite(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // временного файла нет — игнорируем
    }
    throw error;
  }
}

/**
 * Атомарное копирование файла
 */
function atomicCopy(src, target) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // временного файла нет — игнорируем
    }
    throw error;
  }
}

/**
 * Прочитать базу фильмов. Возвращает распарсенный объект или null,
 * если файла нет, он не парсится или в нём нет массива movies.
 */
function readMoviesFile(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && Array.isArray(json.movies) ? json : null;
  } catch {
    return null;
  }
}

module.exports = { atomicWrite, atomicCopy, readMoviesFile };
