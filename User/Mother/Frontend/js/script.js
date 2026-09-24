/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Starting Page
   - Sticky header state
   - Mobile menu (accessible toggle)
   - Active section highlighting in the nav
   - Scroll reveal animations (skipped for reduced motion)
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* This file is loaded in <head>, so flag JS support right away.
     CSS uses .js to collapse the mobile menu and prepare reveal
     animations before the first paint — no flash of the open menu. */
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /* matchMedia change listener with a fallback for older Safari */
  function onMediaChange(query, handler) {
    if (query.addEventListener) query.addEventListener('change', handler);
    else if (query.addListener) query.addListener(handler);
  }

  /* ───────────── Header: add a shadow once the page scrolls ───────────── */
  function initHeader() {
    var header = document.getElementById('siteHeader');
    if (!header) return;

    var ticking = false;
    function update() {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }, { passive: true });

    update();
  }

  /* ───────────── Mobile menu ───────────── */
  function initMenu() {
    var header = document.getElementById('siteHeader');
    var button = document.getElementById('menuBtn');
    var nav = document.getElementById('siteNav');
    if (!header || !button || !nav) return;

    var desktop = window.matchMedia('(min-width: 960px)');

    function isOpen() {
      return button.getAttribute('aria-expanded') === 'true';
    }

    function setOpen(open) {
      header.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }

    button.addEventListener('click', function () {
      setOpen(!isOpen());
      if (isOpen()) {
        var firstLink = nav.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    });

    // Choosing a destination closes the menu
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    // Escape closes and returns focus to the toggle
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) {
        setOpen(false);
        button.focus();
      }
    });

    // Tapping outside the header closes it
    document.addEventListener('click', function (event) {
      if (isOpen() && !header.contains(event.target)) setOpen(false);
    });

    // Growing to desktop width resets the menu
    onMediaChange(desktop, function (event) {
      if (event.matches) setOpen(false);
    });
  }

  /* ───────────── Highlight the nav link for the section in view ───────────── */
  function initActiveNav() {
    // Only in-page links (#section) are managed here; links to other pages
    // keep the "current page" state that is written in their HTML.
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav__link'))
      .filter(function (link) { return (link.getAttribute('href') || '').charAt(0) === '#'; });
    if (!links.length) return;
    var linkFor = {};
    var targets = [];

    links.forEach(function (link) {
      var id = link.getAttribute('href').slice(1);
      var section = document.getElementById(id);
      if (section) {
        linkFor[id] = link;
        targets.push(section);
      }
    });

    // The hero is watched too, so scrolling back to the top clears the highlight
    var hero = document.getElementById('top');
    if (hero) targets.push(hero);

    function setActive(id) {
      links.forEach(function (link) {
        link.classList.remove('is-active');
        link.removeAttribute('aria-current');
      });
      var link = linkFor[id];
      if (link) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'true');
      }
    }

    /* Pick the section that sits under a reading line 40% down the screen.
       Measured on every scroll, so it can never get stuck on an old section. */
    var current = null;
    var ticking = false;

    function update() {
      ticking = false;
      var line = window.innerHeight * 0.4;
      var found = null;
      targets.forEach(function (section) {
        var box = section.getBoundingClientRect();
        if (box.top <= line && box.bottom > line) found = section.id;
      });
      if (found !== current) {
        current = found;
        setActive(found);
      }
    }

    function request() {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }

    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
    update();
  }

  /* ───────────── Reveal content as it scrolls into view ───────────── */
  function initReveal() {
    var items = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!items.length) return;

    function showAll() {
      items.forEach(function (item) { item.classList.add('is-visible'); });
    }

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      showAll();
      return;
    }

    var observer = new IntersectionObserver(function (entries, obs) {
      // Items that enter together are staggered slightly, in reading order
      entries
        .filter(function (entry) { return entry.isIntersecting; })
        .forEach(function (entry, index) {
          entry.target.style.setProperty('--delay', Math.min(index, 5) * 80 + 'ms');
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    items.forEach(function (item) { observer.observe(item); });

    // If the visitor switches reduced motion on mid-visit, stop animating
    onMediaChange(reduceMotion, function (event) {
      if (event.matches) {
        observer.disconnect();
        showAll();
      }
    });
  }

  /* ───────────── Logo: Starting Page or Home ─────────────
     Until the mother presses "Let's Get Started", the logo keeps her on
     the Starting Page. After she presses it, the logo takes her to Home
     for the rest of this visit. */
  var STARTED_KEY = 'mowmmas.started';

  function hasStarted() {
    try { return window.sessionStorage.getItem(STARTED_KEY) === '1'; }
    catch (e) { return false; }
  }

  function initLogoHome() {
    var starts = document.querySelectorAll('[data-start]');
    for (var i = 0; i < starts.length; i++) {
      starts[i].addEventListener('click', function () {
        try { window.sessionStorage.setItem(STARTED_KEY, '1'); } catch (e) { /* storage blocked: logo stays on the Starting Page */ }
      });
    }
    if (!hasStarted()) return;
    var logos = document.querySelectorAll('a.brand');
    for (var j = 0; j < logos.length; j++) {
      logos[j].setAttribute('href', 'home.html');
      logos[j].setAttribute('aria-label', 'MOWMMAS Home');
    }
  }

  /* ───────────── Footer year ───────────── */
  function initYear() {
    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  onReady(function () {
    initHeader();
    initMenu();
    initActiveNav();
    initReveal();
    initYear();
    initLogoHome();
  });
})();
