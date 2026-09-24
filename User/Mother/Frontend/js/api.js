/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · API client and shared helpers
   Loaded (with defer) on every flow page, before the page's own script.
   Exposes one global: window.MOWMMAS = { api, ui, util, API_BASE }
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Served by the MOWMMAS backend (http://localhost:3000) → relative URLs.
     Opened from VS Code Live Server (ports 5500/5501) or as a file → call the
     backend on port 3000 directly. */
  var viaLiveServer = location.protocol === 'file:' || location.port === '5500' || location.port === '5501';
  var API_BASE = viaLiveServer ? 'http://localhost:3000/api' : '/api';
  var ICONS = ''; // icons are embedded in each page (see the sprite at the top of <body>)

  /* ───────────── utilities ───────────── */
  var util = {
    esc: function (value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    param: function (name) {
      return new URLSearchParams(location.search).get(name);
    },

    distanceKm: function (aLat, aLon, bLat, bLon) {
      var rad = function (d) { return d * Math.PI / 180; };
      var dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
      var h = Math.pow(Math.sin(dLat / 2), 2) +
              Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.pow(Math.sin(dLon / 2), 2);
      return 12742 * Math.asin(Math.sqrt(h));
    },

    formatKm: function (km) {
      if (km == null || isNaN(km)) return '';
      return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
    },

    /* Philippine mobile numbers: 09XXXXXXXXX or +639XXXXXXXXX */
    normalizeMobile: function (value) {
      var digits = String(value || '').replace(/[^\d+]/g, '');
      if (/^\+639\d{9}$/.test(digits)) return '0' + digits.slice(3);
      if (/^639\d{9}$/.test(digits)) return '0' + digits.slice(2);
      return digits;
    },
    validMobile: function (value) {
      return /^09\d{9}$/.test(util.normalizeMobile(value));
    },
    formatMobile: function (value) {
      var m = util.normalizeMobile(value);
      return /^09\d{9}$/.test(m) ? m.slice(0, 4) + ' ' + m.slice(4, 7) + ' ' + m.slice(7) : String(value || '');
    },
    telHref: function (value) {
      return 'tel:' + String(value || '').replace(/[^\d+]/g, '');
    },
    smsHref: function (value, body) {
      return 'sms:' + String(value || '').replace(/[^\d+]/g, '') + (body ? '?body=' + encodeURIComponent(body) : '');
    },

    formatDate: function (iso, withTime) {
      if (!iso) return '';
      var d = new Date(iso);
      var opts = { year: 'numeric', month: 'short', day: 'numeric' };
      if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
      return d.toLocaleString('en-PH', opts);
    },
    timeAgo: function (iso) {
      if (!iso) return '';
      var s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + ' min ago';
      if (s < 86400) { var h = Math.floor(s / 3600); return h + ' hour' + (h === 1 ? '' : 's') + ' ago'; }
      var d = Math.floor(s / 86400);
      return d < 30 ? d + ' day' + (d === 1 ? '' : 's') + ' ago' : util.formatDate(iso);
    },

    /* The mother's own submissions, remembered on this device so she can
       track them without retyping. Wrapped in try/catch: storage can be blocked. */
    rememberSubmission: function (entry) {
      try {
        var list = util.recentSubmissions().filter(function (s) { return s.ref !== entry.ref; });
        list.unshift(entry);
        localStorage.setItem('mowmmas.submissions', JSON.stringify(list.slice(0, 10)));
      } catch (e) { /* storage unavailable */ }
    },
    recentSubmissions: function () {
      try { return JSON.parse(localStorage.getItem('mowmmas.submissions')) || []; }
      catch (e) { return []; }
    },
    forgetSubmission: function (ref) {
      try {
        var list = util.recentSubmissions().filter(function (s) { return s && s.ref !== ref; });
        localStorage.setItem('mowmmas.submissions', JSON.stringify(list));
      } catch (e) { /* storage unavailable */ }
    },

    /* What a saved submission is, in words she knows: "Donation offer", "Donor milk request", "Question" */
    submissionTitle: function (s) {
      var type = s && (s.type || { D: 'donate', R: 'request', I: 'inquire' }[String(s.ref || '').charAt(4)]);
      return { donate: 'Donation offer', request: 'Donor milk request', inquire: 'Question' }[type] || 'Submission';
    },

    /* Reference numbers as mothers type them ("mow d 2026 7", "mow-d-2026-00007")
       → "MOW-D-2026-00007". Returns null when it can't be a MOWMMAS reference. */
    normalizeRef: function (value) {
      var s = String(value || '').toUpperCase().replace(/\s+/g, '')
        .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      var m = /^MOW-?([DRI])-?(\d{4})-?(\d{1,6})$/.exec(s);
      if (!m) return null;
      var seq = m[3].length < 5 ? ('00000' + m[3]).slice(-5) : m[3];
      return 'MOW-' + m[1] + '-' + m[2] + '-' + seq;
    }
  };

  /* ───────────── API ───────────── */
  function ApiError(message, status, offline, fields) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
    this.offline = Boolean(offline);
    this.fields = fields || null; // { fieldName: 'message' } from 422 responses
  }
  ApiError.prototype = Object.create(Error.prototype);

  function request(path, options) {
    options = options || {};
    var controller = 'AbortController' in window ? new AbortController() : null;
    var timer = controller && setTimeout(function () { controller.abort(); }, 15000);
    var init = {
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(API_BASE + path, init)
      .catch(function () {
        throw new ApiError('We can\'t reach the MOWMMAS server right now.', 0, true);
      })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            // Only MOWMMAS's own messages are shown (a host's error page may carry an object instead)
            var said = data && typeof data.error === 'string' && data.error.trim() ? data.error : '';
            throw new ApiError(said || 'Something went wrong. Please try again.', res.status, false, data && data.fields);
          }
          return data;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  var api = {
    facilities: function () { return request('/facilities'); },
    facility: function (id) { return request('/facilities/' + encodeURIComponent(id)); },
    submit: function (payload) { return request('/submissions', { method: 'POST', body: payload }); },
    // Sent in the body, so her mobile number never shows in an address (hosts log addresses)
    status: function (ref, mobile) {
      return request('/submissions/track', { method: 'POST', body: { ref: ref, mobile: util.normalizeMobile(mobile) } });
    },

    /* The submissions saved on this device that MOWMMAS no longer has (e.g. removed by
       the program) are taken off the list. Checked at most every 10 minutes; a lookup
       that can't reach the server keeps the entry. Resolves with how many were removed. */
    pruneSaved: function () {
      var KEY = 'mowmmas.savedCheckedAt';
      try {
        if (Date.now() - Number(sessionStorage.getItem(KEY) || 0) < 10 * 60 * 1000) return Promise.resolve(0);
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch (e) { /* storage unavailable: check anyway */ }
      var saved = util.recentSubmissions().filter(function (s) { return s && s.ref && s.mobile; });
      // One after another (not all at once), stopping if MOWMMAS says "too many tries"
      var stop = false;
      return saved.reduce(function (done, s) {
        return done.then(function (removed) {
          if (stop) return removed;
          return api.status(s.ref, s.mobile).then(function () { return removed; }, function (err) {
            if (err && err.status === 404) { util.forgetSubmission(s.ref); return removed + 1; }
            if (err && err.status === 429) stop = true;
            return removed;
          });
        });
      }, Promise.resolve(0));
    }
  };

  /* ───────────── labels ───────────── */
  var SERVICES = [
    { key: 'milkBank',          label: 'Milk bank',           icon: 'i-droplet' },
    { key: 'milkStorage',       label: 'Milk storage',        icon: 'i-snowflake' },
    { key: 'acceptsDonations',  label: 'Accepts donations',   icon: 'i-hand-heart' },
    { key: 'providesDonorMilk', label: 'Provides donor milk', icon: 'i-bottle' },
    { key: 'lactationServices', label: 'Lactation services',  icon: 'i-heart' }
  ];

  var AVAILABILITY = {
    available: { label: 'Donor milk available',     tone: 'available', icon: 'i-check-circle' },
    limited:   { label: 'Limited donor milk',       tone: 'limited',   icon: 'i-alert' },
    none:      { label: 'No donor milk right now',  tone: 'none',      icon: 'i-minus-circle' },
    unknown:   { label: 'Availability not reported', tone: 'unknown',  icon: 'i-help' }
  };

  var SERVICE_TYPES = {
    donate:  { label: 'Donate Breast Milk',  short: 'Donation', icon: 'i-hand-heart', needs: 'acceptsDonations' },
    request: { label: 'Request Breast Milk', short: 'Request',  icon: 'i-bottle',     needs: 'providesDonorMilk' },
    inquire: { label: 'Inquire',             short: 'Inquiry',  icon: 'i-chat',       needs: null }
  };

  /* Submission statuses → pill colour + icon (the word is always shown too).
     Same status keys as User/Mother/Backend/src/statuses.js */
  var STATUS_STYLE = {
    submitted:           { tone: 'new',    icon: 'i-send' },
    under_review:        { tone: 'review', icon: 'i-clock' },
    screening_scheduled: { tone: 'action', icon: 'i-calendar' },
    accepted:            { tone: 'good',   icon: 'i-check-circle' },
    approved:            { tone: 'good',   icon: 'i-check-circle' },
    ready_for_pickup:    { tone: 'good',   icon: 'i-box' },
    answered:            { tone: 'good',   icon: 'i-chat' },
    completed:           { tone: 'good',   icon: 'i-check-circle' },
    closed:              { tone: 'closed', icon: 'i-check' },
    declined:            { tone: 'closed', icon: 'i-x-circle' }
  };


  /* ───────────── UI helpers (return HTML strings) ───────────── */
  var ui = {
    icon: function (name, cls) {
      return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="' + ICONS + '#' + name + '"/></svg>';
    },

    /* Yes / No / Not reported chip for a true | false | null value */
    yesNo: function (value) {
      if (value === true)  return '<span class="yn yn--yes">' + ui.icon('i-check-circle') + 'Yes</span>';
      if (value === false) return '<span class="yn yn--no">' + ui.icon('i-x-circle') + 'No</span>';
      return '<span class="yn yn--unknown">' + ui.icon('i-help') + 'Not reported</span>';
    },

    availability: function (value) {
      var a = AVAILABILITY[value] || AVAILABILITY.unknown;
      return '<span class="avail avail--' + a.tone + '">' + ui.icon(a.icon) + util.esc(a.label) + '</span>';
    },

    /* Status pill for a submission (css: .status-pill in app.css). size: 'lg' for headlines */
    statusPill: function (status, label, size) {
      var s = STATUS_STYLE[status] || { tone: 'new', icon: 'i-info' };
      return '<span class="status-pill status-pill--' + s.tone + (size === 'lg' ? ' status-pill--lg' : '') + '">' +
        ui.icon(s.icon) + '<span>' + util.esc(label || status) + '</span></span>';
    },


    /* Friendly error block with a retry button. The backend being off is
       the most common problem during development, so it gets its own text. */
    errorState: function (err, retryLabel) {
      var offline = err && err.offline;
      return '<div class="state state--error" role="alert">' +
        '<span class="state__icon">' + ui.icon(offline ? 'i-alert' : 'i-info') + '</span>' +
        '<h2 class="state__title">' + (offline ? 'Can\'t reach MOWMMAS right now' : 'Something went wrong') + '</h2>' +
        '<p class="state__text">' + (offline
          ? 'Check your internet connection and try again. (Developers: start the backend with <code>npm start</code> in <code>User/Mother/Backend</code>.)'
          : util.esc(err && err.message)) + '</p>' +
        '<div class="state__actions"><button class="btn btn--primary btn--sm" type="button" data-retry>' +
        ui.icon('i-refresh', 'icon--sm') + util.esc(retryLabel || 'Try again') + '</button></div></div>';
    },

    emptyState: function (title, text, actionsHtml) {
      return '<div class="state"><span class="state__icon">' + ui.icon('i-search') + '</span>' +
        '<h2 class="state__title">' + util.esc(title) + '</h2>' +
        '<p class="state__text">' + util.esc(text) + '</p>' +
        (actionsHtml ? '<div class="state__actions">' + actionsHtml + '</div>' : '') + '</div>';
    },

    /* Honesty notice for facility information that has not been confirmed */
    dataNote: function (facility) {
      var ds = facility && facility.dataStatus;
      if (!ds || !ds.hasProfile) {
        return '<p class="data-note">' + ui.icon('i-info') +
          '<span><strong>Services not reported yet.</strong> This facility has not shared its breast-milk services with MOWMMAS. Please call or visit to ask.</span></p>';
      }
      if (ds.sample) {
        return '<p class="data-note">' + ui.icon('i-alert') +
          '<span><strong>Sample information.</strong> These service details are placeholders for testing and have not been confirmed by the facility. Always call before you go.</span></p>';
      }
      if (!ds.verified) {
        return '<p class="data-note data-note--info">' + ui.icon('i-info') +
          '<span><strong>Reported by facility staff' + (ds.updatedAt ? ', ' + util.esc(util.timeAgo(ds.updatedAt)) : '') + '.</strong> Details can change, so please call to confirm.</span></p>';
      }
      return '<p class="data-note data-note--info">' + ui.icon('i-shield') +
        '<span><strong>Confirmed by facility staff' + (ds.updatedAt ? ' ' + util.esc(util.timeAgo(ds.updatedAt)) : '') + '.</strong> Stock changes quickly, so please call before you travel.</span></p>';
    },

    toast: function (message, kind) {
      var host = document.querySelector('.toast-host');
      if (!host) {
        host = document.createElement('div');
        host.className = 'toast-host';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
      }
      var node = document.createElement('div');
      node.className = 'toast' + (kind === 'warn' ? ' toast--warn' : '');
      node.innerHTML = ui.icon(kind === 'warn' ? 'i-alert' : 'i-check-circle') + '<span>' + util.esc(message) + '</span>';
      host.appendChild(node);
      setTimeout(function () { node.remove(); }, 4200);
    }
  };

  window.MOWMMAS = {
    API_BASE: API_BASE,
    api: api,
    ui: ui,
    util: util,
    SERVICES: SERVICES,
    AVAILABILITY: AVAILABILITY,
    SERVICE_TYPES: SERVICE_TYPES,
    STATUS_STYLE: STATUS_STYLE,
    ApiError: ApiError
  };
})();
