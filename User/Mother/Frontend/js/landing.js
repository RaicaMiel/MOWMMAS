/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Starting Page · live facility preview
   The hero preview lists three real facilities. Their names and towns are
   written in index.html, so they show even without JavaScript. This fills
   in the address, the type and the two statuses from MOWMMAS (one call to
   /api/facilities). If MOWMMAS can't be reached, or a facility isn't in the
   list, the written text stays and that facility says "Call the facility to
   confirm" (css: .is-fallback). The hero never shows an error.
   Needs js/api.js (window.MOWMMAS), loaded before this file.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  /* Text only (textContent), so nothing from the API is read as HTML */
  function setText(item, field, value) {
    each(item.querySelectorAll('[data-fill="' + field + '"]'), function (node) {
      node.textContent = value;
    });
  }

  function fallback(item) {
    item.classList.add('is-fallback');
  }

  function statusFor(statuses, key) {
    for (var i = 0; i < statuses.length; i++) {
      if (statuses[i] && statuses[i].key === key) return statuses[i];
    }
    return null;
  }

  function setStatus(item, field, status) {
    var text = String(status.text || '');
    each(item.querySelectorAll('[data-fill="' + field + '"]'), function (node) {
      node.textContent = text;
      node.setAttribute('data-tone', status.tone || 'unknown');
    });
  }

  function fill(item, f, M) {
    var statuses = M.facilityStatuses(f) || [];
    var lactation = statusFor(statuses, 'lactation');
    var hmb = statusFor(statuses, 'hmb');
    if (!lactation || !lactation.text || !hmb || !hmb.text) {
      fallback(item);
      return;
    }
    if (f.name) setText(item, 'name', f.name);
    var address = f.address || (f.municipality ? f.municipality + ', Antique' : '');
    if (address) setText(item, 'address', address);
    if (f.kindLabel) setText(item, 'type', f.kindLabel);
    setStatus(item, 'lactation', lactation);
    setStatus(item, 'hmb', hmb);
  }

  onReady(function () {
    var list = document.querySelector('[data-preview]');
    if (!list) return;
    var items = list.querySelectorAll('[data-facility]');
    if (!items.length) return;
    list.classList.add('is-live');   // statuses show only once this script runs

    var M = window.MOWMMAS;
    if (!M || !M.api || typeof M.api.facilities !== 'function' || typeof M.facilityStatuses !== 'function') {
      each(items, fallback);
      return;
    }

    M.api.facilities().then(function (data) {
      var facilities = Array.isArray(data) ? data : (data && data.facilities) || [];
      var byId = {};
      facilities.forEach(function (f) { if (f && f.id) byId[f.id] = f; });
      each(items, function (item) {
        var f = byId[item.getAttribute('data-facility')];
        if (!f) { fallback(item); return; }
        try { fill(item, f, M); } catch (e) { fallback(item); }
      });
    }).catch(function () {
      // Server off, offline or slow: keep the written names and towns
      each(items, fallback);
    });
  });
})();
