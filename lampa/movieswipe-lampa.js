/*
 * MovieSwipe plugin for Lampa (ioBroker.movieswipe).
 * Add it in Lampa: Settings -> Extensions -> Add plugin -> http://<ioBroker>:<port>/lampa.js
 * The AI agent (ioBroker.pi-agent) can then open the card of a suggested title on this device, and the adapter keeps
 * watch progress, bookmarks, watched lists and search history the same on all devices (Settings -> MovieSwipe).
 * Plain ES5: Lampa also runs in old WebViews of TVs and players.
 */
(function () {
    'use strict';

    if (window.movieswipe_lampa) return;
    window.movieswipe_lampa = true;

    var BASE = '__MOVIESWIPE_BASE__';
    var current = null;
    var failures = 0;

    function storage(key, def) {
        try {
            return Lampa.Storage.get(key, def);
        } catch (e) {
            return def;
        }
    }

    function deviceId() {
        var id = storage('movieswipe_id', '');
        if (!id) {
            id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            Lampa.Storage.set('movieswipe_id', id);
        }
        return id;
    }

    function platform() {
        try {
            return Lampa.Platform.get() || '';
        } catch (e) {
            return '';
        }
    }

    function get(url, timeout, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = timeout;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                var json = null;
                try {
                    json = JSON.parse(xhr.responseText);
                } catch (e) {
                    json = null;
                }
                ok(json);
            } else if (fail) fail();
        };
        xhr.onerror = function () {
            if (fail) fail();
        };
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = xhr.onerror;
        xhr.send();
        return xhr;
    }

    function report(cmd, status, title, message) {
        get(
            BASE + '/lampa/result?cmd=' + encodeURIComponent(cmd) + '&status=' + encodeURIComponent(status) +
                '&title=' + encodeURIComponent(title || '') + '&message=' + encodeURIComponent(message || ''),
            10000,
            function () {},
            null
        );
    }

    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[\s.,:;!?'"«»()\[\]\-–—&·]+/g, '');
    }

    function yearOf(item) {
        return parseInt(String(item.release_date || item.first_air_date || '').slice(0, 4), 10) || 0;
    }

    /** The best search result for the command, or null */
    function choose(res, c) {
        var list = [];
        var add = function (part, type) {
            if (part && part.results) {
                for (var i = 0; i < part.results.length; i++) list.push({ item: part.results[i], type: type });
            }
        };
        add(res && res.movie, 'movie');
        add(res && res.tv, 'tv');

        var names = [norm(c.originalTitle), norm(c.title)];
        var best = null;
        var bestScore = 0;
        for (var i = 0; i < list.length; i++) {
            var it = list[i].item;
            var titles = [norm(it.original_title), norm(it.original_name), norm(it.title), norm(it.name)];
            var titleMatch = false;
            for (var a = 0; a < titles.length; a++) {
                if (titles[a] && (titles[a] === names[0] || titles[a] === names[1])) titleMatch = true;
            }
            var diff = c.year ? Math.abs(yearOf(it) - c.year) : 0;
            if (!titleMatch || diff > 1) continue;
            var score = 10 - diff * 3 + ((list[i].type === 'tv') === !!c.series ? 2 : 0) - i * 0.01;
            if (score > bestScore) {
                bestScore = score;
                best = it;
            }
        }
        return best;
    }

    function search(query, done) {
        if (!query) return done(null);
        Lampa.Api.search({ query: encodeURIComponent(query) }, function (res) {
            done(res || null);
        });
    }

    function openCard(card, series) {
        card.source = 'tmdb';
        if (Lampa.Router && Lampa.Router.call) {
            Lampa.Router.call('full', card);
        } else {
            Lampa.Activity.push({
                url: '',
                component: 'full',
                id: card.id,
                method: series ? 'tv' : 'movie',
                card: card,
                source: 'tmdb'
            });
        }
    }

    function label(c) {
        return c.title + (c.year ? ' (' + c.year + ')' : '');
    }

    function open(c) {
        var queries = [c.originalTitle, c.title];
        var step = function (n) {
            if (n >= queries.length) {
                try {
                    Lampa.Noty.show('MovieSwipe: точного совпадения нет, ищу «' + c.title + '»');
                    Lampa.Search.open({ input: c.title || c.originalTitle });
                    report(c.cmd, 'search', c.title);
                } catch (e) {
                    report(c.cmd, 'error', c.title, e && e.message);
                }
                return;
            }
            if (!queries[n] || (n > 0 && queries[n] === queries[0])) return step(n + 1);
            search(queries[n], function (res) {
                var card = choose(res, c);
                if (!card) return step(n + 1);
                try {
                    Lampa.Noty.show('MovieSwipe: ' + label(c));
                    var series = !!card.original_name && !card.original_title;
                    openCard(card, series);
                    report(c.cmd, 'opened', card.title || card.name);
                } catch (e) {
                    report(c.cmd, 'error', c.title, e && e.message);
                }
            });
        };
        step(0);
    }

    function handle(commands) {
        for (var i = 0; i < commands.length; i++) {
            var c = commands[i];
            if (c && c.action === 'open') open(c);
            // another device changed the synced data
            if (c && c.action === 'sync' && syncKey()) scheduleSync(300);
        }
    }

    /* ---------- Sync of Lampa data between devices (lib/lampa-sync.js) ---------- */

    var EMBED_KEY = '__MOVIESWIPE_KEY__';
    var SYNC_DEBOUNCE_MS = 5000;
    var SYNC_PERIOD_MS = 10 * 60 * 1000;
    var SYNC_TIMEOUT_MS = 120000;
    var LIST_LIMIT = 3000;
    var SYNC_GROUPS = ['timeline', 'favorite', 'viewed', 'search'];
    var GROUP_OF = {
        timeline: 'timeline',
        favorite: 'favorite',
        cards: 'favorite',
        online_view: 'viewed',
        torrents_view: 'viewed',
        search_history: 'search'
    };
    var LISTS = ['online_view', 'torrents_view', 'search_history'];
    var FAV_TYPES = ['like', 'wath', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];
    var MODE_NAMES = {
        both: 'Отправлять и принимать',
        send: 'Только отправлять',
        receive: 'Только принимать',
        off: 'Не синхронизировать'
    };
    var syncState = {
        busy: false,
        again: false,
        timer: null,
        period: null,
        failures: 0,
        cats: null,
        cubWarned: false,
        resolved: [],
        resolving: false
    };

    function cardOf(item) {
        var card = item;
        try {
            if (Lampa.Utils && Lampa.Utils.clearCard) card = Lampa.Utils.clearCard(item);
        } catch (e) {
            card = item;
        }
        card.source = 'tmdb';
        return card;
    }

    /** An AI agent bookmarked a title the copy has no card for: find it on TMDB as openInLampa does */
    function resolveRequests(requests) {
        if (syncState.resolving) return;
        syncState.resolving = true;
        var step = function (n) {
            if (n >= requests.length) {
                syncState.resolving = false;
                if (syncState.resolved.length) runSync();
                return;
            }
            var r = requests[n];
            var queries = [r.originalTitle, r.title];
            var tryQuery = function (q) {
                if (q >= queries.length) {
                    syncState.resolved.push({ rid: r.rid, error: 'notFound' });
                    return step(n + 1);
                }
                if (!queries[q] || (q > 0 && queries[q] === queries[0])) return tryQuery(q + 1);
                search(queries[q], function (res) {
                    var item = choose(res, r);
                    if (!item) return tryQuery(q + 1);
                    syncState.resolved.push({ rid: r.rid, card: cardOf(item) });
                    step(n + 1);
                });
            };
            try {
                tryQuery(0);
            } catch (e) {
                step(n + 1);
            }
        };
        step(0);
    }

    function str(key, def) {
        var v = storage(key, def);
        return v === null || typeof v == 'undefined' ? def : String(v);
    }

    function syncKey() {
        var key = str('movieswipe_sync_key', '');
        if (!key && EMBED_KEY && EMBED_KEY.indexOf('__') !== 0) key = EMBED_KEY;
        return key;
    }

    function isArray(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function hasOwn(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    /** true when the user is signed in to CUB: then Lampa syncs bookmarks and time codes itself */
    function cubSync() {
        try {
            return !!(Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.sync);
        } catch (e) {
            return false;
        }
    }

    function groupMode(group) {
        var m = str('movieswipe_sync_' + group, 'both');
        return MODE_NAMES[m] ? m : 'both';
    }

    function allowed(cat, dir) {
        var group = GROUP_OF[cat];
        if (syncState.cats && syncState.cats.indexOf(cat) < 0) return false;
        if ((group == 'timeline' || group == 'favorite') && cubSync()) {
            if (!syncState.cubWarned) {
                syncState.cubWarned = true;
                try {
                    Lampa.Noty.show('MovieSwipe: вход в CUB — закладки и тайм-коды синхронизирует CUB, не MovieSwipe');
                } catch (e) {
                    // no notice
                }
            }
            return false;
        }
        var m = groupMode(group);
        return m == 'both' || m == dir;
    }

    function timelineKey() {
        try {
            return Lampa.Timeline.filename() || 'file_view';
        } catch (e) {
            return 'file_view';
        }
    }

    function readObject(key) {
        var v = storage(key, '{}');
        return v && typeof v == 'object' && !isArray(v) ? v : {};
    }

    function readList(key) {
        var v = storage(key, '[]');
        return isArray(v) ? v : [];
    }

    function readFavorite() {
        var d = readObject('favorite');
        for (var i = 0; i < FAV_TYPES.length; i++) if (!isArray(d[FAV_TYPES[i]])) d[FAV_TYPES[i]] = [];
        if (!isArray(d.card)) d.card = [];
        return d;
    }

    function indexOfId(list, id) {
        for (var i = 0; i < list.length; i++) if (String(list[i]) === String(id)) return i;
        return -1;
    }

    function findCard(cards, id) {
        for (var i = 0; i < cards.length; i++) if (cards[i] && String(cards[i].id) === String(id)) return cards[i];
        return null;
    }

    /** The data of a category as {key: {v, ts}} */
    function flatten(cat) {
        var out = {};
        var i, k;
        if (cat == 'timeline') {
            var tl = readObject(timelineKey());
            for (k in tl) {
                if (hasOwn(tl, k) && tl[k] && typeof tl[k] == 'object') out[k] = { v: tl[k], ts: tl[k].updated || 0 };
            }
        } else if (cat == 'favorite') {
            var d = readFavorite();
            for (i = 0; i < FAV_TYPES.length; i++) {
                var list = d[FAV_TYPES[i]];
                for (var j = 0; j < list.length; j++) {
                    out[FAV_TYPES[i] + ':' + list[j]] = { v: { type: FAV_TYPES[i], id: list[j] } };
                }
            }
        } else {
            var arr = readList(cat);
            for (i = 0; i < arr.length; i++) if (typeof arr[i] == 'string') out[arr[i]] = {};
        }
        return out;
    }

    /** What changed since the snapshot of the last sync, and the snapshot after sending it */
    function localChanges(snap, now) {
        var changes = {};
        var next = {};
        var cats = ['timeline', 'favorite'].concat(LISTS);
        for (var c = 0; c < cats.length; c++) {
            var cat = cats[c];
            if (!allowed(cat, 'send') && !allowed(cat, 'receive')) continue;
            var cur = flatten(cat);
            var old = snap[cat] || {};
            var list = [];
            var ns = {};
            var send = allowed(cat, 'send');
            var k;
            for (k in cur) {
                if (!hasOwn(cur, k)) continue;
                if (cat == 'timeline') {
                    ns[k] = cur[k].ts;
                    if (send && (!hasOwn(old, k) || cur[k].ts > old[k])) list.push({ k: k, v: cur[k].v, ts: cur[k].ts || 1 });
                } else {
                    ns[k] = 1;
                    if (send && !hasOwn(old, k)) list.push({ k: k, v: cur[k].v, ts: now });
                }
            }
            if (send && cat != 'timeline') {
                for (k in old) if (hasOwn(old, k) && !hasOwn(cur, k)) list.push({ k: k, ts: now, del: true });
            }
            if (list.length) changes[cat] = list;
            next[cat] = ns;
            if (cat == 'favorite' && list.length) {
                var cards = [];
                var seen = {};
                var all = readFavorite().card;
                for (var i = 0; i < list.length; i++) {
                    if (list[i].del || seen[String(list[i].v.id)]) continue;
                    seen[String(list[i].v.id)] = true;
                    var card = findCard(all, list[i].v.id);
                    if (card) cards.push({ k: String(card.id), v: card, ts: now });
                }
                if (cards.length) changes.cards = cards;
            }
        }
        return { changes: changes, next: next };
    }

    /** Applies the changes of the server; with replace the local data of the category is dropped first */
    function applyChanges(changes, snap, replace) {
        var touched = {};
        var cat, i, e, k;
        var tl = null;
        var fav = null;
        var lists = {};
        var cats = ['timeline', 'favorite', 'cards'].concat(LISTS);
        for (var c = 0; c < cats.length; c++) {
            cat = cats[c];
            if (!allowed(cat, 'receive')) continue;
            var list = (changes && changes[cat]) || [];
            if (!list.length && !replace) continue;
            var s = (snap[cat] = snap[cat] || {});
            if (cat == 'timeline') {
                tl = replace ? {} : readObject(timelineKey());
                if (replace) snap[cat] = s = {};
                for (i = 0; i < list.length; i++) {
                    e = list[i];
                    var local = tl[e.k];
                    var lts = local && typeof local == 'object' ? local.updated || 0 : 0;
                    if (local && lts >= e.ts && !replace) continue;
                    if (e.del) {
                        delete tl[e.k];
                        delete s[e.k];
                    } else {
                        tl[e.k] = e.v;
                        s[e.k] = e.v.updated || e.ts;
                    }
                }
                touched.timeline = true;
            } else if (cat == 'favorite' || cat == 'cards') {
                if (!fav) {
                    fav = readFavorite();
                    if (replace && allowed('favorite', 'receive')) {
                        for (i = 0; i < FAV_TYPES.length; i++) fav[FAV_TYPES[i]] = [];
                        fav.card = [];
                        snap.favorite = {};
                    }
                }
                s = snap[cat] = snap[cat] || {};
                for (i = 0; i < list.length; i++) {
                    e = list[i];
                    if (cat == 'cards') {
                        if (e.v && !findCard(fav.card, e.k)) fav.card.push(e.v);
                        continue;
                    }
                    var type = e.k.slice(0, e.k.indexOf(':'));
                    var id = e.v ? e.v.id : e.k.slice(type.length + 1);
                    if (!fav[type]) continue;
                    var at = indexOfId(fav[type], id);
                    if (e.del) {
                        if (at >= 0) fav[type].splice(at, 1);
                        delete s[e.k];
                    } else {
                        if (at >= 0) fav[type].splice(at, 1);
                        fav[type].unshift(id);
                        s[e.k] = 1;
                    }
                }
                touched.favorite = true;
            } else {
                var arr = replace ? [] : readList(cat);
                if (replace) snap[cat] = s = {};
                for (i = 0; i < list.length; i++) {
                    e = list[i];
                    k = indexOfId(arr, e.k);
                    if (e.del) {
                        if (k >= 0) arr.splice(k, 1);
                        delete s[e.k];
                    } else {
                        if (k < 0) arr.push(e.k);
                        s[e.k] = 1;
                    }
                }
                if (arr.length > LIST_LIMIT) arr = arr.slice(arr.length - LIST_LIMIT);
                lists[cat] = arr;
                touched[cat] = true;
            }
        }
        try {
            if (touched.timeline) {
                Lampa.Storage.set(timelineKey(), tl, true);
                if (Lampa.Timeline && Lampa.Timeline.read) Lampa.Timeline.read();
            }
            if (touched.favorite) {
                Lampa.Storage.set('favorite', fav, true);
                if (Lampa.Favorite && Lampa.Favorite.read) Lampa.Favorite.read();
            }
            for (k in lists) if (hasOwn(lists, k)) Lampa.Storage.set(k, lists[k], true);
        } catch (err) {
            // the next sync tries again
        }
    }

    function post(url, body, timeout, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.timeout = timeout;
        // text/plain: no CORS preflight
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.onload = function () {
            var json = null;
            try {
                json = JSON.parse(xhr.responseText);
            } catch (e) {
                json = null;
            }
            if (xhr.status >= 200 && xhr.status < 300 && json) ok(json);
            else if (fail) fail(xhr.status, json);
        };
        xhr.onerror = function () {
            if (fail) fail(0, null);
        };
        xhr.ontimeout = xhr.onerror;
        xhr.send(body);
    }

    function setLocal(key, value) {
        try {
            Lampa.Storage.set(key, value, true);
        } catch (e) {
            // storage full: the next sync starts over
        }
    }

    function lampaVersion() {
        try {
            return String(Lampa.Manifest.app_version || '');
        } catch (e) {
            return '';
        }
    }

    function syncSettings() {
        var out = {};
        for (var i = 0; i < SYNC_GROUPS.length; i++) out[SYNC_GROUPS[i]] = groupMode(SYNC_GROUPS[i]);
        if (cubSync()) out.timeline = out.favorite = 'off';
        return out;
    }

    function syncFinished(retry) {
        syncState.busy = false;
        if (retry) {
            syncState.failures++;
            scheduleSync(Math.min(5 * 60000, 15000 * syncState.failures));
        } else {
            syncState.failures = 0;
            if (syncState.again) {
                syncState.again = false;
                scheduleSync(500);
            }
        }
    }

    /** One sync: send the local changes, apply those of the other devices */
    function syncStep(round, replace) {
        var epoch = str('movieswipe_sync_epoch', '');
        var since = parseInt(str('movieswipe_sync_rev', '0'), 10) || 0;
        var snap = epoch ? readObject('movieswipe_sync_snap') : {};
        var initial = str('movieswipe_sync_init', '') !== epoch;
        var now = Date.now();
        var local = epoch && !replace ? localChanges(snap, now) : { changes: {}, next: {} };
        var body = {
            key: syncKey(),
            device: deviceId(),
            name: str('movieswipe_device', ''),
            platform: platform(),
            lampa: lampaVersion(),
            epoch: epoch,
            since: replace ? 0 : since,
            initial: initial && !replace,
            changes: local.changes,
            settings: syncSettings()
        };
        var resolved = syncState.resolved.splice(0);
        if (resolved.length) body.resolved = resolved;
        post(
            BASE + '/lampa/sync',
            JSON.stringify(body),
            SYNC_TIMEOUT_MS,
            function (res) {
                if (res.cats) syncState.cats = res.cats;
                if (res.requests && res.requests.length) resolveRequests(res.requests);
                if (res.wait) return syncFinished(false);
                if (res.stale) {
                    // first sync, or the copy on ioBroker was reset
                    setLocal('movieswipe_sync_epoch', String(res.epoch));
                    setLocal('movieswipe_sync_rev', 0);
                    setLocal('movieswipe_sync_snap', {});
                    setLocal('movieswipe_sync_init', res.replace ? String(res.epoch) : '');
                    if (round >= 3) return syncFinished(true);
                    return syncStep(round + 1, !!res.replace);
                }
                var next = local.next;
                for (var c in snap) if (hasOwn(snap, c) && !hasOwn(next, c)) next[c] = snap[c];
                applyChanges(res.changes || {}, next, replace);
                if (replace) {
                    // after taking over the copy the snapshot is the local data as it is now
                    next = localChanges({}, now).next;
                }
                setLocal('movieswipe_sync_snap', next);
                setLocal('movieswipe_sync_rev', res.rev || 0);
                setLocal('movieswipe_sync_init', String(res.epoch));
                if (replace) {
                    try {
                        Lampa.Noty.show('MovieSwipe: данные синхронизации обновлены');
                    } catch (e) {
                        // no notice
                    }
                }
                syncFinished(false);
            },
            function (status) {
                // 403: the sync is off in the adapter, 401: wrong key; try again later
                syncFinished(status != 401 && status != 403);
                if (status == 401 || status == 403) scheduleSync(SYNC_PERIOD_MS);
            }
        );
    }

    function runSync() {
        if (!syncKey()) return;
        if (syncState.busy) {
            syncState.again = true;
            return;
        }
        if (syncState.timer) {
            clearTimeout(syncState.timer);
            syncState.timer = null;
        }
        syncState.busy = true;
        try {
            syncStep(0, false);
        } catch (e) {
            syncFinished(true);
        }
    }

    function scheduleSync(ms) {
        if (syncState.timer) clearTimeout(syncState.timer);
        syncState.timer = setTimeout(function () {
            syncState.timer = null;
            runSync();
        }, ms);
    }

    function watched(name) {
        return name == timelineKey() || name == 'favorite' || LISTS.indexOf(name) >= 0;
    }

    function startSync() {
        // for the console of the device and the tests: window.movieswipe_lampa_sync()
        window.movieswipe_lampa_sync = runSync;
        if (EMBED_KEY && EMBED_KEY.indexOf('__') !== 0 && !str('movieswipe_sync_key', '')) {
            setLocal('movieswipe_sync_key', EMBED_KEY);
        }
        try {
            Lampa.Storage.listener.follow('change', function (e) {
                if (e && watched(e.name) && syncKey()) scheduleSync(SYNC_DEBOUNCE_MS);
            });
        } catch (e) {
            // without the listener the periodic sync still runs
        }
        var tick = function () {
            runSync();
            syncState.period = setTimeout(tick, SYNC_PERIOD_MS);
        };
        syncState.period = setTimeout(tick, 3000);
    }


    function poll() {
        var url =
            BASE + '/lampa/poll?id=' + encodeURIComponent(deviceId()) +
            '&name=' + encodeURIComponent(storage('movieswipe_device', '') || '') +
            '&platform=' + encodeURIComponent(platform());
        current = get(
            url,
            40000,
            function (json) {
                failures = 0;
                if (json && json.commands && json.commands.length) handle(json.commands);
                setTimeout(poll, 200);
            },
            function () {
                failures++;
                setTimeout(poll, Math.min(30000, 2000 * failures));
            }
        );
    }

    function settings() {
        if (!Lampa.SettingsApi) return;
        Lampa.SettingsApi.addComponent({
            component: 'movieswipe',
            name: 'MovieSwipe',
            icon:
                '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" ' +
                'height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: 'movieswipe',
            param: { name: 'movieswipe_device', type: 'input', values: '', default: '' },
            field: {
                name: 'Имя устройства',
                description: 'Как это устройство называют MovieSwipe и ИИ-агент, например «ТВ гостиная» или «Dune»'
            },
            onChange: function () {
                // the next poll sends the new name
                if (current) current.abort();
            }
        });
        Lampa.SettingsApi.addParam({
            component: 'movieswipe',
            param: { name: 'movieswipe_sync_key', type: 'input', values: '', default: '' },
            field: {
                name: 'Ключ синхронизации',
                description: 'Ключ из настроек адаптера MovieSwipe (вкладка «Синхронизация Lampa»), один для всех устройств'
            },
            onChange: function () {
                runSync();
            }
        });
        var groups = [
            ['timeline', 'Прогресс просмотра', 'Тайм-коды: где остановились в фильме или серии'],
            ['favorite', 'Закладки и история', 'Нравится, позже, закладки, история и отметки'],
            ['viewed', 'Просмотренное', 'Отметки просмотренного онлайн и в торрентах'],
            ['search', 'История поиска', 'Что искали в Lampa']
        ];
        for (var i = 0; i < groups.length; i++) {
            Lampa.SettingsApi.addParam({
                component: 'movieswipe',
                param: { name: 'movieswipe_sync_' + groups[i][0], type: 'select', values: MODE_NAMES, default: 'both' },
                field: { name: groups[i][1], description: groups[i][2] },
                onChange: function () {
                    runSync();
                }
            });
        }
    }

    function start() {
        try {
            settings();
        } catch (e) {
            // settings are optional
        }
        poll();
        startSync();
    }

    if (window.appready) start();
    else
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
})();
