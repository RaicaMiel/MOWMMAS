/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Shared OpenStreetMap (Leaflet) helpers
   Used by home.js, hospitals.js and facility.js.
   Load order: api.js → leaflet.js → map.js → page script (all defer).
   Exposes window.MOWMMAS_MAP.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var util = window.MOWMMAS && window.MOWMMAS.util;
  var esc = util ? util.esc : function (s) { return String(s); };

  var ANTIQUE_BOUNDS = [[10.35, 121.70], [11.95, 122.25]];
  var DEFAULT_CENTER = [10.7437, 121.9417]; // San Jose de Buenavista, the capital
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function available() {
    return typeof window.L !== 'undefined' && typeof window.L.map === 'function';
  }

  /* A facility "reported" if it shared at least one breast-milk service */
  function hasReported(facility) {
    var s = facility && facility.services;
    if (!s) return false;
    return Object.keys(s).some(function (k) { return s[k] !== null; });
  }

  /* Create a map inside `el`.
     options: { center, zoom, interactive (default true), fit (L.LatLngBounds | array) } */
  function create(el, options) {
    options = options || {};
    var interactive = options.interactive !== false;
    var map = L.map(el, {
      center: options.center || DEFAULT_CENTER,
      zoom: options.zoom || 9,
      minZoom: 8,
      maxZoom: 19,
      // room around the province, so a popup on a pin at the edge can still be panned fully into view
      maxBounds: L.latLngBounds(ANTIQUE_BOUNDS).pad(1.6),
      maxBoundsViscosity: 0.8,
      scrollWheelZoom: false,      // don't hijack page scrolling
      dragging: interactive,
      touchZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      zoomControl: interactive
    });

    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);

    // Wheel zoom only after the visitor chooses the map (click or keyboard focus)
    if (interactive) {
      map.on('click focus', function () { map.scrollWheelZoom.enable(); });
      map.on('mouseout blur', function () { map.scrollWheelZoom.disable(); });
    }
    return map;
  }

  var PIN_PATH = 'M16 39S3 26.6 3 17a13 13 0 1 1 26 0c0 9.6-13 22-13 22Z';

  /* Branded pin. tone: 'reported' (rose) · 'unreported' (grey) · 'selected' (violet, larger) */
  function markerIcon(facility, opts) {
    opts = opts || {};
    var tone = opts.selected ? 'selected' : hasReported(facility) ? 'reported' : 'unreported';
    var size = opts.selected ? [40, 50] : [32, 40];
    return L.divIcon({
      className: 'map-pin map-pin--' + tone,
      html: '<svg viewBox="0 0 32 40" aria-hidden="true" focusable="false">' +
              '<path d="' + PIN_PATH + '"/><circle cx="16" cy="16.5" r="5.6"/></svg>',
      iconSize: size,
      iconAnchor: [size[0] / 2, size[1] - 1],
      popupAnchor: [0, -size[1] + 6]
    });
  }

  function userIcon() {
    return L.divIcon({
      className: 'map-you',
      html: '<span class="map-you__dot"></span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#' + name + '"/></svg>';
  }

  /* A remote photo is used as is; a local one ("photos/x.jpg") is served by the API */
  function photoUrl(photo) {
    var u = photo && photo.url;
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    var base = (window.MOWMMAS && window.MOWMMAS.API_BASE) || '/api';
    return base.replace(/\/$/, '') + '/' + String(u).replace(/^\//, '');
  }

  /* "Photo: Author · CC BY-SA 4.0", linked to the photo's page and license */
  function creditHtml(photo) {
    var c = (photo && photo.credit) || {};
    var who = c.author || c.source || 'Unknown';
    var whoHtml = c.sourcePage ? '<a href="' + esc(c.sourcePage) + '" target="_blank" rel="noopener">' + esc(who) + '</a>' : esc(who);
    var lic = c.license ? (c.licenseUrl ? '<a href="' + esc(c.licenseUrl) + '" target="_blank" rel="noopener">' + esc(c.license) + '</a>' : esc(c.license)) : '';
    return '<figcaption class="pin-card__credit">Photo: ' + whoHtml + (lic ? ' · ' + lic : '') + '</figcaption>';
  }

  /* The top of the card: the facility's photo, or a plain cover when it has none */
  function mediaHtml(facility) {
    var ui = window.MOWMMAS && window.MOWMMAS.ui;
    var badge = '<span class="pin-card__badge">' + (hasReported(facility) && ui
      ? ui.availability(facility.donorMilkAvailability)
      : '<span class="avail avail--unknown">' + icon('i-help') + 'Services not reported yet</span>') + '</span>';
    var src = photoUrl(facility.photo);
    if (!src) return '<div class="pin-card__media pin-card__media--empty">' + icon('i-hospital') + '<span>No photo yet</span>' + badge + '</div>';
    return '<figure class="pin-card__media">' +
      '<img src="' + esc(src) + '" alt="Photo of ' + esc(facility.name) + '" decoding="async" referrerpolicy="no-referrer" />' +
      badge + creditHtml(facility.photo) + '</figure>';
  }

  /* Popup: a card with the facility's photo and the details of the place.
     opts.href = link for "View facility details", opts.distance = "2.4 km away" */
  function popupHtml(facility, opts) {
    opts = opts || {};
    var address = facility.address || [facility.municipality, 'Antique'].filter(Boolean).join(', ');
    var hours = facility.operatingHours;
    var phone = facility.contactNumber;
    return '<article class="pin-card">' + mediaHtml(facility) +
      '<div class="pin-card__body">' +
        '<p class="pin-card__name">' + esc(facility.name) + '</p>' +
        '<p class="pin-card__meta">' + esc(facility.kindLabel || 'Health facility') +
          (facility.municipality ? ' · ' + esc(facility.municipality) : '') +
          (opts.distance ? ' · ' + esc(opts.distance) : '') + '</p>' +
        '<ul class="pin-card__facts">' +
          '<li class="pin-card__address" title="' + esc(address) + '">' + icon('i-pin') + '<span>' + esc(address) + '</span></li>' +
          '<li' + (hours ? ' title="' + esc(hours) + '"' : ' class="is-missing"') + '>' + icon('i-clock') + '<span>' + (hours ? esc(hours) : 'No hours listed') + '</span></li>' +
          '<li' + (phone ? '' : ' class="is-missing"') + '>' + icon('i-phone') + '<span>' +
            (phone ? '<a href="tel:' + esc(String(phone).replace(/[^\d+]/g, '')) + '">' + esc(phone) + '</a>' : 'No phone listed') + '</span></li>' +
        '</ul>' +
        (opts.href ? '<a class="btn btn--primary btn--block pin-card__cta" href="' + esc(opts.href) + '">View facility details' + icon('i-arrow-right', 'icon--sm') + '</a>' : '') +
      '</div></article>';
  }

  /* If a photo can't load (offline, removed), show the plain cover instead */
  function swapPhoto(img) {
    var fig = img.closest('.pin-card__media');
    if (!fig) return;
    fig.classList.add('pin-card__media--empty');
    var credit = fig.querySelector('.pin-card__credit');
    if (credit) credit.remove();
    img.insertAdjacentHTML('afterend', icon('i-hospital') + '<span>No photo yet</span>');
    img.remove();
  }

  /* Listen on the popup itself (errors don't bubble, so capture): pages may
     redraw the popup's content after it opens, which replaces the <img>. */
  function guardPhoto(popup) {
    var root = popup && popup.getElement && popup.getElement();
    if (!root) return;
    if (!root._photoGuard) {
      root._photoGuard = true;
      root.addEventListener('error', function (e) {
        if (e.target && e.target.matches && e.target.matches('.pin-card__media img')) swapPhoto(e.target);
      }, true);
    }
    var img = root.querySelector('.pin-card__media img');
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute('src')) swapPhoto(img);
  }

  /* Add a keyboard-reachable marker: Enter/Space on the focused pin opens its popup */
  function addFacilityMarker(map, facility, opts) {
    opts = opts || {};
    var marker = L.marker([facility.lat, facility.lon], {
      icon: markerIcon(facility, opts),
      title: facility.name,
      alt: facility.name,
      keyboard: true,
      riseOnHover: true
    }).addTo(map);
    if (opts.popup !== false) {
      marker.bindPopup(popupHtml(facility, opts), {
        className: 'pin-popup',
        maxWidth: 280, minWidth: 280,
        autoPanPadding: [10, 10]
      });
      marker.on('popupopen', function (e) { guardPhoto(e.popup); });
    }
    marker.on('add', function () {
      var el = marker.getElement();
      if (el) el.setAttribute('aria-label', facility.name + (hasReported(facility) ? '' : ', services not reported'));
    });
    var el = marker.getElement();
    if (el) el.setAttribute('aria-label', facility.name + (hasReported(facility) ? '' : ', services not reported'));
    return marker;
  }

  function fitTo(map, points, maxZoom) {
    var latlngs = points.map(function (p) { return [p.lat, p.lon]; });
    if (!latlngs.length) { map.fitBounds(ANTIQUE_BOUNDS); return; }
    if (latlngs.length === 1) { map.setView(latlngs[0], maxZoom || 15); return; }
    map.fitBounds(L.latLngBounds(latlngs).pad(0.12), { maxZoom: maxZoom || 14 });
  }

  /* Friendly placeholder when Leaflet or the tiles can't load (offline) */
  function fallbackHtml(message) {
    return '<div class="map-fallback" role="note">' +
      '<svg class="icon" aria-hidden="true"><use href="#i-map"/></svg>' +
      '<p>' + esc(message || 'The map can\'t be shown right now. You can still use the list of facilities.') + '</p></div>';
  }

  window.MOWMMAS_MAP = {
    ANTIQUE_BOUNDS: ANTIQUE_BOUNDS,
    DEFAULT_CENTER: DEFAULT_CENTER,
    ATTRIBUTION: ATTRIBUTION,
    available: available,
    hasReported: hasReported,
    create: create,
    markerIcon: markerIcon,
    userIcon: userIcon,
    popupHtml: popupHtml,
    addFacilityMarker: addFacilityMarker,
    fitTo: fitTo,
    fallbackHtml: fallbackHtml
  };
})();
