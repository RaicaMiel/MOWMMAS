/* ==========================================================================
   MOWMMAS Admin · SMS notifications

   SMS go out through PhilSMS, sent by the MOWMMAS server (admin-sms.js).
   - Gateway: the banner says whether PhilSMS is connected, and the credit left.
   - Message log: every SMS the MOWMMAS server sent (its data/sms-log.json),
     newest first, 10 a page. One that failed (or wasn't sent) has Resend.
   - Templates: the SMS wording, saved on the MOWMMAS server.
     Edit saves it; Send notification and the Send SMS buttons use it.
   - Registered contacts: the mothers who sent a form (submissions/<ref>),
     one row per mobile number, with the last SMS she got.
   - Send notification: texts one mother; the message starts from the
     template for the type chosen, with her details filled in.
   ========================================================================== */

import { ready, esc, toast, showPageError, errorMessage } from "./admin-session.js";
import {
  getSubmissions,
  cachedSubmissions,
  getFacilities,
  cachedFacilities,
  smsTypeChip,
  smsStatusChip,
  smsNotDelivered,
  formatDate,
  formatDateTime,
  isoDay
} from "./admin-data.js";
import { mobileKey, isMobile, formatMobile, firstName, createPager, hideFormError, holdDialog } from "./admin-ui.js";
import { sendSms, getGateway, getSmsLog, cachedSmsLog, smsLogNote, setUpSendDialog, SMS_TEMPLATES, getSmsTemplates, saveSmsTemplate, fillTemplateToFit } from "./admin-sms.js";

var sendModal = document.getElementById("send_modal");
var sendForm = sendModal && sendModal.querySelector("form");
var recipientSelect = document.getElementById("send_recipient");
var typeSelect = document.getElementById("send_type");
var messageInput = document.getElementById("send_message");
var templateModal = document.getElementById("template_modal");
var templateForm = templateModal && templateModal.querySelector("form");
var templateInput = document.getElementById("template_message");

var banner = document.querySelector(".mw-alert--steps");
var bannerChip = banner && banner.querySelector(".mw-alert__action");

var logPanel = document.getElementById("panel_log");
var logWrap = logPanel && logPanel.querySelector(".mw-table-wrap");
var logBody = logPanel && logPanel.querySelector("tbody");
var logCaption = logPanel && logPanel.querySelector("caption");
var logEmpty = logPanel && logPanel.querySelector(".mw-empty");

var templatesPanel = document.getElementById("panel_templates");
var templatesBody = templatesPanel && templatesPanel.querySelector("tbody");
var templatesCaption = templatesPanel && templatesPanel.querySelector("caption");

var contactsPanel = document.getElementById("panel_contacts");
var contactsWrap = contactsPanel && contactsPanel.querySelector(".mw-table-wrap");
var contactsBody = contactsPanel && contactsPanel.querySelector("tbody");
var contactsCaption = contactsPanel && contactsPanel.querySelector("caption");
var contactsEmpty = contactsPanel && contactsPanel.querySelector(".mw-empty");

var state = {
  submissions: [],
  facilities: {},     // id → facility (for {facility phone})
  log: [],
  contacts: [],
  byKey: {},          // mobile key → contact
  templates: null,    // key → { text, updatedAt, updatedBy }
  logError: null,     // the log couldn't be loaded (and nothing was saved in this tab)
  contactsError: null,
  resending: {}       // ids of SMS being sent again (one resend at a time each)
};

/* ───────────── dates ───────────── */

