#!/usr/bin/env node

/**
 * ПоискКино Incremental Sync Script - MINIMAL VERSION
 * 
 * Загружает фильмы из ПоискКино API с умными фильтрами и встроенной оптимизацией:
 * - Популярные фильмы (с высоким количеством голосов)
 * - Рейтинг > 6.0
 * - С постерами
 * - Последние 5 лет (расширяется по мере заполнения)
 * 
 * ОПТИМИЗАЦИЯ (встроена в скрипт):
 * - Не добавляет ненужные поля (isFavorite, watchStatus, timestamps, language, source)
 * - Результирующая база на 11% меньше
 * - Все критичные данные сохранены
 * - БЕЗ API запросов в приложении
 * 
 * Лимит: 200 запросов/день на бесплатном тарифе
 * Прогресс сохраняется в .sync-progress.json
 */

const fs = require('fs');
const path = require('path');

// Конфигурация
const CONFIG = {
  API_BASE_URL: 'https://api.poiskkino.dev',
  EU_API_BASE_URL: 'https://eu-api.poiskkino.dev',
  API_VERSION: 'v1.5',
  PROGRESS_FILE: path.join(__dirname, '.sync-progress.json'),
  OUTPUT_DIR: path.join(__dirname, '../www/data'),
  MOVIES_PER_REQUEST: 250, // Максимум для API
  MAX_REQUESTS_PER_DAY: 200,
  MIN_RATING: 5.0,
  MIN_VOTES: 1000, // Минимум голосов для популярности
  INITIAL_YEARS: 5, // Начинаем с последних 5 лет
};

// Маппинг жанров ПоискКино -> наши жанры
const GENRE_MAP = {
  'боевик': 'action',
  'приключения': 'adventure',
  'биография': 'biography',
  'комедия': 'comedy',
  'концерт': 'concert',
  'криминал': 'crime',
  'детектив': 'detective',
  'детский': 'kids',
  'документальный': 'documentary',
  'драма': 'drama',
  'эротика': 'erotic',
  'семейный': 'family',
  'фэнтези': 'fantasy',
  'история': 'historical',
  'ужасы': 'horror',
  'кинокомикс': 'comic',
  'мелодрама': 'melodrama',
  'музыка': 'music',
  'мюзикл': 'musical',
  'мистика': 'mystery',
  'нуар': 'noir',
  'реалити-шоу': 'reality',
  'романтика': 'romance',
  'фантастика': 'sci-fi',
  'короткометражка': 'short',
  'спорт': 'sport',
  'ток-шоу': 'talk-show',
  'триллер': 'thriller',
  'военный': 'war',
  'вестерн': 'western'
};

// Маппинг типов ПоискКино -> наши типы контента
const TYPE_MAP = {
  'movie': 'movie',
  'tv-series': 'tv-series',
  'cartoon': 'cartoon',
  'anime': 'anime',
  'animated-series': 'animated-series'
  // 'tv-show' удален - не используется в PWA
};

// Маппинг жанров -> настроения
const GENRE_TO_MOOD_MAP = {
  'action': ['adrenaline', 'energize'],
  'adventure': ['adrenaline', 'fantasy'],
  'animation': ['light-positive', 'cozy'],
  'anime': ['fantasy', 'energize'],
  'biography': ['philosophical', 'emotional'],
  'comedy': ['comedy', 'light-positive'],
  'concert': ['energize', 'light-positive'],
  'crime': ['adrenaline', 'philosophical'],
  'detective': ['adrenaline', 'philosophical'],
  'documentary': ['philosophical'],
  'drama': ['emotional', 'philosophical'],
  'erotic': ['romance'],
  'family': ['cozy', 'light-positive'],
  'fantasy': ['fantasy', 'cozy'],
  'historical': ['philosophical', 'nostalgia'],
  'horror': ['horror', 'adrenaline'],
  'kids': ['light-positive', 'cozy'],
  'comic': ['adrenaline', 'fantasy'],
  'melodrama': ['emotional', 'romance'],
  'music': ['energize', 'light-positive'],
  'musical': ['energize', 'light-positive'],
  'mystery': ['horror', 'philosophical'],
  'noir': ['philosophical', 'nostalgia'],
  'reality': ['light-positive'],
  'romance': ['romance', 'emotional'],
  'sci-fi': ['fantasy', 'philosophical'],
  'short': ['light-positive'],
  'sport': ['energize', 'adrenaline'],
  'talk-show': ['light-positive'],
  'thriller': ['adrenaline', 'horror'],
  'war': ['emotional', 'philosophical'],
  'western': ['adrenaline', 'nostalgia']
};

