'use strict';
/* ══════════════════════════════════════════════════════════════════
   Automatic SMS to mothers, sent with the Admin backend's sms.js (PhilSMS)

   use(sms)                  the SMS sender (null: texting is off)
   received(ref)             right after she sends a form: her reference number
   updated(sub, before)      the admin moved her submission on (the sync pulled
                             it; before = her status history until then): the
                             new status, where she was referred, the admin's message
   copy(sub, record)         a copy of an SMS an admin sent her from the admin pages
   submission(ref)           her submission as this backend has it (or null)

   recover(write)            at start: texts the server stopped before PhilSMS answered
                             are marked "unknown" and added to the SMS log (write)

   Each text is noted in data/notifications.json:
     { id, ref, key, kind: "received" | "status" | "manual", to, message, status, createdAt }
   so the same update is never texted twice (key), and Track Submission shows
   the admin's own texts ("manual") under Messages from health workers.
   The note is written (status "sending") before PhilSMS is asked, so texts
   running at the same moment count against the caps too:
     "form received"   SMS_RECEIVED_PER_NUMBER_DAILY per number a day, and
                       SMS_AUTO_DAILY_LIMIT a day in all
     every automatic   SMS_AUTO_PER_NUMBER_HOURLY per number an hour
   (User/Admin/Backend/.env; 0 turns that kind off). An update more than a day
   old isn't texted (e.g. on the first sync of a new copy).
   ══════════════════════════════════════════════════════════════════ */
const store = require('./store');
const facilities = require('./facilities');
const { statusLabel } = require('./statuses');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SMS_ONE = 160;

let sms = null;
let limits = { perNumberHourly: 5, daily: 100, receivedPerNumberDaily: 3 };

function use(sender, options) {
  sms = sender || null;
  if (options) limits = Object.assign({}, limits, options);
}

const KIND = { donate: 'donation offer', request: 'donor milk request', inquire: 'question' };

// What each status means for her, in one short sentence (Track Submission has the longer one)
const MEANING = {
  under_review: 'A health worker is checking your details.',
  screening_scheduled: 'The facility will tell you the date and time of your screening.',
  accepted: 'The facility will tell you how to bring or send your milk.',
  approved: 'The facility will tell you how to get the milk.',
  ready_for_pickup: 'The donor milk is ready. Please go to the facility, and call first if you can.',
  answered: 'A health worker answered your question.',
  completed: 'All done. Thank you for using MOWMMAS.',
  closed: 'This question is closed. You can send a new one anytime.',
  declined: 'The facility could not go ahead this time. Please call the facility to ask why.'
};

function submission(ref) {
  const list = store.read('submissions', []);
  return Array.isArray(list) ? list.find((s) => s && s.ref === ref) || null : null;
}

function facilityPhone(id) {
  try {
    const f = facilities.get(id).facility;
    return (f && (f.contactNumber || f.smsNumber)) || null;
  } catch (err) {
    return null;
  }
}

// The first wording that fits in one SMS (else the last, shortest one)
function fit(options) {
  return options.find((text) => text.length <= SMS_ONE) || options[options.length - 1];
}

// A referral line (Refer on the admin pages). Older lines have no kind: their wording tells.
function isReferral(h) {
  if (!h) return false;
  if (h.kind) return h.kind === 'referral';
  return h.by === 'admin' && /^Referred to [^\n]+$/.test(String(h.note || '').trim());
}

// A history line, the same however the sync copied it
function signature(h) {
  return [h && h.at, h && h.status, (h && h.note) || ''].join('|');
}

function notes() {
  const list = store.read('notifications', []);
  return Array.isArray(list) ? list : [];
}

// Counts toward the caps: sent, being sent, or maybe sent
const COUNTED = new Set(['sent', 'sending', 'unknown']);

