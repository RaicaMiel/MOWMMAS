/* ==========================================================================
   MOWMMAS Admin · Referrals

   Rows       every submission with referral information (referral.facilityId),
              whatever its form: donation, receiving or question. Newest
              referral first, 10 a page (admin-ui.js createPager).
   Filters    search; Referred to (the facilities that appear in referrals);
              Inquiry type (admin-data.js INQUIRY_TYPES, through inquiryType())
   Referred to
              the facility the mother was directed to, with its phone number
              from facilities/* when known, and the facility she chose on her
              form when it's a different one. MOWMMAS gives her the
              information; she contacts the facility herself. Nothing is sent
              to the facility.
   Review     everything she sent, and the status (admin-submission.js);
              ?ref=<reference> opens it for that referral

   Referrals are sent from Service Inquiries; this page only lists them.
   mowmmas.js opens the dialogs from the rows and fills in their fields.
   Send SMS   texts her through PhilSMS (admin-sms.js); the message starts from
              the Follow-up reminder template (SMS page), with her name, the
              referred facility and its phone number filled in
   ========================================================================== */

import { ready, esc, showPageError, errorMessage } from "./admin-session.js";
import {
  getFacilities,
  getSubmissions,
  cachedFacilities,
  cachedSubmissions,
  submissionChip,
  isFinalStatus,
  INQUIRY_TYPES,
  INQUIRY_TYPE_ORDER,
  inquiryType,
  FORM_KINDS,
  formatDate,
  isoDay
} from "./admin-data.js";
import { domReady, formatMobile, mobileKey, firstName, plainText, muted, sub, createPager } from "./admin-ui.js";
import { setUpSubmissionView, ANSWERS } from "./admin-submission.js";
import { setUpSendDialog, getSmsTemplates, fillTemplateToFit, SMS_TEMPLATES } from "./admin-sms.js";

var page = {
  filters: document.querySelector("form.mw-filters"),
  search: document.getElementById("referral_search"),
  facility: document.getElementById("referral_facility"),
  type: document.getElementById("referral_type"),
  wrap: document.querySelector(".mw-table-wrap"),
  caption: document.querySelector(".mw-table caption"),
  tbody: document.querySelector(".mw-table tbody"),
  empty: document.querySelector(".mw-card .mw-empty"),
  sendModal: document.getElementById("send_modal"),
  sendRecipient: document.getElementById("send_recipient")
};

var emptyTitle = page.empty.querySelector(".mw-empty__title");
var emptyText = page.empty.querySelector(".mw-empty__text");
var inquiriesLink = page.empty.querySelector("[data-empty-inquiries]");
var clearLink = page.empty.querySelector("[data-clear-filters]");
var EMPTY_NONE = { title: emptyTitle.textContent, text: emptyText.textContent };
var EMPTY_FILTERED = {
  title: "No referrals match these filters",
  text: "Try another facility or inquiry type, or clear the filters to see every referral."
};

// list: the referred submissions, newest referral first; rows: their table rows
var state = { loaded: false, list: [], rows: [], byRef: {}, facilityById: {} };

var pager = createPager({ after: page.wrap, label: "Referrals pages", onChange: function () { render(); } });

// The Inquiry type filter: the four types, in their order
INQUIRY_TYPE_ORDER.forEach(function (key) {
  var t = INQUIRY_TYPES[key];
  if (!t) return;
  var option = document.createElement("option");
  option.value = key;
  option.textContent = t.label;
  page.type.appendChild(option);
});

/* ───────────── what a referral says ───────────── */

var time = function (iso) { return Date.parse(iso) || 0; };

function contactOf(s) {
  return s.contact || {};
}

function referralOf(s) {
  return s.referral || {};
}

function hasReferral(s) {
  return !!(s && s.referral && s.referral.facilityId);
}