// "Today, 9:42 AM", "Yesterday, 3:18 PM" or "Sep 21, 11:20 AM", as in the design
function smsTime(iso) {
  var day = isoDay(iso);
  if (!day) return "";
  var today = isoDay(new Date().toISOString());
  var yesterday = isoDay(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  var clock = new Date(Date.parse(iso)).toLocaleTimeString("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
  if (day === today) return "Today, " + clock;
  if (day === yesterday) return "Yesterday, " + clock;
  return formatDateTime(iso);
}

/* ───────────── gateway ───────────── */

function setBanner(tone, text) {
  if (!banner || !bannerChip) return;
  banner.className = "mw-alert mw-alert--steps mw-alert--" + (tone === "success" ? "success" : "info");
  bannerChip.className = "mw-chip mw-chip--" + tone + " mw-alert__action";
  bannerChip.textContent = text;
}

function showGateway() {
  getGateway()
    .then(function (g) {
      if (!g.configured) setBanner("warning", "Gateway: Not set up yet");
      else if (g.connected && g.senderProblem) setBanner("warning", "Gateway: Sender ID " + (g.sender ? '"' + g.sender + '" ' : "") + "not approved yet");
      else if (g.connected) setBanner("success", "Gateway: PhilSMS connected" + (g.balance ? ", " + g.balance + " left" : ""));
      else if (g.problem === "refused") setBanner("danger", "Gateway: PhilSMS refused the key");
      else setBanner("danger", "Gateway: PhilSMS can't be reached");
    })
    .catch(function (error) {
      setBanner("danger", error && error.code === "unreachable" ? "Gateway: MOWMMAS server not running" : "Gateway: Can't be checked");
    });
}

/* ───────────── templates ───────────── */

function templateText(key) {
  var saved = state.templates && state.templates[key];
  if (saved) return saved.text;
  var t = SMS_TEMPLATES.filter(function (x) { return x.key === key; })[0];
  return t ? t.text : "";
}

function renderTemplates() {
  if (!templatesBody) return;
  templatesBody.innerHTML = SMS_TEMPLATES.map(function (t) {
    var saved = state.templates && state.templates[t.key];
    var text = saved ? saved.text : t.text;
    var edited = saved && saved.updatedAt
      ? "Edited " + formatDate(saved.updatedAt) + (saved.updatedBy ? " by " + saved.updatedBy : "")
      : "Default wording";
    return '<tr data-template="' + esc(t.key) + '">' +
      "<td>" +
        '<span class="mw-table__name">' + esc(t.name) + "</span>" +
        '<span class="mw-table__sub">' + esc(edited) + "</span>" +
      "</td>" +
      '<td><span class="mw-chip mw-chip--' + t.tone + '">' + esc(t.event) + "</span></td>" +
      "<td>" + esc(text) + "</td>" +
      '<td class="mw-table__nowrap">' + text.length + " / 160</td>" +
      '<td class="mw-table__js"><button class="mw-link" type="button" data-modal-open="template_modal" data-modal-context="' + esc(t.name) + '" data-modal-value="' + esc(text) + '">Edit<span class="mw-visually-hidden"> ' + esc(t.name) + "</span></button></td>" +
    "</tr>";
  }).join("");
  if (templatesCaption) templatesCaption.textContent = "SMS templates, " + SMS_TEMPLATES.length + " templates";
}

if (templateModal && templateForm) {
  var templateAlert = templateForm.querySelector(".mw-alert--error");
  var templateSave = templateForm.querySelector("button[type='submit']");
  var templateHold = holdDialog(templateModal);
  var templateKey = null;
  var templateOpened = 0;
  var templateSaving = false;

  templateModal.addEventListener("mw:modal-open", function (event) {
    templateOpened += 1;
    var row = event.detail && event.detail.trigger && event.detail.trigger.closest("tr[data-template]");
    templateKey = row ? row.getAttribute("data-template") : null;
    templateHold.release();
    hideFormError(templateModal);
  });

  templateForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (templateSaving || !templateKey) return;
    var text = templateInput.value.trim();
    var showError = function (message) {
      templateAlert.textContent = message;
      templateAlert.hidden = false;
    };
    if (!text) { showError("Write the message first."); return; }
    if (text.length > 160) { showError("Keep it to 160 characters, so it fits in one SMS."); return; }
    var key = templateKey;
    var mine = templateOpened;
    var name = SMS_TEMPLATES.filter(function (t) { return t.key === key; })[0].name;
    templateSaving = true;
    templateHold.hold();
    templateAlert.hidden = true;
    templateSave.disabled = true;
    templateSave.classList.add("is-loading");
    saveSmsTemplate(key, text)
      .then(function (saved) {
        state.templates = state.templates || {};
        state.templates[key] = saved;
        renderTemplates();
        templateHold.release();
        if (templateModal.open && templateOpened === mine) templateModal.close();
        toast(name + " saved. New SMS use this wording.");
      }, function (error) {
        templateHold.release();
        var message = (error && error.message) || "The template couldn't be saved. Try again.";
        if (templateModal.open && templateOpened === mine) showError(message);
        else showPageError(name + " wasn't saved. " + message);
      })
      .then(function () {
        templateSaving = false;
        templateSave.disabled = false;
        templateSave.classList.remove("is-loading");
      });
  });
}

