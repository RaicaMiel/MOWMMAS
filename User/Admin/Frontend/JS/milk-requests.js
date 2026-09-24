/* ==========================================================================
   MOWMMAS Admin · Milk requests

   Rows       submissions/* with type "request", newest first
   Refer list facilities (facilities/*):
                milk banks and donor milk providers, with the donor milk
                they last reported
                breastfeeding support
                services not reported yet
              the facility the request was sent to (or referred to) pre-selected
   Refer      saves the referral in Firestore (admin-refer.js); not offered once
              a request is completed, closed or declined
   View       everything the mother or family sent, and the status
              (admin-submission.js); ?ref=<reference> (the bell) opens it for
              that request

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
  TYPES,
  submissionChip,
  isFinalStatus,
  DONOR_MILK,
  donorMilk,
  facilityUpdatedAt,
  formatDate,
  isoDay
} from "./admin-data.js";
import { domReady, formatMobile, mobileKey, firstName, capitalize, plainText, muted, sub, fitSms } from "./admin-ui.js";
import { setUpRefer } from "./admin-refer.js";
import { setUpSubmissionView, ANSWERS } from "./admin-submission.js";
import { setUpSendDialog, getSmsTemplates, fillTemplateToFit, SMS_TEMPLATES } from "./admin-sms.js";

// Answers from the mother's request form (User/Mother/Frontend/js/form.js)
var RELATIONSHIP = ANSWERS.request.relationship;
var BABY_AGE = ANSWERS.request.babyAge;
var REASONS = ANSWERS.request.reasons;
var ADMITTED = ANSWERS.request.admitted;
var URGENCY = ANSWERS.request.urgency;

var page = {
  search: document.getElementById("request_search"),
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

var state = { loaded: false, list: [], rows: [], byRef: {}, facilityById: {}, facilities: {}, referIds: {} };

/* ───────────── facilities ───────────── */

function servicesOf(f) {
  return (f && f.services) || {};
}

// Milk banks and facilities that give donor milk
function givesDonorMilk(f) {
  var s = servicesOf(f);
  return f.participating === true && (s.milkBank === true || s.providesDonorMilk === true);
}

function givesSupport(f) {
  return f.participating === true && servicesOf(f).lactationServices === true && !givesDonorMilk(f);
}

// Hasn't reported its services yet (every facility, until it shares them)
function notReported(f) {
  var s = servicesOf(f);
  return s.milkBank == null && s.providesDonorMilk == null && s.lactationServices == null;
}

function hasDonorMilkReport(f) {
  return donorMilk(f) !== "unknown";
}

function donorMilkWord(f) {
  return hasDonorMilkReport(f) ? DONOR_MILK[donorMilk(f)].label.toLowerCase() : "not reported";
}

// "limited on Sep 22, 2026"
function lastReported(f) {
  var when = formatDate(facilityUpdatedAt(f));
  return donorMilkWord(f) + (when ? " on " + when : "");
}

/* ───────────── what a request says ───────────── */

function contactOf(s) {
  return s.contact || {};
}

function detailsOf(s) {
  return s.details || {};
}

// "Preterm, low birth weight, in the NICU, admitted now"
function reasonText(d) {
  var reasons = Array.isArray(d.reasons) ? d.reasons : (d.reasons ? [d.reasons] : []);
  var parts = reasons.map(function (r) { return REASONS[r] || String(r); });
  if (ADMITTED[d.admitted]) parts.push(ADMITTED[d.admitted]);
  return capitalize(parts.join(", "));
}

// "Baby Ester, 4 to 6 months, 300ml a day, has a doctor's referral"
// Without a name the age still says whose it is: "Baby 0 to 7 days"
function babyText(d) {
  var parts = [];
  var babyName = d.babyName ? String(d.babyName).trim() : "";
  var age = BABY_AGE[d.babyAge] || "";
  if (babyName) parts.push(babyName);
  if (age) parts.push(babyName ? age : "Baby " + age);
  if (d.amountNeeded) parts.push(String(d.amountNeeded).trim());
  if (d.hasReferral === "yes") parts.push("has a doctor's referral");
  return capitalize(parts.join(", "));
}

