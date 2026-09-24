/* ==========================================================================
   MOWMMAS Admin · SMS (PhilSMS, sent by the MOWMMAS server)

   The PhilSMS token stays on the server (User/Admin/Backend/.env). These
   pages ask the MOWMMAS server (the mother backend, User/Mother/Backend) to
   send, with the signed-in admin's Firebase ID token:
     sendSms({ to, message, type, ref, name, facility, event, resendOf })
                   → the SMS record { id, status: "sent" | "failed" | "skipped", error, ... }
     getGateway()  → { configured, connected, sender, keyHint, balance, expiresOn, error }
     getSmsLog()   → every SMS sent, newest first (the server's data/sms-log.json)
   Nothing about SMS is kept in Firebase: Firebase only confirms who is signed in.
   cachedSmsLog() is this tab's copy (shown at once on the next page), and a
   sent SMS is added to it at once (rememberSms).

   setUpSendDialog({ modal, contact, onSent })
     the Send SMS / Send notification dialog (#send_modal): sends through the
     server, stays open while sending, and says plainly if it wasn't sent.
     contact(mobileKey) → { name, ref } of that mother (her latest submission)

   Templates: the wording on the SMS page, saved on the server (data/sms-templates.json)
     SMS_TEMPLATES, getSmsTemplates(), saveSmsTemplate(key, text), fillTemplate(text, values),
     fillTemplateToFit(text, values): her complete name, or her first name if that doesn't fit one SMS
   ========================================================================== */

import { auth, toast, showPageError } from "./admin-session.js";
import { holdDialog, firstName } from "./admin-ui.js";

/* Served by the MOWMMAS server → relative URLs. Opened from VS Code Live
   Server (ports 5500/5501) or as a file → the server on port 3000 (the same
   rule as the mother site's api.js). */
var viaLiveServer = location.protocol === "file:" || location.port === "5500" || location.port === "5501";
var API_BASE = window.MOWMMAS_API_BASE || (viaLiveServer ? "http://localhost:3000/api" : "/api");
var API_TIMEOUT_MS = 45000;
var SLOW_SEND_MS = 15000;

function apiError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

// what: the result for the admin if it fails, e.g. "nothing was sent" or "the SMS log couldn't be loaded"
function callApi(method, path, body, what) {
  var result = what || "nothing was sent";
  var user = auth.currentUser;
  if (!user) return Promise.reject(apiError("signed-out", "You're signed out. Sign in again, then try again."));
  return user.getIdToken()
    .catch(function () {
      throw apiError("token", "Can't reach Firebase to confirm your sign-in, so " + result + ". Check the internet connection, then try again.");
    })
    .then(function (token) {
      return fetch(API_BASE + path, {
        method: method,
        headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      }).catch(function (error) {
        if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw apiError("timeout", method === "POST" && path === "/admin/sms"
            ? "The MOWMMAS server didn't answer in time, so the SMS may or may not have gone out. Check the Message log before sending it again."
            : "The MOWMMAS server didn't answer in time, so " + result + ". Try again.");
        }
        // An older server (before SMS) turns away the sign-in header, so the browser reports it
        // like a server that isn't running: ask the plain health check to tell them apart
        return fetch(API_BASE + "/health", { signal: AbortSignal.timeout(5000) }).then(function (answer) {
          return answer.ok;
        }, function () { return false; }).then(function (running) {
          if (running) {
            throw apiError("old-server", "The MOWMMAS server running now is an older version without SMS, so " + result + ". Restart it (close its window, then double-click start.bat in User/Mother/Backend).");
          }
          throw apiError("unreachable", "Can't reach the MOWMMAS server, so " + result + ". Start it (double-click start.bat in User/Mother/Backend), then try again.");
        });
      });
    })
    .then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        if (response.status === 404) {
          throw apiError("old-server", "The MOWMMAS server running now is an older version without SMS. Restart it (close its window, then double-click start.bat in User/Mother/Backend).");
        }
        throw apiError(String(response.status), (typeof data.error === "string" && data.error.trim()) || "The MOWMMAS server answered with error " + response.status + ".");
      });
    });
}

export function sendSms(options) {
  return callApi("POST", "/admin/sms", options).then(function (record) {
    rememberSms(record);
    return record;
  });
}

export function getGateway() {
  return callApi("GET", "/admin/sms/gateway", null, "the SMS gateway couldn't be checked");
}

/* ───────────── the SMS log ───────────── */

var CACHE_KEY = "mowmmas.cache.sms";   // cleared on sign-out with the rest (admin-session.js)
var SHARE_MS = 10000;
var logRead = null;                    // { at, promise }: one read shared by the page's callers

function newestFirst(a, b) {
  return (Date.parse(b.sentAt) || 0) - (Date.parse(a.sentAt) || 0) || String(b.id).localeCompare(String(a.id));
}