/* ───────────── registered contacts ───────────── */

var ROLES = [
  { type: "donate", label: "Donor", tone: "brand" },
  { type: "request", label: "Requester", tone: "info" },
  { type: "inquire", label: "Inquiry", tone: "" }
];

// One contact per mobile number. Submissions come newest first.
function buildContacts(submissions) {
  var byKey = {};
  var order = [];

  submissions.forEach(function (s) {
    var contact = s.contact || {};
    var key = mobileKey(contact.mobile);
    if (!key) return;

    var entry = byKey[key];
    if (!entry) {
      var r = s.referral && s.referral.facilityId ? s.referral : null;
      entry = byKey[key] = {
        key: key,
        mobile: formatMobile(contact.mobile || key),
        valid: isMobile(key),
        name: contact.name || "",
        barangay: contact.barangay || "",
        town: contact.municipality || "",
        latestRef: s.ref || "",
        referred: Boolean(r),
        facilityId: r ? r.facilityId : s.facilityId || null,
        facilityName: r ? r.facilityName : s.facilityName || null,
        firstAt: s.createdAt || null,
        types: {}
      };
      order.push(entry);
    }
    // Later in the list means older: that's when she first registered.
    if (s.createdAt) entry.firstAt = s.createdAt;
    if (!entry.name && contact.name) entry.name = contact.name;
    if (!entry.barangay && contact.barangay) entry.barangay = contact.barangay;
    if (!entry.town && contact.municipality) entry.town = contact.municipality;
    if (s.type) entry.types[s.type] = true;
  });

  state.byKey = byKey;
  return order;
}

function roleChips(contact) {
  var chips = ROLES.filter(function (role) { return contact.types[role.type]; }).map(function (role) {
    return '<span class="mw-chip' + (role.tone ? " mw-chip--" + role.tone : "") + '">' + role.label + "</span>";
  });
  if (!chips.length) return '<span class="mw-text-muted">Not recorded</span>';
  if (chips.length === 1) return chips[0];
  return '<div class="mw-table__stack">' + chips.join("") + "</div>";
}

// The last SMS to each number
function lastSmsByKey() {
  var out = {};
  state.log.forEach(function (r) {
    var key = mobileKey(r.to);
    if (key && !out[key]) out[key] = r;
  });
  return out;
}

