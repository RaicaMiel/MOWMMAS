/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Inquire (inquire.html)
   Explains how to ask a facility a question and starts one:
   choose a facility (+ an optional topic) → form.html?type=inquire.

   The facility picker is a button that opens a searchable list grouped
   by municipality (ARIA combobox + listbox): type to filter, ↑/↓ to
   move, Enter to choose, Esc to close.
   Needs: api.js (window.MOWMMAS), loaded before this file with defer.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var api = M.api, ui = M.ui, util = M.util, esc = util.esc;

  function $(id) { return document.getElementById(id); }

  var els = {
    form: $('inqStart'),
    picker: $('facPicker'),
    btn: $('f-facility'),
    value: $('facValue'),
    panel: $('facPanel'),
    search: $('facSearch'),
    list: $('facList'),
    empty: $('facEmpty'),
    hidden: $('facilityId'),
    err: $('err-facility'),
    submit: $('startBtn'),
    status: $('inqStatus')
  };

  // same values as the "What is your question about?" choices in form.js
  var TOPICS = {
    availability: 'Donor milk availability',
    requirements: 'Requirements and documents',
    donating: 'How to donate milk',
    requesting: 'How to request milk',
    lactation: 'Breastfeeding help',
    other: 'Something else'
  };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var facilities = [];   // all facilities from the API
  var shown = [];        // facilities currently listed (after the search filter)
  var active = -1;       // index in `shown` of the highlighted option
  var selected = null;   // chosen facility

  function announce(text) { els.status.textContent = text; }

  /* ───────────── inline error under the picker ───────────── */
  function setError(html) {
    var wrap = els.picker.closest('.field');
    if (html) {
      els.err.innerHTML = ui.icon('i-alert', 'icon--sm') + '<span>' + html + '</span>';
      els.err.hidden = false;
      els.btn.setAttribute('aria-invalid', 'true');
      els.btn.setAttribute('aria-describedby', 'help-facility err-facility');
      wrap.classList.add('has-error');
    } else {
      els.err.innerHTML = '';
      els.err.hidden = true;
      els.btn.removeAttribute('aria-invalid');
      els.btn.setAttribute('aria-describedby', 'help-facility');
      wrap.classList.remove('has-error');
    }
  }

  /* ───────────── what the closed picker shows ───────────── */
  function showValue() {
    if (selected) {
      els.value.innerHTML = '<span class="picker__name">' + esc(selected.name) + '</span>' +
        '<span class="picker__sub">' + esc([selected.kindLabel, selected.municipality].filter(Boolean).join(' · ')) + '</span>';
    } else {
      els.value.innerHTML = '<span class="picker__placeholder">Choose a facility</span>';
    }
  }

  function servicesText(f) {
    return window.MOWMMAS_MAP && window.MOWMMAS_MAP.hasReported
      ? (window.MOWMMAS_MAP.hasReported(f) ? 'Services shared' : 'Services not reported')
      : (f.dataStatus && f.dataStatus.hasProfile ? 'Services shared' : 'Services not reported');
  }

  /* ───────────── the list: grouped by municipality, filtered by the search ───────────── */
  function renderList() {
    var q = els.search.value.trim().toLowerCase();
    shown = facilities.filter(function (f) {
      return !q || (f.name + ' ' + (f.municipality || '') + ' ' + (f.kindLabel || '')).toLowerCase().indexOf(q) !== -1;
    });

    var groups = {};
    shown.forEach(function (f) { var t = f.municipality || 'Other places'; (groups[t] = groups[t] || []).push(f); });
    var towns = Object.keys(groups).sort();
    // keep `shown` in on-screen order so ↑/↓ follow what the mother sees
    shown = [];
    towns.forEach(function (t) { groups[t].sort(function (a, b) { return a.name.localeCompare(b.name); }); shown = shown.concat(groups[t]); });

    var i = 0;
    els.list.innerHTML = towns.map(function (town, g) {
      return '<div class="picker__group" role="group" aria-labelledby="facGroup' + g + '">' +
        '<div class="picker__group-name" id="facGroup' + g + '" role="presentation">' +
          ui.icon('i-pin', 'icon--xs') + esc(town) + '</div>' +
        groups[town].map(function (f) {
          var idx = i++;
          var isSel = selected && selected.id === f.id;
          return '<div class="picker__opt' + (isSel ? ' is-selected' : '') + '" role="option" id="facOpt' + idx + '" data-index="' + idx + '"' +
            ' aria-selected="' + (isSel ? 'true' : 'false') + '">' +
            '<span class="picker__opt-text"><span class="picker__opt-name">' + esc(f.name) + '</span>' +
            '<span class="picker__opt-meta">' + esc(f.kindLabel || 'Health facility') + ' · ' + servicesText(f) + '</span></span>' +
            ui.icon('i-check', 'icon--sm picker__opt-check') +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');

    els.empty.hidden = shown.length > 0;
    var selIndex = selected ? shown.findIndex(function (f) { return f.id === selected.id; }) : -1;
    setActive(q ? (shown.length ? 0 : -1) : (selIndex !== -1 ? selIndex : (shown.length ? 0 : -1)));
  }

  function setActive(index) {
    var prev = els.list.querySelector('.picker__opt.is-active');
    if (prev) prev.classList.remove('is-active');
    active = index;
    if (index < 0) { els.search.removeAttribute('aria-activedescendant'); return; }
    var opt = $('facOpt' + index);
    if (!opt) return;
    opt.classList.add('is-active');
    els.search.setAttribute('aria-activedescendant', opt.id);
    opt.scrollIntoView({ block: 'nearest' });
  }

  /* ───────────── open / close / choose ───────────── */
  function isOpen() { return !els.panel.hidden; }

  function open() {
    if (els.btn.disabled || isOpen()) return;
    els.panel.hidden = false;
    els.btn.setAttribute('aria-expanded', 'true');
    els.picker.classList.add('is-open');
    els.search.value = '';
    renderList();
    els.search.focus();
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    els.panel.hidden = true;
    els.btn.setAttribute('aria-expanded', 'false');
    els.picker.classList.remove('is-open');
    if (returnFocus) els.btn.focus();
  }

  function choose(index) {
    var f = shown[index];
    if (!f) return;
    selected = f;
    els.hidden.value = f.id;
    showValue();
    setError('');
    close(true);
    announce(f.name + ' chosen.');
  }

  els.btn.addEventListener('click', function () { if (isOpen()) close(true); else open(); });
  els.btn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });

  els.search.addEventListener('input', renderList);
  els.search.addEventListener('keydown', function (e) {
    var last = shown.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active >= last ? 0 : active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active <= 0 ? last : active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(shown.length ? 0 : -1); }
    else if (e.key === 'End') { e.preventDefault(); setActive(last); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') { close(false); }
  });

  // mousedown keeps focus in the search box, so the list doesn't close before the click lands
  els.list.addEventListener('mousedown', function (e) { if (e.target.closest('.picker__opt')) e.preventDefault(); });
  els.list.addEventListener('click', function (e) {
    var opt = e.target.closest('.picker__opt');
    if (opt) choose(Number(opt.getAttribute('data-index')));
  });
  els.list.addEventListener('mousemove', function (e) {
    var opt = e.target.closest('.picker__opt');
    if (opt && Number(opt.getAttribute('data-index')) !== active) setActive(Number(opt.getAttribute('data-index')));
  });

  document.addEventListener('click', function (e) {
    if (isOpen() && !els.picker.contains(e.target)) close(false);
  });

  /* ───────────── loading the facilities ───────────── */
  function loaded(data) {
    facilities = (data && data.facilities) || [];
    els.btn.disabled = false;
    var pre = util.param('facility');
    selected = facilities.filter(function (f) { return f.id === pre; })[0] || null;
    els.hidden.value = selected ? selected.id : '';
    showValue();
    announce(facilities.length + ' facilities loaded.');
  }

  function showLoadError(err) {
    els.btn.disabled = true;
    els.value.innerHTML = '<span class="picker__placeholder">Facilities could not be loaded</span>';
    setError(esc(err && err.offline
      ? 'We can\'t reach MOWMMAS right now. Check your connection, then try again.'
      : (err && err.message) || 'Something went wrong.') +
      ' <button class="inq-retry" type="button" data-retry>Try again</button>');
  }

  function load() {
    els.btn.disabled = true;
    els.value.innerHTML = '<span class="picker__placeholder">Loading facilities…</span>';
    setError('');
    api.facilities().then(loaded).catch(showLoadError);
  }

  /* ───────────── topic from the link (inquire.html?topic=…) ───────────── */
  var topicParam = util.param('topic');
  if (topicParam && Object.prototype.hasOwnProperty.call(TOPICS, topicParam)) $('t-' + topicParam).checked = true;

  /* ───────────── "Ask about this" on an example question ───────────── */
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]')) { load(); return; }
    var pick = e.target.closest('[data-topic]');
    if (!pick) return;
    var key = pick.getAttribute('data-topic');
    var radio = $('t-' + key);
    if (!radio) return;
    radio.checked = true;
    els.form.classList.remove('is-flash');
    void els.form.offsetWidth; // restart the highlight
    els.form.classList.add('is-flash');
    els.form.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    (selected || els.btn.disabled ? els.submit : els.btn).focus({ preventScroll: true });
    announce('Topic chosen: ' + TOPICS[key] + '. ' + (selected ? 'Press Write my question.' : 'Now choose the facility you want to ask.'));
  });

  /* ───────────── continue to the question form ───────────── */
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (els.btn.disabled) return;
    if (!selected) {
      setError('Please choose the facility you want to ask.');
      els.btn.focus();
      return;
    }
    var topic = els.form.querySelector('input[name="topic"]:checked');
    els.submit.classList.add('is-loading');
    location.assign('form.html?type=inquire&facility=' + encodeURIComponent(selected.id) +
      (topic ? '&topic=' + topic.value : '') + '&from=inquire');
  });

  // coming back with the browser's Back button: the button must not stay "loading"
  window.addEventListener('pageshow', function () { els.submit.classList.remove('is-loading'); });

  load();
})();
