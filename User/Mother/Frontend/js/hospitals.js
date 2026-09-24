/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Hospitals Near Me (flow step 3)
   - List + OpenStreetMap of every facility, with its milk bank, milk
     storage, lactation services, donor milk and contact number
   - Search, municipality, filter chips, "shared services only", sort
   - "Use my location" (asked only when the mother taps it)
   - ?service=donate|request|inquire context (legacy "donation" too)
   - Filters live in the URL (history.replaceState) so Back restores them
   Needs: api.js, leaflet.js (optional), map.js — all loaded with defer.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  var MAP = window.MOWMMAS_MAP;
  if (!M) return;
  var ui = M.ui;
  var util = M.util;
  var esc = util.esc;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var desktop = window.matchMedia('(min-width: 1024px)');

  /* URL key → what the chip checks. A chip only matches a confirmed value. */
  var CHIPS = {
    bank:      { key: 'milkBank' },
    storage:   { key: 'milkStorage' },
    lactation: { key: 'lactationServices' },
    donations: { key: 'acceptsDonations' },
    donormilk: { key: 'providesDonorMilk' },
    available: { availability: 'available' }
  };
  var CHIP_ORDER = Object.keys(CHIPS);

  var CONTEXT = {
    donate: {
      tone: 'rose',
      lead: 'You want to donate breast milk',
      first: 'Facilities that confirmed they accept donations are shown first.',
      hidden: function (n) {
        return n === 1 ? '1 facility that said it doesn\'t accept donations is hidden.'
          : n + ' facilities that said they don\'t accept donations are hidden.';
      },
      matchLabel: 'Accepts donations', matchIcon: 'i-hand-heart'
    },
    request: {
      tone: 'violet',
      lead: 'You want to request breast milk',
      first: 'Facilities that confirmed they provide donor milk are shown first.',
      hidden: function (n) {
        return n === 1 ? '1 facility that said it doesn\'t provide donor milk is hidden.'
          : n + ' facilities that said they don\'t provide donor milk are hidden.';
      },
      matchLabel: 'Provides donor milk', matchIcon: 'i-bottle'
    },
    inquire: {
      tone: 'mint',
      lead: 'You want to ask a question',
      first: 'You can ask any facility. Facilities that shared their services are shown first.',
      hidden: null
    }
  };

  var FACTS = [
    { key: 'milkBank',          label: 'Milk bank',          icon: 'i-droplet' },
    { key: 'milkStorage',       label: 'Milk storage',       icon: 'i-snowflake' },
    { key: 'lactationServices', label: 'Lactation services', icon: 'i-heart' }
  ];
  var AVAIL_RANK = { available: 0, limited: 1, none: 2 };

  /* Antique plus its islands (Caluya lies west of the mainland) */
  var NEAR_ANTIQUE = { south: 10.25, north: 12.10, west: 121.35, east: 122.40 };
  var LOC_KEY = 'mowmmas.location';
  var RETURN_KEY = 'mowmmas.hospitals.return';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    locate: $('locateBtn'),
    locStatus: $('locStatus'),
    banner: $('contextBanner'),
    bannerIcon: $('contextIcon'),
    bannerText: $('contextText'),
    showAll: $('contextShowAll'),
    controls: $('controls'),
    search: $('searchInput'),
    muni: $('muniSelect'),
    sort: $('sortSelect'),
    more: $('moreBtn'),
    moreCount: $('moreCount'),
    shared: $('sharedOnly'),
    clear: $('clearBtn'),
    results: $('results'),
    count: $('resultCount'),
    list: $('facList'),
    listCol: document.querySelector('.list-col'),
    map: $('hospMap'),
    creditDate: $('creditDate'),
    legendYou: $('legendYou')
  };
  var chipButtons = Array.prototype.slice.call(document.querySelectorAll('.fchip[data-chip]'));
  var viewButtons = Array.prototype.slice.call(document.querySelectorAll('.viewswitch__btn'));

  var state = {
    q: '', town: '', chips: [], shared: false, sort: 'shared',
    service: null, view: 'list', selected: null, user: null
  };
  var data = null;       // API response
  var byId = {};
  var rows = [];         // what is shown now: [{ f, km }]
  var lastResult = null;

  var map = null, layer = null, userMarker = null, markers = {};
  var mapFailed = false, needsFit = true;

  /* ───────────── helpers ───────────── */
  function reported(f) {
    if (MAP) return MAP.hasReported(f);
    var s = f && f.services;
    return Boolean(s && Object.keys(s).some(function (k) { return s[k] !== null; }));
  }
  function needsKey() {
    var t = state.service && M.SERVICE_TYPES[state.service];
    return t ? t.needs : null;
  }
  function facilityHref(f) {
    return 'facility.html?id=' + encodeURIComponent(f.id) +
      (state.service ? '&service=' + encodeURIComponent(state.service) : '');
  }
  function insideAntique(p) {
    return p && p.lat >= NEAR_ANTIQUE.south && p.lat <= NEAR_ANTIQUE.north &&
      p.lon >= NEAR_ANTIQUE.west && p.lon <= NEAR_ANTIQUE.east;
  }
  function townCenter(name) {
    var list = (data && data.municipalities) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name && list[i].center) return list[i].center;
    }
    return null;
  }
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function distanceText(km, fromTown) {
    if (km == null) return '';
    return util.formatKm(km) + (fromTown ? ' from ' + fromTown : ' away');
  }
  function storage(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }

  /* ───────────── URL ⇄ state ───────────── */
  function readUrl() {
    var p = new URLSearchParams(location.search);
    var svc = (p.get('service') || '').toLowerCase();
    if (svc === 'donation') svc = 'donate';
    state.service = CONTEXT[svc] ? svc : null;
    state.q = (p.get('q') || '').slice(0, 80);
    state.town = p.get('town') || '';
    state.chips = CHIP_ORDER.filter(function (key) {
      return (p.get('has') || '').split(',').indexOf(key) !== -1;
    });
    state.shared = p.get('shared') === '1';
    var sort = p.get('sort');
    state.sort = sort === 'name' || sort === 'near' ? sort : 'shared';
  }

  function queryString(withService) {
    var p = new URLSearchParams();
    if (withService && state.service) p.set('service', state.service);
    if (state.q) p.set('q', state.q);
    if (state.town) p.set('town', state.town);
    if (state.chips.length) p.set('has', state.chips.join(','));
    if (state.shared) p.set('shared', '1');
    if (state.sort !== 'shared') p.set('sort', state.sort);
    var qs = p.toString();
    return location.pathname + (qs ? '?' + qs : '');
  }

  function writeUrl() {
    try { history.replaceState(history.state, '', queryString(true)); } catch (e) { /* file:// */ }
  }

  /* the mother's location is kept for this visit only, so Back from a
     facility page still shows distances */
  function saveLocation(p) {
    var s = storage('sessionStorage');
    try {
      if (!s) return;
      if (p) s.setItem(LOC_KEY, JSON.stringify({ lat: p.lat, lon: p.lon, at: Date.now() }));
      else s.removeItem(LOC_KEY);
    } catch (e) { /* storage blocked */ }
  }
  function loadLocation() {
    var s = storage('sessionStorage');
    try {
      var v = s && JSON.parse(s.getItem(LOC_KEY));
      if (v && typeof v.lat === 'number' && Date.now() - v.at < 30 * 60 * 1000 && insideAntique(v)) return { lat: v.lat, lon: v.lon };
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ───────────── filtering & sorting ───────────── */
  function passes(f) {
    var s = f.services || {};
    for (var i = 0; i < state.chips.length; i++) {
      var chip = CHIPS[state.chips[i]];
      if (chip.availability) { if (f.donorMilkAvailability !== chip.availability) return false; }
      else if (s[chip.key] !== true) return false;
    }
    if (state.shared && !reported(f)) return false;
    if (state.q) {
      var hay = norm([f.name, f.municipality, f.address, f.kindLabel].join(' '));
      var words = norm(state.q).split(' ').filter(Boolean);
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) === -1) return false;
    }
    return true;
  }

  function byName(a, b) { return a.f.name.localeCompare(b.f.name); }

  function compute() {
    var all = data.facilities;
    var needs = needsKey();
    var hidden = 0;
    var base = [];
    all.forEach(function (f) {
      if (needs && f.services && f.services[needs] === false) { hidden++; return; }
      if (passes(f)) base.push(f);
    });

    var list = base;
    var origin = state.user;
    var fallbackTown = null;
    if (state.town) {
      var inTown = base.filter(function (f) { return f.municipality === state.town; });
      var center = townCenter(state.town);
      if (!inTown.length && base.length && center) {
        // No facility listed in this town yet: show the nearest ones instead of a dead end
        fallbackTown = state.town;
        origin = { lat: center.lat, lon: center.lon };
      } else {
        list = inTown;
      }
    }

    var out = list.map(function (f) {
      return { f: f, km: origin ? util.distanceKm(origin.lat, origin.lon, f.lat, f.lon) : null };
    });

    out.sort(function (a, b) {
      if (fallbackTown) return a.km - b.km;
      if (state.sort === 'near' && a.km != null && b.km != null) return (a.km - b.km) || byName(a, b);
      if (state.sort === 'name') return byName(a, b);
      if (needs) {
        var ma = a.f.services[needs] === true ? 0 : 1;
        var mb = b.f.services[needs] === true ? 0 : 1;
        if (ma !== mb) return ma - mb;
      }
      var ra = reported(a.f) ? 0 : 1, rb = reported(b.f) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      var va = a.f.donorMilkAvailability in AVAIL_RANK ? AVAIL_RANK[a.f.donorMilkAvailability] : 3;
      var vb = b.f.donorMilkAvailability in AVAIL_RANK ? AVAIL_RANK[b.f.donorMilkAvailability] : 3;
      if (state.service === 'request' && va !== vb) return va - vb;
      return byName(a, b);
    });
    if (fallbackTown) out = out.slice(0, 5);

    return { rows: out, hidden: hidden, fallbackTown: fallbackTown, total: all.length, pool: base.length };
  }

  /* ───────────── rendering: banner, count, list ───────────── */
  function renderBanner(hidden) {
    var copy = state.service && CONTEXT[state.service];
    if (!copy) { els.banner.hidden = true; return; }
    var type = M.SERVICE_TYPES[state.service];
    els.banner.className = 'context-banner context-banner--' + copy.tone;
    els.bannerIcon.innerHTML = ui.icon(type.icon);
    els.bannerText.innerHTML = '<strong>' + esc(copy.lead) + '.</strong> ' + esc(copy.first) +
      (hidden && copy.hidden ? ' ' + esc(copy.hidden(hidden)) : '');
    els.showAll.setAttribute('href', queryString(false));
    els.banner.hidden = false;
  }

  function renderCount(res) {
    var n = res.rows.length;
    var text;
    if (res.fallbackTown) {
      text = 'No facility listed in ' + res.fallbackTown + ' yet · showing the ' + n + ' nearest';
    } else if (!n) {
      text = 'No facilities match your search';
    } else if (n === res.total) {
      text = 'Showing all ' + n + ' facilities';
    } else {
      text = 'Showing ' + n + ' of ' + res.total + ' facilities';
    }
    if (n && !res.fallbackTown && state.sort === 'near' && state.user) text += ' · nearest first';
    els.count.textContent = text;
  }

  function hintHtml(f) {
    var ds = f.dataStatus || {};
    if (!ds.hasProfile) {
      return '<p class="fcard__hint">' + ui.icon('i-help') + '<span>Services not reported yet. Call or visit to ask.</span></p>';
    }
    if (ds.sample) return ''; // no extra line on the card; the facility page explains it
    var when = ds.updatedAt ? ' · ' + esc(util.timeAgo(ds.updatedAt)) : '';
    if (ds.verified) {
      return '<p class="fcard__hint fcard__hint--ok">' + ui.icon('i-shield') + '<span>Confirmed by facility staff' + when + '</span></p>';
    }
    return '<p class="fcard__hint fcard__hint--info">' + ui.icon('i-info') + '<span>Reported by facility staff' + when + '. Call to confirm.</span></p>';
  }

  function cardHtml(row, res) {
    var f = row.f;
    var s = f.services || {};
    var name = esc(f.name);
    var isReported = reported(f);
    var needs = needsKey();
    var copy = state.service && CONTEXT[state.service];
    var dist = distanceText(row.km, res.fallbackTown);

    var match = '';
    if (needs && copy && copy.matchLabel) {
      match = '<div class="fcard__match' + (copy.tone === 'violet' ? ' fcard__match--violet' : '') + '">' +
        '<span class="fact__label">' + ui.icon(copy.matchIcon, 'icon--sm') + esc(copy.matchLabel) + '</span>' +
        ui.yesNo(s[needs]) + '</div>';
    }

    var facts = FACTS.map(function (item) {
      return '<div class="fact"><span class="fact__label">' + ui.icon(item.icon, 'icon--sm') + esc(item.label) + '</span>' +
        ui.yesNo(s[item.key]) + '</div>';
    }).join('') +
      '<div class="fact fact--wide"><span class="fact__label">' + ui.icon('i-bottle', 'icon--sm') + 'Donor milk</span>' +
      ui.availability(f.donorMilkAvailability) + '</div>';

    var contact = f.contactNumber
      ? '<a href="' + esc(util.telHref(f.contactNumber)) + '">' + esc(f.contactNumber) + '</a>'
      : '<span class="fcard__none">No number listed yet</span>';

    var actions = '<a class="btn btn--primary btn--sm fcard__details" href="' + esc(facilityHref(f)) + '" data-details="' + esc(f.id) + '">' +
        'View details<span class="sr-only"> for ' + name + '</span>' + ui.icon('i-arrow-right', 'icon--sm') + '</a>' +
      '<button class="btn btn--outline btn--sm fcard__mapbtn" type="button" data-show="' + esc(f.id) + '">' +
        ui.icon('i-map', 'icon--sm') + 'Show on map<span class="sr-only">: ' + name + '</span></button>' +
      (f.contactNumber
        ? '<a class="btn btn--outline btn--sm" href="' + esc(util.telHref(f.contactNumber)) + '">' +
          ui.icon('i-phone', 'icon--sm') + 'Call<span class="sr-only"> ' + name + '</span></a>'
        : '');

    return '<article class="fcard' + (state.selected === f.id ? ' is-selected' : '') + '" id="fac-' + esc(f.id) + '" aria-labelledby="fac-' + esc(f.id) + '-name">' +
      '<div class="fcard__head">' +
        '<span class="fcard__icon' + (isReported ? '' : ' fcard__icon--muted') + '">' + ui.icon('i-hospital') + '</span>' +
        '<div class="fcard__title">' +
          '<h3 class="fcard__name" id="fac-' + esc(f.id) + '-name">' + name + '</h3>' +
          '<p class="fcard__meta">' +
            '<span class="badge">' + esc(f.kindLabel || 'Health facility') + '</span>' +
            (f.municipality ? '<span class="fcard__town">' + ui.icon('i-pin', 'icon--xs') + esc(f.municipality) + '</span>' : '') +
            (dist ? '<span class="badge badge--rose">' + ui.icon('i-navigation') + esc(dist) + '</span>' : '') +
            '<span class="badge fcard__flag">' + ui.icon('i-map') + 'On the map</span>' +
          '</p>' +
        '</div>' +
      '</div>' +
      match +
      '<div class="fcard__facts">' + facts + '</div>' +
      '<div class="fcard__info">' +
        '<p class="fcard__contact">' + ui.icon('i-phone', 'icon--sm') + contact + '</p>' +
        hintHtml(f) +
      '</div>' +
      '<div class="fcard__actions">' + actions + '</div>' +
    '</article>';
  }

  function renderList(res) {
    var html = '';
    if (res.fallbackTown) {
      html += '<p class="list-note">' + ui.icon('i-info') + '<span><strong>No facility in ' + esc(res.fallbackTown) +
        ' is listed yet.</strong> These are the ' + res.rows.length + ' nearest to ' + esc(res.fallbackTown) +
        '. Distances are straight-line from the town centre.</span></p>';
    }
    if (!res.rows.length) {
      var where = state.town ? ' in ' + state.town : '';
      html += ui.emptyState('No facilities match' + where,
        'Try another name or town, or remove a filter. Facilities that have not reported their services can still help, so call to ask.',
        '<button class="btn btn--primary btn--sm" type="button" data-clear>' + ui.icon('i-refresh', 'icon--sm') + 'Clear filters</button>');
    } else {
      html += res.rows.map(function (row) { return cardHtml(row, res); }).join('');
    }
    els.list.innerHTML = html;
    els.list.setAttribute('aria-busy', 'false');
    if (els.listCol && els.listCol.scrollTop) els.listCol.scrollTop = 0; // new results start at the top
    updateFade();
  }

  /* wide screens: fade the bottom of the list while more cards are below */
  function updateFade() {
    var pane = els.listCol;
    if (!pane) return;
    var more = desktop.matches && pane.scrollHeight - pane.scrollTop - pane.clientHeight > 6;
    pane.classList.toggle('has-more', more);
  }

  function activeFilterCount() {
    return state.chips.length + (state.shared ? 1 : 0);
  }

  function syncControls() {
    if (els.search.value !== state.q) els.search.value = state.q;
    els.muni.value = state.town;
    var near = els.sort.querySelector('option[value="near"]');
    near.disabled = !state.user;
    near.textContent = state.user ? 'Nearest first' : 'Nearest first (use my location)';
    if (state.sort === 'near' && !state.user) state.sort = 'shared';
    els.sort.value = state.sort;
    chipButtons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(state.chips.indexOf(b.getAttribute('data-chip')) !== -1));
    });
    els.shared.checked = state.shared;
    var n = activeFilterCount();
    els.moreCount.hidden = !n;
    els.moreCount.textContent = String(n);
    els.more.setAttribute('aria-label', n ? 'Filters, ' + n + ' on' : 'Filters');
    els.legendYou.textContent = state.user ? 'You · selected facility' : 'Selected facility';
  }

  /* ───────────── map ───────────── */
  function mapVisible() {
    return Boolean(els.map && els.map.offsetWidth > 0 && els.map.offsetHeight > 0);
  }

  function ensureMap() {
    if (map || mapFailed) return map;
    if (!MAP || !MAP.available()) {
      mapFailed = true;
      els.map.innerHTML = MAP ? MAP.fallbackHtml() : '';
      document.body.classList.add('no-map');
      return null;
    }
    if (!mapVisible()) return null;

    map = MAP.create(els.map, {});
    layer = L.layerGroup().addTo(map);
    if ('ResizeObserver' in window) {
      var pending = false;
      new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(function () {
          pending = false;
          if (!mapVisible()) return;
          map.invalidateSize();
          if (needsFit) fitResults();
        });
      }).observe(els.map);
    }
    if (data) drawMarkers(true);
    else MAP.fitTo(map, []);
    return map;
  }

  function markerLabel(f) {
    return f.name + (reported(f) ? '' : ', services not reported');
  }

  function drawUser() {
    if (!map) return;
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (state.user) {
      userMarker = L.marker([state.user.lat, state.user.lon], {
        icon: MAP.userIcon(), keyboard: false, interactive: false, title: 'You are here', zIndexOffset: 500
      }).addTo(map);
    }
  }

  function drawMarkers(fit) {
    if (!map) { needsFit = true; return; }
    layer.clearLayers();
    markers = {};
    var fromTown = lastResult && lastResult.fallbackTown;
    rows.forEach(function (row) {
      var f = row.f;
      if (typeof f.lat !== 'number' || typeof f.lon !== 'number') return;
      var selected = f.id === state.selected;
      var m = MAP.addFacilityMarker(layer, f, {
        href: facilityHref(f),
        distance: distanceText(row.km, fromTown),
        selected: selected
      });
      if (selected) m.setZIndexOffset(1000);
      // popups open on click and on Enter (keyboard) — both select the facility
      m.on('popupopen', function () { select(f.id, { from: 'map' }); });
      markers[f.id] = m;
    });
    drawUser();
    if (fit) fitResults();
  }

  function fitResults() {
    if (!map || !mapVisible()) { needsFit = true; return; }
    var pts = rows.map(function (r) { return r.f; });
    if (state.user && !(lastResult && lastResult.fallbackTown)) pts = pts.concat([state.user]);
    MAP.fitTo(map, pts);
    needsFit = false;
  }

  function restyleMarker(id, selected) {
    var m = markers[id];
    var f = byId[id];
    if (!m || !f) return;
    var old = m.getElement();
    var hadFocus = old && document.activeElement === old;
    m.setIcon(MAP.markerIcon(f, { selected: selected }));
    m.setZIndexOffset(selected ? 1000 : 0);
    var el = m.getElement();
    if (el) {
      el.setAttribute('aria-label', markerLabel(f));
      if (hadFocus) el.focus();
    }
    if (m.isPopupOpen()) m.getPopup().update();
  }

  function select(id, opts) {
    opts = opts || {};
    var prev = state.selected;
    if (prev === id) return;
    state.selected = id;
    if (prev) {
      var pc = document.getElementById('fac-' + prev);
      if (pc) pc.classList.remove('is-selected');
      restyleMarker(prev, false);
    }
    var card = id && document.getElementById('fac-' + id);
    if (card) card.classList.add('is-selected');
    if (id) restyleMarker(id, true);

    // Picking a pin on the wide layout scrolls its card into view in the list beside the map
    if (opts.from === 'map' && card && desktop.matches) {
      var pane = els.listCol.getBoundingClientRect();
      var box = card.getBoundingClientRect();
      if (box.top < pane.top || box.bottom > pane.bottom) {
        els.listCol.scrollTo({
          top: els.listCol.scrollTop + (box.top - pane.top) - 8,
          behavior: reduceMotion.matches ? 'auto' : 'smooth'
        });
      }
    }
  }

  function showOnMap(id) {
    var f = byId[id];
    if (!f) return;
    if (!desktop.matches) setView('map', true);
    if (!ensureMap()) return;
    map.invalidateSize();
    select(id);
    map.setView([f.lat, f.lon], Math.max(map.getZoom(), 14), { animate: !reduceMotion.matches });
    needsFit = false;
    var m = markers[id];
    if (m) m.openPopup();
  }

  /* ───────────── List | Map (phones & tablets) ───────────── */
  function setView(view, scroll) {
    state.view = view === 'map' ? 'map' : 'list';
    els.results.setAttribute('data-view', state.view);
    viewButtons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === state.view));
    });
    if (state.view === 'map' || desktop.matches) {
      if (ensureMap()) {
        map.invalidateSize();
        if (needsFit) fitResults();
      }
    }
    if (scroll) {
      document.querySelector('.results-bar').scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
  }

  /* ───────────── the whole update cycle ───────────── */
  function render(fit) {
    if (!data) return;
    syncControls();
    var res = compute();
    lastResult = res;
    rows = res.rows;
    if (state.selected && !rows.some(function (r) { return r.f.id === state.selected; })) state.selected = null;
    renderBanner(res.hidden);
    renderCount(res);
    renderList(res);
    drawMarkers(fit);
  }

  function update(fit) {
    writeUrl();
    render(fit !== false);
  }

  function clearFilters() {
    state.q = ''; state.town = ''; state.chips = []; state.shared = false;
    state.sort = state.user ? 'near' : 'shared';
    update(true);
  }

  /* ───────────── "Use my location" ───────────── */
  function setLocStatus(tone, text) {
    var icon = tone === 'warn' ? 'i-alert' : tone === 'ok' ? 'i-check-circle' : 'i-locate';
    els.locStatus.className = 'loc-status' + (tone ? ' is-' + tone : '');
    els.locStatus.innerHTML = text ? ui.icon(icon, 'icon--sm') + '<span>' + esc(text) + '</span>' : '';
  }

  function locateDone() {
    els.locate.classList.remove('is-loading');
    els.locate.disabled = false;
    els.locate.removeAttribute('aria-busy');
  }

  function locate() {
    if (!('geolocation' in navigator)) {
      setLocStatus('warn', 'This browser can\'t share your location. Choose your municipality instead.');
      return;
    }
    if (window.isSecureContext === false) {
      setLocStatus('warn', 'Location only works on a secure (https) connection. Choose your municipality instead.');
      return;
    }
    els.locate.classList.add('is-loading');
    els.locate.disabled = true;
    els.locate.setAttribute('aria-busy', 'true');
    setLocStatus('', 'Finding your location…');

    navigator.geolocation.getCurrentPosition(function (pos) {
      locateDone();
      var here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (!insideAntique(here)) {
        state.user = null;
        saveLocation(null);
        if (state.sort === 'near') state.sort = 'shared';
        setLocStatus('warn', 'You seem to be outside Antique, so distances would not help. All facilities in Antique are shown. Choose a municipality to narrow them down.');
        update(true);
        return;
      }
      state.user = here;
      saveLocation(here);
      state.sort = 'near';
      setLocStatus('ok', 'Found you. The nearest facilities are shown first.');
      update(true);
    }, function (err) {
      locateDone();
      var text = err && err.code === 1
        ? 'Location is turned off for this site. Choose your municipality instead, or allow location in your browser settings.'
        : err && err.code === 3
          ? 'Finding your location took too long. Try again, or choose your municipality.'
          : 'We couldn\'t find your location. Choose your municipality instead.';
      setLocStatus('warn', text);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 });
  }

  /* ───────────── loading ───────────── */
  function skeletons() {
    return '<div class="skeleton fac-skeleton"></div><div class="skeleton fac-skeleton"></div><div class="skeleton fac-skeleton"></div>';
  }

  function fillTowns() {
    var counts = {};
    data.facilities.forEach(function (f) { counts[f.municipality] = (counts[f.municipality] || 0) + 1; });
    var towns = (data.municipalities || []).map(function (m) { return m.name; })
      .sort(function (a, b) { return a.localeCompare(b); });
    els.muni.innerHTML = '<option value="">All municipalities</option>' + towns.map(function (name) {
      var n = counts[name] || 0;
      return '<option value="' + esc(name) + '">' + esc(name) + (n ? ' (' + n + ')' : ' (none listed yet)') + '</option>';
    }).join('');
    if (state.town && towns.indexOf(state.town) === -1) state.town = '';
  }

  function restoreReturn() {
    var s = storage('sessionStorage');
    var saved = null;
    try { saved = s && JSON.parse(s.getItem(RETURN_KEY)); if (s) s.removeItem(RETURN_KEY); } catch (e) { saved = null; }
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!saved || !nav || nav.type !== 'back_forward' || saved.url !== location.pathname + location.search) return;
    if (saved.id && byId[saved.id]) select(saved.id);
    if (els.listCol) els.listCol.scrollTop = saved.list || 0;
    window.scrollTo(0, saved.y || 0);
  }

  function load() {
    els.list.setAttribute('aria-busy', 'true');
    els.list.innerHTML = skeletons();
    els.count.textContent = 'Loading facilities…';
    M.api.facilities().then(function (response) {
      data = response;
      byId = {};
      data.facilities.forEach(function (f) { byId[f.id] = f; });
      fillTowns();
      var fetchedAt = data.source && data.source.fetchedAt;
      els.creditDate.textContent = fetchedAt ? ' · updated ' + util.formatDate(fetchedAt) : '';
      update(true);
      restoreReturn();
    }).catch(function (err) {
      els.list.innerHTML = ui.errorState(err, 'Try again');
      els.list.setAttribute('aria-busy', 'false');
      els.count.textContent = 'Facilities could not be loaded';
    });
  }

  /* ───────────── events ───────────── */
  var searchTimer = null;
  els.search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.q = els.search.value.trim().slice(0, 80);
      update(true);
    }, 220);
  });
  els.controls.addEventListener('submit', function (event) {
    event.preventDefault();
    clearTimeout(searchTimer);
    state.q = els.search.value.trim().slice(0, 80);
    update(true);
    if (!desktop.matches) els.search.blur(); // put the phone keyboard away
  });
  els.muni.addEventListener('change', function () { state.town = els.muni.value; update(true); });
  els.sort.addEventListener('change', function () { state.sort = els.sort.value; update(false); });
  els.shared.addEventListener('change', function () { state.shared = els.shared.checked; update(true); });
  chipButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-chip');
      var on = state.chips.indexOf(key) !== -1;
      state.chips = CHIP_ORDER.filter(function (k) { return k === key ? !on : state.chips.indexOf(k) !== -1; });
      update(true);
    });
  });
  els.clear.addEventListener('click', clearFilters);
  /* "Filters" (in the results bar) opens the filters panel under the bar */
  function setFiltersOpen(open) {
    els.more.setAttribute('aria-expanded', String(open));
    els.controls.classList.toggle('is-open', open);
  }
  els.more.addEventListener('click', function () {
    setFiltersOpen(els.more.getAttribute('aria-expanded') !== 'true');
  });
  // Esc inside the panel closes it and returns to the button
  els.controls.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && els.controls.classList.contains('is-open')) {
      setFiltersOpen(false);
      els.more.focus();
    }
  });
  els.locate.addEventListener('click', locate);

  els.showAll.addEventListener('click', function (event) {
    event.preventDefault();
    state.service = null;
    update(true);
    els.count.setAttribute('tabindex', '-1');
    els.count.focus();
  });

  viewButtons.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view'), false); });
  });

  els.list.addEventListener('click', function (event) {
    var t = event.target;
    var show = t.closest('[data-show]');
    if (show) { showOnMap(show.getAttribute('data-show')); return; }
    if (t.closest('[data-clear]')) { clearFilters(); return; }
    if (t.closest('[data-retry]')) { load(); return; }
    var details = t.closest('[data-details]');
    if (details) {
      var s = storage('sessionStorage');
      try {
        if (s) s.setItem(RETURN_KEY, JSON.stringify({
          url: location.pathname + location.search, y: window.scrollY,
          list: els.listCol ? els.listCol.scrollTop : 0, id: details.getAttribute('data-details')
        }));
      } catch (e) { /* storage blocked */ }
    }
  });

  if (els.listCol) {
    els.listCol.addEventListener('scroll', updateFade, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(updateFade).observe(els.listCol);
  }

  function onBreakpoint() {
    if (desktop.matches) setView('list', false);
    else setView(state.view, false);
    updateFade();
  }
  if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
  else if (desktop.addListener) desktop.addListener(onBreakpoint);

  /* ───────────── start ───────────── */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  readUrl();
  state.user = loadLocation();
  if (state.user) setLocStatus('ok', 'Using the location you shared earlier.');
  syncControls();
  renderBanner(0);
  setView('list', false);
  load();
})();