export function cachedSmsLog() {
  try {
    var saved = sessionStorage.getItem(CACHE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    return null;
  }
}

function keepLog(list) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (error) { /* full or blocked: no copy */ }
}

export function getSmsLog(options) {
  if (logRead && !(options && options.fresh) && Date.now() - logRead.at < SHARE_MS) {
    return logRead.promise.then(function (list) { return list.slice(); });
  }
  var entry = { at: Date.now() };
  entry.promise = callApi("GET", "/admin/sms/log", null, "the SMS log couldn't be loaded").then(function (data) {
    var list = (Array.isArray(data.records) ? data.records : []).slice().sort(newestFirst);
    keepLog(list);
    return list;
  });
  entry.promise.catch(function () { if (logRead === entry) logRead = null; });
  logRead = entry;
  return entry.promise.then(function (list) { return list.slice(); });
}

/* An SMS just sent from this page: the tab's copy and the shared read have it at once */
function rememberSms(record) {
  if (!record || !record.id || record.logged === false) return;
  var add = function (list) {
    return [record].concat(list.filter(function (r) { return r.id !== record.id; })).sort(newestFirst);
  };
  var saved = cachedSmsLog();
  if (saved) keepLog(add(saved));
  if (logRead) logRead.promise = logRead.promise.then(add, function () { return [record]; });
}

/* ───────────── templates ───────────── */

// The SMS page's four templates, with the wording they start with
export var SMS_TEMPLATES = [
  { key: "referral", name: "Referral details", event: "Referral sent", tone: "brand", type: "referral",
    text: "Hi {name}, this is MOWMMAS. Please contact {facility} at {facility phone} to confirm requirements and schedule. - MOWMMAS" },
  { key: "availability", name: "Availability update", event: "Availability update", tone: "info", type: "update",
    text: "Update: The facility you inquired about has a new availability of donor milk. Please contact the facility for details." },
  { key: "visit_reminder", name: "Visit reminder", event: "Reminder", tone: "warning", type: "reminder",
    text: "Reminder: Please contact {facility} before your visit. - MOWMMAS" },
  { key: "followup_reminder", name: "Follow-up reminder", event: "Reminder", tone: "warning", type: "reminder",
    text: "Reminder: Please contact the referred facility to confirm requirements and schedule. - MOWMMAS" }
];

var templatesRead = null;

/* { key: { text, updatedAt, updatedBy } } with the saved wording, else the starting one.
   If the saved ones can't be read, the starting wording is used (and .error says why). */
export function getSmsTemplates(options) {
  if (templatesRead && !(options && options.fresh)) return templatesRead;
  templatesRead = callApi("GET", "/admin/sms/templates", null, "the saved templates couldn't be loaded")
    .then(function (data) { return { saved: data.templates || {}, error: null }; })
    .catch(function (error) {
      templatesRead = null;
      return { saved: {}, error: error };
    })
    .then(function (result) {
      var out = {};
      var saved = result.saved || {};
      SMS_TEMPLATES.forEach(function (t) {
        var s = saved[t.key];
        out[t.key] = s && typeof s.text === "string" && s.text.trim()
          ? { text: s.text, updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || null }
          : { text: t.text, updatedAt: null, updatedBy: null };
      });
      Object.defineProperty(out, "error", { value: result.error, enumerable: false });
      return out;
    });
  return templatesRead;
}

export function saveSmsTemplate(key, text) {
  return callApi("POST", "/admin/sms/templates", { key: key, text: String(text).trim() }, "the template wasn't saved").then(function (saved) {
    templatesRead = null;
    return saved;
  });
}

/* A template with her details: {name} (her complete name), {first name},
   {facility} and {facility phone}. A detail that isn't known is left out,
   e.g. "at {facility phone}" without a number. */
export function fillTemplate(text, values) {
  var v = values || {};
  var out = String(text || "");
  out = v.name ? out.replace(/\{name\}/g, v.name) : out.replace(/ ?\{name\}/g, "");
  out = v.firstName ? out.replace(/\{first name\}/g, v.firstName) : out.replace(/ ?\{first name\}/g, "");
  out = v.phone ? out.replace(/\{facility phone\}/g, v.phone) : out.replace(/ (at|on) \{facility phone\}/g, "").replace(/\{facility phone\}/g, "");
  out = out.replace(/\{facility\}/g, v.facility || "the facility");
  return out.replace(/ +,/g, ",").replace(/ {2,}/g, " ").trim();
}

/* The template with her complete name, if it fits in one SMS (160 characters);
   else with her first name; else without a name */