function newestReferralFirst(a, b) {
  return time(referralOf(b).referredAt) - time(referralOf(a).referredAt) ||
    time(b.createdAt) - time(a.createdAt) ||
    String(b.ref).localeCompare(String(a.ref));
}

function typeKey(s) {
  var key = inquiryType(s);
  return INQUIRY_TYPES[key] ? key : "other";
}

function typeLabel(s) {
  var t = INQUIRY_TYPES[typeKey(s)];
  return t ? t.label : "";
}

// The name the mother was given (saved with the referral), else the facility's name now
function facilityName(s) {
  var r = referralOf(s);
  var f = state.facilityById[r.facilityId];
  return String(r.facilityName || (f && f.name) || "").trim();
}

// The referred facility's phone number from facilities/* (landline first, as in the SMS templates), or ""
function facilityPhone(id) {
  var f = state.facilityById[id];
  var raw = f && (f.contactNumber || f.smsNumber);
  return raw ? formatMobile(raw) : "";
}

// The facility she chose on her form, when it isn't the one she was referred to, else ""
function otherChoice(s) {
  var chose = String(s.facilityName || "").trim();
  if (!chose) return "";
  var same = s.facilityId ? s.facilityId === referralOf(s).facilityId : chose === facilityName(s);
  return same ? "" : chose;
}

// The Follow-up reminder template (SMS page)
function startingTemplate(key) {
  var t = SMS_TEMPLATES.filter(function (x) { return x.key === key; })[0];
  return t ? t.text : "";
}
var followupTemplate = startingTemplate("followup_reminder");

// Her complete name; her first name only if the complete one makes it longer than one SMS
function smsFor(s) {
  var name = String(contactOf(s).name || "").trim();
  return fillTemplateToFit(followupTemplate, {
    name: name,
    firstName: firstName(name),
    facility: facilityName(s),
    phone: facilityPhone(referralOf(s).facilityId)
  });
}

function searchText(s) {
  var c = contactOf(s);
  var r = referralOf(s);
  var d = s.details || {};
  return [
    s.ref, c.name, c.mobile, formatMobile(c.mobile), c.barangay, c.municipality, c.email,
    facilityName(s), facilityPhone(r.facilityId), otherChoice(s), r.referredBy, r.note,
    typeLabel(s), FORM_KINDS[s.type], s.type === "inquire" ? ANSWERS.inquire.topic[d.topic] : "",
    s.statusLabel, plainText(submissionChip(s)), formatDate(r.referredAt)
  ].join(" ").toLowerCase();
}

/* ───────────── rows ───────────── */

function rowHtml(s) {
  var c = contactOf(s);
  var r = referralOf(s);
  var name = String(c.name || "").trim();
  var label = name || s.ref;
  var mobile = formatMobile(c.mobile);

  var when = formatDate(r.referredAt)
    ? '<time datetime="' + esc(isoDay(r.referredAt)) + '">' + esc(formatDate(r.referredAt)) + "</time>"
    : muted("Not recorded");

  var mother = name
    ? '<span class="mw-table__name">' + esc(name) + "</span>"
    : '<span class="mw-table__name mw-text-muted">Name not given</span>';
  mother += mobile ? '<span class="mw-table__sub mw-table__nowrap">' + esc(mobile) + "</span>" : sub("No mobile number");

  var type = esc(typeLabel(s)) + sub(FORM_KINDS[s.type]);

  var phone = facilityPhone(r.facilityId);
  var chose = otherChoice(s);
  var facility = (facilityName(s) ? esc(facilityName(s)) : muted("Name not recorded")) +
    (phone ? '<span class="mw-table__sub mw-table__nowrap">' + esc(phone) + "</span>" : "") +
    (chose ? sub("Mother chose " + chose) : "");

  var by = r.referredBy ? esc(r.referredBy) : muted("Not recorded");

  var context = esc(name ? name + " · " + s.ref : s.ref);
  var actions =
    '<button class="mw-link" type="button" data-modal-open="submission_modal" data-modal-context="' + context + '">Review<span class="mw-visually-hidden"> referral for ' + esc(label) + "</span></button>";
  if (mobileKey(c.mobile)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="send_modal"' +
      ' data-modal-field-send_recipient="' + esc(mobileKey(c.mobile)) + '"' +
      // A completed or closed referral gets no reminder: the message starts empty
      ' data-modal-field-send_type="' + (isFinalStatus(s.status) ? "update" : "reminder") + '"' +
      ' data-modal-field-send_message="' + (isFinalStatus(s.status) ? "" : esc(smsFor(s))) + '">Send SMS<span class="mw-visually-hidden"> to ' + esc(label) + "</span></button>";
  }

  return (
    '<tr data-ref="' + esc(s.ref) + '">' +
      '<td class="mw-table__nowrap">' + when + "</td>" +
      '<td><span class="mw-table__id">' + esc(s.ref) + "</span></td>" +
      "<td>" + mother + "</td>" +
      "<td>" + type + "</td>" +
      "<td>" + facility + "</td>" +
      "<td>" + by + "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
      '<td class="mw-table__js"><div class="mw-table__actions mw-table__actions--stack">' + actions + "</div></td>" +
    "</tr>"
  );
}

