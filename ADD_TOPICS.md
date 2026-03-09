# Инструкция по добавлению Topics на GitHub

## Зачем нужны topics?

Topics помогают пользователям находить ваш репозиторий через поиск GitHub и улучшают видимость проекта.

## Как добавить topics

### Способ 1: Через веб-интерфейс GitHub

1. Открой https://github.com/sadam6752-tech/ioBroker.movieswipe
2. Справа от названия репозитория найди раздел "About" (⚙️ Settings)
3. Нажми на иконку шестеренки ⚙️ рядом с "About"
4. В поле "Topics" добавь следующие темы (через запятую или пробел):

```
iobroker
adapter
movies
pwa
kinopoisk
multimedia
smart-home
movie-discovery
progressive-web-app
entertainment
```

5. Нажми "Save changes"

### Способ 2: Через GitHub CLI (если установлен)

```bash
gh repo edit sadam6752-tech/ioBroker.movieswipe \
  --add-topic iobroker \
  --add-topic adapter \
  --add-topic movies \
  --add-topic pwa \
  --add-topic kinopoisk \
  --add-topic multimedia \
  --add-topic smart-home \
  --add-topic movie-discovery \
  --add-topic progressive-web-app \
  --add-topic entertainment
```

## Рекомендуемые topics

### Обязательные (для ioBroker):
- `iobroker` - основная тема для всех адаптеров
- `adapter` - указывает, что это адаптер
- `smart-home` - категория умного дома

### Функциональные:
- `movies` - работа с фильмами
- `pwa` - Progressive Web App
- `multimedia` - мультимедиа контент
- `entertainment` - развлечения

### Технические:
- `kinopoisk` - используемый API
- `movie-discovery` - поиск фильмов
- `progressive-web-app` - полное название PWA

## Проверка

После добавления topics:
1. Они появятся под названием репозитория
2. Можно кликнуть на любой topic, чтобы найти похожие проекты
3. Repochecker больше не будет показывать ошибку E8002

## Результат

Topics помогут:
- Пользователям находить ваш адаптер
- Улучшить SEO репозитория
- Показать связь с экосистемой ioBroker
- Пройти проверку repochecker

---

**После добавления topics запусти repochecker снова, чтобы убедиться, что ошибка E8002 исчезла!**