export function fillTemplateToFit(text, values) {
  var v = values || {};
  var full = String(v.name || "").trim();
  var first = String(v.firstName || firstName(full)).trim();
  var tries = [
    Object.assign({}, v, { name: full, firstName: first }),
    Object.assign({}, v, { name: first, firstName: first }),
    Object.assign({}, v, { name: "", firstName: "" })
  ].map(function (t) { return fillTemplate(text, t); });
  return tries.filter(function (s) { return s.length <= 160; })[0] || tries[tries.length - 1].slice(0, 160);
}

/* ───────────── the Send SMS dialog ───────────── */

function sendError(error) {
  return (error && error.message) || "The SMS couldn't be sent. Try again.";
}

export function setUpSendDialog(options) {
  var modal = options.modal;
  var form = modal.querySelector("form");
  var alert = form.querySelector(".mw-alert--error");
  var button = form.querySelector("button[type='submit']");
  var typeSelect = document.getElementById("send_type");
  var recipient = document.getElementById("send_recipient");
  var message = document.getElementById("send_message");
  var hold = holdDialog(modal);

  var opened = 0;       // counts openings, so a send acts only on the dialog it came from
  var sending = false;  // one at a time
  var openRef = null;   // the submission of the row it was opened from
  var openKey = null;   // that mother's number

  function show(tone, text) {
    alert.className = "mw-alert mw-alert--" + tone;
    alert.textContent = text;
    alert.hidden = false;
    modal.scrollTop = 0;
  }

  function setLoading(on) {
    button.disabled = on;
    button.classList.toggle("is-loading", on);
  }

  // The dialog's message bar, back to hidden (it may show a success or a warning)
  function hideAlert() {
    alert.hidden = true;
    alert.className = "mw-alert mw-alert--error";
  }

  modal.addEventListener("mw:modal-open", function (event) {
    opened += 1;
    var trigger = event.detail && event.detail.trigger;
    var row = trigger && trigger.closest("[data-ref]");
    openRef = row ? row.getAttribute("data-ref") : null;
    openKey = (trigger && trigger.getAttribute("data-modal-field-send_recipient")) || null;
    hold.release();
    hideAlert();
    setLoading(sending);
    if (sending) show("warning", "The last SMS is still sending. Its result shows here when it's done.");
  });
  modal.addEventListener("close", function () {
    hold.release();
    if (!sending) setLoading(false);
    hideAlert();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();   // the dialog closes itself once the SMS is sent
    if (sending) {
      show("warning", "The last SMS is still sending. Wait for its message, then try again.");
      return;
    }
    var key = recipient.value;
    var text = message.value.trim();
    if (!key) { show("error", "Choose who gets the SMS."); return; }
    if (!text) { show("error", "Write the message first."); return; }

    var who = options.contact(key) || {};
    var ref = key === openKey && openRef ? openRef : who.ref || null;
    var label = who.name || recipient.options[recipient.selectedIndex].textContent;
    var mine = opened;
    var ownDialog = function () { return modal.open && opened === mine; };

    sending = true;
    hold.hold();
    setLoading(true);
    alert.hidden = true;
    var slowTimer = setTimeout(function () {
      if (!ownDialog()) return;
      hold.release();
      show("warning", "This is taking longer than usual. You can close this window. A message will say when it's sent, or if it wasn't.");
    }, SLOW_SEND_MS);

    sendSms({ to: key, message: text, type: typeSelect ? typeSelect.value : "update", ref: ref, name: who.name || null })
      .then(function (record) {
        clearTimeout(slowTimer);
        sending = false;
        if (options.onSent) options.onSent(record);
        var logNote = record.logged === false ? " It couldn't be added to the Message log (" + (record.logError || "Firebase refused") + ")." : "";
        if (record.status === "sent") {
          if (ownDialog()) {
            hold.release();
            modal.close();
          } else {
            setLoading(false);
            if (modal.open) show("success", "Your last SMS was sent to " + label + "." + logNote);
          }
          toast("SMS sent to " + label + "." + logNote);
          return;
        }
        var why = (record.status === "unknown" ? "The SMS to " + label + " may not have been sent. " : "The SMS to " + label + " wasn't sent. ") +
          (record.error || "") + logNote;
        hold.release();
        setLoading(false);
        if (ownDialog()) show(record.status === "unknown" ? "warning" : "error", why);
        else {
          if (modal.open) show("error", why);
          showPageError(why);
        }
      }, function (error) {
        clearTimeout(slowTimer);
        sending = false;
        var why = sendError(error);
        var uncertain = error && error.code === "timeout";
        hold.release();
        setLoading(false);
        if (ownDialog()) show(uncertain ? "warning" : "error", why);
        else {
          if (modal.open) show(uncertain ? "warning" : "error", why);
          showPageError((uncertain ? "The SMS to " + label + " may not have been sent. " : "The SMS to " + label + " wasn't sent. ") + why);
        }
      });
  });
}