function plural(count) {
  return count + (count === 1 ? " record" : " records");
}

function readFilters() {
  return {
    words: page.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean),
    facility: page.facility.value,
    type: page.type.value
  };
}

// Every word typed must appear somewhere in the row (name, mobile, facility, status…)
function shownRows() {
  var filter = readFilters();
  return state.rows.filter(function (row) {
    if (filter.facility && row.facilityId !== filter.facility) return false;
    if (filter.type && row.type !== filter.type) return false;
    return filter.words.every(function (word) { return row.text.indexOf(word) !== -1; });
  });
}

function render() {
  if (!state.loaded) return;
  var shown = shownRows();
  var total = state.rows.length;

  page.tbody.innerHTML = pager.slice(shown).map(function (row) { return row.html; }).join("");
  page.caption.textContent = (shown.length === total
    ? "Referrals, " + plural(total)
    : "Referrals, " + shown.length + " of " + plural(total)) + pager.caption();
  page.wrap.hidden = shown.length === 0;

  var none = total === 0;
  emptyTitle.textContent = none ? EMPTY_NONE.title : EMPTY_FILTERED.title;
  emptyText.textContent = none ? EMPTY_NONE.text : EMPTY_FILTERED.text;
  inquiriesLink.hidden = !none;
  clearLink.hidden = none;
  page.empty.hidden = shown.length !== 0;
}

/* ───────────── filter and send lists ───────────── */

// The facilities that appear in referrals, A to Z, with how many. The one chosen stays chosen.
function fillFacilityFilter() {
  var chosen = page.facility.value;
  var byId = {};
  var list = [];
  state.list.forEach(function (s) {
    var id = referralOf(s).facilityId;
    if (!byId[id]) {
      // newest referral first: the name the latest mother was given
      byId[id] = { id: id, name: facilityName(s) || "Name not recorded", count: 0 };
      list.push(byId[id]);
    }
    byId[id].count += 1;
  });
  list.sort(function (a, b) { return a.name.localeCompare(b.name); });

  var all = page.facility.querySelector('option[value=""]');
  page.facility.innerHTML = "";
  page.facility.appendChild(all);
  list.forEach(function (f) {
    var option = document.createElement("option");
    option.value = f.id;
    option.textContent = f.name + " (" + f.count + ")";
    page.facility.appendChild(option);
  });
  if (chosen && byId[chosen]) page.facility.value = chosen;
  else if (chosen) pager.reset();   // no referral to it anymore: every facility again
}

// Every referred mother's number once. The one chosen stays chosen (new data can arrive while Send SMS is open).
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
   what this page needs. */