/**
 * Создать хеш API ключа (для отслеживания смены ключа)
 */
function hashApiKey(apiKey) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(apiKey).digest('hex').substring(0, 8);
}

/**
 * Загрузить прогресс синхронизации
 */
function loadProgress(apiKey) {
  try {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      const data = fs.readFileSync(CONFIG.PROGRESS_FILE, 'utf8');
      const progress = JSON.parse(data);
      
      // Проверяем, изменился ли API ключ
      const currentKeyHash = hashApiKey(apiKey);
      if (progress.apiKeyHash && progress.apiKeyHash !== currentKeyHash) {
        console.log('🔑 Обнаружен новый API ключ!');
        console.log('   Сбрасываем счетчик запросов для нового ключа...');
        
        // Сбрасываем только счетчик запросов, но сохраняем прогресс загрузки
        progress.requestsToday = 0;
        progress.lastRequestDate = null;
        progress.apiKeyHash = currentKeyHash;
        
        console.log('✅ Можно продолжать загрузку с нового ключа!\n');
      } else {
        progress.apiKeyHash = currentKeyHash;
      }
      
      return progress;
    }
  } catch (error) {
    console.error('Ошибка загрузки прогресса:', error.message);
  }

  // Дефолтный прогресс
  const currentYear = new Date().getFullYear();
  return {
    lastCursor: null,
    totalMovies: 0,
    requestsToday: 0,
    lastRequestDate: null,
    apiKeyHash: hashApiKey(apiKey),
    yearRange: {
      start: currentYear - CONFIG.INITIAL_YEARS,
      end: currentYear
    },
    completed: false
  };
}

/**
 * Сохранить прогресс синхронизации
 */
