/* ==========================================================================
   MOWMMAS Admin · Dashboard

   Everything here is read from Firestore once the admin is confirmed:
     - the four KPI cards and "Needs updating"   facilities/*
     - "Recent inquiries & referrals"            submissions/*
     - "Recent SMS"                              the MOWMMAS server's SMS log (admin-sms.js)
   ========================================================================== */

import { ready, esc, showPageError, errorMessage } from "./admin-session.js";
import {
  getFacilities,
  getSubmissions,
  cachedFacilities,
  cachedSubmissions,
  smsStatusChip,
  isParticipating,
  hasDonorMilk,
  isOverdue,
  TYPES,
  submissionChip,
  hmbStatus,
  facilityUpdatedAt,
  daysAgo,
  isoDay
} from "./admin-data.js";
import { getSmsLog, cachedSmsLog } from "./admin-sms.js";

var LIST_SIZE = 3;

/* The rules every page shares (public, donor milk, needs updating) are in admin-data.js. */

/* ───────────── page helpers ───────────── */

var errors = [];

function fail(error, what) {
  errors.push(errorMessage(error, what));
  showPageError(errors.join(" "));
}

function setStat(key, value) {
  var el = document.querySelector('.mw-stat__value[data-stat="' + key + '"]');
  if (el) el.textContent = String(value);
}

// Shows the list when it has rows, the card's empty state when it doesn't.
function fillList(listId, emptyId, html) {
  var list = document.getElementById(listId);
  var empty = document.getElementById(emptyId);
  if (!list || !empty) return;
  list.innerHTML = html;
  list.hidden = !html;
  empty.hidden = !!html;
}

/* ───────────── facilities: KPIs and "Needs updating" ───────────── */

function renderFacilities(facilities) {
  var participating = facilities.filter(isParticipating);

  setStat("participating", participating.length);
  setStat("verified", facilities.filter(function (f) { return hmbStatus(f) === "verified"; }).length);
  setStat("donor_milk", facilities.filter(hasDonorMilk).length);
  setStat("overdue", participating.filter(isOverdue).length);

  // Oldest update first; never-updated facilities come before everything else.
  var stale = participating.slice().sort(function (a, b) {
    var ta = Date.parse(facilityUpdatedAt(a)) || 0;
    var tb = Date.parse(facilityUpdatedAt(b)) || 0;
    return ta - tb || String(a.name).localeCompare(String(b.name));
  }).slice(0, LIST_SIZE);

  fillList("stale_list", "stale_empty", stale.map(staleItem).join(""));
}

function staleItem(f) {
  var iso = facilityUpdatedAt(f);
  var day = isoDay(iso);
  var overdue = isOverdue(f);
  var when;

  if (day) {
    when = '<span class="mw-visually-hidden">Last updated </span>' +
      "<time" + (overdue ? ' class="mw-text-warning"' : "") + ' datetime="' + esc(day) + '">' + esc(daysAgo(iso)) + "</time>";
  } else {
    when = '<span class="mw-text-warning">Never updated</span>';
  }
  if (overdue) when += '<span class="mw-visually-hidden"> (overdue)</span>';

  return '<li class="mw-list__item">' +
    '<p class="mw-list__title">' + esc(f.name) + "</p>" +
    '<p class="mw-list__meta">' + when + "</p>" +
    "</li>";
}

/* ───────────── submissions: "Recent inquiries & referrals" ───────────── */

function renderSubmissions(submissions) {
  fillList("activity_list", "activity_empty", submissions.slice(0, LIST_SIZE).map(activityItem).join(""));
}

function activityItem(s) {
  var contact = s.contact || {};
  var name = String(contact.name || "").trim();
  var type = TYPES[s.type];
  var verb = type ? type.verb : (s.typeLabel || "sent a form");
  var meta = verb + (s.facilityName ? " · " + s.facilityName : "");

  return '<li class="mw-list__item">' +
    '<p class="mw-list__title">' + esc(name || s.ref) + "</p>" +
    '<p class="mw-list__meta">' + esc(meta) + "</p>" +
    submissionChip(s) +
    "</li>";
}

/* ───────────── "Recent SMS" ───────────── */

function renderSms(log) {
  fillList("sms_list", "sms_empty", log.slice(0, LIST_SIZE).map(smsItem).join(""));
}

function smsItem(r) {
  return '<li class="mw-list__item mw-list__item--message">' +
    '<p class="mw-list__title">' + esc(r.name || r.to || "Name not given") + "</p>" +
    '<p class="mw-list__meta">' + esc(r.message) + "</p>" +
    smsStatusChip(r) +
  "</li>";
}

/* ───────────── load ───────────── */

/* What this browser tab already has (from the last page) shows at once;
   the fresh copy from Firestore replaces it a moment later. */
(function showRemembered() {
  var facilities = cachedFacilities();
  var submissions = cachedSubmissions();
  var log = cachedSmsLog();
  if (facilities) renderFacilities(facilities);
  if (submissions) renderSubmissions(submissions);
  if (log) renderSms(log);
})();

ready.then(function () {
  var main = document.getElementById("main");
  if (main) main.setAttribute("aria-busy", "true");

  var facilities = getFacilities()
    .then(renderFacilities)
    .catch(function (error) { fail(error, "facility information"); });

  var submissions = getSubmissions()
    .then(renderSubmissions)
    .catch(function (error) { fail(error, "recent inquiries and referrals"); });

  var sms = getSmsLog()
    .then(renderSms)
    .catch(function (error) {
      errors.push(error.message);
      showPageError(errors.join(" "));
    });

  Promise.all([facilities, submissions, sms]).then(function () {
    if (main) main.removeAttribute("aria-busy");
  });
}).catch(function () {
  // Not signed in yet or Firebase unreachable: admin-session.js shows the error.
  // Numbers that never loaded show a dash instead of staying blank.
  document.querySelectorAll(".mw-stat__value").forEach(function (value) {
    if (!value.textContent.trim()) value.textContent = "–";
  });
});
