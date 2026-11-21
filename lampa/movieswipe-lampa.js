/*
 * MovieSwipe plugin for Lampa (ioBroker.movieswipe).
 * Add it in Lampa: Settings -> Extensions -> Add plugin -> http://<ioBroker>:<port>/lampa.js
 * The AI agent (ioBroker.pi-agent) can then open the card of a suggested title on this device.
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
        }
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
    }

    function start() {
        try {
            settings();
        } catch (e) {
            // settings are optional
        }
        poll();
    }

    if (window.appready) start();
    else
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
})();