function saveProgress(progress) {
  try {
    fs.writeFileSync(
      CONFIG.PROGRESS_FILE,
      JSON.stringify(progress, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Ошибка сохранения прогресса:', error.message);
  }
}

/**
 * Проверить лимит запросов
 */
function checkRateLimit(progress) {
  const today = new Date().toISOString().split('T')[0];
  
  if (progress.lastRequestDate !== today) {
    // Новый день - сбрасываем счетчик
    progress.requestsToday = 0;
    progress.lastRequestDate = today;
  }

  return progress.requestsToday < CONFIG.MAX_REQUESTS_PER_DAY;
}

/**
 * Маппинг жанров из ПоискКино в наши
 */
function mapGenres(kpGenres) {
  if (!kpGenres || !Array.isArray(kpGenres)) return [];
  
  const genres = new Set();
  kpGenres.forEach(g => {
    const genreName = g.name?.toLowerCase();
    if (genreName && GENRE_MAP[genreName]) {
      genres.add(GENRE_MAP[genreName]);
    }
  });
  
  return Array.from(genres);
}

/**
 * Маппинг жанров в настроения
 */
function mapGenresToMoods(genres) {
  const moods = new Set();
  genres.forEach(genre => {
    const genreMoods = GENRE_TO_MOOD_MAP[genre];
    if (genreMoods) {
      genreMoods.forEach(m => moods.add(m));
    }
  });
  return Array.from(moods);
}

/**
 * Нормализация стран
 */
const COUNTRY_MAPPING = {
  'США': 'США',
  'US': 'США',
  'USA': 'США',
  'United States': 'США',
  'Россия': 'Россия',
  'Russia': 'Россия',
  'СССР': 'Россия',
  'Soviet Union': 'Россия',
  'Франция': 'Франция',
  'France': 'Франция',
  'Великобритания': 'Великобритания',
  'UK': 'Великобритания',
  'United Kingdom': 'Великобритания',
  'Германия': 'Германия',
  'Germany': 'Германия',
  'Италия': 'Италия',
  'Italy': 'Италия',
  'Испания': 'Испания',
  'Spain': 'Испания',
  'Япония': 'Япония',
  'Japan': 'Япония',
  'Южная Корея': 'Южная Корея',
  'South Korea': 'Южная Корея',
  'Корея': 'Южная Корея',
  'Korea': 'Южная Корея',
  'Республика Корея': 'Южная Корея',
  'Индия': 'Индия',
  'India': 'Индия'
};

function normalizeCountries(kpCountries) {
  if (!kpCountries || !Array.isArray(kpCountries)) {
    return ['Другие'];
  }
  
  const normalized = kpCountries
    .map(c => c.name)
    .filter(Boolean)
    .map(name => COUNTRY_MAPPING[name] || 'Другие')
    .filter((c, index, self) => self.indexOf(c) === index); // убираем дубликаты
  
  return normalized.length > 0 ? normalized : ['Другие'];
}

/**
 * Конвертировать фильм из ПоискКино в наш формат
 */
function convertMovie(kpMovie) {
  const genres = mapGenres(kpMovie.genres);
  const moods = mapGenresToMoods(genres);

  // Извлекаем режиссера и актеров
  const director = kpMovie.persons
    ?.find(p => p.enProfession === 'director')
    ?.name || 'Неизвестно';
  
  const cast = kpMovie.persons
    ?.filter(p => p.enProfession === 'actor')
    .slice(0, 5)
    .map(p => p.name) || [];

  // Нормализуем страны
  const countries = normalizeCountries(kpMovie.countries);

  // Определяем тип контента
  let contentType = 'movie'; // по умолчанию
  if (kpMovie.type && TYPE_MAP[kpMovie.type]) {
    contentType = TYPE_MAP[kpMovie.type];
  } else if (genres.includes('anime')) {
    contentType = 'anime';
  } else if (kpMovie.isSeries) {
    contentType = 'tv-series';
  }

  return {
    id: `kp-${kpMovie.id}`,
    title: kpMovie.name || kpMovie.alternativeName || 'Без названия',
    originalTitle: kpMovie.enName || kpMovie.alternativeName || '',
    year: kpMovie.year || 0,
    description: kpMovie.description || kpMovie.shortDescription || 'Описание отсутствует',
    genres,
    moods,
    countries,
    contentType,
    rating: kpMovie.rating?.kp || kpMovie.rating?.imdb || 0,
    duration: kpMovie.movieLength || 120,
    director,
    cast,
    poster: kpMovie.poster?.url || '',
    backdrop: kpMovie.backdrop?.url || kpMovie.poster?.url || ''
    // Оптимизированная версия - не добавляем ненужные поля:
    // - language: всегда 'ru' (можно захардкодить в коде)
    // - isFavorite: хранится в localStorage
    // - watchStatus: хранится в user profile
    // - source: всегда 'kinopoisk' (можно захардкодить в коде)
    // - createdAt: не нужна для статических данных
    // - updatedAt: не нужна для статических данных
  };
}

/**
 * Загрузить фильмы из ПоискКино API с retry при сетевых ошибках
 */
async function fetchMovies(apiKey, progress) {
  const url = new URL(`${CONFIG.API_BASE_URL}/${CONFIG.API_VERSION}/movie`);
  
  // Параметры запроса
  const params = {
    // Фильтры
    'rating.kp': `${CONFIG.MIN_RATING}-10`,
    'votes.kp': `${CONFIG.MIN_VOTES}-10000000`,
    'year': `${progress.yearRange.start}-${progress.yearRange.end}`,
    // Убрали фильтр 'type': 'movie' чтобы загружать все типы контента
    'notNullFields': ['poster.url', 'name'],
    
    // Поля для ответа
    'selectFields': [
      'id', 'name', 'enName', 'alternativeName', 'description', 'shortDescription',
      'year', 'rating', 'movieLength', 'genres', 'countries', 'poster', 'backdrop', 'persons',
      'type', 'isSeries'
    ],
    
    // Пагинация
    'limit': CONFIG.MOVIES_PER_REQUEST,
    'sortField': 'votes.kp',
    'sortType': '-1' // Сортировка по популярности (убывание)
  };

  // Добавляем курсор если есть
  if (progress.lastCursor) {
    params.next = progress.lastCursor;
  }

  // Формируем query string
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, v));
    } else {
      url.searchParams.append(key, value);
    }
  });

  console.log(`\nЗапрос: ${url.pathname}${url.search.substring(0, 100)}...`);

  // Retry при сетевых ошибках
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 30000]; // 5с, 15с, 30с

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30с timeout

      let response;
      try {
        response = await fetch(url.toString(), {
          headers: {
            'X-API-KEY': apiKey,
            'Accept': 'application/json'
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return {
        movies: data.docs || [],
        nextCursor: data.next || null,
        hasNext: data.hasNext || false,
        total: data.total || 0
      };

    } catch (error) {
      const isNetworkError = error.name === 'AbortError' ||
        error.message.includes('fetch failed') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network') ||
        error.message.includes('socket');

      const isRateLimit = error.message.includes('403') ||
        error.message.includes('429') ||
        error.message.includes('Forbidden');

      // Rate limit — не ретраим, пробрасываем сразу
      if (isRateLimit) throw error;

      if (isNetworkError && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`⚠️  Сетевая ошибка (попытка ${attempt + 1}/${MAX_RETRIES}): ${error.message}`);
        console.log(`   Повтор через ${delay / 1000}с...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Исчерпали попытки или не сетевая ошибка
      throw error;
    }
  }
}

/**
 * Сохранить фильмы в JSON файл
 */
function saveMovies(movies, progress) {
  const outputFile = path.join(CONFIG.OUTPUT_DIR, 'movies-poiskkino.json');
  
  let existingMovies = [];
  if (fs.existsSync(outputFile)) {
    try {
      const data = fs.readFileSync(outputFile, 'utf8');
      const json = JSON.parse(data);
      existingMovies = json.movies || [];
    } catch (error) {
      console.warn('Не удалось загрузить существующие фильмы:', error.message);
    }
  }

  // Добавляем новые фильмы (избегаем дубликатов)
  const existingIds = new Set(existingMovies.map(m => m.id));
  const newMovies = movies.filter(m => !existingIds.has(m.id));
  
  const allMovies = [...existingMovies, ...newMovies];

  // Создаем директорию если не существует
  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  }

  // Сохраняем
  fs.writeFileSync(
    outputFile,
    JSON.stringify({ movies: allMovies }, null, 2),
    'utf8'
  );

  console.log(`✓ Сохранено ${newMovies.length} новых фильмов (всего: ${allMovies.length})`);

  // Сразу создаём резервную копию чтобы не потерять прогресс при перезапуске адаптера
  try {
    const backupFile = path.join(CONFIG.OUTPUT_DIR, 'movies-poiskkino.backup.json');
    fs.copyFileSync(outputFile, backupFile);
  } catch (e) {
    // Не критично если бэкап не создался
  }
  
  return newMovies.length;
}

/**
 * Главная функция синхронизации
 */
async function sync(apiKey, maxRequests = null, yearOverride = {}, useEuServer = false) {
  console.log('🎬 ПоискКино Incremental Sync');
  console.log('================================\n');

  // Выбираем URL сервера
  if (useEuServer) {
    CONFIG.API_BASE_URL = CONFIG.EU_API_BASE_URL;
    console.log('🌍 Используется EU-зеркало: ' + CONFIG.API_BASE_URL);
  }

  // Загружаем прогресс с учетом API ключа
  const progress = loadProgress(apiKey);

  // Применяем переопределение диапазона лет если указано
  if (yearOverride.start !== undefined) progress.yearRange.start = yearOverride.start;
  if (yearOverride.end !== undefined) progress.yearRange.end = yearOverride.end;
  
  console.log(`Прогресс:`);
  console.log(`  Всего загружено: ${progress.totalMovies} фильмов`);
  console.log(`  Запросов сегодня: ${progress.requestsToday}/${CONFIG.MAX_REQUESTS_PER_DAY}`);
  console.log(`  Период: ${progress.yearRange.start}-${progress.yearRange.end}`);
  console.log(`  Статус: ${progress.completed ? 'Завершено' : 'В процессе'}\n`);

  if (progress.completed) {
    console.log('✓ Синхронизация уже завершена!');
    console.log('Для повторной синхронизации удалите файл .sync-progress.json\n');
    return;
  }

  // Проверяем лимит
  if (!checkRateLimit(progress)) {
    console.log('⚠️  Достигнут дневной лимит запросов (200) для текущего API ключа');
    console.log('💡 Вы можете продолжить с другим API ключом:');
    console.log('   node poiskkino-sync.cjs YOUR_OTHER_API_KEY\n');
    return;
  }

  const requestsLimit = maxRequests || (CONFIG.MAX_REQUESTS_PER_DAY - progress.requestsToday);
  console.log(`Будет выполнено до ${requestsLimit} запросов\n`);

  let requestCount = 0;
  let totalNewMovies = 0;

  try {
    while (requestCount < requestsLimit) {
      // Загружаем порцию фильмов
      const result = await fetchMovies(apiKey, progress);
      requestCount++;
      progress.requestsToday++;

      console.log(`Получено ${result.movies.length} фильмов`);

      // Конвертируем и сохраняем
      const convertedMovies = result.movies.map(convertMovie);
      const newCount = saveMovies(convertedMovies, progress);
      
      totalNewMovies += newCount;
      progress.totalMovies += newCount;

      // Обновляем курсор
      progress.lastCursor = result.nextCursor;

      // Сохраняем прогресс
      saveProgress(progress);

      // Проверяем есть ли еще данные
      if (!result.hasNext || !result.nextCursor) {
        console.log('\n✓ Все фильмы для текущего периода загружены!');
        
        // Расширяем период на 5 лет назад
        if (progress.yearRange.start > 1900) {
          progress.yearRange.start -= 5;
          progress.lastCursor = null;
          console.log(`Расширяем период: ${progress.yearRange.start}-${progress.yearRange.end}`);
          saveProgress(progress);
        } else {
          progress.completed = true;
          saveProgress(progress);
          console.log('✓ Синхронизация полностью завершена!');
          break;
        }
      }

      // Небольшая задержка между запросами
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const endTime = new Date();
    const endTimeStr = endTime.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    console.log('\n================================');
    console.log(`✓ Синхронизация завершена`);
    console.log(`  Дата и время: ${endTimeStr}`);
    console.log(`  Новых фильмов: ${totalNewMovies}`);
    console.log(`  Всего фильмов: ${progress.totalMovies}`);
    console.log(`  Использовано запросов: ${requestCount}`);
    console.log(`  Осталось запросов сегодня: ${CONFIG.MAX_REQUESTS_PER_DAY - progress.requestsToday}`);
    console.log('================================\n');

  } catch (error) {
    const errorMessage = error.message || '';
    
    // Проверяем является ли это ошибкой лимита
    const isRateLimit = errorMessage.includes('403') || 
                       errorMessage.includes('суточный лимит') ||
                       errorMessage.includes('лимит по запросам') ||
                       errorMessage.includes('Forbidden');

    // Проверяем является ли это сетевой ошибкой
    const isNetworkError = error.name === 'AbortError' ||
                       errorMessage.includes('fetch failed') ||
                       errorMessage.includes('ECONNRESET') ||
                       errorMessage.includes('ETIMEDOUT') ||
                       errorMessage.includes('ENOTFOUND') ||
                       errorMessage.includes('network') ||
                       errorMessage.includes('socket');
    
    if (isRateLimit) {
      console.log('\n⚠️  Достигнут дневной лимит API');
      console.log('Прогресс сохранен. Синхронизация продолжится автоматически завтра или с другим API ключом.\n');
      saveProgress(progress);
      process.exit(0); // Выход с кодом 0 (успех)
    } else if (isNetworkError) {
      console.error('\n⚠️  Сетевая ошибка после всех попыток:', error.message);
      console.error('Прогресс сохранен. Синхронизация продолжится при следующем запуске.\n');
      saveProgress(progress);
      process.exit(0); // Код 0 — не ошибка адаптера, просто временный сбой сети
    } else {
      console.error('\n❌ Ошибка синхронизации:', error.message);
      console.error('Прогресс сохранен. Запустите скрипт снова для продолжения.\n');
      saveProgress(progress);
      process.exit(1);
    }
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Использование: node poiskkino-sync.cjs [опции]

Опции:
  --api-key <key>       API ключ ПоискКино (обязательно)
  --max-requests <n>    Максимум запросов за один запуск (по умолчанию: до лимита)
  --daily-limit <n>     Дневной лимит запросов (по умолчанию: 200)
  --min-rating <n>      Минимальный рейтинг (по умолчанию: 5.0)
  --min-votes <n>       Минимальное количество голосов (по умолчанию: 1000)
  --year-start <n>      Начальный год диапазона
  --year-end <n>        Конечный год диапазона
  --reset               Сбросить прогресс и начать заново
  --status              Показать текущий статус
  -h, --help            Показать эту справку

Примеры:
  node poiskkino-sync.cjs --api-key YOUR_KEY
  node poiskkino-sync.cjs --api-key YOUR_KEY --max-requests 10
  node poiskkino-sync.cjs --status
  node poiskkino-sync.cjs --reset
`);
    process.exit(0);
  }

  if (args.includes('--status')) {
    const progress = loadProgress('');
    console.log('\n📊 Статус синхронизации:');
    console.log(`  Всего загружено: ${progress.totalMovies} фильмов`);
    console.log(`  Запросов сегодня: ${progress.requestsToday}/${CONFIG.MAX_REQUESTS_PER_DAY}`);
    console.log(`  Последний запрос: ${progress.lastRequestDate || 'никогда'}`);
    console.log(`  Период: ${progress.yearRange.start}-${progress.yearRange.end}`);
    console.log(`  Статус: ${progress.completed ? 'Завершено ✓' : 'В процессе...'}\n`);
    process.exit(0);
  }

  if (args.includes('--reset')) {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      fs.unlinkSync(CONFIG.PROGRESS_FILE);
      console.log('✓ Прогресс сброшен\n');
    } else {
      console.log('⚠️  Файл прогресса не найден\n');
    }
    process.exit(0);
  }

  const apiKeyIndex = args.indexOf('--api-key');
  if (apiKeyIndex === -1 || !args[apiKeyIndex + 1]) {
    console.error('❌ Ошибка: требуется API ключ');
    console.error('Используйте: node poiskkino-sync.cjs --api-key YOUR_KEY\n');
    process.exit(1);
  }

  const apiKey = args[apiKeyIndex + 1];

  // Применяем параметры из аргументов командной строки в CONFIG
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };

  if (getArg('--daily-limit'))  CONFIG.MAX_REQUESTS_PER_DAY = parseInt(getArg('--daily-limit'));
  if (getArg('--min-rating'))   CONFIG.MIN_RATING = parseFloat(getArg('--min-rating'));
  if (getArg('--min-votes'))    CONFIG.MIN_VOTES = parseInt(getArg('--min-votes'));

  const maxRequests = getArg('--max-requests') ? parseInt(getArg('--max-requests')) : null;

  const yearOverride = {};
  if (getArg('--year-start')) yearOverride.start = parseInt(getArg('--year-start'));
  if (getArg('--year-end'))   yearOverride.end   = parseInt(getArg('--year-end'));

  const useEuServer = args.includes('--eu-server');

  sync(apiKey, maxRequests, yearOverride, useEuServer).catch(error => {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
  });
}

module.exports = { sync, loadProgress, saveProgress };
