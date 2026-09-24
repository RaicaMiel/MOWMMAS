/* ==========================================================================
   MOWMMAS Admin · Donation inquiries

   Rows       submissions/* with type "donate", newest first
   Refer list facilities (facilities/*): those that accept milk donations
              first, then those that haven't reported their services yet;
              the facility the mother chose (or referred to) pre-selected
   Refer      saves the referral in Firestore (admin-refer.js); not offered once
              a donation is completed, closed or declined
   View       everything the mother sent, and the status (admin-submission.js);
              ?ref=<reference> (the bell) opens it for that donation

   mowmmas.js opens the dialogs from the rows and fills in their fields.
   Send SMS   texts her through PhilSMS (admin-sms.js); the message starts from
              the Referral details template (SMS page), with her details filled in
   ========================================================================== */

import { ready, esc, showPageError, errorMessage } from "./admin-session.js";
import {
  getFacilities,
  getSubmissions,
  cachedFacilities,
  cachedSubmissions,
  submissionChip,
  isFinalStatus,
  formatDate,
  isoDay
} from "./admin-data.js";
import { domReady, formatMobile, mobileKey, firstName, plainText, muted, sub, fitSms } from "./admin-ui.js";
import { setUpRefer } from "./admin-refer.js";
import { setUpSubmissionView, ANSWERS } from "./admin-submission.js";
import { setUpSendDialog, getSmsTemplates, fillTemplateToFit, SMS_TEMPLATES } from "./admin-sms.js";

// Answers from the mother's donation form (User/Mother/Frontend/js/form.js)
var BABY_AGE = ANSWERS.donate.babyAge;
var DELIVERY = ANSWERS.donate.delivery;
var PREFERRED_TIME = ANSWERS.donate.preferredTime;

var page = {
  search: document.getElementById("inquiry_search"),
  searchForm: document.querySelector("form.mw-filters--search"),
  wrap: document.querySelector(".mw-table-wrap"),
  caption: document.querySelector(".mw-table caption"),
  tbody: document.querySelector(".mw-table tbody"),
  empty: document.querySelector(".mw-card .mw-empty"),
  referModal: document.getElementById("refer_modal"),
  referSelect: document.getElementById("refer_facility"),
  referHint: document.getElementById("refer_facility_hint"),
  sendModal: document.getElementById("send_modal"),
  sendRecipient: document.getElementById("send_recipient")
};

var emptyTitle = page.empty.querySelector(".mw-empty__title");
var emptyText = page.empty.querySelector(".mw-empty__text");
var emptyLink = page.empty.querySelector("a");
var EMPTY_SEARCH = { title: emptyTitle.textContent, text: emptyText.textContent };
var REFER_HINT = page.referHint.textContent;

var state = { loaded: false, list: [], rows: [], byRef: {}, facilityById: {}, referIds: {} };

/* ───────────── what a donation says ───────────── */

function contactOf(s) {
  return s.contact || {};
}

function detailsOf(s) {
  return s.details || {};
}

// "Drop-off on Sep 24, 2026, morning"
function planText(d) {
  var parts = [];
  var how = DELIVERY[d.delivery] || "";
  var when = formatDate(d.preferredDate);
  if (how && when) parts.push(how + " on " + when);
  else if (how) parts.push(how);
  else if (when) parts.push("On " + when);
  if (PREFERRED_TIME[d.preferredTime]) parts.push(PREFERRED_TIME[d.preferredTime]);
  return parts.join(", ");
}

// "Estimated 500ml a week, baby 4 to 6 months"
function amountText(d) {
  var parts = [];
  if (d.estimatedVolume) parts.push("Estimated " + String(d.estimatedVolume).trim());
  if (BABY_AGE[d.babyAge]) parts.push((parts.length ? "baby " : "Baby ") + BABY_AGE[d.babyAge]);
  return parts.join(", ");
}

// The Referral details template (SMS page), for the facility she was referred to (or chose)
var referralTemplate = SMS_TEMPLATES[0].text;

