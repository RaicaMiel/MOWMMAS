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

  /* The top of the card: the facility's photo, when it has one */
  function mediaHtml(facility) {
    var src = photoUrl(facility.photo);
    if (!src) return '';
    return '<figure class="pin-card__media">' +
      '<img src="' + esc(src) + '" alt="Photo of ' + esc(facility.name) + '" decoding="async" referrerpolicy="no-referrer" />' +
      creditHtml(facility.photo) + '</figure>';
  }

  /* The facility's three statuses (api.js facilityStatuses), one line each */
  function statusesHtml(facility) {
    var M = window.MOWMMAS;
    if (!M || !M.facilityStatuses) return '';
    return '<ul class="pin-card__status">' + M.facilityStatuses(facility).map(function (st) {
      return '<li><span class="pin-card__status-label">' + icon(st.icon) + '<span>' + esc(st.label) + '</span></span>' + M.ui.statusChip(st) + '</li>';
    }).join('') + '</ul>';
  }

  /* Popup: a card with the facility's photo (if any) and the details of the place.
     opts.href = link for "View Details" (with it comes "Ask About a Service", unless the
     facility is listed for information only), opts.distance = "2.4 km away" */
  function popupHtml(facility, opts) {
    opts = opts || {};
    var ui = window.MOWMMAS && window.MOWMMAS.ui;
    var address = facility.address || [facility.municipality, 'Antique'].filter(Boolean).join(', ');
    var hours = facility.operatingHours;
    var phone = facility.contactNumber;
    var ask = opts.href && !facility.infoOnly ? 'form.html?type=inquire&facility=' + encodeURIComponent(facility.id) : '';
    return '<article class="pin-card">' + mediaHtml(facility) +
      '<div class="pin-card__body">' +
        '<p class="pin-card__name">' + esc(facility.name) + '</p>' +
        '<p class="pin-card__meta">' + esc(facility.kindLabel || 'Health facility') +
          (facility.municipality ? ' · ' + esc(facility.municipality) : '') +
          (opts.distance ? ' · ' + esc(opts.distance) : '') + '</p>' +
        '<ul class="pin-card__facts">' +
          '<li>' + icon('i-pin') + '<span>' + esc(address) + '</span></li>' +
          '<li' + (phone ? '' : ' class="is-missing"') + '>' + icon('i-phone') + '<span>' +
            (phone ? (ui ? ui.phoneLinks(phone) : esc(phone)) : 'Not Verified') + '</span></li>' +
          '<li' + (hours ? '' : ' class="is-missing"') + '>' + icon('i-clock') + '<span>' + (hours ? esc(hours) : 'Operating Hours: Not Verified') + '</span></li>' +
        '</ul>' +
        statusesHtml(facility) +
        (opts.href
          ? '<div class="pin-card__actions">' +
              '<a class="btn btn--primary btn--block pin-card__cta" href="' + esc(opts.href) + '">View Details' + icon('i-arrow-right', 'icon--sm') + '</a>' +
              (ask ? '<a class="btn btn--outline btn--block pin-card__ask" href="' + esc(ask) + '">' + icon('i-chat', 'icon--sm') + 'Ask About a Service</a>' : '') +
            '</div>'
          : '') +
      '</div></article>';
  }

  /* If a photo can't load (offline, removed), the card goes on without it */
  function swapPhoto(img) {
    var fig = img.closest('.pin-card__media');
    if (fig) fig.remove();
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
        // the left side keeps clear of the zoom buttons
        autoPanPaddingTopLeft: [56, 10],
        autoPanPaddingBottomRight: [10, 10]
      });
      marker.on('popupopen', function (e) { guardPhoto(e.popup); });
    }
    marker.on('add', function () {
      var el = marker.getElement();
      if (el) el.setAttribute('aria-label', facility.name + (hasReported(facility) ? '' : ', services not verified yet'));
    });
    var el = marker.getElement();
    if (el) el.setAttribute('aria-label', facility.name + (hasReported(facility) ? '' : ', services not verified yet'));
    return marker;
  }

  /* options.animate false: jump there at once. Leaflet starts a zoom animation on the next
     frame, so a view set right after an animated fit would be undone by it. */
  function fitTo(map, points, maxZoom, options) {
    var still = options && options.animate === false ? { animate: false } : {};
    var latlngs = points.map(function (p) { return [p.lat, p.lon]; });
    if (!latlngs.length) { map.fitBounds(ANTIQUE_BOUNDS, still); return; }
    if (latlngs.length === 1) { map.setView(latlngs[0], maxZoom || 15, still); return; }
    map.fitBounds(L.latLngBounds(latlngs).pad(0.12), Object.assign({ maxZoom: maxZoom || 14 }, still));
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
