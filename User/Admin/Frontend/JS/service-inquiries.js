/* ==========================================================================
   MOWMMAS Admin · Service Inquiries

   Rows       submissions/* of every kind, newest first: the donation inquiry
              form, the receiving inquiry form and questions, each with its
              inquiry type (admin-data.js inquiryType)
   Filters    search (every word typed must appear in the row), Inquiry type
              (?type=<key> chooses it, e.g. from the old Donation inquiries
              and Milk requests addresses) and Status; 10 rows a page
   Refer list public facilities (facilities/*), never one listed for
              information only, in the order that fits the inquiry type:
                donation       verified Human Milk Banks, then facilities
                               documented as accepting milk donations, then the others
                receiving      verified Human Milk Banks (with the donor milk
                               they last reported), then documented lactation
                               support, then the others
                breastfeeding  documented lactation support, then the others
                other          every one
              the facility the mother chose (or was referred to) pre-selected
   Send referral
              saves the referral in Firestore (admin-refer.js); an earlier
              status moves on to Information Sent. Not offered once an
              inquiry is completed or closed. Nothing is sent to the facility:
              the mother contacts it herself
   Review     everything the mother sent, and the status (admin-submission.js);
              ?ref=<reference> (the bell) opens it for that inquiry

   mowmmas.js opens the dialogs from the rows and fills in their fields.
   Send SMS   texts her through PhilSMS (admin-sms.js); when a facility is
              known the message starts from the Referral details template
              (SMS page), with her details filled in
   ========================================================================== */

import { ready, esc, showPageError, errorMessage } from "./admin-session.js";
import {
  getFacilities,
  getSubmissions,
  cachedFacilities,
  cachedSubmissions,
  INQUIRY_TYPES,
  INQUIRY_TYPE_ORDER,
  inquiryType,
  FORM_KINDS,
  submissionChip,
  isFinalStatus,
  isVerifiedHmb,
  DONOR_MILK,
  donorMilk,
  facilityUpdatedAt,
  formatDate,
  isoDay
} from "./admin-data.js";
import { domReady, formatMobile, mobileKey, firstName, capitalize, plainText, muted, sub, fitSms, createPager } from "./admin-ui.js";
import { setUpRefer } from "./admin-refer.js";
import { setUpSubmissionView, ANSWERS } from "./admin-submission.js";
import { setUpSendDialog, getSmsTemplates, fillTemplateToFit, SMS_TEMPLATES } from "./admin-sms.js";

// Answers from the mother's forms (User/Mother/Frontend/js/form.js)
var DONATE = ANSWERS.donate;
var REQUEST = ANSWERS.request;
var TOPIC = ANSWERS.inquire.topic;

// A question's excerpt in the Facility column, in characters
var EXCERPT_LENGTH = 80;

