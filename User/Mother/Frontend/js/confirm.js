/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Submission confirmation (confirm.html?ref=…)
   Flow step 7 of the MOWMMAS journey.

   - Success message for the type of submission (from the reference letter)
   - Reference number, large, with a Copy button
   - When this device remembers the mobile number used for the reference,
     the current status is loaded with MOWMMAS.api.status(); otherwise the
     page points the mother to Track Submission
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var api = M.api, ui = M.ui, util = M.util, esc = util.esc;

  function $(id) { return document.getElementById(id); }

  var TYPES = {
    donate: {
      title: 'Your donation offer has been submitted.', eyebrow: 'Donation offer sent', noun: 'donation offer',
      label: 'Donation offer', icon: 'i-hand-heart', example: 'Screening scheduled',
      note: 'The facility does all screening, collection and sharing of breast milk. MOWMMAS only passes your details on and keeps you updated.'
    },
    request: {
      title: 'Your request has been submitted.', eyebrow: 'Request sent', noun: 'request',
      label: 'Donor milk request', icon: 'i-bottle', example: 'Approved',
      note: 'The facility decides on every request and gives out the milk. MOWMMAS only passes your details on and keeps you updated.'
    },
    inquire: {
      title: 'Your question has been submitted.', eyebrow: 'Question sent', noun: 'question',
      label: 'Question', icon: 'i-chat', example: 'Answered',
      note: 'The facility\'s health workers answer your question. MOWMMAS only passes it on and keeps you updated.'
    }
  };
  var LETTER = { D: 'donate', R: 'request', I: 'inquire' };

  var ref = util.normalizeRef(util.param('ref'));
  var mine = ref ? util.recentSubmissions().filter(function (s) { return s && s.ref === ref; })[0] || null : null;
  var typeKey = ref ? LETTER[ref.charAt(4)] : null;
  var T = TYPES[typeKey] || null;

  var els = {
    eyebrow: $('cfEyebrow'), title: $('pageTitle'), lede: $('pageLede'),
    refNum: $('refNum'), copyBtn: $('copyBtn'), copyLabel: $('copyLabel'),
    status: $('statusBody'), steps: $('nextSteps'), note: $('cfNote'), track: $('trackBtn'),
    hero: $('cfHero'), body: $('cfBody'), missing: $('cfMissing')
  };


  /* ───────────── no (valid) reference in the link ───────────── */
  function showMissing() {
    document.title = 'Reference number missing | MOWMMAS';
    els.eyebrow.textContent = 'Submission';
    els.title.textContent = 'We couldn\'t find your reference number';
    els.lede.textContent = 'This page shows the confirmation for a form you sent. The link seems to be missing its reference number.';
    $('cfMark').classList.add('cf-mark--muted');
    $('cfMark').innerHTML = ui.icon('i-help');
    $('refCard').hidden = true;
    els.hero.classList.add('is-single');
    els.body.hidden = true;
    els.missing.hidden = false;
    els.missing.innerHTML = '<div class="state cf-state">' +
      '<span class="state__icon">' + ui.icon('i-search') + '</span>' +
      '<h2 class="state__title">Look up your submission instead</h2>' +
      '<p class="state__text">Enter your reference number (it starts with MOW-) and your mobile number on the tracking page.</p>' +
      '<div class="state__actions">' +
        '<a class="btn btn--primary" href="status.html">' + ui.icon('i-search', 'icon--sm') + 'Track a submission</a>' +
        '<a class="btn btn--outline" href="home.html">' + ui.icon('i-home', 'icon--sm') + 'Back to Home</a>' +
      '</div></div>';
  }

  /* ───────────── copy the reference number ───────────── */
  function copyFallback(value) {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }

  function copied(ok) {
    if (ok) {
      els.copyLabel.textContent = 'Copied';
      els.copyBtn.classList.add('is-copied');
      ui.toast('Reference number copied.');
      setTimeout(function () { els.copyLabel.textContent = 'Copy'; els.copyBtn.classList.remove('is-copied'); }, 2500);
    } else {
      ui.toast('Couldn\'t copy. Please write the number down: ' + ref, 'warn');
    }
  }

  els.copyBtn.addEventListener('click', function () {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(ref).then(function () { copied(true); }, function () { copied(copyFallback(ref)); });
    } else {
      copied(copyFallback(ref));
    }
  });

  /* ───────────── what happens next ───────────── */
  function renderSteps(facilityName, mobile) {
    var who = facilityName ? 'The health workers of ' + esc(facilityName) : 'The facility\'s health workers';
    var sms = mobile
      ? 'You receive an SMS on <strong>' + esc(util.formatMobile(mobile)) + '</strong>.'
      : 'You receive an SMS on the mobile number you gave.';
    els.steps.innerHTML =
      '<li class="cf-step"><span class="cf-step__num" aria-hidden="true">1</span><div>' +
        '<p class="cf-step__title">They review it</p>' +
        '<p class="cf-step__text">' + who + ' look at your ' + esc(T.noun) + '.</p></div></li>' +
      '<li class="cf-step"><span class="cf-step__num" aria-hidden="true">2</span><div>' +
        '<p class="cf-step__title">They update your status</p>' +
        '<p class="cf-step__text">For example to “' + esc(T.example) + '”, with a short note.</p></div></li>' +
      '<li class="cf-step"><span class="cf-step__num" aria-hidden="true">3</span><div>' +
        '<p class="cf-step__title">You get a message</p>' +
        '<p class="cf-step__text">' + sms + ' You can also <a href="status.html?ref=' + encodeURIComponent(ref) + '">check here anytime</a>.</p></div></li>';
  }

  /* ───────────── status panel ───────────── */
  function kv(label, valueHtml) {
    return '<div class="kv"><p class="kv__k">' + esc(label) + '</p><div class="kv__v">' + valueHtml + '</div></div>';
  }

  function phoneHtml(number) {
    return number
      ? '<a class="cf-phone" href="' + esc(util.telHref(number)) + '">' + ui.icon('i-phone', 'icon--sm') + esc(number) + '</a>'
      : '<span class="muted">No number listed yet. The health workers will contact you by SMS.</span>';
  }

  function renderStatus(view) {
    var f = view.facility || {};
    var meaning = view.status === 'submitted'
      ? 'Waiting for a health worker to review it.'
      : 'Updated ' + esc(util.timeAgo(view.updatedAt)) + '. See every update on the tracking page.';
    els.status.innerHTML =
      '<div class="cf-now">' + ui.statusPill(view.status, view.statusLabel, 'lg') +
        '<p class="cf-now__text">' + meaning + '</p></div>' +
      '<div class="cf-kv">' +
        kv('Submitted', '<time datetime="' + esc(view.createdAt) + '">' + esc(util.formatDate(view.createdAt, true)) + '</time>') +
        kv('Facility', '<strong>' + esc(f.name || (mine && mine.facilityName) || '') + '</strong>' +
          (f.municipality ? '<span class="cf-sub">' + esc(f.municipality) + ', Antique</span>' : '')) +
        kv('Contact number', phoneHtml(f.contactNumber)) +
        kv('Type', esc(T.label)) +
      '</div>';
    els.status.setAttribute('aria-busy', 'false');
  }

  /* This device doesn't know the mobile number for this reference */
  function renderPrompt(extraNote) {
    els.status.innerHTML =
      '<div class="cf-kv">' +
        kv('Reference', '<strong class="cf-mono">' + esc(ref) + '</strong>') +
        kv('Type', esc(T.label)) +
        (mine && mine.facilityName ? kv('Facility', '<strong>' + esc(mine.facilityName) + '</strong>') : '') +
      '</div>' +
      '<div class="cf-prompt">' + ui.icon('i-search', 'icon--sm') +
        '<div><p class="cf-prompt__title">Track your submission</p>' +
        '<p class="cf-prompt__text">' + esc(extraNote || 'To see the latest status, enter this reference number and the mobile number you used on the tracking page.') + '</p>' +
        '<a class="cf-prompt__link" href="status.html?ref=' + encodeURIComponent(ref) + '">Open Track Submission' + ui.icon('i-arrow-right', 'icon--xs') + '</a></div></div>';
    els.status.setAttribute('aria-busy', 'false');
  }

  function loadStatus() {
    els.status.setAttribute('aria-busy', 'true');
    els.status.innerHTML = '<div class="skeleton cf-skel" aria-hidden="true"></div><p class="sr-only">Loading the status…</p>';
    api.status(ref, mine.mobile).then(function (view) {
      renderStatus(view);
      renderSteps(view.facility && view.facility.name, mine.mobile);
      if (view.contactName) els.lede.textContent = 'Thank you, ' + view.contactName + '. ' + ledeFor(view.facility && view.facility.name);
    }).catch(function (err) {
      if (err && err.status === 404) {
        renderPrompt('We couldn\'t load the status right now. You can still look it up on the tracking page with your mobile number.');
        return;
      }
      els.status.innerHTML = ui.errorState(err, 'Try again');
      els.status.setAttribute('aria-busy', 'false');
    });
  }

  els.status.addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]')) loadStatus();
  });

  function ledeFor(facilityName) {
    return facilityName
      ? 'The health workers of ' + facilityName + ' will review it and update you by SMS.'
      : 'The facility\'s health workers will review it and update you by SMS.';
  }

  /* ───────────── start ───────────── */
  if (!ref || !T) {
    showMissing();
    return;
  }

  document.title = T.eyebrow + ' | MOWMMAS';
  els.eyebrow.innerHTML = ui.icon(T.icon, 'icon--sm') + esc(T.eyebrow);
  els.title.textContent = T.title;
  els.lede.textContent = mine ? 'Thank you. ' + ledeFor(mine.facilityName) : 'Keep your reference number so you can check the status anytime.';
  els.refNum.textContent = ref;
  els.track.href = 'status.html?ref=' + encodeURIComponent(ref);
  els.note.querySelector('span').innerHTML = '<strong>MOWMMAS is not a milk bank.</strong> ' + esc(T.note);

  renderSteps(mine && mine.facilityName, mine && mine.mobile);

  if (mine && mine.mobile) loadStatus();
  else renderPrompt();
})();
