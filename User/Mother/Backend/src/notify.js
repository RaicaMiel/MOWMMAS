'use strict';
/* ══════════════════════════════════════════════════════════════════
   Automatic SMS to mothers, sent with the Admin backend's sms.js (PhilSMS)

   use(sms, limits)          the SMS sender (null: texting is off) and the caps
   received(sub)             right after she sends a form: her reference number
   updated(sub, deadline)    the admin moved her submission on: the new status,
                             where she was referred, the admin's message. The
                             admin pages ask for this right after saving
                             (POST /api/admin/notify), and sweep() catches any
                             update that wasn't asked for
   sweep(deadline)           texts every admin update of the last day not texted yet
   copy(sub, record)         a copy of an SMS an admin sent her from the admin pages
   submission(ref)           her submission (Firestore), or null
   recover()                 texts left "sending" (the server stopped before PhilSMS
                             answered) become "unknown" and are added to the SMS log
   Texting is off (use(null)) on a server without the PhilSMS key: it then claims
   nothing, so a server that has the key sends them.

   Each automatic text is claimed first: notifications/auto-<key> is created with
   status "sending", which only one server can do, so the same update is never
   texted twice, even with the server on a computer and the one online running.
   The caps (User/Admin/Backend/.env; 0 turns that kind off) are counted in
   limits/<id>, in Manila time:
     "form received"   SMS_RECEIVED_PER_NUMBER_DAILY per number a day, and
                       SMS_AUTO_DAILY_LIMIT a day in all
     every automatic   SMS_AUTO_PER_NUMBER_HOURLY per number an hour
   A text that isn't sent (over a cap, or it failed) gives its place back.
   An update more than a day old isn't texted.
   deadline (optional): a time (ms) after which no new text is started; the rest
   is left for the next sweep.
   ══════════════════════════════════════════════════════════════════ */
const cloud = require('./cloud');
const firestore = require('../../../Admin/Backend/src/firestore');
const facilities = require('./facilities');
const { statusLabel } = require('./statuses');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SMS_ONE = 160;
// A text still "sending" after this was cut off: far longer than any send can take (PhilSMS: 20 s,
// a request online: 60 s), with room for the clocks of two servers to differ
const STUCK_AFTER_MS = 10 * 60 * 1000;

let sms = null;     // the sender: null when texting is off (no PhilSMS key)
let tools = null;   // the SMS helpers (segments, …), there even when texting is off
let limits = { perNumberHourly: 5, daily: 100, receivedPerNumberDaily: 3 };

/* sender: sms.js when texting is on, else null; helpers: sms.js either way (recovery
   sends nothing, so it runs on every server) */
function use(sender, options, helpers) {
  sms = sender || null;
  tools = helpers || sender || null;
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
  return cloud.getSubmission(ref);
}

