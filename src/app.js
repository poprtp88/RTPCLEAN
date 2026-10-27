/**
 * POP RTP — main app.
 * RTP values come from the server (GET /api/games); this file renders them,
 * refreshes them at every 3-minute São Paulo boundary, and wires the page UI.
 */
(function () {
    'use strict';

    var PLATFORMS = Array.isArray(window.PLATFORMS_CONFIG) ? window.PLATFORMS_CONFIG : [];
    var PROVIDERS = window.PROVIDERS || {};
    var UI = window.UI_CONFIG || {};

    var CYCLE_MS = 3 * 60 * 1000;
    var INITIAL_GAMES = 24;
    var GAMES_PER_PAGE = 24;
    var SORTE_ENTRY_DELAY_MS = 5600;

    var cdnBase = '';
    var allGames = [];
    var currentProvider = 'all';
    var visibleLimit = INITIAL_GAMES;

    function $(id) { return document.getElementById(id); }
    function pad2(n) { return String(n).padStart(2, '0'); }

    function getSaoPauloNow() {
        return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    }

    // ============================================
    // LINKS (single source: data/platforms.json + data/ui-config.json)
    // ============================================

    function platformUrl(id) {
        for (var i = 0; i < PLATFORMS.length; i++) {
            if (String(PLATFORMS[i].id) === String(id)) return PLATFORMS[i].url || '';
        }
        return '';
    }

    function isLiveUrl(url) {
        return !!url && url !== '#';
    }

    function applyLinks(scope) {
        var root = scope || document;
        root.querySelectorAll('[data-platform-id]').forEach(function (el) {
            var url = platformUrl(el.getAttribute('data-platform-id'));
            if (isLiveUrl(url)) el.setAttribute('href', url);
        });
        var links = UI.links || {};
        root.querySelectorAll('[data-link]').forEach(function (el) {
            var url = links[el.getAttribute('data-link')];
            if (isLiveUrl(url)) el.setAttribute('href', url);
        });
    }

    // Placeholder hrefs never navigate.
    document.addEventListener('click', function (e) {
        var a = e.target.closest('a[href="#"]');
        if (a) e.preventDefault();
    });

    // ============================================
    // OVERLAYS (popups, modals, lightbox)
    // ============================================

    var openOverlays = [];

    function setScrollLocked() {
        document.body.style.overflow = openOverlays.length ? 'hidden' : '';
    }

    /**
     * Wires an .overlay element: clicking the backdrop or any [data-close] closes it, Escape closes the top one.
     * Returns { show, hide, isOpen } or null when the element is missing.
     */
    function createOverlay(id, onClose) {
        var el = $(id);
        if (!el) return null;
        var api = {
            el: el,
            isOpen: function () { return openOverlays.indexOf(api) !== -1; },
            show: function () {
                if (api.isOpen()) return;
                openOverlays.push(api);
                el.classList.add('is-open');
                el.setAttribute('aria-hidden', 'false');
                setScrollLocked();
            },
            hide: function () {
                var idx = openOverlays.indexOf(api);
                if (idx === -1) return;
                openOverlays.splice(idx, 1);
                el.classList.remove('is-open');
                el.setAttribute('aria-hidden', 'true');
                setScrollLocked();
                if (onClose) onClose();
            },
        };
        el.addEventListener('click', function (e) {
            if (e.target === el || e.target.closest('[data-close]')) api.hide();
        });
        return api;
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && openOverlays.length) openOverlays[openOverlays.length - 1].hide();
    });

    // ============================================
    // RTP (values from the server; retention + live ticker read them via window)
    // ============================================

    function generateRandomRTP(gameId) {
        var g = allGames.find(function (x) { return x.id === gameId; });
        return g ? g.rtp : 0;
    }
    window.generateRandomRTP = generateRandomRTP;

    function getRTPColorClass(rtp) {
        if (rtp >= 70) return 'high';
        if (rtp >= 50) return 'medium';
        return 'low';
    }

    /** Fresh card order on every page load; game ids and RTP are untouched. */
    var SESSION_GRID_SEED = (Date.now() ^ Math.floor((performance.now() % 1) * 1e9)) >>> 0;

    function seededShuffle(arr, seed) {
        var out = arr.slice();
        for (var i = out.length - 1; i > 0; i--) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            var j = seed % (i + 1);
            var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
        }
        return out;
    }

    function setGames(data) {
        cdnBase = data.cdnBase || cdnBase;
        allGames = data.games || [];
        window._allGames = allGames;
    }

    function gamesUrl() {
        return window.RTP_STATIC_GAMES_URL || '/api/games';
    }

    function loadAllGames() {
        var prefetched = window.RTP_GAMES_PROMISE;
        window.RTP_GAMES_PROMISE = null;
        return (prefetched || fetch(gamesUrl(), { credentials: 'same-origin' })
            .then(function (r) {
                if (!r.ok) throw new Error('games ' + r.status);
                return r.json();
            }))
            .then(setGames)
            .catch(function (e) { console.error('Games unavailable:', e); });
    }

    function refreshRTPFromServer() {
        if (window.RTP_STATIC_GAMES_URL) return;
        fetch('/api/games', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data) return;
                setGames(data);
                renderGameCards();
            })
            .catch(function (e) { console.warn('RTP refresh failed:', e); });
    }

    // ============================================
    // CLOCK + 3-MINUTE COUNTDOWN
    // ============================================

    function updateSystemTime() {
        var el = $('systemTime');
        if (el) {
            el.textContent = getSaoPauloNow().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
    }

    function getTimeUntilNextUpdate() {
        var sp = getSaoPauloNow();
        var minutesUntilNext = 3 - (sp.getMinutes() % 3);
        return minutesUntilNext * 60000 - sp.getSeconds() * 1000 - sp.getMilliseconds();
    }

    function setText(id, text) {
        var el = $(id);
        if (el) el.textContent = text;
    }

    function setWidth(id, pct) {
        var el = $(id);
        if (el) el.style.width = pct + '%';
    }

    function updateCountdownTimer() {
        var ms = getTimeUntilNextUpdate();
        var minutes = Math.floor(ms / 60000);
        var seconds = Math.floor((ms % 60000) / 1000);
        var progress = ((CYCLE_MS - ms) / CYCLE_MS) * 100;

        setText('timerMinutes', pad2(minutes));
        setText('timerSeconds', pad2(seconds));
        setText('mobileTimerMinutes', pad2(minutes));
        setText('mobileTimerSeconds', pad2(seconds));
        setText('floatingTimerMinutes', pad2(minutes));
        setText('floatingTimerSeconds', pad2(seconds));
        setText('nextUpdate', minutes + ':' + pad2(seconds));
        setText('progressPercent', Math.floor(progress) + '%');
        setText('mobileProgressPercent', Math.floor(progress) + '%');
        setWidth('timerProgressBar', progress);
        setWidth('mobileTimerProgressBar', progress);
        setWidth('floatingTimerProgressBar', progress);
    }

    /** Ticks the countdown and refreshes RTP once per new 3-minute block (São Paulo time). */
    function startCountdownTimer() {
        var lastBlock = -1;
        updateCountdownTimer();
        setInterval(function () {
            updateCountdownTimer();
            var minute = getSaoPauloNow().getMinutes();
            var block = Math.floor(minute / 3) * 3;
            if (block !== lastBlock && minute % 3 === 0) {
                lastBlock = block;
                setTimeout(refreshRTPFromServer, 100);
            }
        }, 500);
    }

    // ============================================
    // GAMES GRID
    // ============================================

    function getGamesGridColumnCount() {
        var grid = $('gamesGrid');
        if (!grid) return 3;
        var tpl = getComputedStyle(grid).gridTemplateColumns;
        if (tpl && tpl !== 'none') {
            var n = tpl.trim().split(/\s+/).filter(Boolean).length;
            if (n > 0) return n;
        }
        return 3;
    }

    /** Rounds the limit up to a full grid row, never beyond the filtered total. */
    function alignVisibleLimitToGridRows(limit, cols, total) {
        if (total <= 0 || cols < 1) return 0;
        var t = Math.min(limit, total);
        return Math.min(total, Math.ceil(t / cols) * cols);
    }

    function filterGamesByProvider(provider) {
        if (provider === 'all') return allGames;
        return allGames.filter(function (g) { return g.provider === provider; });
    }

    var PRIORITY_BADGES = { 1: 'FORTUNE', 2: 'POPULAR', 3: 'DESTAQUE' };

    function createGameCard(game, index) {
        var rtp = game.rtp != null ? game.rtp : generateRandomRTP(game.id);
        var colorClass = getRTPColorClass(rtp);
        var badge = PRIORITY_BADGES[game.priority]
            ? '<span class="game-badge game-badge--p' + game.priority + '">' + PRIORITY_BADGES[game.priority] + '</span>'
            : '';

        var card = document.createElement('div');
        card.className = 'game-card';
        card.style.animationDelay = (index * 0.02) + 's';
        card.innerHTML =
            '<div class="game-image-wrap">' +
                '<img src="' + game.imagePath + '" alt="' + game.imageName + '" class="game-image" loading="lazy">' +
                badge +
            '</div>' +
            '<div class="game-rtp">' +
                '<div class="game-rtp-row">' +
                    '<span class="game-rtp-label">RTP</span>' +
                    '<span class="game-rtp-value rtp-' + colorClass + '">' + rtp + '%</span>' +
                '</div>' +
                '<div class="rtp-bar"><div class="rtp-bar-fill rtp-fill-' + colorClass + '" style="width:' + rtp + '%"></div></div>' +
            '</div>';
        card.addEventListener('click', openPlatformModal);
        return card;
    }

    /** End index of each rendered batch; each batch is shuffled on its own so "load more" only appends. */
    var renderedBatchEnds = [];

    function appendBatch(frag, filtered, start, end) {
        seededShuffle(filtered.slice(start, end), SESSION_GRID_SEED).forEach(function (game, i) {
            frag.appendChild(createGameCard(game, i % GAMES_PER_PAGE));
        });
    }

    /** append=true adds only the cards between the last batch and visibleLimit. */
    function renderGameCards(append) {
        var grid = $('gamesGrid');
        if (!grid) return;

        var filtered = filterGamesByProvider(currentProvider);
        visibleLimit = alignVisibleLimitToGridRows(visibleLimit, getGamesGridColumnCount(), filtered.length);

        var frag = document.createDocumentFragment();
        var renderedEnd = renderedBatchEnds.length ? renderedBatchEnds[renderedBatchEnds.length - 1] : 0;
        if (append && renderedEnd > 0 && visibleLimit >= renderedEnd) {
            if (visibleLimit > renderedEnd) {
                appendBatch(frag, filtered, renderedEnd, visibleLimit);
                renderedBatchEnds.push(visibleLimit);
            }
            grid.appendChild(frag);
        } else {
            var ends = renderedBatchEnds.filter(function (e) { return e < visibleLimit; });
            ends.push(visibleLimit);
            var start = 0;
            ends.forEach(function (end) {
                appendBatch(frag, filtered, start, end);
                start = end;
            });
            renderedBatchEnds = ends;
            grid.innerHTML = '';
            grid.appendChild(frag);
        }

        var moreWrap = $('loadMoreContainer');
        if (moreWrap) {
            var remaining = filtered.length - visibleLimit;
            moreWrap.hidden = remaining <= 0;
            setText('remainingGamesCount', '+' + Math.max(0, remaining));
        }
    }

    function setupLoadMore() {
        var btn = $('loadMoreBtn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            visibleLimit += GAMES_PER_PAGE;
            renderGameCards(true);
        });
    }

    // ============================================
    // PROVIDER FILTER
    // ============================================

    function providerLabel(key) {
        var p = PROVIDERS[key];
        return (p && (p.label || p.displayName)) || key;
    }

    function setupProviderMenu() {
        var toggle = $('providerToggle');
        var menu = $('providerMenu');
        if (!toggle || !menu) return;

        var counts = {};
        allGames.forEach(function (g) { counts[g.provider] = (counts[g.provider] || 0) + 1; });
        var keys = Object.keys(PROVIDERS).filter(function (k) { return counts[k]; });
        Object.keys(counts).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });

        var items = [{ key: 'all', label: 'TODOS', count: allGames.length }].concat(
            keys.map(function (k) { return { key: k, label: providerLabel(k), count: counts[k] }; })
        );

        menu.innerHTML = items.map(function (it) {
            return '<button type="button" class="provider-item' + (it.key === currentProvider ? ' is-active' : '') +
                '" role="option" data-provider="' + it.key.replace(/"/g, '&quot;') + '">' +
                '<span class="provider-item-name">' + it.label + '</span>' +
                '<span class="provider-item-count">' + it.count + '</span></button>';
        }).join('');

        function setCurrent(it) {
            setText('currentProviderName', it.label);
            setText('currentProviderCount', String(it.count));
        }
        setCurrent(items[0]);

        function setOpen(open) {
            menu.classList.toggle('is-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }

        toggle.addEventListener('click', function () { setOpen(!menu.classList.contains('is-open')); });

        menu.addEventListener('click', function (e) {
            var btn = e.target.closest('.provider-item');
            if (!btn) return;
            currentProvider = btn.getAttribute('data-provider');
            visibleLimit = INITIAL_GAMES;
            renderedBatchEnds = [];
            menu.querySelectorAll('.provider-item').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
            setCurrent(items.filter(function (it) { return it.key === currentProvider; })[0]);
            renderGameCards();
            setOpen(false);
        });

        document.addEventListener('click', function (e) {
            if (!toggle.contains(e.target) && !menu.contains(e.target)) setOpen(false);
        });
    }

    // ============================================
    // CAROUSELS
    // ============================================

    function setupCarousel() {
        var track = $('carouselTrack');
        var dotsWrap = $('carouselDots');
        if (!track) return;

        var slides = track.querySelectorAll('.carousel-slide');
        var total = slides.length;
        if (!total) return;
        var current = 0;
        var timer = null;

        track.querySelectorAll('.carousel-slide--platform').forEach(function (slide) {
            slide.addEventListener('click', function (e) {
                e.preventDefault();
                openPlatformModal();
            });
        });

        if (dotsWrap) {
            var html = '';
            for (var i = 0; i < total; i++) {
                html += '<button type="button" class="carousel-dot" aria-label="Banner ' + (i + 1) + '" data-slide="' + i + '"></button>';
            }
            dotsWrap.innerHTML = html;
        }
        var dots = dotsWrap ? dotsWrap.querySelectorAll('.carousel-dot') : [];

        function go(index) {
            current = (index + total) % total;
            track.style.transform = 'translateX(-' + current * 100 + '%)';
            dots.forEach(function (d, i) { d.classList.toggle('is-active', i === current); });
        }

        function restart() {
            clearInterval(timer);
            timer = setInterval(function () { go(current + 1); }, 5000);
        }

        function nav(index) { go(index); restart(); }

        var prev = $('prevBtn');
        var next = $('nextBtn');
        if (prev) prev.addEventListener('click', function () { nav(current - 1); });
        if (next) next.addEventListener('click', function () { nav(current + 1); });
        dots.forEach(function (d, i) { d.addEventListener('click', function () { nav(i); }); });

        var touchX = null;
        track.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
        track.addEventListener('touchend', function (e) {
            if (touchX === null) return;
            var diff = touchX - e.changedTouches[0].clientX;
            touchX = null;
            if (Math.abs(diff) > 40) nav(current + (diff > 0 ? 1 : -1));
        });

        go(0);
        restart();
    }

    function setupSideBannerCarousel() {
        var track = $('sideBannerTrack');
        if (!track) return;
        var slides = track.querySelectorAll('.side-banner-slide');
        var dots = document.querySelectorAll('.side-dot');
        var total = slides.length;
        if (total < 2) return;
        var current = 0;

        function go(index) {
            current = (index + total) % total;
            track.style.transform = 'translateX(-' + current * 100 + '%)';
            dots.forEach(function (d, i) { d.classList.toggle('is-active', i === current); });
        }

        dots.forEach(function (d, i) { d.addEventListener('click', function () { go(i); }); });
        setInterval(function () { go(current + 1); }, 4000);
        go(0);
    }

    // ============================================
    // PLATFORM MODAL
    // ============================================

    var platformModal = null;

    function openPlatformModal() {
        if (!platformModal) return;
        generatePlatformCards();
        platformModal.show();
    }

    function platformLogo(id) {
        return id >= 18 ? 'asset/' + id + '.png' : cdnBase + '/asset/' + id + '.png';
    }

    function shuffleArray(arr) {
        var out = arr.slice();
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
        }
        return out;
    }

    function generatePlatformCards() {
        var grid = $('platformGrid');
        if (!grid) return;
        grid.innerHTML = '';

        var list = PLATFORMS;
        if (PLATFORMS.length > 1) {
            var featured = PLATFORMS[0];
            var popbra = null;
            var rest = [];
            for (var i = 1; i < PLATFORMS.length; i++) {
                if (!popbra && PLATFORMS[i].id === 4) popbra = PLATFORMS[i];
                else rest.push(PLATFORMS[i]);
            }
            list = [featured].concat(popbra ? [popbra] : [], shuffleArray(rest));
        }

        list.forEach(function (platform, index) {
            var live = isLiveUrl(platform.url);
            var card = document.createElement('a');
            card.className = 'platform-card' + (index === 0 ? ' platform-card--featured' : '');
            card.href = live ? platform.url : '#';
            if (live) {
                card.target = '_blank';
                card.rel = 'noopener';
            }

            card.innerHTML =
                '<img src="' + platformLogo(platform.id) + '" alt="' + (platform.name || 'Plataforma ' + platform.id) + '" loading="lazy">' +
                '<span class="platform-status">ONLINE</span>';
            grid.appendChild(card);
        });

        setText('modalPlatformCount', String(PLATFORMS.length));
    }

    function setupPlatformModal() {
        platformModal = createOverlay('platformModal');
        if (!platformModal) return;
        generatePlatformCards();
        var floating = $('floatingTimerBtn');
        if (floating) floating.addEventListener('click', openPlatformModal);
        document.querySelectorAll('[data-open-platforms]').forEach(function (el) {
            el.addEventListener('click', openPlatformModal);
        });
    }

    // ============================================
    // ENTRY POPUP: one popup (PopSorte, else POPJUN launch) once per session
    // ============================================

    function sessionOnce(key) {
        try {
            if (sessionStorage.getItem(key)) return false;
            sessionStorage.setItem(key, '1');
        } catch (e) { /* storage blocked: still show once per page load */ }
        return true;
    }

    function setupEntryPopups() {
        var popup = createOverlay('sorteOverlay') || createOverlay('launchOverlay');
        if (!popup || !sessionOnce('poprtp:entryPopup')) return;
        setTimeout(popup.show, SORTE_ENTRY_DELAY_MS);
    }

    // ============================================
    // INIT
    // ============================================

    window.RTPApp = {
        createOverlay: createOverlay,
        platformUrl: platformUrl,
        openPlatformModal: openPlatformModal,
        sessionOnce: sessionOnce,
    };

    function init() {
        applyLinks();
        setupCarousel();
        setupSideBannerCarousel();
        setupPlatformModal();
        setupEntryPopups();
        setupLoadMore();

        updateSystemTime();
        setInterval(updateSystemTime, 1000);
        startCountdownTimer();

        loadAllGames().then(function () {
            var grid = $('gamesGrid');
            if (!allGames.length) {
                if (grid) grid.innerHTML = '<p class="games-message games-message--error">Nenhum jogo disponível no momento.</p>';
                return;
            }
            if (cdnBase) generatePlatformCards();
            setupProviderMenu();
            renderGameCards();
            setText('activeGames', String(allGames.length));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