// Why an automatic text of this kind to this number can't go now (null when it can)
function overLimit(list, key, kind) {
  const now = Date.now();
  const lastDay = list.filter((n) => n && (n.kind === 'received' || n.kind === 'status') && COUNTED.has(n.status) && now - (Date.parse(n.createdAt) || 0) < DAY);
  if (kind === 'received') {
    const received = lastDay.filter((n) => n.kind === 'received');
    if (received.length >= limits.daily) return 'Not sent: the daily limit for "form received" texts (' + limits.daily + ') was reached.';
    if (received.filter((n) => n.to === key).length >= limits.receivedPerNumberDaily) {
      return 'Not sent: this number already got ' + limits.receivedPerNumberDaily + ' "form received" texts today.';
    }
  }
  if (lastDay.filter((n) => n.to === key && now - (Date.parse(n.createdAt) || 0) < HOUR).length >= limits.perNumberHourly) {
    return 'Not sent: this number already got ' + limits.perNumberHourly + ' automatic texts in the last hour.';
  }
  return null;
}

// Checks the caps and notes the text as "sending", in one step under the store's lock, so two
// texts at the same moment can't both slip under a cap. Returns the note's id and why it can't go.
function reserve(sub, kind, key, to, message) {
  const id = 'pending-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let skip = null;
  store.update('notifications', [], (list) => {
    skip = to ? overLimit(list, to, kind) : null;
    list.push({ id, ref: sub.ref, key, kind, to: to || null, message, status: skip ? 'skipped' : 'sending', createdAt: new Date().toISOString() });
  });
  return { id, skip };
}

function settle(id, record) {
  store.update('notifications', [], (list) => {
    const n = list.find((x) => x && x.id === id);
    if (n) Object.assign(n, { id: record.id, to: record.to, message: record.message, status: record.status, createdAt: record.sentAt });
  });
}

async function text(sub, kind, key, fields) {
  const to = sms.mobileKey(sub.contact && sub.contact.mobile);
  const slot = reserve(sub, kind, key, to, fields.message);
  const record = await sms.send(Object.assign({
    to: to || (sub.contact && sub.contact.mobile),
    ref: sub.ref,
    name: (sub.contact && sub.contact.name) || null,
    auto: true,
    skip: slot.skip
  }, fields));
  settle(slot.id, record);
  return record;
}

/* ───────────── after a restart ───────────── */

function recover(write) {
  const stopped = [];
  store.update('notifications', [], (list) => {
    list.forEach((n) => {
      if (n && n.status === 'sending') { n.status = 'unknown'; stopped.push(Object.assign({}, n)); }
    });
  });
  for (const n of stopped) {
    const sub = submission(n.ref);
    try {
      write({
        id: n.id.replace(/^pending-/, 'sms-'), to: n.to, name: (sub && sub.contact && sub.contact.name) || null, ref: n.ref,
        facility: (sub && sub.facilityName) || null, type: n.kind === 'received' ? 'received' : 'status', event: 'Automatic text',
        message: n.message, segments: sms.segments(n.message || ''), status: 'unknown',
        error: 'The MOWMMAS server stopped before PhilSMS answered, so it may or may not have been sent. Check Reports in the PhilSMS dashboard before sending it again.',
        gatewayUid: null, auto: true, sentAt: n.createdAt, sentBy: null, resendOf: null
      });
    } catch (err) {
      console.warn('[sms] Could not add an unfinished text to the SMS log: ' + err.message);
    }
  }
  return stopped.length;
}

/* ───────────── her form arrived ───────────── */

async function received(ref) {
  if (!sms) return null;
  const sub = submission(ref);
  if (!sub) return null;
  const key = 'received|' + sub.ref;
  if (notes().some((n) => n && n.key === key)) return null;
  const kind = KIND[sub.type] || 'form';
  const message = fit([
    'MOWMMAS: We received your ' + kind + ' for ' + sub.facilityName + '. Ref: ' + sub.ref + ". We'll text you when it's updated.",
    'MOWMMAS: We received your ' + kind + '. Ref: ' + sub.ref + ". We'll text you when it's updated.",
    'MOWMMAS: We received your form. Ref: ' + sub.ref + '.'
  ]);
  return text(sub, 'received', key, { message, type: 'received', event: 'Form received', facility: sub.facilityName || null });
}

