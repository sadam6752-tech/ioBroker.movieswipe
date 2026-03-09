# Инструкция по переименованию репозитория

## Проблема

Repochecker требует, чтобы имя репозитория было `ioBroker.movieswipe` (с заглавной B), а сейчас оно `iobroker.movieswipe`.

## Решение

### 1. Переименовать репозиторий на GitHub

1. Открой https://github.com/sadam6752-tech/iobroker.movieswipe
2. Перейди в Settings (вверху справа)
3. В разделе "Repository name" измени на: `ioBroker.movieswipe`
4. Нажми "Rename"

### 2. Обновить локальный remote

После переименования на GitHub:

```bash
cd iobroker-adapter-movieswipe/iobroker.movieswipe
git remote set-url origin https://github.com/sadam6752-tech/ioBroker.movieswipe.git
```

### 3. Проверить

```bash
git remote -v
```

Должно показать:
```
origin  https://github.com/sadam6752-tech/ioBroker.movieswipe.git (fetch)
origin  https://github.com/sadam6752-tech/ioBroker.movieswipe.git (push)
```

### 4. Обновить package.json и io-package.json

Это уже сделано в коммите, просто запушь изменения после переименования:

```bash
git push
```

## Примечание

GitHub автоматически создаст редирект со старого URL на новый, так что старые ссылки продолжат работать.