// Her complete name; her first name only if the complete one makes it longer than one SMS
function smsFor(s) {
  var name = String(contactOf(s).name || "").trim();
  var first = firstName(name);
  var r = s.referral && s.referral.facilityId ? s.referral : null;
  var facility = (r && r.facilityName) || s.facilityName;
  if (facility) {
    var f = state.facilityById[(r && r.facilityId) || s.facilityId];
    return fillTemplateToFit(referralTemplate, { name: name, firstName: first, facility: facility, phone: f && (f.contactNumber || f.smsNumber) });
  }
  return fitSms([
    (name ? "Hi " + name + ", this is MOWMMAS. " : "Hi, this is MOWMMAS. ") + "We received your milk donation inquiry. We'll text you the facility to contact. - MOWMMAS",
    (first ? "Hi " + first + ", this is MOWMMAS. " : "Hi, this is MOWMMAS. ") + "We received your milk donation inquiry. We'll text you the facility to contact. - MOWMMAS",
    "MOWMMAS: We received your milk donation inquiry. We'll text you the facility to contact."
  ]);
}

function searchText(s) {
  var c = contactOf(s);
  var d = detailsOf(s);
  return [
    s.ref, c.name, c.mobile, formatMobile(c.mobile), c.barangay, c.municipality, c.email,
    s.facilityName, s.referral && s.referral.facilityName, s.statusLabel, plainText(submissionChip(s)),
    planText(d), amountText(d), formatDate(s.createdAt)
  ].join(" ").toLowerCase();
}

/* ───────────── rows ───────────── */

function rowHtml(s) {
  var c = contactOf(s);
  var d = detailsOf(s);
  var name = c.name || "";
  var label = name || s.ref;
  var mobile = formatMobile(c.mobile);

  var mother = name
    ? '<span class="mw-table__name">' + esc(name) + "</span>"
    : '<span class="mw-table__name mw-text-muted">Name not given</span>';
  mother += mobile ? '<span class="mw-table__sub mw-table__nowrap">' + esc(mobile) + "</span>" : sub("No mobile number");

  var place = c.barangay
    ? esc(c.barangay) + sub(c.municipality)
    : (c.municipality ? esc(c.municipality) : muted("Not given"));

  // Referred: where to. Not yet: the facility the mother chose, marked as her choice.
  var r = s.referral;
  var facility = r && r.facilityName
    ? esc(r.facilityName) + sub("Referred " + formatDate(r.referredAt)) + sub(planText(d)) + sub(amountText(d))
    : s.facilityName
      ? esc(s.facilityName) + sub("Mother's choice, not referred yet") + sub(planText(d)) + sub(amountText(d))
      : muted("Not yet referred") + sub(planText(d)) + sub(amountText(d));

  var date = s.createdAt
    ? '<time datetime="' + esc(isoDay(s.createdAt)) + '">' + esc(formatDate(s.createdAt)) + "</time>"
    : muted("Not given");

  var wanted = (r && r.facilityId) || s.facilityId;
  var referTo = state.referIds[wanted] ? wanted : "";
  var context = esc(name ? name + " · " + s.ref : s.ref);
  var actions =
    '<button class="mw-link" type="button" data-modal-open="submission_modal" data-modal-context="' + context + '">View<span class="mw-visually-hidden"> inquiry from ' + esc(label) + "</span></button>";
  // A finished donation (completed, closed or declined) can't be referred
  if (!isFinalStatus(s.status)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="refer_modal" data-modal-context="' + context + '"' +
      ' data-modal-field-refer_facility="' + esc(referTo) + '">Refer<span class="mw-visually-hidden"> ' + esc(label) + "</span></button>";
  }
  if (mobileKey(c.mobile)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="send_modal"' +
      ' data-modal-field-send_recipient="' + esc(mobileKey(c.mobile)) + '"' +
      ' data-modal-field-send_type="' + ((s.referral && s.referral.facilityName) || s.facilityName ? "referral" : "update") + '"' +
      ' data-modal-field-send_message="' + esc(smsFor(s)) + '">Send SMS<span class="mw-visually-hidden"> to ' + esc(label) + "</span></button>";
  }

  return (
    '<tr data-ref="' + esc(s.ref) + '">' +
      '<td><span class="mw-table__id">' + esc(s.ref) + "</span></td>" +
      "<td>" + mother + "</td>" +
      '<td class="mw-table__nowrap">' + place + "</td>" +
      "<td>" + facility + "</td>" +
      '<td class="mw-table__nowrap">' + date + "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
      '<td class="mw-table__js"><div class="mw-table__actions mw-table__actions--stack">' + actions + "</div></td>" +
    "</tr>"
  );
}

