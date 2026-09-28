/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Facility Information (flow step 4)
   facility.html?id=<facility id>(&service=donate|request|inquire)

   Shows everything the mother needs before she calls, visits or sends
   a form: name, address, contact number, operating hours, about, the
   facility statuses (breastfeeding/lactation support, HMB status, milk
   storage, human milk-related information & referral), donor-milk
   availability (only a verified milk bank reports it; otherwise a link to
   request donor milk), a small OpenStreetMap map, and the next step (none
   for a facility listed for information only).
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
    return util.phones(f.contactNumber).filter(util.validMobile)[0] || null;
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

  /* ───────────── panels ───────────── */
  function kv(label, valueHtml) {
    return '<div class="kv"><dt class="kv__k">' + esc(label) + '</dt><dd class="kv__v">' + valueHtml + '</dd></div>';
  }

  function infoPanel(f) {
    var contact;
    if (f.contactNumber) {
      // Each number with its own call link and Copy button
      contact = util.phones(f.contactNumber).map(function (p) {
        return '<span class="fac-phone">' +
          '<a class="fac-phone__num" href="' + esc(util.telHref(p)) + '">' + ui.icon('i-phone', 'icon--sm') + esc(p) + '</a>' +
          '<button class="btn btn--outline btn--sm fac-copy" type="button" data-copy="' + esc(p) + '">' +
            ui.icon('i-copy', 'icon--sm') + 'Copy<span class="sr-only"> ' + esc(p) + '</span></button>' +
        '</span>';
      }).join('') || esc(f.contactNumber);
    } else {
      contact =
        '<span class="fac-missing">' + ui.icon('i-help', 'icon--sm') + 'Not Verified</span>' +
        '<span class="fac-hint">Visit the facility or ask at your barangay health station.</span>';
    }

    var hours = f.operatingHours
      ? esc(f.operatingHours)
      : '<span class="fac-missing">' + ui.icon('i-help', 'icon--sm') + 'Not Verified</span>' +
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
        kv('Type', esc(f.kindLabel || 'Health facility')) +
        kv('Address', esc(f.address || (f.municipality ? f.municipality + ', Antique' : 'Antique'))) +
        kv('Contact number', contact) +
        kv('Operating hours', hours) +
        (f.about ? kv('About', esc(f.about)) : '') +
      '</dl>' +
      actions +
    '</section>';
  }

  function servicesPanel(f) {
    var facts = M.facilityStatuses(f, { withStorage: true }).map(function (st) {
      return '<li class="service-fact">' +
        '<span class="service-fact__name">' + ui.icon(st.icon) + esc(st.label) + '</span>' +
        ui.statusChip(st) +
      '</li>';
    }).join('');

    // Donor milk availability only for a verified milk bank ("Availability not reported"
    // until it reports it); anywhere else the mother can send a request and a health
    // worker refers her
    var stock = stockText(f.milkStock);
    var updated = f.dataStatus && f.dataStatus.updatedAt;
    var known = f.donorMilkAvailability === 'available' || f.donorMilkAvailability === 'limited' || f.donorMilkAvailability === 'none';
    var avail;
    if (M.isVerifiedHmb(f)) {
      avail = '<div class="fac-avail">' +
          '<p class="fac-avail__label">Donor milk availability</p>' +
          '<div class="fac-avail__row">' + ui.availability(f.donorMilkAvailability) +
            (stock ? '<span class="fac-avail__stock">' + ui.icon('i-box', 'icon--sm') + esc(stock) + '</span>' : '') +
          '</div>' +
          (known && updated
            ? '<p class="fac-avail__updated">' + ui.icon('i-clock', 'icon--xs') + 'Updated ' + esc(util.timeAgo(updated)) + '</p>'
            : '') +
          '<p class="fac-avail__updated">' + ui.icon('i-phone', 'icon--xs') + 'Call the facility to confirm before you go.</p>' +
        '</div>';
    } else {
      var requestHref = f.infoOnly ? 'hospitals.html?service=request' : formHref('request');
      avail = '<div class="fac-avail">' +
          '<p class="fac-avail__label">Donor milk</p>' +
          '<div class="fac-avail__row">' + ui.statusChip({ text: 'Not available locally', tone: 'no' }) + '</div>' +
          '<p class="fac-avail__updated">' + ui.icon('i-send', 'icon--xs') +
            '<span>Need donor milk? <a href="' + esc(requestHref) + '">Submit a request</a> to ask about referral options.</span></p>' +
        '</div>';
    }

    return '<section class="panel fac-panel fac-panel--grow" aria-labelledby="svcTitle">' +
      '<div class="panel__head"><span class="panel__icon">' + ui.icon('i-droplet') + '</span>' +
        '<h2 class="panel__title" id="svcTitle">Breast-milk services</h2></div>' +
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
     Donate / Request go straight to the form. A health worker reviews it
     and gives next steps or a referral, so neither is ever blocked here. */
  function formHref(type) {
    return 'form.html?type=' + type + '&facility=' + encodeURIComponent(id);
  }

  var CHOICE_SUB = {
    donate: 'Submit a donation inquiry. A health worker will review your information and provide the appropriate next steps.',
    request: 'Submit a request for donor milk. A health worker will review your request and provide referral or next-step information.'
  };

  function choiceHtml(type) {
    var t = M.SERVICE_TYPES[type];
    var suggested = service === type ? ' is-suggested' : '';
    return '<a class="fac-choice' + suggested + '" href="' + esc(formHref(type)) + '">' +
      '<span class="fac-choice__icon">' + ui.icon(t.icon) + '</span>' +
      '<span class="fac-choice__text"><span class="fac-choice__label">' + esc(t.label) + '</span>' +
        '<span class="fac-choice__sub">' + esc(CHOICE_SUB[type]) + '</span></span>' +
      ui.icon('i-arrow-right', 'fac-choice__go') +
    '</a>';
  }

  function chooseSection(f) {
    if (f.infoOnly) {
      return '<section class="fac-choose" id="nextStep" aria-labelledby="chooseTitle">' +
        '<div class="fac-choose__copy">' +
          '<h2 class="fac-choose__title" id="chooseTitle">For information only</h2>' +
          '<p class="fac-choose__text">MOWMMAS lists ' + esc(f.name) + ' for information only, so it can\'t receive forms here. ' +
            'Please contact the facility directly, or choose another facility.</p>' +
        '</div>' +
        '<div class="fac-choose__actions">' +
          '<a class="fac-choose__ask" href="hospitals.html' + serviceQuery + '">' + ui.icon('i-list', 'icon--sm') + 'See other facilities</a>' +
        '</div>' +
      '</section>';
    }
    return '<section class="fac-choose" id="nextStep" aria-labelledby="chooseTitle">' +
      '<div class="fac-choose__copy">' +
        '<h2 class="fac-choose__title" id="chooseTitle">What would you like to do here?</h2>' +
        '<p class="fac-choose__text">Your form goes to the health workers of the selected facility. ' +
          'They will review your inquiry and provide the appropriate information or referral. ' +
          '<strong>MOWMMAS is not a milk bank.</strong></p>' +
      '</div>' +
      '<div class="fac-choose__actions">' +
        choiceHtml('donate') +
        choiceHtml('request') +
        '<a class="fac-choose__ask" href="' + esc(formHref('inquire')) + '">' + ui.icon('i-chat', 'icon--sm') +
          'Not sure yet? Ask About a Service</a>' +
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

    els.sticky.hidden = Boolean(f.infoOnly);   // no forms to go to

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
