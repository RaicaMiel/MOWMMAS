/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Choose a Service (flow step 5)
   service.html?facility=<facility id>(&service=donate|request|inquire)

   Three big choices for the chosen facility — Donate Breast Milk,
   Request Breast Milk, Inquire — each with an honest status line taken
   from the facility's data (Yes / Not confirmed / No). A service the
   facility says it does NOT offer is shown disabled with a link to
   facilities that do. The choice the mother came with (?service=) is
   highlighted and receives focus.
   Needs: api.js (window.MOWMMAS).
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var ui = M.ui;
  var util = M.util;
  var esc = util.esc;

  var CARDS = [
    {
      type: 'donate', tone: 'rose', icon: 'i-hand-heart',
      title: 'Donate Breast Milk',
      text: 'Have extra breast milk? Offer it to this facility. Its health workers will guide you through screening and drop-off.',
      go: 'Start donation form',
      yes: 'This facility accepts donations',
      no: 'This facility doesn\'t accept donations'
    },
    {
      type: 'request', tone: 'violet', icon: 'i-bottle',
      title: 'Request Breast Milk',
      text: 'Need donor milk for your baby? Send a request. A health worker will review it and tell you the next steps.',
      go: 'Start request form',
      yes: 'This facility gives donor milk',
      no: 'This facility doesn\'t give donor milk'
    },
    {
      type: 'inquire', tone: 'mint', icon: 'i-chat',
      title: 'Inquire',
      text: 'Have a question? Ask about services, requirements, or whether donor milk is available right now.',
      go: 'Ask a question',
      yes: 'You can ask any facility'
    }
  ];

  var els = {
    back: document.getElementById('backLink'),
    backLabel: document.getElementById('backLabel'),
    lede: document.getElementById('facLede'),
    summary: document.getElementById('facSummary'),
    body: document.getElementById('svcBody'),
    status: document.getElementById('svcStatus')
  };

  var id = (util.param('facility') || '').trim();
  var service = normalizeService(util.param('service'));
  var serviceQuery = service ? '?service=' + service : '';

  /* ───────────── helpers ───────────── */
  function normalizeService(value) {
    if (value === 'donation') return 'donate';
    return value && Object.prototype.hasOwnProperty.call(M.SERVICE_TYPES, value) ? value : null;
  }

  function facilityHref() {
    return 'facility.html?id=' + encodeURIComponent(id) + (service ? '&service=' + service : '');
  }

  function formHref(type) {
    return 'form.html?type=' + type + '&facility=' + encodeURIComponent(id);
  }

  function announce(text) {
    els.status.textContent = text;
  }

  /* ───────────── static parts ───────────── */
  function renderFrame() {
    if (id) {
      els.back.setAttribute('href', facilityHref());
      els.backLabel.textContent = 'Back to facility details';
    } else {
      els.back.setAttribute('href', 'hospitals.html' + serviceQuery);
      els.backLabel.textContent = 'Back to Hospitals Near Me';
    }
  }

  function renderLoading() {
    els.body.setAttribute('aria-busy', 'true');
    els.lede.hidden = false;
    els.lede.innerHTML = '<span class="skeleton svc-skel svc-skel--line" aria-hidden="true"></span><span class="sr-only">Loading facility…</span>';
    els.summary.hidden = false;
    els.summary.innerHTML = '<div class="skeleton svc-skel svc-skel--summary" aria-hidden="true"></div>';
    els.body.innerHTML = '<div class="svc-grid" aria-hidden="true">' +
      '<div class="skeleton svc-skel svc-skel--card"></div>' +
      '<div class="skeleton svc-skel svc-skel--card"></div>' +
      '<div class="skeleton svc-skel svc-skel--card"></div></div>';
  }

  function renderProblem(stateHtml, message) {
    els.body.setAttribute('aria-busy', 'false');
    els.lede.hidden = true;
    els.summary.hidden = true;
    els.summary.innerHTML = '';
    els.body.innerHTML = '<div class="svc-state">' + stateHtml + '</div>';
    announce(message);
  }

  function renderNoFacility() {
    // No valid facility → the way back is the facility list, not a broken details link
    els.back.setAttribute('href', 'hospitals.html' + serviceQuery);
    els.backLabel.textContent = 'Back to Hospitals Near Me';
    renderProblem(ui.emptyState(
      'We couldn\'t find that facility',
      'Choose a health facility first. Then you can donate, request milk, or ask a question there.',
      '<a class="btn btn--primary btn--sm" href="hospitals.html' + serviceQuery + '">' +
        ui.icon('i-pin', 'icon--sm') + 'Find a facility</a>'
    ), 'We couldn\'t find that facility.');
  }

  function renderError(err) {
    renderProblem(ui.errorState(err, 'Try again'), 'The facility could not be loaded.');
    var retry = els.body.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', load);
  }

  /* ───────────── band: lede + facility summary ───────────── */
  function renderHead(f) {
    els.lede.hidden = false;
    els.lede.innerHTML = 'at <strong>' + esc(f.name) + '</strong>';
    document.title = 'Choose a service · ' + f.name + ' | MOWMMAS';

    var ds = f.dataStatus || {};
    var honesty = '';
    if (!ds.hasProfile) {
      honesty = '<p class="svc-fac__note">' + ui.icon('i-info', 'icon--xs') + 'Services not reported yet. The facility will tell you.</p>';
    } else if (ds.sample) {
      honesty = '<p class="svc-fac__note">' + ui.icon('i-alert', 'icon--xs') + 'Sample information. Please call to confirm.</p>';
    }

    var contact = f.contactNumber
      ? '<a href="' + esc(util.telHref(f.contactNumber)) + '">' + esc(f.contactNumber) + '</a>'
      : '<span class="svc-fac__missing">No number listed yet</span>';

    els.summary.hidden = false;
    els.summary.innerHTML =
      '<aside class="svc-fac" aria-labelledby="facSumLabel">' +
        '<div class="svc-fac__top">' +
          '<span class="svc-fac__icon">' + ui.icon('i-hospital') + '</span>' +
          '<div class="svc-fac__info">' +
            '<p class="svc-fac__label" id="facSumLabel">Your chosen facility</p>' +
            '<p class="svc-fac__name">' + esc(f.name) + '</p>' +
          '</div>' +
        '</div>' +
        '<ul class="svc-fac__meta">' +
          '<li>' + ui.icon('i-pin', 'icon--sm') + '<span>' + esc(f.municipality || 'Antique') +
            (f.kindLabel ? ' · ' + esc(f.kindLabel) : '') + '</span></li>' +
          '<li>' + ui.icon('i-phone', 'icon--sm') + '<span>' + contact + '</span></li>' +
        '</ul>' +
        honesty +
        '<a class="btn btn--outline btn--sm svc-fac__change" href="hospitals.html' + serviceQuery + '">' +
          ui.icon('i-refresh', 'icon--sm') + 'Choose a different facility</a>' +
      '</aside>';
  }

  /* ───────────── option cards ───────────── */
  function statusFor(card, f) {
    if (card.type === 'inquire') return true;
    var key = M.SERVICE_TYPES[card.type].needs;
    var value = f.services ? f.services[key] : null;
    return value === true || value === false ? value : null;
  }

  function cardHtml(card, f) {
    var state = statusFor(card, f);
    var disabled = state === false;
    var suggested = service === card.type;
    var classes = 'service service--' + card.tone + ' svc-card' +
      (disabled ? ' is-disabled' : '') + (suggested ? ' is-suggested' : '');

    var badge = suggested
      ? '<span class="svc-card__badge">' + ui.icon(disabled ? 'i-info' : 'i-heart', 'icon--xs') +
          (disabled ? 'You picked this' : 'Suggested for you') + '</span>'
      : '';

    var status;
    if (state === true) {
      status = '<p class="svc-status svc-status--yes">' + ui.icon('i-check-circle', 'icon--sm') + '<span>' + esc(card.yes) + '</span></p>';
    } else if (state === false) {
      status = '<p class="svc-status svc-status--no">' + ui.icon('i-x-circle', 'icon--sm') + '<span>' + esc(card.no) + '</span></p>';
    } else {
      status = '<p class="svc-status svc-status--unknown">' + ui.icon('i-help', 'icon--sm') + '<span>Not confirmed yet. The facility will tell you.</span></p>';
    }
    // Requests also show today's reported donor-milk availability, when known
    if (card.type === 'request' && state !== false && f.donorMilkAvailability) {
      status += '<p class="svc-card__avail">' + ui.availability(f.donorMilkAvailability) + '</p>';
    }

    var action = disabled
      ? '<a class="svc-card__alt" href="hospitals.html?service=' + card.type + '">Find a facility that does' +
          ui.icon('i-arrow-right', 'icon--sm') + '</a>'
      : '<a class="service__link svc-card__go" href="' + esc(formHref(card.type)) + '">' + esc(card.go) +
          ui.icon('i-arrow-right', 'icon--sm') + '</a>';

    return '<article class="' + classes + '" data-type="' + card.type + '"' +
        (disabled ? ' aria-disabled="true"' : '') + ' aria-labelledby="card-' + card.type + '">' +
      badge +
      '<span class="service__icon">' + ui.icon(card.icon) + '</span>' +
      '<h2 class="service__title" id="card-' + card.type + '">' + esc(card.title) + '</h2>' +
      '<p class="service__text">' + esc(card.text) + '</p>' +
      '<div class="svc-card__status">' + status + '</div>' +
      action +
    '</article>';
  }

  function nextHtml(f) {
    return '<section class="svc-next" aria-labelledby="nextTitle">' +
      '<h2 class="svc-next__title" id="nextTitle">What happens after you choose</h2>' +
      '<ol class="svc-steps">' +
        '<li class="svc-step"><span class="svc-step__num">1</span><span class="svc-step__body">' +
          '<strong>Fill in a short form</strong><span>Your name, mobile number and a few details.</span></span></li>' +
        '<li class="svc-step"><span class="svc-step__num">2</span><span class="svc-step__body">' +
          '<strong>A health worker reviews it</strong><span>At ' + esc(f.name) + '.</span></span></li>' +
        '<li class="svc-step"><span class="svc-step__num">3</span><span class="svc-step__body">' +
          '<strong>You get updates</strong><span>Check anytime on <a href="status.html">Track Submission</a> with your reference number.</span></span></li>' +
      '</ol>' +
      '<p class="svc-foot">' + ui.icon('i-shield', 'icon--sm') +
        '<span>MOWMMAS sends your form to the facility\'s health workers. The facility provides the actual service. <strong>MOWMMAS is not a milk bank.</strong></span></p>' +
    '</section>';
  }

  function focusSuggested() {
    if (!service) return;
    var card = els.body.querySelector('.svc-card.is-suggested');
    if (!card) return;
    var target = card.querySelector('.svc-card__go, .svc-card__alt');
    if (!target) return;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    var box = card.getBoundingClientRect();
    if (box.bottom > window.innerHeight || box.top < 0) {
      card.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ───────────── page ───────────── */
  function render(data) {
    var f = data.facility;
    renderHead(f);
    els.body.innerHTML =
      '<div class="svc-grid">' + CARDS.map(function (c) { return cardHtml(c, f); }).join('') + '</div>' +
      nextHtml(f);
    els.body.setAttribute('aria-busy', 'false');
    announce('Services at ' + f.name + ' loaded. Choose Donate, Request, or Inquire.');
    focusSuggested();
  }

  function load() {
    if (!id) { renderNoFacility(); return; }
    renderLoading();
    M.api.facility(id).then(function (data) {
      if (!data || !data.facility) { renderNoFacility(); return; }
      render(data);
    }).catch(function (err) {
      if (err && err.status === 404) renderNoFacility();
      else renderError(err);
    });
  }

  renderFrame();
  load();
})();