/* ───────────── the admin moved it on ───────────── */

function updateText(sub, entry, previous) {
  const kind = KIND[sub.type] || 'form';
  const noteText = sms.clean(entry.note || '');   // cleaned first, so its length is the length sent
  if (isReferral(entry)) {
    // The facility this line names (a later referral may name another)
    const named = entry.facilityName || (/^Referred to ([^\n]+)$/.exec(noteText) || [])[1] || '';
    const r = sub.referral && sub.referral.facilityId ? sub.referral : null;
    const facility = named || (r && r.facilityName) || 'a health facility';
    const facilityId = entry.facilityId || (r && r.facilityName === facility ? r.facilityId : null);
    const phone = facilityId ? facilityPhone(facilityId) : null;
    const message = fit([
      'MOWMMAS: Your ' + kind + ' ' + sub.ref + ' was referred to ' + facility + '. Please contact them' + (phone ? ' at ' + phone : '') + ' to confirm the next steps.',
      'MOWMMAS: Your ' + kind + ' ' + sub.ref + ' was referred to ' + facility + (phone ? '. Call ' + phone : '') + '.'
    ]);
    return { message, type: 'referral', event: 'Referred to ' + facility, facility };
  }
  const label = statusLabel(entry.status);
  const changed = !previous || previous.status !== entry.status;
  const head = changed
    ? 'MOWMMAS: Your ' + kind + ' ' + sub.ref + ' is now ' + label + '.'
    : 'MOWMMAS: A message about your ' + kind + ' ' + sub.ref + ':';
  let body = noteText || (changed ? MEANING[entry.status] || '' : '');
  // At most 3 SMS: 459 characters, or 201 when a character outside the SMS alphabet
  // (e.g. an emoji) makes it a unicode text
  if (sms.segments(head + ' ' + body) > 3) {
    const max = sms.isGsm(head + ' ' + body) ? sms.MAX_LENGTH : 201;
    const more = ' ... The full message is on MOWMMAS Track Submission.';
    const room = max - head.length - 1 - more.length;
    body = Array.from(body).slice(0, Math.max(0, room)).join('').trim() + more;
  }
  return {
    message: (head + ' ' + body).trim(),
    type: 'status',
    event: changed ? 'Status: ' + label : 'Message',
    facility: (sub.referral && sub.referral.facilityName) || sub.facilityName || null
  };
}

async function updated(sub, before) {
  if (!sms || !sub) return [];
  const history = Array.isArray(sub.statusHistory) ? sub.statusHistory : [];
  const had = new Set((Array.isArray(before) ? before : []).map(signature));
  const sent = new Set(notes().map((n) => n && n.key));
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || entry.by !== 'admin' || had.has(signature(entry))) continue;
    const key = 'status|' + sub.ref + '|' + signature(entry);
    if (sent.has(key)) continue;
    if (!(Date.now() - (Date.parse(entry.at) || 0) < DAY)) continue; // too old to text now
    out.push(await text(sub, 'status', key, updateText(sub, entry, history[i - 1])));
  }
  return out;
}

/* ───────────── an admin texted her ───────────── */

function copy(sub, record) {
  if (!sub || !record || record.status !== 'sent') return;
  try {
    store.update('notifications', [], (list) => {
      list.push({ id: record.id, ref: sub.ref, key: 'manual|' + record.id, kind: 'manual', to: record.to, message: record.message, status: record.status, createdAt: record.sentAt });
    });
  } catch (err) {
    console.warn('[sms] Sent, but the copy for Track Submission could not be saved: ' + err.message);
  }
}

module.exports = { use, received, updated, copy, submission, recover, isReferral };