setUpSendDialog({
  modal: page.sendModal,
  // her latest referral with that number
  contact: function (key) {
    var s = state.list.filter(function (x) { return mobileKey(contactOf(x).mobile) === key; })[0];
    return s ? { name: contactOf(s).name || null, ref: s.ref } : null;
  }
});

// A link to a referral on another table page, or hidden by the filters: show its row
function revealRef(ref) {
  if (!state.byRef[ref]) return;
  var find = function () { return shownRows().findIndex(function (row) { return row.ref === ref; }); };
  var index = find();
  if (index === -1) {
    page.filters.reset();
    pager.reset();
    index = find();
  }
  pager.show(index);
  render();
}

var view = setUpSubmissionView({
  modal: document.getElementById("submission_modal"),
  submission: function (ref) { return state.byRef[ref] || null; },
  onSaved: replaceSubmission,
  reveal: revealRef
});

/* ───────────── filters: live ───────────── */

function filterChanged() {
  pager.reset();   // new filters: back to page 1
  render();
}

page.filters.addEventListener("submit", function (event) { event.preventDefault(); });
page.search.addEventListener("input", filterChanged);
page.search.addEventListener("search", filterChanged);
page.facility.addEventListener("change", filterChanged);
page.type.addEventListener("change", filterChanged);
clearLink.addEventListener("click", function (event) {
  event.preventDefault();
  page.filters.reset();
  pager.reset();
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

function buildRows() {
  state.byRef = {};
  state.rows = state.list.map(function (s) {
    state.byRef[s.ref] = s;
    return { ref: s.ref, facilityId: referralOf(s).facilityId, type: typeKey(s), html: rowHtml(s), text: searchText(s) };
  });
  fillFacilityFilter();
}

// The facilities' phone numbers (and names, for a referral saved without one)
function useFacilities(facilities) {
  state.facilityById = {};
  facilities.forEach(function (f) { state.facilityById[f.id] = f; });
  if (state.loaded) { buildRows(); render(); }
}

function useSubmissions(submissions) {
  state.list = submissions.filter(hasReferral).sort(newestReferralFirst);
  fillRecipients(state.list);
  buildRows();
  state.loaded = true;
  render();
}

// A status was saved: that submission as it is now, everywhere on the page (row, search, filters)
function replaceSubmission(updated) {
  useSubmissions(state.list.map(function (s) { return s.ref === updated.ref ? updated : s; }));
}

function showLoading() {
  if (state.loaded) return;
  page.wrap.hidden = false;
  page.empty.hidden = true;
  page.tbody.innerHTML = '<tr><td colspan="8"><span class="mw-text-muted">Loading referrals…</span></td></tr>';
}

domReady.then(function () {
  var cachedFacs = cachedFacilities();
  var cachedSubs = cachedSubmissions();
  if (cachedFacs) useFacilities(cachedFacs);
  if (cachedSubs) useSubmissions(cachedSubs);
  else showLoading();
});

Promise.all([ready, domReady])
  .then(function () { return getSmsTemplates(); })
  .then(function (templates) {
    var saved = templates && templates.followup_reminder;
    if (!saved || saved.text === followupTemplate) return;
    followupTemplate = saved.text;
    if (state.loaded) { buildRows(); render(); }
  })
  .catch(function () { /* the starting wording stays; the load below says if sign-in failed */ });

Promise.all([ready, domReady])
  .then(function () {
    page.wrap.setAttribute("aria-busy", "true");
    return Promise.allSettled([getSubmissions(), getFacilities()]);
  })
  .then(function (results) {
    page.wrap.removeAttribute("aria-busy");
    var submissions = results[0];
    var facilities = results[1];

    if (facilities.status === "fulfilled") useFacilities(facilities.value);
    else fail(facilities.reason, "the facilities' phone numbers");

    if (submissions.status !== "fulfilled") {
      fail(submissions.reason, "referrals");
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
    fail(error, "referrals");
    if (state.loaded) view.openFromLink({ fresh: false });
  });
