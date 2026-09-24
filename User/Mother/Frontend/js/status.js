/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Track a submission (status.html?ref=…)

   - "On this device": quick picks from MOWMMAS.util.recentSubmissions()
   - Look-up form: reference number (typed any way: "mow r 2026 12" →
     MOW-R-2026-00012) + mobile number → MOWMMAS.api.status()
   - Result: type, facility (with call link), current status, a timeline
     of the status history and the messages from health workers
   - Opens the result on its own when ?ref= is in the link and this
     device knows the mobile number used for it
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var api = M.api, ui = M.ui, util = M.util, esc = util.esc;

  function $(id) { return document.getElementById(id); }

  var TYPE_INFO = {
    donate:  { label: 'Donation offer',     icon: 'i-hand-heart' },
    request: { label: 'Donor milk request', icon: 'i-bottle' },
    inquire: { label: 'Question',           icon: 'i-chat' }
  };
  var LETTER = { D: 'donate', R: 'request', I: 'inquire' };

  /* What each status means for the mother, in plain words */
  var MEANING = {
    submitted: {
      donate: 'Your offer reached the facility. A health worker will review it soon.',
      request: 'Your request reached the facility. A health worker will review it soon.',
      inquire: 'Your question reached the facility. A health worker will reply soon.'
    },
    under_review: 'A health worker is checking your details.',
    screening_scheduled: 'Your health screening has a date. Watch for an SMS with the details.',
    accepted: 'Your donation was accepted. The facility will tell you how to bring or send your milk.',
    approved: 'Your request was approved. The facility will tell you how to get the milk.',
    ready_for_pickup: 'The donor milk is ready. Please go to the facility to collect it, and call first if you can.',
    answered: 'A health worker answered your question. See the messages below or your SMS.',
    completed: 'All done. Thank you for using MOWMMAS.',
    closed: 'This question is closed. You can send a new question anytime.',
    declined: 'The facility could not go ahead this time. Check the messages below, or call the facility to ask why.'
  };

  var els = {
    hero: $('trkHero'), aside: $('trkAside'), form: $('trackForm'),
    ref: $('f-ref'), mobile: $('f-mobile'), btn: $('lookupBtn'), btnLabel: $('lookupLabel'),
    result: $('result'), guide: $('guide')
  };

  var shownKey = null;   // ref of the result on screen
  var last = null;       // { ref, mobile } of the last look-up
  var busy = false;
  var touched = {};

  /* ═════════════════════════ this device's submissions ═════════════════════════ */

  var showAllRecent = false;
  var HINT_HTML = els.aside.innerHTML;   // "Where is my reference number?" from the page, shown when nothing is saved

  function renderRecent() {
    var list = util.recentSubmissions().filter(function (s) { return s && s.ref && s.mobile; });
    if (!list.length) { els.hero.classList.remove('has-recent'); els.aside.innerHTML = HINT_HTML; return; }
    els.hero.classList.add('has-recent');
    var visible = showAllRecent ? list : list.slice(0, 3);
    els.aside.innerHTML = '<div class="trk-recent' + (list.length === 1 ? ' trk-recent--tip' : '') + '">' +
      '<p class="trk-recent__label">' + ui.icon('i-lock', 'icon--xs') + 'On this device</p>' +
      '<div class="trk-recent__scroll"><ul class="trk-recent__list">' + visible.map(function (s, i) {
        var type = TYPE_INFO[s.type] || TYPE_INFO[LETTER[String(s.ref).charAt(4)]] || TYPE_INFO.inquire;
        var active = s.ref === shownKey;
        return '<li><button class="pick' + (active ? ' is-active' : '') + '" type="button" data-pick="' + i + '"' +
          (active ? ' aria-current="true"' : '') + '>' +
          '<span class="pick__icon">' + ui.icon(type.icon, 'icon--sm') + '</span>' +
          '<span class="pick__text"><span class="pick__title">' + esc(util.submissionTitle(s)) + '</span>' +
          (s.facilityName ? '<span class="pick__meta">' + esc(s.facilityName) + '</span>' : '') + '</span>' +
          '<span class="pick__when">' + esc(util.formatDate(s.createdAt)) + '</span>' +
          ui.icon('i-chevron-right', 'icon--sm pick__chev') + '</button></li>';
      }).join('') + '</ul>' +
      (list.length > 3 && !showAllRecent
        ? '<button class="trk-recent__more" type="button" data-more>Show all ' + list.length + '</button>' : '') +
      '</div>' + tipHtml(list.length) +
      '</div>';
    els.aside._list = list;
  }

  /* One saved submission leaves room under it for the reference-number tip; with more, the list uses the space */
  function tipHtml(count) {
    if (count !== 1) return '';
    return '<div class="trk-recent__tip">' +
      '<p class="trk-hint__title">' + ui.icon('i-help', 'icon--sm') + ' Where is my reference number?</p>' +
      '<ul class="trk-hint__list">' +
        '<li>' + ui.icon('i-check', 'icon--xs') + ' On the page you saw after sending your form.</li>' +
        '<li>' + ui.icon('i-check', 'icon--xs') + ' In the SMS about your submission.</li>' +
      '</ul></div>';
  }

  els.aside.addEventListener('click', function (e) {
    var more = e.target.closest('[data-more]');
    if (more) { showAllRecent = true; renderRecent(); return; }
    var pick = e.target.closest('[data-pick]');
    if (!pick) return;
    var s = (els.aside._list || [])[Number(pick.getAttribute('data-pick'))];
    if (!s) return;
    els.ref.value = s.ref;
    els.mobile.value = util.formatMobile(s.mobile);
    setError('ref', ''); setError('mobile', '');
    lookup(s.ref, s.mobile, { reveal: true });
  });

  /* ═════════════════════════ look-up form ═════════════════════════ */

  function setError(key, message) {
    var input = key === 'ref' ? els.ref : els.mobile;
    var err = $('err-' + key);
    var help = 'help-' + key;
    if (message) {
      err.innerHTML = ui.icon('i-alert', 'icon--sm') + '<span>' + esc(message) + '</span>';
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', help + ' ' + err.id);
    } else {
      err.innerHTML = '';
      err.hidden = true;
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', help);
    }
  }

  function checkRef() {
    var v = els.ref.value.trim();
    if (!v) return 'Please enter your reference number. It starts with MOW-.';
    if (!util.normalizeRef(v)) return 'Please check the reference number. It looks like MOW-R-2026-00012.';
    return '';
  }
  function checkMobile() {
    var v = els.mobile.value.trim();
    if (!v) return 'Please enter the mobile number you used on the form.';
    if (/[^\d\s\-+().]/.test(v) || !util.validMobile(v)) return 'Please enter a mobile number like 0917 123 4567.';
    return '';
  }

  els.form.addEventListener('input', function (e) {
    var key = e.target === els.ref ? 'ref' : e.target === els.mobile ? 'mobile' : null;
    if (!key) return;
    touched[key] = true;
    if (!$('err-' + key).hidden && !(key === 'ref' ? checkRef() : checkMobile())) setError(key, '');
  });

  els.form.addEventListener('focusout', function (e) {
    if (e.target === els.ref && (touched.ref || !$('err-ref').hidden)) {
      setError('ref', checkRef());
      var n = util.normalizeRef(els.ref.value);
      if (n) els.ref.value = n;   // show the tidy form of what she typed
    }
    if (e.target === els.mobile && (touched.mobile || !$('err-mobile').hidden)) setError('mobile', checkMobile());
  });

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var refErr = checkRef(), mobErr = checkMobile();
    setError('ref', refErr);
    setError('mobile', mobErr);
    if (refErr) { els.ref.focus(); return; }
    if (mobErr) { els.mobile.focus(); return; }
    var ref = util.normalizeRef(els.ref.value);
    els.ref.value = ref;
    lookup(ref, util.normalizeMobile(els.mobile.value), { reveal: true });
  });

  function setBusy(on, label) {
    busy = on;
    els.btn.disabled = on;
    els.btn.classList.toggle('is-loading', on);
    els.btn.setAttribute('aria-busy', String(on));
    els.btnLabel.textContent = on ? (label || 'Looking it up…') : 'Show my status';
  }

  /* ═════════════════════════ look-up ═════════════════════════ */

  function skeleton() {
    return '<div class="trk-skel" aria-hidden="true"><div class="skeleton trk-skel__head"></div>' +
      '<div class="trk-skel__grid"><div class="skeleton"></div><div class="skeleton"></div></div></div>' +
      '<p class="sr-only">Looking up your submission…</p>';
  }

  function reveal() {
    var card = $('resultCard') || els.result.firstElementChild;
    if (!card) return;
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    if (card.hasAttribute('tabindex')) card.focus({ preventScroll: true });
  }

  function lookup(ref, mobile, opts) {
    opts = opts || {};
    if (busy) return;
    last = { ref: ref, mobile: mobile };
    setBusy(true, opts.refresh ? 'Refreshing…' : null);
    var refreshBtn = els.result.querySelector('[data-refresh]');
    if (opts.refresh && refreshBtn) { refreshBtn.classList.add('is-loading'); refreshBtn.disabled = true; }
    else els.result.innerHTML = skeleton();
    els.result.setAttribute('aria-busy', 'true');

    api.status(ref, mobile).then(function (view) {
      setBusy(false);
      shownKey = view.ref;
      util.rememberSubmission({
        ref: view.ref, mobile: util.normalizeMobile(mobile), type: view.type, typeLabel: view.typeLabel,
        facilityId: view.facility && view.facility.id, facilityName: view.facility && view.facility.name,
        createdAt: view.createdAt
      });
      renderResult(view, mobile);
      renderRecent();
      els.guide.hidden = true;
      try { history.replaceState(null, '', 'status.html?ref=' + encodeURIComponent(view.ref)); } catch (e) { /* ignore */ }
      if (opts.refresh) ui.toast('Status refreshed.');
      if (opts.reveal) reveal();
    }).catch(function (err) {
      setBusy(false);
      shownKey = null;
      renderRecent();
      els.guide.hidden = false;
      if (err && err.status === 400 && err.fields && err.fields.mobile) {
        els.result.innerHTML = '';
        setError('mobile', err.fields.mobile);
        els.mobile.focus();
        return;
      }
      if (err && err.status === 404) {
        // Saved on this device (the same reference AND mobile number) but no longer in MOWMMAS:
        // off the list. A saved one looked up with another number stays.
        var saved = util.recentSubmissions().some(function (s) {
          return s && s.ref === ref && util.normalizeMobile(s.mobile) === util.normalizeMobile(mobile);
        });
        if (saved) {
          util.forgetSubmission(ref);
          renderRecent();
        }
        // Only what she typed is shown: nothing about any other submission or number
        els.result.innerHTML = notFoundHtml(ref, mobile);
      } else if (err && err.status === 429) {
        els.result.innerHTML = stateHtml('i-clock', 'Please wait a few minutes', err.message, '');
      } else {
        els.result.innerHTML = '<div class="trk-error">' + ui.errorState(err, 'Try again') + '</div>';
      }
      if (opts.reveal) reveal();
    }).finally(function () {
      els.result.setAttribute('aria-busy', 'false');
    });
  }

  function stateHtml(icon, title, text, actions) {
    return '<div class="state trk-state" role="alert" tabindex="-1" id="resultCard">' +
      '<span class="state__icon">' + ui.icon(icon) + '</span>' +
      '<h2 class="state__title">' + esc(title) + '</h2>' +
      '<p class="state__text">' + esc(text) + '</p>' + actions + '</div>';
  }

  // Nothing matches the reference AND mobile number she typed: say so, and show only what she typed
  function notFoundHtml(ref, mobile) {
    return '<div class="state trk-state" role="alert" tabindex="-1" id="resultCard">' +
      '<span class="state__icon">' + ui.icon('i-search') + '</span>' +
      '<h2 class="state__title">No submission found</h2>' +
      '<p class="state__text">There is no submission with the reference number <strong class="trk-nowrap">' + esc(ref) + '</strong> ' +
        'and the mobile number <strong class="trk-nowrap">' + esc(util.formatMobile(mobile)) + '</strong>.</p>' +
      '<ul class="trk-tips">' +
        '<li>' + ui.icon('i-check', 'icon--xs') + 'Check the reference number on your confirmation page or in the SMS.</li>' +
        '<li>' + ui.icon('i-check', 'icon--xs') + 'Use the same mobile number you entered on the form.</li>' +
      '</ul>' +
      '<div class="state__actions"><button class="btn btn--outline btn--sm" type="button" data-edit>' +
        ui.icon('i-edit', 'icon--sm') + 'Check my details</button></div></div>';
  }

  els.result.addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]') && last) { lookup(last.ref, last.mobile, { reveal: false }); return; }
    if (e.target.closest('[data-refresh]') && last) { lookup(last.ref, last.mobile, { refresh: true }); return; }
    if (e.target.closest('[data-edit]')) {
      els.form.scrollIntoView({ block: 'center' });
      els.ref.focus({ preventScroll: true });
      els.ref.select();
    }
  });

  /* ═════════════════════════ result ═════════════════════════ */

  function meaning(view) {
    var m = MEANING[view.status];
    if (m && typeof m === 'object') m = m[view.type];
    return m || 'Your status was updated by the health workers.';
  }

  function whenHtml(iso) {
    return '<time datetime="' + esc(iso) + '">' + esc(util.formatDate(iso, true)) + '</time>' +
      '<span class="trk-ago"> · ' + esc(util.timeAgo(iso)) + '</span>';
  }

  function timelineHtml(view) {
    var items = (view.statusHistory || []).slice().reverse();
    if (!items.length) return '<p class="muted">No status updates yet.</p>';
    var tones = M.STATUS_STYLE || {};
    return '<ol class="tl">' + items.map(function (h, i) {
      var st = tones[h.status] || { tone: 'new', icon: 'i-info' };
      var note = h.note ? '<p class="tl__note">' + ui.icon('i-message', 'icon--xs') + '<span>' + lines(h.note) + '</span></p>'
        : h.status === 'submitted' && i === items.length - 1 ? '<p class="tl__plain">You sent the form through MOWMMAS.</p>' : '';
      return '<li class="tl__item' + (i === 0 ? ' is-latest' : '') + '">' +
        '<span class="tl__dot tl__dot--' + st.tone + '">' + ui.icon(st.icon, 'icon--xs') + '</span>' +
        '<div class="tl__body">' +
          '<p class="tl__head"><span class="tl__label">' + esc(h.statusLabel || h.status) + '</span>' +
            (i === 0 ? '<span class="badge badge--rose tl__latest">Latest</span>' : '') + '</p>' +
          '<p class="tl__time">' + whenHtml(h.at) + '</p>' + note +
        '</div></li>';
    }).join('') + '</ol>';
  }

  // Text with its line breaks kept
  function lines(text) {
    return esc(text).replace(/\r?\n/g, '<br>');
  }

  function messagesHtml(view, mobile) {
    var list = view.messages || [];
    if (!list.length) {
      return '<div class="trk-empty">' +
        '<span class="trk-empty__icon">' + ui.icon('i-message') + '</span>' +
        '<p class="trk-empty__title">No messages yet</p>' +
        '<p class="trk-empty__text">When the health workers send you a message or an SMS about this, it appears here.</p></div>';
    }
    return '<ul class="msgs">' + list.map(function (m) {
      return '<li class="msg">' +
        '<span class="msg__icon">' + ui.icon('i-message', 'icon--sm') + '</span>' +
        '<div class="msg__body"><p class="msg__text">' + lines(m.message) + '</p>' +
        '<p class="msg__time">' + whenHtml(m.at) + '</p></div></li>';
    }).join('') + '</ul>';
  }

  function renderResult(view, mobile) {
    var type = TYPE_INFO[view.type] || TYPE_INFO.inquire;
    var f = view.facility || {};
    var phone = f.contactNumber
      ? '<a class="trk-call" href="' + esc(util.telHref(f.contactNumber)) + '">' + ui.icon('i-phone', 'icon--sm') +
        '<span>Call ' + esc(f.contactNumber) + '</span></a>'
      : '<span class="muted">No number listed yet</span>';
    var count = (view.messages || []).length;

    els.result.innerHTML =
      '<article class="trk-result" id="resultCard" tabindex="-1" aria-labelledby="resultTitle">' +
        '<header class="trk-summary">' +
          '<div class="trk-summary__top">' +
            '<span class="trk-summary__icon">' + ui.icon(type.icon) + '</span>' +
            '<div class="trk-summary__id">' +
              '<p class="trk-summary__type">' + esc(type.label) + (view.contactName ? ' · from ' + esc(view.contactName) : '') + '</p>' +
              '<h2 class="trk-summary__ref" id="resultTitle">' + esc(view.ref) + '</h2>' +
            '</div>' +
            '<button class="btn btn--outline btn--sm trk-refresh" type="button" data-refresh>' +
              ui.icon('i-refresh', 'icon--sm') + '<span>Refresh</span></button>' +
          '</div>' +
          '<div class="trk-summary__grid">' +
            '<div class="trk-now">' +
              '<p class="trk-now__label">Current status</p>' +
              ui.statusPill(view.status, view.statusLabel, 'lg') +
              '<p class="trk-now__text">' + esc(meaning(view)) + '</p>' +
            '</div>' +
            '<dl class="trk-facts">' +
              '<div class="trk-fact trk-fact--wide"><dt>Facility</dt><dd><strong>' + esc(f.name || '') + '</strong>' +
                (f.municipality ? '<span class="trk-fact__sub">' + esc(f.municipality) + ', Antique</span>' : '') + '</dd></div>' +
              '<div class="trk-fact"><dt>Contact</dt><dd>' + phone + '</dd></div>' +
              '<div class="trk-fact"><dt>Submitted</dt><dd>' + esc(util.formatDate(view.createdAt, true)) + '</dd></div>' +
              '<div class="trk-fact"><dt>Last update</dt><dd>' + esc(util.timeAgo(view.updatedAt)) + '</dd></div>' +
              '<div class="trk-fact"><dt>Updates by SMS to</dt><dd>' + esc(util.formatMobile(mobile)) + '</dd></div>' +
            '</dl>' +
          '</div>' +
        '</header>' +
        '<div class="trk-grid">' +
          '<section class="panel trk-panel" aria-labelledby="historyTitle">' +
            '<div class="panel__head"><span class="panel__icon">' + ui.icon('i-activity') + '</span>' +
              '<h3 class="panel__title" id="historyTitle">Status history</h3></div>' +
            timelineHtml(view) +
          '</section>' +
          '<section class="panel trk-panel" aria-labelledby="msgTitle">' +
            '<div class="panel__head"><span class="panel__icon panel__icon--mint">' + ui.icon('i-message') + '</span>' +
              '<h3 class="panel__title" id="msgTitle">Messages from health workers' +
              (count ? ' <span class="badge trk-count">' + count + '</span>' : '') + '</h3></div>' +
            (count ? '<p class="trk-panel__sub">Newest first. The texts a health worker sent to ' + esc(util.formatMobile(mobile)) + ' show here too.</p>' : '') +
            messagesHtml(view, mobile) +
          '</section>' +
        '</div>' +
      '</article>';
  }

  /* ═════════════════════════ start ═════════════════════════ */
  renderRecent();
  // Saved ones MOWMMAS no longer has come off the list before she taps them
  api.pruneSaved({ force: true }).then(function (removed) { if (removed && !busy) renderRecent(); });

  var fromLink = util.normalizeRef(util.param('ref'));
  if (fromLink) {
    els.ref.value = fromLink;
    var known = util.recentSubmissions().filter(function (s) { return s && s.ref === fromLink && s.mobile; })[0];
    if (known) {
      els.mobile.value = util.formatMobile(known.mobile);
      lookup(fromLink, known.mobile, { reveal: false });
    } else {
      els.mobile.focus({ preventScroll: true });
    }
  }
})();
