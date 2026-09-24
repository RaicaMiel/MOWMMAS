/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Home (flow step 2)
   - Progress bar
   - Live numbers from the API (facilities / facilities that shared services)
   - Small OpenStreetMap preview with every facility
   - "Track a submission" list of this phone's recent submissions
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

  var els = {
    stats: document.getElementById('homeStats'),
    sentence: document.getElementById('statSentence'),
    total: document.getElementById('statTotal'),
    shared: document.getElementById('statShared'),
    map: document.getElementById('homeMap'),
    mapStatus: document.getElementById('mapStatus'),
    credit: document.getElementById('mapCredit'),
    recent: document.getElementById('recentBox')
  };

  var map = null;
  var markers = null;
  var fitPoints = [];   // what the preview is framed on
  var touched = false;  // true once the mother pans/zooms the preview herself


  /* ───────────── map preview ───────────── */
  function initMap() {
    if (!els.map) return;
    if (!MAP || !MAP.available()) {
      els.map.innerHTML = MAP
        ? MAP.fallbackHtml('The map can\'t be shown right now. Open "Hospitals Near Me" to see the list of facilities.')
        : '';
      return;
    }
    map = MAP.create(els.map, { zoom: 8 });
    // A small preview must show the whole province (it is long north–south):
    // allow one more zoom-out level and fractional zooms for a snug fit.
    map.options.zoomSnap = 0.25;
    map.setMinZoom(7);
    // On touch screens a small map inside a long page should not trap
    // scrolling: pins stay tappable, "Open full map" is there to explore.
    if (window.matchMedia('(pointer: coarse)').matches) map.dragging.disable();
    markers = L.layerGroup().addTo(map);
    MAP.fitTo(map, fitPoints);
    ['pointerdown', 'keydown', 'wheel'].forEach(function (type) {
      els.map.addEventListener(type, function () { touched = true; }, { passive: true });
    });

    // Keep Leaflet in step when the card changes size (fonts, rotation)
    if ('ResizeObserver' in window) {
      var pending = false;
      new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(function () {
          pending = false;
          map.invalidateSize();
          if (!touched) MAP.fitTo(map, fitPoints);
        });
      }).observe(els.map);
    }
  }

  function facilityHref(f) {
    return 'facility.html?id=' + encodeURIComponent(f.id);
  }

  /* ───────────── live numbers + markers ───────────── */
  function setLoading() {
    els.stats.setAttribute('aria-busy', 'true');
    els.sentence.textContent = 'Loading facility information…';
    [els.total, els.shared].forEach(function (el) {
      el.classList.add('is-loading');
      el.innerHTML = '&nbsp;';
    });
    els.mapStatus.innerHTML = '';
  }

  function render(data) {
    var facilities = (data && data.facilities) || [];
    var shared = facilities.filter(function (f) { return MAP ? MAP.hasReported(f) : false; }).length;

    els.total.classList.remove('is-loading');
    els.shared.classList.remove('is-loading');
    els.total.textContent = String(facilities.length);
    els.shared.textContent = String(shared);
    els.sentence.textContent = facilities.length + ' health facilities in Antique · ' +
      shared + ' have shared their breast-milk services';
    els.stats.setAttribute('aria-busy', 'false');

    var fetchedAt = data && data.source && data.source.fetchedAt;
    els.credit.innerHTML = 'Facility locations: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
      (fetchedAt ? ' · updated ' + esc(util.formatDate(fetchedAt)) : '');

    if (map && markers) {
      markers.clearLayers();
      facilities.forEach(function (f) {
        if (typeof f.lat !== 'number' || typeof f.lon !== 'number') return;
        MAP.addFacilityMarker(markers, f, { href: facilityHref(f) });
      });
      fitPoints = facilities.filter(function (f) { return typeof f.lat === 'number' && typeof f.lon === 'number'; });
      MAP.fitTo(map, fitPoints);
    }
  }

  function showError(err) {
    els.stats.setAttribute('aria-busy', 'false');
    [els.total, els.shared].forEach(function (el) {
      el.classList.remove('is-loading');
      el.textContent = '?';
    });
    els.sentence.textContent = 'Facility information could not be loaded.';
    els.mapStatus.innerHTML = ui.errorState(err, 'Try again');
  }

  function load() {
    setLoading();
    M.api.facilities().then(render).catch(showError);
  }

  els.mapStatus.addEventListener('click', function (event) {
    if (event.target.closest('[data-retry]')) load();
  });

  /* ───────────── this phone's recent submissions ───────────── */
  function renderRecent() {
    if (!els.recent) return;
    var list = util.recentSubmissions().filter(function (s) { return s && s.ref; }).slice(0, 3);
    if (!list.length) return; // keep the "What you need" explainer from the HTML

    // What she sent (not the reference number), then where and when
    var rows = list.map(function (s) {
      var type = M.SERVICE_TYPES[s.type] || null;
      var facility = s.facilityName || (s.facility && s.facility.name) || '';
      var when = s.createdAt || s.at || s.date || null;
      var meta = [facility, when ? util.formatDate(when) : ''].filter(Boolean).map(esc).join(' · ');
      return '<li><a class="recent-link" href="status.html?ref=' + encodeURIComponent(s.ref) + '">' +
        '<span class="recent__icon">' + ui.icon(type ? type.icon : 'i-file', 'icon--sm') + '</span>' +
        '<span class="recent__body"><span class="recent__title">' + esc(util.submissionTitle(s)) + '</span>' +
        (meta ? '<span class="recent__meta">' + meta + '</span>' : '') + '</span>' +
        ui.icon('i-chevron-right', 'icon--sm recent__chev') + '</a></li>';
    }).join('');

    els.recent.innerHTML = '<p class="track-card__label">Sent from this phone</p>' +
      '<ul class="recent-list">' + rows + '</ul>';
  }

  initMap();
  load();
  renderRecent();
  // Ones MOWMMAS no longer has come off the list (the "What you need" explainer shows if none are left)
  M.api.pruneSaved().then(function (removed) { if (removed) location.reload(); });
})();