function contactRow(contact, last) {
  var name = contact.name || "Name not given";
  var place = contact.barangay || contact.town || "";
  var placeSub = contact.barangay && contact.town ? '<span class="mw-table__sub">' + esc(contact.town) + "</span>" : "";
  var sms = !contact.valid
    ? '<span class="mw-chip mw-chip--warning">Check number</span>'
    : state.logError && !state.log.length
      ? '<span class="mw-text-muted">Couldn\'t be checked</span>'
      : last
      ? '<div class="mw-table__stack">' + smsStatusChip(last) + '<span class="mw-table__sub mw-table__nowrap">' + esc(smsTime(last.sentAt)) + "</span></div>"
      : smsLogNote()
        // Only the newest SMS were loaded: an older one may be there
        ? '<span class="mw-chip">None among the newest</span>'
        : '<span class="mw-chip">None sent yet</span>';

  return "<tr>" +
    "<td>" +
      '<span class="mw-table__name">' + esc(name) + "</span>" +
      (contact.latestRef ? '<span class="mw-table__sub mw-table__nowrap">Latest: ' + esc(contact.latestRef) + "</span>" : "") +
    "</td>" +
    '<td class="mw-table__nowrap">' + esc(contact.mobile) + "</td>" +
    '<td class="mw-table__nowrap">' + (place ? esc(place) + placeSub : '<span class="mw-text-muted">Not given</span>') + "</td>" +
    "<td>" + roleChips(contact) + "</td>" +
    '<td class="mw-table__nowrap">' + (contact.firstAt
      ? '<time datetime="' + esc(isoDay(contact.firstAt)) + '">' + esc(formatDate(contact.firstAt)) + "</time>"
      : '<span class="mw-text-muted">Unknown</span>') + "</td>" +
    "<td>" + sms + "</td>" +
    '<td class="mw-table__js"><button class="mw-link" type="button" data-send-to="' + esc(contact.key) + '"' + (contact.valid ? "" : " disabled") + '>Send SMS<span class="mw-visually-hidden"> to ' + esc(name) + "</span></button></td>" +
  "</tr>";
}

function renderContacts() {
  var contacts = state.contacts;
  var last = lastSmsByKey();
  if (state.contactsError && !contacts.length) {
    if (contactsCaption) contactsCaption.textContent = "Registered contacts couldn't be loaded";
    if (recipientSelect) recipientSelect.innerHTML = '<option value="">Contacts couldn\'t be loaded</option>';
    if (contactsWrap) contactsWrap.hidden = true;
    if (contactsEmpty) contactsEmpty.hidden = true;
    return;
  }
  if (contactsCaption) {
    contactsCaption.textContent = "Registered contacts, " + contacts.length + (contacts.length === 1 ? " mother" : " mothers");
  }
  if (contactsBody) contactsBody.innerHTML = contacts.map(function (c) { return contactRow(c, last[c.key]); }).join("");
  if (contactsWrap) contactsWrap.hidden = contacts.length === 0;
  if (contactsEmpty) contactsEmpty.hidden = contacts.length > 0;
  renderRecipients(contacts);
}

function renderRecipients(contacts) {
  if (!recipientSelect) return;
  var chosen = recipientSelect.value;
  var valid = contacts.filter(function (c) { return c.valid; });
  if (!valid.length) {
    recipientSelect.innerHTML = '<option value="">No registered contacts yet</option>';
    return;
  }
  recipientSelect.innerHTML = valid.map(function (contact) {
    return '<option value="' + esc(contact.key) + '">' + esc((contact.name || "Name not given") + " · " + contact.mobile) + "</option>";
  }).join("");
  if (state.byKey[chosen]) recipientSelect.value = chosen;
}

/* ───────────── Send notification ───────────── */

// The template for a type, with that mother's details
function draftFor(type, key) {
  var c = state.byKey[key] || {};
  var f = c.facilityId ? state.facilities[c.facilityId] : null;
  var template = type === "referral" ? "referral"
    : type === "reminder" ? (c.referred ? "followup_reminder" : "visit_reminder")
    : "availability";
  return fillTemplateToFit(templateText(template), {
    name: c.name || "",
    firstName: firstName(c.name),
    facility: c.facilityName || (f && f.name) || "",
    phone: (f && (f.contactNumber || f.smsNumber)) || ""
  });
}

var draftEdited = false;   // the admin changed the message: a new type or recipient leaves it alone

function fillDraft() {
  if (!messageInput || draftEdited) return;
  messageInput.value = draftFor(typeSelect ? typeSelect.value : "update", recipientSelect.value).slice(0, 160);
  messageInput.dispatchEvent(new Event("input", { bubbles: true }));   // the count and the preview
  draftEdited = false;
}