async function facilityPhone(id) {
  try {
    const f = (await facilities.get(id)).facility;
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

// A history line, the same however it was read
function signature(h) {
  return [h && h.at, h && h.status, (h && h.note) || ''].join('|');
}

/* ───────────── the caps ───────────── */

// Counts this text against its caps. Resolves with { skip: why it can't go (or null), release }
async function takeQuota(kind, to) {
  const hour = cloud.manilaHour();
  const day = hour.slice(0, 10);
  const caps = [];
  if (kind === 'received') {
    caps.push(['sms-received-all-' + day, limits.daily, 'Not sent: the daily limit for "form received" texts (' + limits.daily + ') was reached.']);
    caps.push(['sms-received-' + to + '-' + day, limits.receivedPerNumberDaily, 'Not sent: this number already got ' + limits.receivedPerNumberDaily + ' "form received" texts today.']);
  }
  caps.push(['sms-auto-' + to + '-' + hour, limits.perNumberHourly, 'Not sent: this number already got ' + limits.perNumberHourly + ' automatic texts this hour.']);
  const ids = caps.map((c) => c[0]);
  const values = await cloud.add(ids, 1);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await cloud.add(ids, -1).catch((err) => console.warn('[sms] Could not give back a place under the caps: ' + err.message));
  };
  const over = caps.findIndex((c, i) => !(values[i] <= c[1]));
  if (over !== -1) {
    await release();
    return { skip: caps[over][2], release: null };
  }
  return { skip: null, release };
}

/* ───────────── sending one ───────────── */

// Claims a text; a Firestore hiccup gets one more try (if the first claim landed after all,
// the second finds it: the note is then "sending", and recovery logs it as not confirmed)
async function claim(note) {
  try {
    return await cloud.claimNote(note);
  } catch (err) {
    if (err.code !== 'unavailable' && err.code !== 'firestore-error') throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return cloud.claimNote(note);
  }
}

async function text(sub, kind, key, fields) {
  if (!cloud.isOwn(sub.ref)) return null;   // a test run's submission (year 9999) is never texted for real, and the reverse
  const to = sms.mobileKey(sub.contact && sub.contact.mobile);
  // If it can't be claimed at all, nothing is sent now: the next sweep finds it unclaimed and sends it
  const noteId = await claim({ ref: sub.ref, key, kind, to: to || null, message: fields.message });
  if (!noteId) return null;   // sent already, or being sent right now
  let quota = { skip: null, release: null };
  if (to) {
    try {
      quota = await takeQuota(kind, to);
    } catch (err) {
      // Without the counts a flood of forms could use up the SMS credit, so it waits for the admin
      quota = { skip: 'Not sent: the limits on automatic texts could not be checked (' + err.message + ') Send it again from the Message log.', release: null };
    }
  }
  const record = await sms.send(Object.assign({
    id: cloud.smsIdFor(noteId),   // logged under an id fixed by the note, so it is in the log once
    to: to || (sub.contact && sub.contact.mobile),
    ref: sub.ref,
    name: (sub.contact && sub.contact.name) || null,
    auto: true,
    skip: quota.skip
  }, fields));
  if (quota.release && (record.status === 'failed' || record.status === 'skipped')) await quota.release();
  if (record.logged === false) {
    // Not in the SMS log (Firestore hiccup): one more try; else the note keeps the record and
    // stays "sending", and recovery adds it to the log with its real status
    const clean = Object.assign({}, record);
    delete clean.logged;
    delete clean.logError;
    const saved = await cloud.addSms(clean).then(() => true, () => false);
    if (!saved) {
      await cloud.keepUnlogged(noteId, clean).catch((err) => console.warn('[sms] Not in the SMS log, and its note could not keep it: ' + err.message));
      return record;
    }
    record.logged = true;
    delete record.logError;
  }
  await cloud.settleNote(noteId, record).catch((err) => console.warn('[sms] Sent, but its note could not be updated: ' + err.message));
  return record;
}

/* ───────────── her form arrived ───────────── */

async function received(sub) {
  if (!sms || !sub) return null;
  const kind = KIND[sub.type] || 'form';
  const message = fit([
    'MOWMMAS: We received your ' + kind + ' for ' + sub.facilityName + '. Ref: ' + sub.ref + ". We'll text you when it's updated.",
    'MOWMMAS: We received your ' + kind + '. Ref: ' + sub.ref + ". We'll text you when it's updated.",
    'MOWMMAS: We received your form. Ref: ' + sub.ref + '.'
  ]);
  return text(sub, 'received', 'received|' + sub.ref, { message, type: 'received', event: 'Form received', facility: sub.facilityName || null });
}

/* ───────────── the admin moved it on ───────────── */

async function updateText(sub, entry, previous) {
  const kind = KIND[sub.type] || 'form';
  const noteText = sms.clean(entry.note || '');   // cleaned first, so its length is the length sent
  if (isReferral(entry)) {
    // The facility this line names (a later referral may name another)
    const named = entry.facilityName || (/^Referred to ([^\n]+)$/.exec(noteText) || [])[1] || '';
    const r = sub.referral && sub.referral.facilityId ? sub.referral : null;
    const facility = named || (r && r.facilityName) || 'a health facility';
    const facilityId = entry.facilityId || (r && r.facilityName === facility ? r.facilityId : null);
    const phone = facilityId ? await facilityPhone(facilityId) : null;
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

/* Texts each admin update of the last day that hasn't been texted.
   Resolves with { records, done } (done: false when the deadline stopped it early). */
async function updated(sub, deadline) {
  const records = [];
  if (!sms || !sub) return { records, done: true };
  const history = Array.isArray(sub.statusHistory) ? sub.statusHistory : [];
  const due = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || entry.by !== 'admin') continue;
    if (!(Date.now() - (Date.parse(entry.at) || 0) < DAY)) continue;   // too old to text now
    due.push({ entry, previous: history[i - 1], key: 'status|' + sub.ref + '|' + signature(entry) });
  }
  if (!due.length) return { records, done: true };
  const noted = new Set((await cloud.notesFor(sub.ref)).map((n) => n && n.key));
  for (const d of due) {
    if (noted.has(d.key)) continue;
    if (deadline && Date.now() > deadline) return { records, done: false };
    const record = await text(sub, 'status', d.key, await updateText(sub, d.entry, d.previous));
    if (record) records.push(record);
  }
  return { records, done: true };
}

/* One pass over the submissions after where the last one stopped (counters/<stateId>), at
   most a day back. list(since) → the documents, oldest first, each with _at (the time it is
   listed by, as Firestore stores it); each(doc) → { records, done }. The place is saved as
   it goes, and only past a time no later document shares (the list is "later than"), so a
   pass that stops (the deadline, a server stopped) never skips one.
     start: where a first pass starts: 'day' (a day back) or 'now'
     margin: the place stays at least this far back (saves still landing, clocks that differ) */
async function pass(stateId, list, each, deadline, options) {
  const o = options || {};
  const state = await firestore.getDoc('counters', stateId);
  const dayAgo = Date.now() - DAY;
  // The place never moves past the last `margin`: a save stamped a moment ago may still be landing,
  // so the newest documents are listed again until they are that old (the notes stop a second text)
  const settledBefore = o.margin ? Date.now() - o.margin : Infinity;
  let since;
  if (state && typeof state.until === 'string' && Date.parse(state.until) > dayAgo) {
    since = state.until;
  } else {
    since = new Date(state || o.start !== 'now' ? dayAgo : Date.now()).toISOString();
  }
  const docs = await list(since);
  const records = [];
  let checked = 0;
  let done = true;
  // From the saved place (a quiet pass then writes nothing); moved on only by listed documents
  const kept = state && typeof state.until === 'string' && !Number.isNaN(Date.parse(state.until)) ? state.until : null;
  let reached = kept || since;
  let saved = state ? state.until : null;
  let sinceSave = 0;
  const save = async () => {
    if (reached === saved) return;
    const until = reached;
    await firestore.setDoc('counters', stateId, { until, updatedAt: new Date() })
      .then(() => { saved = until; sinceSave = 0; })
      .catch((err) => console.warn('[sms] Could not save where the sweep stopped: ' + err.message));
  };
  for (let i = 0; i < docs.length; i++) {
    if (deadline && Date.now() > deadline) { done = false; break; }   // the rest waits for the next sweep
    const doc = docs[i];
    if (cloud.isOwn(doc.ref)) {
      const result = await each(doc);
      records.push(...result.records);
      if (!result.done) { done = false; break; }
      checked++;
    }
    const next = docs[i + 1];
    if (doc._at && (!next || next._at !== doc._at) && Date.parse(doc._at) > Date.parse(reached) &&
        Date.parse(doc._at) <= settledBefore) reached = doc._at;
    if (++sinceSave >= 20) await save();
  }
  await save();
  return { checked, records, done };
}

/* Texts every admin update of the last day not texted yet (counters/notify-sweep), and
   every form of the last day whose reference number nobody texted (counters/notify-received:
   e.g. it was sent to a server without the PhilSMS key, or Firestore failed right then).
   Forms are listed by savedAt, Firestore's own clock when it was saved (forms from before it
   had one were texted by the old server, and aren't listed). A quiet sweep costs a few reads.
   Resolves with { checked, records, done }. */
async function sweep(deadline) {
  if (!sms) return { checked: 0, records: [], done: true };
  const updates = await pass(cloud.limitId('notify-sweep'), (since) => cloud.changedByAdminSince(since),
    (doc) => updated(doc, deadline), deadline, { start: 'day', margin: 2 * 60 * 1000 });
  if (!updates.done) return updates;
  const forms = await pass(cloud.limitId('notify-received'), (since) => cloud.savedSince(since), async (sub) => {
    if (!(Date.now() - (Date.parse(sub.savedAt || sub.createdAt) || 0) < DAY)) return { records: [], done: true };
    if (await cloud.hasNote('received|' + sub.ref)) return { records: [], done: true };
    const record = await received(sub);
    return { records: record ? [record] : [], done: true };
  }, deadline, { start: 'day', margin: 2 * 60 * 1000 });
  return { checked: updates.checked + forms.checked, records: updates.records.concat(forms.records), done: forms.done };
}

/* ───────────── an admin texted her ───────────── */

async function copy(sub, record) {
  if (!sub || !record || record.status !== 'sent') return;
  try {
    await cloud.addManualNote(sub.ref, record);
  } catch (err) {
    console.warn('[sms] Sent, but the copy for Track Submission could not be saved: ' + err.message);
  }
}

/* ───────────── texts cut off ───────────── */

async function recover() {
  if (!tools) return 0;
  return cloud.recoverStuckNotes(STUCK_AFTER_MS, async (n, id) => {
    const sub = await submission(n.ref).catch(() => null);
    return ({
      id, to: n.to, name: (sub && sub.contact && sub.contact.name) || null, ref: n.ref,
      facility: (sub && sub.facilityName) || null, type: n.kind === 'received' ? 'received' : 'status', event: 'Automatic text',
      message: n.message, segments: tools.segments(n.message || ''), status: 'unknown',
      error: 'The MOWMMAS server stopped before PhilSMS answered, so it may or may not have been sent. Check Reports in the PhilSMS dashboard before sending it again.',
      gatewayUid: null, auto: true, sentAt: n.createdAt, sentBy: null, resendOf: null
    });
  });
}

module.exports = { use, received, updated, sweep, copy, submission, recover, isReferral, signature };
