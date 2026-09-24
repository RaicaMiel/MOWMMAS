/* ==========================================================================
   MOWMMAS Admin · Data from Firestore

   facilities/<id>     health facilities in Antique (imported from the map,
                       or added by an admin)
   submissions/<ref>   mothers' donations, requests and inquiries
                       (copied from the mother backend by the Admin backend)

   Every value comes back as plain JavaScript: Firestore timestamps become ISO
   strings and GeoPoints become { lat, lon }, so pages can format them the
   same way whatever wrote them.

   One read per collection per page: every caller on a page (the page itself,
   the background pre-load, the notifications bell) shares the same read.
   Pass { fresh: true } to read again (e.g. right before exporting a CSV).
   ========================================================================== */

import { db } from "./admin-session.js";
import {
  collection,
  getDocs,
  doc,
  runTransaction,
  serverTimestamp,
  Timestamp,
  GeoPoint
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ───────────── plain values ───────────── */

export function plain(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof GeoPoint) return { lat: value.latitude, lon: value.longitude };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    var out = {};
    Object.keys(value).forEach(function (key) { out[key] = plain(value[key]); });
    return out;
  }
  return value;
}

function rows(snapshot) {
  return snapshot.docs.map(function (d) {
    var data = plain(d.data());
    data.id = data.id || d.id;
    return data;
  });
}

var time = function (iso) { return Date.parse(iso) || 0; };

function newestFirst(a, b) {
  return time(b.createdAt) - time(a.createdAt) || String(b.ref).localeCompare(String(a.ref));
}

/* ───────────── remembered data (this browser tab) ─────────────
   Every read is kept for the tab, so the next page can show it at once
   (cachedFacilities / cachedSubmissions) while the fresh copy loads.
   Signing out clears it (admin-session.js forgetSession). */
var CACHE = "mowmmas.cache.";

function remember(key, data) {
  try { sessionStorage.setItem(CACHE + key, JSON.stringify(data)); } catch (error) { /* full or blocked: no cache */ }
}