if (sendModal && sendForm) {
  setUpSendDialog({
    modal: sendModal,
    contact: function (key) {
      var c = state.byKey[key];
      return c ? { name: c.name || null, ref: c.latestRef || null } : null;
    },
    onSent: function (record) {
      if (record && record.id && record.logged !== false) {
        state.log = [record].concat(state.log.filter(function (r) { return r.id !== record.id; }));
      }
      renderLog();
      renderContacts();
    }
  });
  sendModal.addEventListener("mw:modal-open", function () {
    draftEdited = false;
    fillDraft();
  });
  if (messageInput) messageInput.addEventListener("input", function (event) { if (event.isTrusted) draftEdited = true; });
  if (typeSelect) typeSelect.addEventListener("change", fillDraft);
  if (recipientSelect) recipientSelect.addEventListener("change", fillDraft);
}

// A contact's Send SMS opens Send notification with that mother chosen
if (contactsBody) {
  contactsBody.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-send-to]");
    if (!button || !sendModal || typeof sendModal.showModal !== "function" || sendModal.open) return;
    if (recipientSelect) recipientSelect.value = button.getAttribute("data-send-to");
    sendModal.returnFocusTo = button;
    sendModal.dispatchEvent(new CustomEvent("mw:modal-open", { detail: { trigger: button } }));
    sendModal.showModal();
  });
}

/* ───────────── Message log ───────────── */

var logPager = logWrap ? createPager({ after: logWrap, label: "Message log pages", onChange: renderLog }) : null;

function logRow(r) {
  var name = r.name || "Name not given";
  var mobile = formatMobile(r.to);
  var detail = [r.auto ? "Automatic" : r.sentBy ? "By " + r.sentBy : "", r.event && r.event !== (r.type === "referral" ? "Referral sent" : "") ? r.event : ""]
    .filter(Boolean).join(" · ");
  var resent = state.log.some(function (x) { return x.resendOf === r.id && x.status === "sent"; });
  var status = r.status === "sent" && !smsNotDelivered(r)
    ? smsStatusChip(r)
    : resent
      ? '<div class="mw-table__stack">' + smsStatusChip(r) + '<span class="mw-table__sub">Sent again</span></div>'
      : '<div class="mw-table__stack">' + smsStatusChip(r) +
          '<button class="mw-link" type="button" data-resend="' + esc(r.id) + '"' + (state.resending[r.id] ? " disabled" : "") + ">" +
          (state.resending[r.id] ? "Sending…" : "Resend") + '<span class="mw-visually-hidden"> SMS to ' + esc(name) + "</span></button></div>";
  return "<tr>" +
    "<td>" +
      '<span class="mw-table__name">' + esc(name) + "</span>" +
      '<span class="mw-table__sub mw-table__nowrap">' + esc(mobile) + "</span>" +
    "</td>" +
    "<td>" + smsTypeChip(r) + (detail ? '<span class="mw-table__sub">' + esc(detail) + "</span>" : "") + "</td>" +
    "<td>" + esc(r.message) + (r.status !== "sent" && r.error ? '<span class="mw-table__sub">' + esc(r.error) + "</span>" : "") + "</td>" +
    "<td>" + status + "</td>" +
    '<td class="mw-table__nowrap"><time datetime="' + esc(r.sentAt || "") + '">' + esc(smsTime(r.sentAt)) + "</time></td>" +
  "</tr>";
}

var LOG_EMPTY = logEmpty ? {
  title: logEmpty.querySelector(".mw-empty__title").textContent,
  text: logEmpty.querySelector(".mw-empty__text").textContent
} : null;

function renderLog() {
  if (!logBody) return;
  var list = state.log;
  if (LOG_EMPTY) {
    // Not loaded is not the same as nothing sent
    var failed = state.logError && !list.length;
    logEmpty.querySelector(".mw-empty__title").textContent = failed ? "The message log couldn't be loaded" : LOG_EMPTY.title;
    logEmpty.querySelector(".mw-empty__text").textContent = failed ? state.logError : LOG_EMPTY.text;
  }
  var shown = logPager ? logPager.slice(list) : list;
  logBody.innerHTML = shown.map(logRow).join("");
  if (logCaption) logCaption.textContent = "Message log, " + list.length + (list.length === 1 ? " message" : " messages") + (logPager ? logPager.caption() : "");
  if (logWrap) logWrap.hidden = list.length === 0;
  if (logEmpty) logEmpty.hidden = list.length > 0;
  // When the server sent only the newest SMS, say so under the log
  var note = logPanel && logPanel.querySelector("[data-sms-note]");
  var text = list.length ? smsLogNote() : "";
  if (!note && text && logPanel) {
    note = document.createElement("p");
    note.className = "mw-table__sub";
    note.setAttribute("data-sms-note", "");
    logPanel.appendChild(note);
  }
  if (note) {
    note.textContent = text;
    note.hidden = !text;
  }
}