function needChip(d) {
  var urgency = URGENCY[d.urgency];
  if (urgency) return '<span class="mw-chip mw-chip--' + urgency.tone + '">' + esc(urgency.label) + "</span>";
  return '<span class="mw-chip mw-chip--brand">' + esc(capitalize(TYPES.request.verb)) + "</span>";
}

function relationshipText(d) {
  return d.relationship && d.relationship !== "mother" ? (RELATIONSHIP[d.relationship] || "") : "";
}

function facilityNote(s, id) {
  var f = state.facilities[id || s.facilityId];
  if (!f || !givesDonorMilk(f)) return "";
  if (!hasDonorMilkReport(f)) return "Donor milk not reported yet";
  return "Last reported donor milk: " + lastReported(f);
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
    (name ? "Hi " + name + ", this is MOWMMAS. " : "Hi, this is MOWMMAS. ") + "We received your request for donor milk. We'll text you the facility to contact. - MOWMMAS",
    (first ? "Hi " + first + ", this is MOWMMAS. " : "Hi, this is MOWMMAS. ") + "We received your request for donor milk. We'll text you the facility to contact. - MOWMMAS",
    "MOWMMAS: We received your request for donor milk. We'll text you the facility to contact."
  ]);
}

function searchText(s) {
  var c = contactOf(s);
  var d = detailsOf(s);
  var urgency = URGENCY[d.urgency];
  return [
    s.ref, c.name, c.mobile, formatMobile(c.mobile), c.barangay, c.municipality, c.email,
    s.facilityName, s.referral && s.referral.facilityName, s.statusLabel, plainText(submissionChip(s)),
    urgency ? urgency.label : "", reasonText(d), babyText(d), relationshipText(d), formatDate(s.createdAt)
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
  mother += sub(relationshipText(d));

  var place = c.barangay
    ? esc(c.barangay) + sub(c.municipality)
    : (c.municipality ? esc(c.municipality) : muted("Not given"));

  var need = needChip(d) + sub(reasonText(d)) + sub(babyText(d));

  // Referred: where to. Not yet: the facility the request was sent to, marked as the mother's choice.
  var r = s.referral;
  var facility = r && r.facilityName
    ? esc(r.facilityName) + sub("Referred " + formatDate(r.referredAt)) + sub(facilityNote(s, r.facilityId))
    : s.facilityName
      ? esc(s.facilityName) + sub("Mother's choice, not referred yet") + sub(facilityNote(s))
      : muted("Not yet referred");

  var date = s.createdAt
    ? '<time datetime="' + esc(isoDay(s.createdAt)) + '">' + esc(formatDate(s.createdAt)) + "</time>"
    : muted("Not given");

  var wanted = (r && r.facilityId) || s.facilityId;
  var referTo = state.referIds[wanted] ? wanted : "";
  var context = esc(name ? name + " · " + s.ref : s.ref);
  var actions =
    '<button class="mw-link" type="button" data-modal-open="submission_modal" data-modal-context="' + context + '">View<span class="mw-visually-hidden"> request from ' + esc(label) + "</span></button>";
  // A finished request (completed, closed or declined) can't be referred
  if (!isFinalStatus(s.status)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="refer_modal" data-modal-context="' + context + '"' +
      ' data-modal-field-refer_facility="' + esc(referTo) + '">Refer to facility<span class="mw-visually-hidden"> for ' + esc(label) + "</span></button>";
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
      "<td>" + need + "</td>" +
      "<td>" + facility + "</td>" +
      '<td class="mw-table__nowrap">' + date + "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
      '<td class="mw-table__js"><div class="mw-table__actions mw-table__actions--stack">' + actions + "</div></td>" +
    "</tr>"
  );
}

function render() {
  if (!state.loaded) return;
  // Every word typed must appear somewhere in the row (name, mobile, place, need, facility, status…).
  var words = page.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  var shown = state.rows.filter(function (row) {
    return words.every(function (word) { return row.text.indexOf(word) !== -1; });
  });

  page.tbody.innerHTML = shown.map(function (row) { return row.html; }).join("");
  page.caption.textContent = "Milk requests, " + shown.length + (shown.length === 1 ? " record" : " records");
  page.wrap.hidden = shown.length === 0;

  var none = state.rows.length === 0;
  emptyTitle.textContent = none ? "No milk requests yet" : EMPTY_SEARCH.title;
  emptyText.textContent = none ? "When a mother or family sends the donor milk request form, it shows here." : EMPTY_SEARCH.text;
  emptyLink.hidden = none;
  page.empty.hidden = shown.length !== 0;
}

/* ───────────── refer and send lists ───────────── */

function addGroup(label, list, textFor) {
  if (!list.length) return;
  var group = document.createElement("optgroup");
  group.label = label;
  list.forEach(function (f) {
    var option = document.createElement("option");
    option.value = f.id;
    option.textContent = textFor(f);
    group.appendChild(option);
  });
  page.referSelect.appendChild(group);
}

function fillReferList(facilities) {
  state.facilities = {};
  facilities.forEach(function (f) { state.facilities[f.id] = f; });

  var milk = facilities.filter(givesDonorMilk);
  var support = facilities.filter(givesSupport);
  var unknown = facilities.filter(function (f) { return !givesDonorMilk(f) && !givesSupport(f) && notReported(f); });
  state.referIds = {};
  milk.concat(support, unknown).forEach(function (f) { state.referIds[f.id] = f; });

  var placeholder = page.referSelect.querySelector('option[value=""]');
  page.referSelect.innerHTML = "";
  page.referSelect.appendChild(placeholder);
  var where = function (f) { return f.name + (f.municipality ? " · " + f.municipality : ""); };
  addGroup("Milk banks and donor milk providers", milk, function (f) {
    return f.name + " (donor milk: " + donorMilkWord(f) + ")";
  });
  addGroup("Breastfeeding support", support, where);
  addGroup("Services not reported yet", unknown, where);

  REFER_HINT = milk.length || support.length
    ? "Donor milk shows what each facility last reported. The facility confirms it with the mother."
    : "No facility has reported its services yet. Call the facility to check before referring.";
  if (!milk.length && !support.length && !unknown.length) REFER_HINT = "No facility can take referrals right now. Update a facility's services on the Facilities page.";
  page.referHint.textContent = REFER_HINT;
}

// What the chosen facility last reported, under the list
function referHintFor(id) {
  var f = state.referIds[id];
  if (!f) return REFER_HINT;
  if (notReported(f) && !givesDonorMilk(f)) return f.name + " hasn't reported its services yet. Call the facility to check before referring.";
  if (givesDonorMilk(f)) {
    if (!hasDonorMilkReport(f)) return f.name + " hasn't reported its donor milk yet. The facility confirms it with the mother.";
    return f.name + " last reported donor milk as " + lastReported(f) + ". The facility confirms it with the mother.";
  }
  return f.name + " gives breastfeeding support" +
    (servicesOf(f).providesDonorMilk === false ? " and doesn't give donor milk." : ". It hasn't reported giving donor milk.");
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
  // her latest milk request with that number
  contact: function (key) {
    var s = state.list.filter(function (x) { return mobileKey(contactOf(x).mobile) === key; })[0];
    return s ? { name: contactOf(s).name || null, ref: s.ref } : null;
  }
});

setUpRefer({
  modal: page.referModal,
  select: page.referSelect,
  note: document.getElementById("refer_note"),
  noun: "milk request",
  submission: function (ref) { return state.byRef[ref] || null; },
  facility: function (id) { return state.referIds[id] || null; },
  onOpen: function (s) {
    page.referHint.textContent = referHintFor(page.referSelect.value);
    if (s && s.facilityName && !state.referIds[s.facilityId] && Object.keys(state.referIds).length) {
      page.referHint.textContent = REFER_HINT + " The request was sent to " + s.facilityName + ", which isn't on this list.";
    }
  },
  onSaved: replaceSubmission
});
page.referSelect.addEventListener("change", function () {
  page.referHint.textContent = referHintFor(page.referSelect.value);
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
  page.tbody.innerHTML = '<tr><td colspan="8"><span class="mw-text-muted">Loading milk requests…</span></td></tr>';
}

domReady.then(function () {
  var cachedFacs = cachedFacilities();
  var cachedSubs = cachedSubmissions("request");
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
    return Promise.allSettled([getSubmissions("request"), getFacilities()]);
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
      fail(submissions.reason, "milk requests");
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
    fail(error, "milk requests");
    if (state.loaded) view.openFromLink({ fresh: false });
  });