function render() {
  if (!state.loaded) return;
  // Every word typed must appear somewhere in the row (name, mobile, place, facility, status…).
  var words = page.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  var shown = state.rows.filter(function (row) {
    return words.every(function (word) { return row.text.indexOf(word) !== -1; });
  });

  page.tbody.innerHTML = shown.map(function (row) { return row.html; }).join("");
  page.caption.textContent = "Donation inquiries, " + shown.length + (shown.length === 1 ? " record" : " records");
  page.wrap.hidden = shown.length === 0;

  var none = state.rows.length === 0;
  emptyTitle.textContent = none ? "No donation inquiries yet" : EMPTY_SEARCH.title;
  emptyText.textContent = none ? "When a mother sends the donation form, her inquiry shows here." : EMPTY_SEARCH.text;
  emptyLink.hidden = none;
  page.empty.hidden = shown.length !== 0;
}

/* ───────────── refer and send lists ───────────── */

function acceptsDonations(f) {
  return f.participating === true && !!f.services && f.services.acceptsDonations === true;
}

// Hasn't said either way yet (no facility has reported until it shares its services)
function notReported(f) {
  return !f.services || f.services.acceptsDonations == null;
}

function addGroup(label, list) {
  if (!list.length) return;
  var group = document.createElement("optgroup");
  group.label = label;
  list.forEach(function (f) {
    var option = document.createElement("option");
    option.value = f.id;
    option.textContent = f.name + (f.municipality ? " · " + f.municipality : "");
    group.appendChild(option);
  });
  page.referSelect.appendChild(group);
}

function fillReferList(facilities) {
  var accepts = facilities.filter(acceptsDonations);
  var unknown = facilities.filter(function (f) { return !acceptsDonations(f) && notReported(f); });
  state.referIds = {};
  accepts.concat(unknown).forEach(function (f) { state.referIds[f.id] = f; });
  var placeholder = page.referSelect.querySelector('option[value=""]');
  page.referSelect.innerHTML = "";
  page.referSelect.appendChild(placeholder);
  addGroup("Accepts milk donations", accepts);
  addGroup("Services not reported yet", unknown);
  REFER_HINT = accepts.length
    ? "Facilities that accept milk donations come first. Call the others to check before referring."
    : "No facility has reported accepting milk donations yet. Call the facility to check before referring.";
  if (!accepts.length && !unknown.length) REFER_HINT = "No facility can take donations right now. Update a facility's services on the Facilities page.";
  page.referHint.textContent = REFER_HINT;
}

// Every mother's number once. The one chosen stays chosen (new data can arrive while Send SMS is open).
function fillRecipients(submissions) {
  var seen = {};
  var chosen = page.sendRecipient.value;
  page.sendRecipient.innerHTML = "";
  submissions.forEach(function (s) {
    var c = contactOf(s);
    var key = mobileKey(c.mobile);
    if (!key || seen[key]) return;
    seen[key] = true;
    var option = document.createElement("option");
    option.value = key;
    option.textContent = (c.name || s.ref) + " · " + formatMobile(c.mobile);
    page.sendRecipient.appendChild(option);
  });
  if (chosen && seen[chosen]) page.sendRecipient.value = chosen;
}

/* ───────────── dialogs ─────────────
   mowmmas.js opens them from the rows and fills in their fields; these add
   what this page needs. Refer saves through admin-refer.js. */

setUpSendDialog({
  modal: page.sendModal,
  // her latest donation inquiry with that number
  contact: function (key) {
    var s = state.list.filter(function (x) { return mobileKey(contactOf(x).mobile) === key; })[0];
    return s ? { name: contactOf(s).name || null, ref: s.ref } : null;
  }
});

setUpRefer({
  modal: page.referModal,
  select: page.referSelect,
  note: document.getElementById("refer_note"),
  noun: "donation inquiry",
  submission: function (ref) { return state.byRef[ref] || null; },
  facility: function (id) { return state.referIds[id] || null; },
  onOpen: function (s) {
    page.referHint.textContent = REFER_HINT;
    if (s && s.facilityName && !state.referIds[s.facilityId] && Object.keys(state.referIds).length) {
      page.referHint.textContent = REFER_HINT + " The mother chose " + s.facilityName + ", which isn't on this list.";
    }
  },
  onSaved: replaceSubmission
});
page.referModal.addEventListener("close", function () { page.referHint.textContent = REFER_HINT; });