// Resend: the same message to the same number, as a new SMS
if (logBody) {
  logBody.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-resend]");
    if (!button || button.disabled) return;
    var r = state.log.filter(function (x) { return x.id === button.getAttribute("data-resend"); })[0];
    if (!r || state.resending[r.id]) return;
    var who = r.name || formatMobile(r.to);
    // It may already have reached her: ask first
    if (r.status === "unknown" && !window.confirm("This SMS to " + who + " may already have reached her. Check Reports in the PhilSMS dashboard first. Send it again anyway?")) return;
    state.resending[r.id] = true;
    renderLog();
    sendSms({ to: r.to, message: r.message, type: r.type, event: r.event, ref: r.ref, name: r.name, facility: r.facility, resendOf: r.id })
      .then(function (record) {
        delete state.resending[r.id];
        var logNote = record.logged === false ? " It couldn't be added to the Message log (" + (record.logError || "unknown reason") + ")." : "";
        if (record.logged !== false) state.log = [record].concat(state.log.filter(function (x) { return x.id !== record.id; }));
        renderLog();
        renderContacts();
        if (record.status === "sent") toast("SMS sent again to " + who + "." + logNote);
        else showPageError((record.status === "unknown" ? "The SMS to " + who + " may not have been sent. " : "The SMS to " + who + " wasn't sent. ") + (record.error || "") + logNote);
      }, function (error) {
        delete state.resending[r.id];
        renderLog();
        showPageError((error && error.code === "timeout" ? "The SMS to " + who + " may not have been sent. " : "The SMS to " + who + " wasn't sent. ") + ((error && error.message) || ""));
      });
  });
}

/* ───────────── load ───────────── */

function useFacilities(list) {
  state.facilities = {};
  (list || []).forEach(function (f) { state.facilities[f.id] = f; });
}

function useSubmissions(submissions) {
  state.submissions = submissions;
  state.contacts = buildContacts(submissions);
  renderContacts();
}

function useLog(log) {
  state.log = log;
  renderLog();
  renderContacts();
}

/* What this browser tab already has (from the last page) shows at once;
   the fresh copy from Firestore replaces it a moment later. */
(function showRemembered() {
  var facilities = cachedFacilities();
  if (facilities) useFacilities(facilities);
  var submissions = cachedSubmissions();
  if (submissions) useSubmissions(submissions);
  var log = cachedSmsLog();
  if (log) useLog(log);
  renderTemplates();
})();

ready
  .then(function () {
    showGateway();
    return Promise.allSettled([getSubmissions(), getSmsLog(), getFacilities(), getSmsTemplates()]);
  })
  .then(function (results) {
    var errors = [];
    if (results[2].status === "fulfilled") useFacilities(results[2].value);
    if (results[0].status === "fulfilled") useSubmissions(results[0].value);
    else {
      errors.push(errorMessage(results[0].reason, "registered contacts"));
      state.contactsError = errors[errors.length - 1];
      renderContacts();
    }
    if (results[1].status === "fulfilled") useLog(results[1].value);
    else {
      errors.push(results[1].reason.message);
      state.logError = results[1].reason.message;
      renderLog();
      renderContacts();
    }
    state.templates = results[3].value;
    renderTemplates();
    if (state.templates.error) errors.push(state.templates.error.message + " The default wording is shown.");
    if (errors.length) showPageError(errors.join(" "));
  })
  .catch(function (error) {
    showPageError(errorMessage(error, "registered contacts"));
  });