function recall(key) {
  try {
    var value = sessionStorage.getItem(CACHE + key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    return null;
  }
}

export function cachedFacilities() {
  return recall("facilities");
}

export function cachedSubmissions(type) {
  var all = recall("submissions");
  if (!all) return null;
  return type ? all.filter(function (s) { return s.type === type; }) : all;
}

/* ───────────── one shared read per collection ─────────────
   A read that is running, or finished less than SHARE_MS ago, is reused. */
var SHARE_MS = 10000;
var reads = {};

function shared(key, load, options) {
  var hit = reads[key];
  if (hit && !(options && options.fresh) && (hit.pending || Date.now() - hit.at < SHARE_MS)) return hit.promise;
  var entry = { pending: true, at: Date.now() };
  entry.promise = load().then(function (value) {
    entry.pending = false;
    entry.at = Date.now();
    return value;
  }, function (error) {
    if (reads[key] === entry) delete reads[key];
    throw error;
  });
  reads[key] = entry;
  return entry.promise;
}

/* All facilities, A to Z */
export function getFacilities(options) {
  return shared("facilities", function () {
    return getDocs(collection(db, "facilities")).then(function (snapshot) {
      var list = rows(snapshot)
        .filter(function (f) { return f && f.name; })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      remember("facilities", list);
      return list;
    });
  }, options).then(function (list) { return list.slice(); });
}

/* Mothers' submissions, newest first. type: "donate" | "request" | "inquire" | undefined (all).
   Always one read of the whole collection, shared by every caller on the page. */
export function getSubmissions(type, options) {
  return shared("submissions", function () {
    return getDocs(collection(db, "submissions")).then(function (snapshot) {
      var list = rows(snapshot).map(function (s) {
        s.ref = s.ref || s.id;
        return withSavedHere(s);
      }).sort(newestFirst);
      remember("submissions", list);
      return list;
    });
  }, options).then(function (list) {
    return type ? list.filter(function (s) { return s.type === type; }) : list.slice();
  });
}

/* Submissions saved on this page (ref → the submission as saved). A read that
   started before a save can arrive after it, with the older copy: every admin
   change adds a line to statusHistory, so the copy with more lines is newer. */
var savedHere = {};

function historyLength(s) {
  return Array.isArray(s && s.statusHistory) ? s.statusHistory.length : 0;
}

function withSavedHere(s) {
  var mine = savedHere[s.ref];
  return mine && historyLength(mine) > historyLength(s) ? mine : s;
}

/* A submission changed here (e.g. referred): the tab's copy and the shared read follow */
function rememberSubmission(updated) {
  savedHere[updated.ref] = updated;
  var all = recall("submissions");
  if (all) {
    remember("submissions", all.map(function (s) { return s.ref === updated.ref ? updated : s; }));
  }
  var hit = reads.submissions;
  if (hit && !hit.pending) {
    hit.promise = hit.promise.then(function (list) {
      return list.map(function (s) { return s.ref === updated.ref ? updated : s; });
    });
  }
}

/* ───────────── SMS (the log itself comes from the MOWMMAS server: admin-sms.js) ───────────── */

// What an SMS was about → chip (mw-chip--…), as on the design's Message log
export var SMS_TYPES = {
  referral: { label: "Referral sent", tone: "brand" },
  update: { label: "Update", tone: "info" },
  reminder: { label: "Reminder", tone: "warning" },
  status: { label: "Status update", tone: "info" },
  received: { label: "Form received", tone: "" }
};

export function smsTypeChip(record) {
  var t = SMS_TYPES[record && record.type] || SMS_TYPES.update;
  return '<span class="mw-chip' + (t.tone ? " mw-chip--" + t.tone : "") + '">' + escText(t.label) + "</span>";
}

var SMS_STATUS = {
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  unknown: { label: "Not confirmed", tone: "warning" },
  skipped: { label: "Not sent", tone: "" }
};

// PhilSMS's delivery answer for a sent SMS (e.g. "Delivered", "Undelivered")
export function smsNotDelivered(record) {
  return !!record && record.status === "sent" && /undeliver|fail|reject|expire|block|invalid/i.test(record.delivery || "");
}

export function smsStatusChip(record) {
  if (record && record.status === "sent" && /^delivered$/i.test(record.delivery || "")) {
    return '<span class="mw-chip mw-chip--success">Delivered</span>';
  }
  if (smsNotDelivered(record)) return '<span class="mw-chip mw-chip--danger">Not delivered</span>';
  var s = SMS_STATUS[record && record.status] || SMS_STATUS.failed;
  return '<span class="mw-chip' + (s.tone ? " mw-chip--" + s.tone : "") + '">' + escText(s.label) + "</span>";
}

/* ───────────── the rules every page shares ───────────── */

// "Needs updating": a public facility never updated, or not in this many days
export var STALE_AFTER_DAYS = 30;

export function isParticipating(facility) {
  return !!facility && facility.participating === true;
}

export function hasDonorMilk(facility) {
  var v = facility && facility.donorMilkAvailability;
  return v === "available" || v === "limited";
}

export function isOverdue(facility) {
  if (!isParticipating(facility)) return false;
  var days = daysSince(facilityUpdatedAt(facility));
  return days === null || days > STALE_AFTER_DAYS;
}

// Statuses after which nothing more happens (same as the mother backend's statuses.js)
export var FINAL_STATUSES = ["completed", "closed", "declined"];

export function isFinalStatus(status) {
  return FINAL_STATUSES.indexOf(status) !== -1;
}

/* ───────────── referrals (write) ───────────── */

// The status names the mother sees (same as the mother backend's statuses.js)
var MOTHER_STATUS_LABELS = {
  submitted: "Submitted", under_review: "Under review", screening_scheduled: "Screening scheduled",
  accepted: "Donation accepted", approved: "Approved", ready_for_pickup: "Ready for pick-up",
  answered: "Answered", completed: "Completed", closed: "Closed", declined: "Declined"
};

export function motherStatusLabel(status) {
  return MOTHER_STATUS_LABELS[status] || status || "Unknown";
}

// The statuses each kind of submission moves through, in order (same as the backends' statuses.js)
export var STATUS_FLOW = {
  donate: ["submitted", "under_review", "screening_scheduled", "accepted", "completed", "declined"],
  request: ["submitted", "under_review", "approved", "ready_for_pickup", "completed", "declined"],
  inquire: ["submitted", "answered", "closed"]
};

function refused(code, detail, current) {
  var error = new Error(code);
  error.code = code;
  error.detail = detail || null;
  if (current) error.current = current;
  return error;
}

/* Each save's history line gets an id. If the connection drops after Firestore
   applied a save, the SDK runs the transaction again: finding its own line
   already there, it stops (saved) instead of adding it twice. The mother's
   copy leaves the id out (sync.js copies status, at, by and note only). */
function saveId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function alreadySaved(raw, id) {
  return (Array.isArray(raw.statusHistory) ? raw.statusHistory : []).some(function (h) { return h && h.id === id; });
}

/* Refer a mother's donation or request to a facility, saved in Firestore
   (submissions/<ref>). It runs as a Firestore transaction: it reads the
   submission as it is in Firestore right now and decides from that, never
   from the page's copy, so it can't undo a newer status.
     referral        { facilityId, facilityName, note, referredAt, referredBy }
     status          "Submitted" moves to "Under review" (a later status is kept)
     statusHistory   + "Referred to <facility>"; the mother sees this line, not the note
     adminUpdatedAt  when an admin last changed it (Firestore's clock); the mother
                     backend's sync reads only submissions with a newer one
   Refused, with error.code:
     "final"          already completed, closed or declined (error.detail: the status)
     "same-facility"  already referred to that facility (error.detail: its name)
     "not-found"      no longer in Firestore
   Resolves with the submission as it is now (plain values), and updates the
   tab's copy so other pages show it at once. */
export function referSubmission(ref, facility, note, adminEmail) {
  var target = doc(db, "submissions", ref);
  var id = saveId();
  return runTransaction(db, function (tx) {
    return tx.get(target).then(function (snapshot) {
      if (!snapshot.exists()) throw refused("not-found");
      var raw = snapshot.data();
      var current = plain(raw);
      current.ref = current.ref || ref;
      if (alreadySaved(raw, id)) return current;
      if (isFinalStatus(current.status)) throw refused("final", current.status);
      if (current.referral && current.referral.facilityId === facility.id) throw refused("same-facility", facility.name);

      var now = Timestamp.now();
      var moveOn = current.status === "submitted";
      var status = moveOn ? "under_review" : current.status;
      var referral = {
        facilityId: facility.id,
        facilityName: facility.name,
        note: note ? String(note).trim() || null : null,
        referredAt: now,
        referredBy: adminEmail || null
      };
      var entry = {
        id: id,
        kind: "referral",
        status: status,
        statusLabel: MOTHER_STATUS_LABELS[status] || status,
        at: now,
        by: "admin",
        note: "Referred to " + facility.name,
        facilityId: facility.id,
        facilityName: facility.name
      };
      var patch = {
        referral: referral,
        statusHistory: (Array.isArray(raw.statusHistory) ? raw.statusHistory : []).concat([entry]),
        updatedAt: serverTimestamp(),
        adminUpdatedAt: serverTimestamp()
      };
      if (moveOn) {
        patch.status = status;
        patch.statusLabel = MOTHER_STATUS_LABELS[status];
        patch.isFinal = false;
      }
      tx.update(target, patch);

      var at = now.toDate().toISOString();
      return Object.assign({}, current, {
        ref: current.ref || ref,
        status: status,
        statusLabel: MOTHER_STATUS_LABELS[status] || current.statusLabel,
        isFinal: moveOn ? false : current.isFinal,
        referral: plain(referral),
        statusHistory: (Array.isArray(current.statusHistory) ? current.statusHistory : []).concat([plain(entry)]),
        updatedAt: at,
        adminUpdatedAt: at
      });
    });
  }).then(function (updated) {
    rememberSubmission(updated);
    return updated;
  });
}

/* ───────────── status updates (write) ───────────── */

var MESSAGE_MAX = 500;

/* Move a mother's submission to a new status, and/or leave her a message,
   saved in Firestore (submissions/<ref>). A Firestore transaction, like Refer:
   it decides from the submission as it is in Firestore right now.
     change.status      the new status: one of STATUS_FLOW[type], not "submitted"
     change.note        a message for the mother (optional); she sees it on
                        Track Submission, in her status history
     change.expected    the status the admin was looking at; if it changed
                        since, nothing is saved
     change.adminEmail  who made the change (kept here, not sent to the mother)
   Refused, with error.code:
     "changed"     the status changed meanwhile (error.detail: the status now;
                   error.current: the submission as it is now)
     "bad-status"  not a status this kind of submission can have
     "no-change"   the same status and no message
     "not-found"   no longer in Firestore
   Resolves with the submission as it is now (plain values). Either way the
   tab's copy follows Firestore, so other pages show the latest at once. */
export function updateSubmissionStatus(ref, change) {
  var target = doc(db, "submissions", ref);
  var id = saveId();
  return runTransaction(db, function (tx) {
    return tx.get(target).then(function (snapshot) {
      if (!snapshot.exists()) throw refused("not-found");
      var raw = snapshot.data();
      var current = plain(raw);
      current.ref = current.ref || ref;
      if (alreadySaved(raw, id)) return current;
      if (current.status !== change.expected) throw refused("changed", current.status, current);

      var status = change.status;
      var flow = STATUS_FLOW[current.type] || [];
      if (status === "submitted" || flow.indexOf(status) === -1) throw refused("bad-status", status);
      var note = String(change.note || "").trim().slice(0, MESSAGE_MAX) || null;
      if (status === current.status && !note) throw refused("no-change");

      var now = Timestamp.now();
      var entry = {
        id: id,
        kind: "status",
        status: status,
        statusLabel: motherStatusLabel(status),
        at: now,
        by: "admin",
        byEmail: change.adminEmail || null,
        note: note
      };
      tx.update(target, {
        status: status,
        statusLabel: motherStatusLabel(status),
        isFinal: isFinalStatus(status),
        statusHistory: (Array.isArray(raw.statusHistory) ? raw.statusHistory : []).concat([entry]),
        updatedAt: serverTimestamp(),
        adminUpdatedAt: serverTimestamp()
      });

      var at = now.toDate().toISOString();
      return Object.assign({}, current, {
        status: status,
        statusLabel: motherStatusLabel(status),
        isFinal: isFinalStatus(status),
        statusHistory: (Array.isArray(current.statusHistory) ? current.statusHistory : []).concat([plain(entry)]),
        updatedAt: at,
        adminUpdatedAt: at
      });
    });
  }).then(function (updated) {
    rememberSubmission(updated);
    return updated;
  }, function (error) {
    if (error && error.current) rememberSubmission(error.current);
    throw error;
  });
}

/* ───────────── what things mean ───────────── */

export var TYPES = {
  donate: { label: "Donation", verb: "wants to donate" },
  request: { label: "Milk request", verb: "needs donor milk" },
  inquire: { label: "Inquiry", verb: "asked a question" }
};

// Submission status → chip tone (mw-chip--…)
var STATUS_TONE = {
  submitted: "warning",
  under_review: "info",
  screening_scheduled: "info",
  accepted: "brand",
  approved: "brand",
  ready_for_pickup: "brand",
  answered: "success",
  completed: "success",
  closed: "",
  declined: "danger"
};

var STATUS_LABEL = {
  submitted: "New",
  under_review: "Under review",
  screening_scheduled: "Screening scheduled",
  accepted: "Donation accepted",
  approved: "Approved",
  ready_for_pickup: "Ready for pick-up",
  answered: "Answered",
  completed: "Completed",
  closed: "Closed",
  declined: "Declined"
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || status || "Unknown";
}

export function statusChip(status) {
  var tone = STATUS_TONE[status];
  return '<span class="mw-chip' + (tone ? " mw-chip--" + tone : "") + '">' + escText(statusLabel(status)) + "</span>";
}

/* A submission's chip: "Referred" while a referred one is under review, else its status */
export function submissionChip(submission) {
  if (submission && submission.referral && submission.status === "under_review") {
    return '<span class="mw-chip mw-chip--brand">Referred</span>';
  }
  return statusChip(submission && submission.status);
}

/* Human milk bank status of a facility */
export function hmbStatus(facility) {
  var s = facility && facility.services;
  var bank = s ? s.milkBank : null;
  if (bank === true) return facility.dataStatus && facility.dataStatus.verified ? "verified" : "not_verified";
  if (bank === false) return "no";
  return "unknown";
}

export var HMB = {
  verified: { label: "HMB: Verified", tone: "success" },
  not_verified: { label: "HMB: Not verified", tone: "warning" },
  no: { label: "HMB: No", tone: "" },
  unknown: { label: "HMB: Not reported", tone: "" }
};

export var DONOR_MILK = {
  available: { label: "Available", tone: "success" },
  limited: { label: "Limited", tone: "warning" },
  none: { label: "Not available", tone: "danger" },
  unknown: { label: "Unknown", tone: "" }
};

export function donorMilk(facility) {
  var v = facility && facility.donorMilkAvailability;
  return DONOR_MILK[v] ? v : "unknown";
}

/* When a facility's information was last updated (ISO), or null */
export function facilityUpdatedAt(facility) {
  var d = facility && facility.dataStatus;
  return (d && d.updatedAt) || null;
}

/* ───────────── dates (Philippine time) ───────────── */

var DAY = 24 * 60 * 60 * 1000;

export function daysSince(iso) {
  var t = time(iso);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

export function daysAgo(iso) {
  var days = daysSince(iso);
  if (days === null) return "Never";
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return days + " days ago";
}

export function formatDate(iso) {
  var t = time(iso);
  if (!t) return "";
  return new Date(t).toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso) {
  var t = time(iso);
  if (!t) return "";
  return new Date(t).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* YYYY-MM-DD for a <time datetime=""> */
export function isoDay(iso) {
  var t = time(iso);
  return t ? new Date(t + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
}

function escText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
