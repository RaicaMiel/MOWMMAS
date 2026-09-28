/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Breast Milk Information (guide.html)
   A guide through six steps, one open at a time:
   - The step list (a column on wide screens, a strip on phones) opens
     any step; Back / Next under the open step walk through them in order
   - The open step is in the address once she moves through the guide
     (guide.html#referral), so a link can open a step directly
   - Steps already opened get a check, for this visit
   Without JS every step shows, one under the other.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.gd-tab'));
  if (!tabs.length) return;
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    list: document.querySelector('.gd-tabs'),
    stage: document.querySelector('.gd-stage'),
    fill: $('gdFill'),
    count: $('gdCount'),
    back: $('gdBack'),
    next: $('gdNext'),
    nextLabel: $('gdNextLabel'),
    done: $('gdDone')
  };
  var SEEN_KEY = 'mowmmas.guide.seen';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var desktop = window.matchMedia('(min-width: 960px)');
  var current = -1;
  var seen = loadSeen();

  /* ───────────── helpers ───────────── */
  function loadSeen() {
    try { return JSON.parse(sessionStorage.getItem(SEEN_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveSeen() {
    try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* storage blocked */ }
  }
  function titleOf(i) {
    return tabs[i].querySelector('.gd-tab__title').textContent;
  }
  function indexOf(id) {
    for (var i = 0; i < panels.length; i++) if (panels[i] && panels[i].id === id) return i;
    return -1;
  }
  function behavior() {
    return reduceMotion.matches ? 'auto' : 'smooth';
  }

  /* The open step starts below the sticky header */
  function bringIntoView(instant) {
    var header = document.getElementById('siteHeader');
    var offset = (header ? header.offsetHeight : 0) + 12;
    var top = els.stage.getBoundingClientRect().top;
    if (top < offset || top > window.innerHeight * 0.6) {
      window.scrollBy({ top: top - offset, behavior: instant ? 'auto' : behavior() });
    }
  }

  /* Phones: keep the chosen step in the middle of the strip */
  function centreTab(i, instant) {
    if (desktop.matches || !els.list || i < 0) return;
    var tab = tabs[i].parentNode;
    els.list.scrollTo({ left: tab.offsetLeft - (els.list.clientWidth - tab.offsetWidth) / 2, behavior: instant ? 'auto' : behavior() });
  }

  /* ───────────── open a step ─────────────
     how: 'load' (first view), 'tab' (from the list: focus stays on it),
     'nav' (Back / Next: focus goes to the step's heading) */
  function show(i, how) {
    if (i < 0 || i >= panels.length || i === current) return;
    current = i;
    seen[panels[i].id] = true;
    saveSeen();

    tabs.forEach(function (tab, k) {
      var open = k === i;
      tab.setAttribute('aria-selected', String(open));
      tab.setAttribute('tabindex', open ? '0' : '-1');
      var done = !open && Boolean(seen[panels[k].id]);
      tab.classList.toggle('is-done', done);
      tab.setAttribute('aria-label', 'Step ' + (k + 1) + ' of ' + tabs.length + ': ' + titleOf(k) + (done ? ', done' : ''));
      panels[k].hidden = !open;
    });

    var panel = panels[i];
    panel.classList.remove('is-entering');
    if (how !== 'load') {
      void panel.offsetWidth; // restart the entrance
      panel.classList.add('is-entering');
    }

    var last = i === panels.length - 1;
    els.fill.style.width = ((i + 1) / panels.length * 100) + '%';
    els.count.textContent = 'Step ' + (i + 1) + ' of ' + panels.length;
    els.back.classList.toggle('is-first', i === 0);
    els.back.disabled = i === 0;
    els.next.hidden = last;
    els.done.hidden = !last;
    if (!last) {
      els.nextLabel.innerHTML = 'Next<span class="gd-nav__to">: ' + titleOf(i + 1).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>';
    }

    if (how !== 'load') {
      try { history.replaceState(history.state, '', '#' + panel.id); } catch (e) { /* file:// */ }
    }
    centreTab(i, how === 'load');

    if (how === 'nav') {
      bringIntoView();
      var heading = panel.querySelector('.gd-panel__title');
      if (heading) heading.focus({ preventScroll: true });
    } else if (how === 'tab') {
      bringIntoView();
    }
  }

  /* ───────────── events ───────────── */
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      show(i, 'tab');
    });
  });

  // Arrow keys move through the steps (and open them), Home / End jump to the first / last
  els.list.addEventListener('keydown', function (event) {
    var i = tabs.indexOf(document.activeElement);
    if (i === -1 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      show(i, 'tab');
      return;
    }
    var to = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') to = (i + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') to = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = tabs.length - 1;
    if (to === null) return;
    event.preventDefault();
    tabs[to].focus({ preventScroll: true });
    show(to, 'tab');
  });

  els.back.addEventListener('click', function () { show(current - 1, 'nav'); });
  els.next.addEventListener('click', function () { show(current + 1, 'nav'); });

  // A link to another step of this guide (guide.html#sms) opens it
  window.addEventListener('hashchange', function () {
    var i = indexOf(location.hash.slice(1));
    if (i !== -1) show(i, 'tab');
  });

  // Phones: from the row to the strip (a rotation, a resized window), the open step stays in view
  var onBreakpoint = function (e) { if (!e.matches) centreTab(current, true); };
  if (desktop.addEventListener) desktop.addEventListener('change', onBreakpoint);
  else if (desktop.addListener) desktop.addListener(onBreakpoint);

  /* ───────────── start ───────────── */
  var start = indexOf(location.hash.slice(1));
  show(start === -1 ? 0 : start, 'load');
  els.stage.classList.add('is-ready');
  if (start !== -1) {
    var place = function () { bringIntoView(true); };
    if (document.readyState === 'complete') place();
    else window.addEventListener('load', function () { setTimeout(place, 0); });
  }
})();