var view = setUpSubmissionView({
  modal: document.getElementById("submission_modal"),
  submission: function (ref) { return state.byRef[ref] || null; },
  onSaved: replaceSubmission
});

/* ───────────── search ───────────── */

page.searchForm.addEventListener("submit", function (event) { event.preventDefault(); });
page.search.addEventListener("input", render);
page.search.addEventListener("search", render);
emptyLink.addEventListener("click", function (event) {
  event.preventDefault();
  page.search.value = "";
  render();
  page.search.focus();
});

/* ───────────── load ─────────────
   1. What this browser tab already has (from the last page) shows at once.
   2. The fresh copy from Firestore replaces it a moment later.
   Nothing to show yet: a "Loading…" row, never an empty table. */

var errors = [];
function fail(error, what) {
  errors.push(errorMessage(error, what));
  showPageError(errors.join(" "));
}

var pendingFacilities = null;
function useFacilities(facilities) {
  state.facilityById = {};
  facilities.forEach(function (f) { state.facilityById[f.id] = f; });
  // Don't swap the list under an open Refer form; do it when the form closes.
  if (page.referModal.open) pendingFacilities = facilities;
  else fillReferList(facilities);
}
page.referModal.addEventListener("close", function () {
  if (pendingFacilities) { fillReferList(pendingFacilities); pendingFacilities = null; }
});

function buildRows() {
  state.byRef = {};
  state.rows = state.list.map(function (s) {
    state.byRef[s.ref] = s;
    return { html: rowHtml(s), text: searchText(s) };
  });
}

// A referral or status was saved: that submission as it is now, everywhere on the page (row, search)
function replaceSubmission(updated) {
  state.list = state.list.map(function (s) { return s.ref === updated.ref ? updated : s; });
  buildRows();
  render();
}

function useSubmissions(submissions) {
  fillRecipients(submissions);
  state.list = submissions;
  buildRows();
  state.loaded = true;
  render();
}

function showLoading() {
  if (state.loaded) return;
  page.wrap.hidden = false;
  page.empty.hidden = true;
  page.tbody.innerHTML = '<tr><td colspan="7"><span class="mw-text-muted">Loading donation inquiries…</span></td></tr>';
}

domReady.then(function () {
  var cachedFacs = cachedFacilities();
  var cachedSubs = cachedSubmissions("donate");
  if (cachedFacs) useFacilities(cachedFacs);
  if (cachedSubs) useSubmissions(cachedSubs);
  else showLoading();
});

Promise.all([ready, domReady]).then(function () {
  getSmsTemplates().then(function (templates) {
    if (templates.referral.text === referralTemplate) return;
    referralTemplate = templates.referral.text;
    if (state.loaded) { buildRows(); render(); }
  });
});

Promise.all([ready, domReady])
  .then(function () {
    page.wrap.setAttribute("aria-busy", "true");
    return Promise.allSettled([getSubmissions("donate"), getFacilities()]);
  })
  .then(function (results) {
    page.wrap.removeAttribute("aria-busy");
    var submissions = results[0];
    var facilities = results[1];

    if (facilities.status === "fulfilled") {
      useFacilities(facilities.value);
    } else {
      fail(facilities.reason, "the facility list for referrals");
      REFER_HINT = "The facility list couldn't be loaded. Refresh the page to try again.";
      page.referHint.textContent = REFER_HINT;
    }

    if (submissions.status !== "fulfilled") {
      fail(submissions.reason, "donation inquiries");
      if (!state.loaded) page.wrap.hidden = true;
      else view.openFromLink({ fresh: false });
      return;
    }
    useSubmissions(submissions.value);
    view.openFromLink();
  })
  .catch(function (error) {
    page.wrap.removeAttribute("aria-busy");
    if (!state.loaded) page.wrap.hidden = true;
    fail(error, "donation inquiries");
    if (state.loaded) view.openFromLink({ fresh: false });
  });
