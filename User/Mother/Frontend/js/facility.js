/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Facility Information (flow step 4)
   facility.html?id=<facility id>(&service=donate|request|inquire)

   Shows everything the mother needs before she calls, visits or sends
   a form: name, address, contact number, operating hours, the
   breast-milk services (tri-state: Yes / No / Not reported), donor-milk
   availability, a small OpenStreetMap map, and the next step.
   Needs: api.js (window.MOWMMAS), Leaflet + map.js (optional — the
   page still works without the map).
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var ui = M.ui;
  var util = M.util;
  var esc = util.esc;

  var SMS_TEXT = 'Hello! I found your facility on MOWMMAS (Mothers Online With Milk Management, Access, and Support). ' +
    'I would like to ask about your breast-milk services. Thank you.';

  var els = {
    back: document.getElementById('backLink'),
    badges: document.getElementById('facBadges'),
    title: document.getElementById('pageTitle'),
    address: document.getElementById('facAddress'),
    note: document.getElementById('facNote'),
    body: document.getElementById('facBody'),
    status: document.getElementById('facStatus'),
    sticky: document.getElementById('stickyBar'),
    stickyBtn: document.getElementById('stickyBtn')
  };

  var id = (util.param('id') || '').trim();
  var service = normalizeService(util.param('service'));
  var serviceQuery = service ? '?service=' + service : '';
  var map = null;

  /* ───────────── helpers ───────────── */
  function normalizeService(value) {
    if (value === 'donation') return 'donate';
    return value && Object.prototype.hasOwnProperty.call(M.SERVICE_TYPES, value) ? value : null;
  }


  function number(n) {
    return Number(n).toLocaleString('en-PH');
  }

  function stockText(stock) {
    if (!stock || !isFinite(stock.bottles)) return '';
    var text = number(stock.bottles) + (stock.bottles === 1 ? ' bottle' : ' bottles');
    if (stock.volumeMl) text += ' · ' + number(stock.volumeMl) + ' ml';
    return text;
  }

  /* A number that can receive a text: the SMS number, or a Philippine mobile number */
  function smsTarget(f) {
    if (f.smsNumber) return f.smsNumber;
    if (f.contactNumber && util.validMobile(f.contactNumber)) return f.contactNumber;
    return null;
  }

  function announce(text) {
    els.status.textContent = text;
  }

  /* ───────────── static parts (known before loading) ───────────── */
  function renderFrame() {
    els.back.setAttribute('href', 'hospitals.html' + serviceQuery);
  }

  function renderLoading() {
    els.body.setAttribute('aria-busy', 'true');
    els.title.innerHTML = '<span class="sr-only">Loading facility details…</span>' +
      '<span class="skeleton fac-skel fac-skel--title" aria-hidden="true"></span>';
    els.badges.innerHTML = '<span class="skeleton fac-skel fac-skel--chip" aria-hidden="true"></span>' +
      '<span class="skeleton fac-skel fac-skel--chip" aria-hidden="true"></span>';
    els.address.innerHTML = '<span class="skeleton fac-skel fac-skel--line" aria-hidden="true"></span>';
    els.address.hidden = false;
    els.note.innerHTML = '';
    els.sticky.hidden = true;
    els.body.innerHTML =
      '<div class="fac-grid" aria-hidden="true">' +
        '<div class="fac-col"><div class="skeleton fac-skel fac-skel--panel"></div><div class="skeleton fac-skel fac-skel--panel-lg"></div></div>' +
        '<div class="fac-col"><div class="skeleton fac-skel fac-skel--map"></div></div>' +
      '</div>';
  }

  /* Error / not-found: compact heading + one branded state card */
  function renderProblem(stateHtml, message) {
    els.body.setAttribute('aria-busy', 'false');
    els.title.textContent = 'Facility details';
    els.badges.innerHTML = '';
    els.address.hidden = true;
    els.note.innerHTML = '';
    els.sticky.hidden = true;
    els.body.innerHTML = '<div class="fac-state">' + stateHtml + '</div>';
    document.title = 'Facility details | MOWMMAS';
    announce(message);
  }

  function renderNotFound() {
    renderProblem(ui.emptyState(
      'We couldn\'t find that facility',
      'The link may be old or incomplete. Choose a facility from the list to see its details.',
      '<a class="btn btn--primary btn--sm" href="hospitals.html' + serviceQuery + '">' +
        ui.icon('i-list', 'icon--sm') + 'See all facilities</a>'
    ), 'We couldn\'t find that facility.');
  }

  function renderError(err) {
    renderProblem(ui.errorState(err, 'Try again'), 'The facility details could not be loaded.');
    var retry = els.body.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', load);
  }

  /* ───────────── band: badges, name, address, honesty note ───────────── */
  function renderHead(f) {
    els.badges.innerHTML =
      '<span class="badge">' + ui.icon('i-hospital') + esc(f.kindLabel || 'Health facility') + '</span>' +
      (f.municipality ? '<span class="badge badge--rose">' + ui.icon('i-pin') + esc(f.municipality) + '</span>' : '');
    els.title.textContent = f.name;
    els.address.hidden = false;
    els.address.innerHTML = ui.icon('i-pin', 'icon--sm') + '<span>' + esc(f.address || (f.municipality ? f.municipality + ', Antique' : 'Antique')) + '</span>';
    els.note.innerHTML = ui.dataNote(f);
    document.title = f.name + ' | MOWMMAS';
  }

  /* What the facility says about the service the mother came for */
  function contextHtml(f) {
    if (!service || service === 'inquire') return '';
    var t = M.SERVICE_TYPES[service];
    var value = f.services ? f.services[t.needs] : null;
    var what = service === 'donate' ? 'accepts donations' : 'gives donor milk';
    if (value === true) {
      return '<p class="fac-context fac-context--yes">' + ui.icon('i-check-circle', 'icon--sm') +
        '<span>Good news: this facility ' + what + '.</span></p>';
    }
    if (value === false) {
      return '<p class="fac-context fac-context--no">' + ui.icon('i-x-circle', 'icon--sm') +
        '<span>This facility doesn\'t ' + (service === 'donate' ? 'accept donations' : 'give donor milk') + '. ' +
        '<a href="hospitals.html?service=' + service + '">Find a facility that does</a></span></p>';
    }
    return '<p class="fac-context fac-context--unknown">' + ui.icon('i-help', 'icon--sm') +
      '<span>Not confirmed if this facility ' + what + '. You can still ask.</span></p>';
  }

  /* ───────────── panels ───────────── */
  function kv(label, valueHtml) {
    return '<div class="kv"><dt class="kv__k">' + esc(label) + '</dt><dd class="kv__v">' + valueHtml + '</dd></div>';
  }

  function infoPanel(f) {
    var contact;
    if (f.contactNumber) {
      contact =
        '<span class="fac-phone">' +
          '<a class="fac-phone__num" href="' + esc(util.telHref(f.contactNumber)) + '">' + ui.icon('i-phone', 'icon--sm') + esc(f.contactNumber) + '</a>' +
          '<button class="btn btn--outline btn--sm fac-copy" type="button" data-copy="' + esc(f.contactNumber) + '">' +
            ui.icon('i-copy', 'icon--sm') + 'Copy<span class="sr-only"> contact number</span></button>' +
        '</span>';
    } else {
      contact =
        '<span class="fac-missing">' + ui.icon('i-help', 'icon--sm') + 'No number listed yet</span>' +
        '<span class="fac-hint">Visit the facility or ask at your barangay health station.</span>';
    }

    var hours = f.operatingHours
      ? esc(f.operatingHours)
      : '<span class="fac-missing">' + ui.icon('i-help', 'icon--sm') + 'Not reported yet</span>' +
        '<span class="fac-hint">Call or visit the facility to ask.</span>';

    var actions = '';
    if (f.contactNumber) {
      var sms = smsTarget(f);
      actions =
        '<div class="fac-contact">' +
          '<p class="fac-contact__title">Contact the facility</p>' +
          '<div class="fac-contact__actions">' +
            '<a class="btn btn--outline fac-contact__btn" href="' + esc(util.telHref(f.contactNumber)) + '">' +
              ui.icon('i-phone', 'icon--sm') + 'Call</a>' +
            (sms
              ? '<a class="btn btn--outline fac-contact__btn" href="' + esc(util.smsHref(sms, SMS_TEXT)) + '">' +
                  ui.icon('i-message', 'icon--sm') + 'Send SMS</a>'
              : '') +
          '</div>' +
          (sms ? '' : '<p class="fac-hint">Texting isn\'t available because this is a landline number. Please call instead.</p>') +
        '</div>';
    }

    return '<section class="panel fac-panel" aria-labelledby="infoTitle">' +
      '<div class="panel__head"><span class="panel__icon">' + ui.icon('i-hospital') + '</span>' +
        '<h2 class="panel__title" id="infoTitle">Facility information</h2></div>' +
      '<dl class="fac-kv">' +
        kv('Hospital / facility name', esc(f.name)) +
        kv('Address', esc(f.address || (f.municipality ? f.municipality + ', Antique' : 'Not reported yet'))) +
        kv('Contact number', contact) +
        kv('Operating hours', hours) +
      '</dl>' +
      actions +
    '</section>';
  }

  function servicesPanel(f) {
    var s = f.services || {};
    var reported = window.MOWMMAS_MAP ? window.MOWMMAS_MAP.hasReported(f) : Object.keys(s).some(function (k) { return s[k] !== null; });

    var facts = M.SERVICES.map(function (item) {
      return '<li class="service-fact">' +
        '<span class="service-fact__name">' + ui.icon(item.icon) + esc(item.label) + '</span>' +
        ui.yesNo(s[item.key] === undefined ? null : s[item.key]) +
      '</li>';
    }).join('');

    var stock = stockText(f.milkStock);
    var updated = f.dataStatus && f.dataStatus.updatedAt;
    var known = f.donorMilkAvailability === 'available' || f.donorMilkAvailability === 'limited' || f.donorMilkAvailability === 'none';

    var avail =
      '<div class="fac-avail">' +
        '<p class="fac-avail__label">Donor milk availability</p>' +
        '<div class="fac-avail__row">' + ui.availability(f.donorMilkAvailability) +
          (stock ? '<span class="fac-avail__stock">' + ui.icon('i-box', 'icon--sm') + esc(stock) + '</span>' : '') +
        '</div>' +
        (known && updated
          ? '<p class="fac-avail__updated">' + ui.icon('i-clock', 'icon--xs') + 'Updated ' + esc(util.timeAgo(updated)) + '</p>'
          : '<p class="fac-avail__updated">' + ui.icon('i-phone', 'icon--xs') + 'Call the facility to ask about donor milk today.</p>') +
      '</div>';

    return '<section class="panel fac-panel fac-panel--grow" aria-labelledby="svcTitle">' +
      '<div class="panel__head"><span class="panel__icon">' + ui.icon('i-droplet') + '</span>' +
        '<h2 class="panel__title" id="svcTitle">Breast-milk services</h2></div>' +
      (reported ? '' : '<p class="fac-unreported">' + ui.icon('i-info', 'icon--sm') +
        '<span><strong>Not reported yet. Call to ask.</strong> This facility hasn\'t told MOWMMAS about these services.</span></p>') +
      '<ul class="service-facts">' + facts + '</ul>' +
      avail +
    '</section>';
  }

  function locationPanel(f) {
    return '<section class="panel fac-panel fac-location" aria-labelledby="locTitle">' +
      '<div class="panel__head"><span class="panel__icon">' + ui.icon('i-map') + '</span>' +
        '<h2 class="panel__title" id="locTitle">Location</h2></div>' +
      '<div class="map fac-map" id="facMap" role="region" aria-label="Map showing ' + esc(f.name) + '"></div>' +
    '</section>';
  }

  function beforeYouGoPanel(f) {
    var reqs = (f.requirements || []).filter(Boolean);
    if (!reqs.length && !f.notes) return '';
    return '<section class="panel fac-panel" aria-labelledby="bringTitle">' +
      '<div class="panel__head"><span class="panel__icon fac-icon--violet">' + ui.icon('i-file') + '</span>' +
        '<h2 class="panel__title" id="bringTitle">' + (reqs.length ? 'What to bring' : 'Note from the facility') + '</h2></div>' +
      (reqs.length
        ? '<ul class="fac-bring">' + reqs.map(function (r) {
            return '<li>' + ui.icon('i-check', 'icon--xs') + '<span>' + esc(r) + '</span></li>';
          }).join('') + '</ul>'
        : '') +
      (f.notes
        ? '<div class="fac-notes">' + (reqs.length ? '<p class="fac-notes__label">Note from the facility</p>' : '') +
            '<p class="fac-notes__text">' + esc(f.notes) + '</p></div>'
        : '') +
    '</section>';
  }

  /* The two main actions, right at the end of the facility details:
     Donate / Request go straight to the form; a service the facility
     says it does not offer is shown, but can't be chosen. */
  function formHref(type) {
    return 'form.html?type=' + type + '&facility=' + encodeURIComponent(id);
  }

  function choiceHtml(f, type) {
    var t = M.SERVICE_TYPES[type];
    var offered = f.services ? f.services[t.needs] : null;
    var suggested = service === type ? ' is-suggested' : '';
    if (offered === false) {
      return '<div class="fac-choice is-off" aria-disabled="true">' +
        '<span class="fac-choice__icon">' + ui.icon(t.icon) + '</span>' +
        '<span class="fac-choice__text"><span class="fac-choice__label">' + esc(t.label) + '</span>' +
          '<span class="fac-choice__sub">Not offered here · <a href="hospitals.html?service=' + type + '">Find a facility that does</a></span></span>' +
      '</div>';
    }
    return '<a class="fac-choice' + suggested + '" href="' + esc(formHref(type)) + '">' +
      '<span class="fac-choice__icon">' + ui.icon(t.icon) + '</span>' +
      '<span class="fac-choice__text"><span class="fac-choice__label">' + esc(t.label) + '</span>' +
        '<span class="fac-choice__sub">' + (offered === true ? 'Offered here · fill in a short form' : 'Not confirmed yet · the facility will tell you') + '</span></span>' +
      ui.icon('i-arrow-right', 'fac-choice__go') +
    '</a>';
  }

  function chooseSection(f) {
    return '<section class="fac-choose" id="nextStep" aria-labelledby="chooseTitle">' +
      '<div class="fac-choose__copy">' +
        '<h2 class="fac-choose__title" id="chooseTitle">What would you like to do here?</h2>' +
        '<p class="fac-choose__text">Your form goes straight to the health workers of ' + esc(f.name) +
          '. They provide the service; MOWMMAS is not a milk bank.</p>' +
        contextHtml(f) +
      '</div>' +
      '<div class="fac-choose__actions">' +
        choiceHtml(f, 'donate') +
        choiceHtml(f, 'request') +
        '<a class="fac-choose__ask" href="' + esc(formHref('inquire')) + '">' + ui.icon('i-chat', 'icon--sm') +
          'Not sure yet? Ask this facility a question</a>' +
      '</div>' +
    '</section>';
  }

  /* ───────────── map ───────────── */
  function showMapFallback(el, message) {
    if (el.querySelector('.map-fallback')) return;
    el.insertAdjacentHTML('beforeend', window.MOWMMAS_MAP
      ? window.MOWMMAS_MAP.fallbackHtml(message)
      : '<div class="map-fallback" role="note">' + ui.icon('i-map') + '<p>' + esc(message) + '</p></div>');
  }

  function initMap(f) {
    var el = document.getElementById('facMap');
    if (!el) return;
    var MAP = window.MOWMMAS_MAP;
    var offline = 'The map can\'t be shown right now. Please check your connection and try again.';
    if (!MAP || !MAP.available() || !isFinite(f.lat) || !isFinite(f.lon)) {
      el.classList.add('fac-map--off');
      showMapFallback(el, offline);
      return;
    }
    try {
      if (map) { map.remove(); map = null; }
      map = MAP.create(el, { center: [f.lat, f.lon], zoom: 16, interactive: true });
      MAP.addFacilityMarker(map, f, { selected: true });

      // Tiles blocked (offline, no data) → explain instead of a grey box
      var loaded = 0, failed = 0;
      map.on('tileload', function () { loaded += 1; });
      map.on('tileerror', function () {
        failed += 1;
        if (failed >= 4 && loaded === 0) showMapFallback(el, offline);
      });
      // The container size settles after layout/fonts
      setTimeout(function () { if (map) map.invalidateSize(); }, 250);
    } catch (e) {
      el.classList.add('fac-map--off');
      showMapFallback(el, offline);
    }
  }

  /* ───────────── copy number ───────────── */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'sr-only';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function bindCopy() {
    els.body.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-copy]');
      if (!btn) return;
      var value = btn.getAttribute('data-copy');
      copyText(value).then(function () {
        ui.toast('Number copied: ' + value);
      }, function () {
        ui.toast('Couldn\'t copy. The number is ' + value, 'warn');
      });
    });
  }

  /* ───────────── page ───────────── */
  function render(data) {
    var f = data.facility;
    renderHead(f);

    els.sticky.hidden = false;

    els.body.innerHTML =
      '<div class="fac-grid">' +
        '<div class="fac-col">' + infoPanel(f) + servicesPanel(f) + '</div>' +
        '<div class="fac-col">' + locationPanel(f) + beforeYouGoPanel(f) + '</div>' +
      '</div>' +
      chooseSection(f);
    els.body.setAttribute('aria-busy', 'false');
    announce('Details for ' + f.name + ' loaded.');
    initMap(f);
  }

  function load() {
    if (!id) { renderNotFound(); return; }
    renderLoading();
    M.api.facility(id).then(function (data) {
      if (!data || !data.facility) { renderNotFound(); return; }
      render(data);
    }).catch(function (err) {
      if (err && err.status === 404) renderNotFound();
      else renderError(err);
    });
  }

  renderFrame();
  bindCopy();
  load();
})();