var page = {
  filters: document.querySelector("form.mw-filters"),
  search: document.getElementById("inquiry_search"),
  type: document.getElementById("filter_type"),
  status: document.getElementById("filter_status"),
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
var EMPTY_FILTERED = { title: emptyTitle.textContent, text: emptyText.textContent };
var REFER_HINT = page.referHint.textContent;

var state = {
  loaded: false,
  list: [],
  rows: [],             // { ref, kind, final, html, text } per submission, in list order
  byRef: {},
  facilityById: {},
  referable: [],        // the facilities a mother can be referred to, A to Z
  referIds: {},         // id → one of them
  referFailed: false    // the fresh facility list couldn't be read
};

var pager = createPager({ after: page.wrap, label: "Service inquiries pages", onChange: function () { render(); } });

/* ───────────── the Inquiry type filter ─────────────
   Its options come from INQUIRY_TYPES; ?type=<key> chooses one. */

INQUIRY_TYPE_ORDER.forEach(function (key) {
  var option = document.createElement("option");
  option.value = key;
  option.textContent = INQUIRY_TYPES[key].label;
  page.type.appendChild(option);
});

(function typeFromLink() {
  var wanted = String(new URLSearchParams(window.location.search).get("type") || "").trim().toLowerCase();
  if (wanted && Object.prototype.hasOwnProperty.call(INQUIRY_TYPES, wanted)) page.type.value = wanted;
})();

// The address follows the Inquiry type filter, so reloading keeps it
function keepTypeInLink() {
  try {
    var url = new URL(window.location.href);
    if (page.type.value) url.searchParams.set("type", page.type.value);
    else url.searchParams.delete("type");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (error) { /* the address keeps what it had */ }
}

/* ───────────── facilities ───────────── */

function servicesOf(f) {
  return (f && f.services) || {};
}

// A public facility that can get forms (not one listed for information only)
function canRefer(f) {
  return f.participating === true && f.infoOnly !== true;
}

// "Yes — documented" (true) for these services
function hasLactation(f) {
  return servicesOf(f).lactationServices === true;
}

function acceptsDonations(f) {
  return servicesOf(f).acceptsDonations === true;
}

// Documented breastfeeding support, and not a verified milk bank
function givesSupport(f) {
  return hasLactation(f) && !isVerifiedHmb(f);
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

/* ───────────── what an inquiry says ───────────── */

function contactOf(s) {
  return s.contact || {};
}

function detailsOf(s) {
  return s.details || {};
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// Donation inquiry form: "Drop-off on Sep 24, 2026, morning"
function planText(d) {
  var parts = [];
  var how = DONATE.delivery[d.delivery] || "";
  var when = formatDate(d.preferredDate);
  if (how && when) parts.push(how + " on " + when);
  else if (how) parts.push(how);
  else if (when) parts.push("On " + when);
  if (DONATE.preferredTime[d.preferredTime]) parts.push(DONATE.preferredTime[d.preferredTime]);
  return parts.join(", ");
}

// Donation inquiry form: "Estimated 500ml a week, baby 4 to 6 months"
function amountText(d) {
  var parts = [];
  if (d.estimatedVolume) parts.push("Estimated " + String(d.estimatedVolume).trim());
  if (DONATE.babyAge[d.babyAge]) parts.push((parts.length ? "baby " : "Baby ") + DONATE.babyAge[d.babyAge]);
  return parts.join(", ");
}

// Receiving inquiry form: "Preterm, low birth weight, in the NICU, admitted now"
function reasonText(d) {
  var reasons = Array.isArray(d.reasons) ? d.reasons : (d.reasons ? [d.reasons] : []);
  var parts = reasons.map(function (r) { return REQUEST.reasons[r] || String(r); });
  if (REQUEST.admitted[d.admitted]) parts.push(REQUEST.admitted[d.admitted]);
  return capitalize(parts.join(", "));
}

// Receiving inquiry form: "Baby Ester, 4 to 6 months, 300ml a day, has a doctor's referral"
// Without a name the age still says whose it is: "Baby 0 to 7 days"
function babyText(d) {
  var parts = [];
  var babyName = d.babyName ? String(d.babyName).trim() : "";
  var age = REQUEST.babyAge[d.babyAge] || "";
  if (babyName) parts.push(babyName);
  if (age) parts.push(babyName ? age : "Baby " + age);
  if (d.amountNeeded) parts.push(String(d.amountNeeded).trim());
  if (d.hasReferral === "yes") parts.push("has a doctor's referral");
  return capitalize(parts.join(", "));
}

function needChip(d) {
  var urgency = REQUEST.urgency[d.urgency];
  if (urgency) return '<span class="mw-chip mw-chip--' + esc(urgency.tone) + '">' + esc(urgency.label) + "</span>";
  return '<span class="mw-chip mw-chip--brand">' + esc("Urgency not given") + "</span>";
}

// Who sent a receiving inquiry, when it wasn't the mother: "Father"
function relationshipText(s) {
  var d = detailsOf(s);
  if (s.type !== "request") return "";
  return d.relationship && d.relationship !== "mother" ? (REQUEST.relationship[d.relationship] || "") : "";
}

// Question: "Breastfeeding help"
function topicText(d) {
  return TOPIC[d.topic] || (d.topic ? String(d.topic) : "");
}

// Question: its first words, on one line: “How do I store milk before …”
function questionExcerpt(d) {
  var question = String(d.question || "").replace(/\s+/g, " ").trim();
  if (question.length <= EXCERPT_LENGTH) return question ? "“" + question + "”" : "";
  var cut = question.slice(0, EXCERPT_LENGTH);
  // Cut inside a word: end at the word before it (a single long word is cut as it is)
  if (question.charAt(EXCERPT_LENGTH) !== " ") cut = cut.replace(/ \S*$/, "") || cut;
  return "“" + cut.trim() + "…”";
}

// "Question · Breastfeeding help"
function formText(s) {
  var form = FORM_KINDS[s.type] || "";
  var topic = s.type === "inquire" ? topicText(detailsOf(s)) : "";
  return [form, topic].filter(Boolean).join(" · ");
}

// Donor milk is shown only for a verified milk bank, and only for a receiving inquiry
function facilityNote(s, id) {
  if (inquiryType(s) !== "receiving") return "";
  var f = state.facilityById[id || s.facilityId];
  if (!f || !isVerifiedHmb(f)) return "";
  if (!hasDonorMilkReport(f)) return "Donor milk not reported yet";
  return "Last reported donor milk: " + lastReported(f);
}

// What she sent that matters most, under the facility
function detailsHtml(s) {
  var d = detailsOf(s);
  if (s.type === "donate") return sub(planText(d)) + sub(amountText(d));
  if (s.type === "request") return '<span class="mw-table__sub">' + needChip(d) + "</span>" + sub(reasonText(d)) + sub(babyText(d));
  if (s.type === "inquire") return sub(questionExcerpt(d));
  return "";
}

// The Referral details template (SMS page), for the facility she was referred to (or chose)
var referralTemplate = SMS_TEMPLATES[0].text;

// What she sent, for the message when no facility is known yet
var RECEIVED = { donate: "donation inquiry", request: "receiving inquiry" };

// Her complete name; her first name only if the complete one makes it longer than one SMS
function smsFor(s) {
  var name = String(contactOf(s).name || "").trim();
  var first = firstName(name);
  var r = s.referral && s.referral.facilityId ? s.referral : null;
  // A question only gets the referral wording once a referral is saved (every question names a facility)
  var facility = (r && r.facilityName) || (s.type !== "inquire" ? s.facilityName : "");
  if (facility) {
    var f = state.facilityById[(r && r.facilityId) || s.facilityId];
    return fillTemplateToFit(referralTemplate, { name: name, firstName: first, facility: facility, phone: f && (f.contactNumber || f.smsNumber) });
  }
  var hi = function (who) { return who ? "Hi " + who + ", this is MOWMMAS. " : "Hi, this is MOWMMAS. "; };
  if (s.type === "inquire") {
    return fitSms([
      hi(name) + "We received your question and will reply soon. - MOWMMAS",
      hi(first) + "We received your question and will reply soon. - MOWMMAS",
      "MOWMMAS: We received your question and will reply soon."
    ]);
  }
  var what = RECEIVED[s.type] || "inquiry";
  return fitSms([
    hi(name) + "We received your " + what + ". MOWMMAS will review it and text you the next steps. - MOWMMAS",
    hi(first) + "We received your " + what + ". MOWMMAS will review it and text you the next steps. - MOWMMAS",
    "MOWMMAS: We received your " + what + ". MOWMMAS will review it and text you the next steps."
  ]);
}

function searchText(s) {
  var c = contactOf(s);
  var d = detailsOf(s);
  var kind = INQUIRY_TYPES[inquiryType(s)];
  var parts = [
    s.ref, c.name, c.mobile, formatMobile(c.mobile), c.barangay, c.municipality, c.email,
    s.facilityName, s.referral && s.referral.facilityName, s.statusLabel, plainText(submissionChip(s)),
    kind ? kind.label : "", formText(s), formatDate(s.createdAt)
  ];
  if (s.type === "donate") parts.push(planText(d), amountText(d));
  if (s.type === "request") {
    var urgency = REQUEST.urgency[d.urgency];
    parts.push(urgency ? urgency.label : "", reasonText(d), babyText(d), relationshipText(s));
  }
  if (s.type === "inquire") parts.push(d.question);
  return parts.join(" ").toLowerCase();
}

/* ───────────── rows ───────────── */

function rowHtml(s) {
  var c = contactOf(s);
  var name = c.name || "";
  var about = name ? " inquiry from " + name : " inquiry " + s.ref;
  var mobile = formatMobile(c.mobile);

  var mother = name
    ? '<span class="mw-table__name">' + esc(name) + "</span>"
    : '<span class="mw-table__name mw-text-muted">Name not given</span>';
  mother += mobile ? '<span class="mw-table__sub mw-table__nowrap">' + esc(mobile) + "</span>" : sub("No mobile number");
  mother += sub(relationshipText(s));

  var kind = INQUIRY_TYPES[inquiryType(s)];
  var type = esc(kind ? kind.label : "") + sub(formText(s));

  // Referred: where to. Not yet: the facility the mother chose, marked as her choice.
  var r = s.referral;
  var referredOn = r && r.referredAt ? formatDate(r.referredAt) : "";
  var facility = r && r.facilityName
    ? esc(r.facilityName) + sub("Referred" + (referredOn ? " " + referredOn : "")) + sub(facilityNote(s, r.facilityId))
    : s.facilityName
      ? esc(s.facilityName) + sub("Mother's choice, not referred yet") + sub(facilityNote(s))
      : muted("Not yet referred");
  facility += detailsHtml(s);

  var date = s.createdAt
    ? '<time datetime="' + esc(isoDay(s.createdAt)) + '">' + esc(formatDate(s.createdAt)) + "</time>"
    : muted("Not given");

  var context = esc(name ? name + " · " + s.ref : s.ref);
  var actions =
    '<button class="mw-link" type="button" data-modal-open="submission_modal" data-modal-context="' + context + '">Review<span class="mw-visually-hidden">' + esc(about) + "</span></button>";
  // A finished inquiry (completed or closed) can't be referred
  if (!isFinalStatus(s.status)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="refer_modal" data-modal-context="' + context + '">' +
      'Send referral<span class="mw-visually-hidden"> for the' + esc(about) + "</span></button>";
  }
  if (mobileKey(c.mobile)) {
    actions +=
      '<button class="mw-link" type="button" data-modal-open="send_modal"' +
      ' data-modal-field-send_recipient="' + esc(mobileKey(c.mobile)) + '"' +
      ' data-modal-field-send_type="' + ((r && r.facilityName) || (s.type !== "inquire" && s.facilityName) ? "referral" : "update") + '"' +
      ' data-modal-field-send_message="' + esc(smsFor(s)) + '">Send SMS<span class="mw-visually-hidden"> about the' + esc(about) + "</span></button>";
  }

  return (
    '<tr data-ref="' + esc(s.ref) + '">' +
      '<td><span class="mw-table__id">' + esc(s.ref) + "</span></td>" +
      "<td>" + mother + "</td>" +
      "<td>" + type + "</td>" +
      "<td>" + facility + "</td>" +
      '<td class="mw-table__nowrap">' + date + "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
      '<td class="mw-table__js"><div class="mw-table__actions mw-table__actions--stack">' + actions + "</div></td>" +
    "</tr>"
  );
}

/* ───────────── filters and the table ───────────── */

function readFilters() {
  return {
    words: page.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean),
    type: page.type.value,
    status: page.status.value
  };
}

function matches(row, filter) {
  if (filter.type && row.kind !== filter.type) return false;
  if (filter.status === "open" && row.final) return false;
  if (filter.status === "final" && !row.final) return false;
  // Every word typed must appear somewhere in the row (name, mobile, place, type, facility, status…).
  return filter.words.every(function (word) { return row.text.indexOf(word) !== -1; });
}

function shownRows() {
  var filter = readFilters();
  return state.rows.filter(function (row) { return matches(row, filter); });
}

function render() {
  if (!state.loaded) return;
  var list = shownRows();
  var total = state.rows.length;

  page.tbody.innerHTML = pager.slice(list).map(function (row) { return row.html; }).join("");
  page.caption.textContent = (list.length === total
    ? "Service inquiries, " + plural(total, "record")
    : "Service inquiries, " + list.length + " of " + plural(total, "record")) + pager.caption();
  page.wrap.hidden = list.length === 0;

  var none = total === 0;
  emptyTitle.textContent = none ? "No inquiries yet" : EMPTY_FILTERED.title;
  emptyText.textContent = none ? "When a mother sends an inquiry form or a question, it shows here." : EMPTY_FILTERED.text;
  emptyLink.hidden = none;
  page.empty.hidden = list.length !== 0;
}

function clearFilters() {
  page.search.value = "";
  page.type.value = "";
  page.status.value = "";
  keepTypeInLink();
}

// ?ref=<reference>: the table page that has its row (with every inquiry shown if the filters hide it)
function reveal(ref) {
  if (!state.byRef[ref]) return;
  var find = function () { return shownRows().findIndex(function (row) { return row.ref === ref; }); };
  var index = find();
  if (index === -1) {
    clearFilters();
    index = find();
  }
  pager.show(index);
  render();
}

page.filters.addEventListener("submit", function (event) { event.preventDefault(); });
// New filters: back to page 1
function filtersChanged() {
  pager.reset();
  render();
}
page.search.addEventListener("input", filtersChanged);
page.search.addEventListener("search", filtersChanged);
page.type.addEventListener("change", function () {
  keepTypeInLink();
  filtersChanged();
});
page.status.addEventListener("change", filtersChanged);
emptyLink.addEventListener("click", function (event) {
  event.preventDefault();
  clearFilters();
  filtersChanged();
  page.search.focus();
});

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

function where(f) {
  return f.name + (f.municipality ? " · " + f.municipality : "");
}

// The facilities to offer for an inquiry type, in groups, best fit first
function referGroups(kind) {
  var listed = state.referable;
  var banks = listed.filter(isVerifiedHmb);
  if (kind === "donation") {
    return [
      { label: "Verified Human Milk Banks", list: banks, text: where },
      { label: "Accept milk donations (documented)", list: listed.filter(function (f) { return !isVerifiedHmb(f) && acceptsDonations(f); }), text: where },
      { label: "Other facilities", list: listed.filter(function (f) { return !isVerifiedHmb(f) && !acceptsDonations(f); }), text: where }
    ];
  }
  if (kind === "receiving") {
    return [
      { label: "Verified Human Milk Banks", list: banks, text: function (f) { return f.name + " (donor milk: " + donorMilkWord(f) + ")"; } },
      { label: "Lactation support documented", list: listed.filter(givesSupport), text: where },
      { label: "Other facilities", list: listed.filter(function (f) { return !isVerifiedHmb(f) && !givesSupport(f); }), text: where }
    ];
  }
  if (kind === "breastfeeding") {
    return [
      { label: "Lactation support documented", list: listed.filter(hasLactation), text: where },
      { label: "Other facilities", list: listed.filter(function (f) { return !hasLactation(f); }), text: where }
    ];
  }
  return [{ label: "Published facilities", list: listed, text: where }];
}

// The hint under the list for an inquiry type
function listHint(kind, groups) {
  var loadNote = state.referFailed ? " This list may be out of date: refresh the page to load the latest." : "";
  if (!state.referable.length) {
    return state.referFailed
      ? "The facility list couldn't be loaded. Refresh the page to try again."
      : "No facility can take referrals right now. Publish a facility on the Health Facilities page.";
  }
  var confirm = " The mother contacts the facility to confirm availability, requirements and schedule.";
  var first = groups[0].list.length > 0;
  if (kind === "donation") {
    if (first) return "Verified Human Milk Banks are listed first." + confirm + loadNote;
    if (groups[1].list.length) return "No verified Human Milk Bank is listed yet. Facilities documented as accepting milk donations are listed first." + confirm + loadNote;
    return "No verified Human Milk Bank is listed yet. Call the facility to check before referring." + loadNote;
  }
  if (kind === "receiving") {
    return (first
      ? "Verified Human Milk Banks are listed first." + confirm
      : "No verified Human Milk Bank is listed yet. Call the facility to check before referring.") + loadNote;
  }
  if (kind === "breastfeeding") {
    return (first
      ? "Facilities with documented lactation support are listed first." + confirm
      : "No facility has documented lactation support yet. Call the facility to check before referring.") + loadNote;
  }
  return confirm.trim() + loadNote;
}

var referKind = "other";   // the inquiry type of the submission in the Refer dialog

function fillReferList(kind) {
  referKind = kind;
  var groups = referGroups(kind);
  var placeholder = page.referSelect.querySelector('option[value=""]');
  page.referSelect.innerHTML = "";
  page.referSelect.appendChild(placeholder);
  groups.forEach(function (g) { addGroup(g.label, g.list, g.text); });
  REFER_HINT = listHint(kind, groups);
  page.referHint.textContent = REFER_HINT;
}

// What MOWMMAS knows about the chosen facility, under the list
function referHintFor(id) {
  var f = state.referIds[id];
  if (!f) return REFER_HINT;
  if (referKind === "receiving") {
    if (isVerifiedHmb(f)) {
      if (!hasDonorMilkReport(f)) return f.name + " is a verified Human Milk Bank. It hasn't reported its donor milk yet. The mother contacts the facility to confirm it.";
      return f.name + " is a verified Human Milk Bank. It last reported donor milk as " + lastReported(f) + ". The mother contacts the facility to confirm it.";
    }
    if (givesSupport(f)) return f.name + " has documented lactation support. It is not a verified Human Milk Bank.";
    return f.name + "'s services are not verified yet. Call the facility to check before referring.";
  }
  if (referKind === "donation") {
    if (isVerifiedHmb(f)) return f.name + " is a verified Human Milk Bank. The mother contacts the facility to confirm requirements and schedule.";
    if (acceptsDonations(f)) return f.name + " is documented as accepting milk donations. It is not a verified Human Milk Bank.";
    return f.name + " isn't documented as accepting milk donations. Call the facility to check before referring.";
  }
  if (referKind === "breastfeeding") {
    if (hasLactation(f)) return f.name + " has documented lactation support. The mother contacts the facility to confirm availability and schedule.";
    return f.name + " has no documented lactation support. Call the facility to check before referring.";
  }
  return REFER_HINT;
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
  // her latest inquiry with that number
  contact: function (key) {
    var s = state.list.filter(function (x) { return mobileKey(contactOf(x).mobile) === key; })[0];
    return s ? { name: contactOf(s).name || null, ref: s.ref } : null;
  }
});

setUpRefer({
  modal: page.referModal,
  select: page.referSelect,
  note: document.getElementById("refer_note"),
  submission: function (ref) { return state.byRef[ref] || null; },
  facility: function (id) { return state.referIds[id] || null; },
  // The list for this inquiry type, with the facility she chose (or was referred to) chosen
  onOpen: function (s) {
    fillReferList(s ? inquiryType(s) : "other");
    var wanted = s ? (s.referral && s.referral.facilityId) || s.facilityId : "";
    page.referSelect.value = wanted && state.referIds[wanted] ? wanted : "";
    page.referHint.textContent = referHintFor(page.referSelect.value);
    if (s && s.facilityName && !state.referIds[s.facilityId] && state.referable.length) {
      page.referHint.textContent = REFER_HINT + " The mother chose " + s.facilityName + ", which isn't on this list.";
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
  onSaved: replaceSubmission,
  reveal: reveal
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

function setReferable(facilities) {
  state.referable = facilities.filter(canRefer);
  state.referIds = {};
  state.referable.forEach(function (f) { state.referIds[f.id] = f; });
}

var pendingFacilities = null;
function useFacilities(facilities) {
  state.facilityById = {};
  facilities.forEach(function (f) { state.facilityById[f.id] = f; });
  // Don't swap the list under an open Refer form; do it when the form closes.
  if (page.referModal.open) pendingFacilities = facilities;
  else setReferable(facilities);
  // The rows name facilities (donor milk, the phone in the SMS)
  if (state.loaded) { buildRows(); render(); }
}
page.referModal.addEventListener("close", function () {
  if (pendingFacilities) { setReferable(pendingFacilities); pendingFacilities = null; }
});

function buildRows() {
  state.byRef = {};
  state.rows = state.list.map(function (s) {
    state.byRef[s.ref] = s;
    return { ref: s.ref, kind: inquiryType(s), final: isFinalStatus(s.status), html: rowHtml(s), text: searchText(s) };
  });
}

// A referral or status was saved: that submission as it is now, everywhere on the page (row, search, filters)
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
  page.tbody.innerHTML = '<tr><td colspan="7"><span class="mw-text-muted">Loading service inquiries…</span></td></tr>';
}

domReady.then(function () {
  var cachedFacs = cachedFacilities();
  var cachedSubs = cachedSubmissions();
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
    return Promise.allSettled([getSubmissions(), getFacilities()]);
  })
  .then(function (results) {
    page.wrap.removeAttribute("aria-busy");
    var submissions = results[0];
    var facilities = results[1];

    if (facilities.status === "fulfilled") {
      state.referFailed = false;
      useFacilities(facilities.value);
    } else {
      fail(facilities.reason, "the facility list for referrals");
      state.referFailed = true;
    }

    if (submissions.status !== "fulfilled") {
      fail(submissions.reason, "service inquiries");
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
    fail(error, "service inquiries");
    if (state.loaded) view.openFromLink({ fresh: false });
  });
