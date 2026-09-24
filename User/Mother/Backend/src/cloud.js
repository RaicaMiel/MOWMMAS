'use strict';
/* ══════════════════════════════════════════════════════════════════
   Where the MOWMMAS server keeps its records: Firestore, signed in as the
   admin (User/Admin/Backend/src/firestore.js). Vercel keeps no files, so
   the server on a computer and the one online share these:

     submissions/<ref>         the mothers' forms (what the admin pages show)
     counters/refs-<year>      the last reference number handed out that year
     notifications/<id>        each text sent about a submission: the automatic
                               ones (id auto-…, one per update, so it is never sent
                               twice) and copies of the admin's own texts, which
                               Track Submission shows
     smsLog/<id>               every SMS, as the admin's Message log shows it
     smsTemplates/<key>        the SMS page's wording
     limits/<id>               counts for the limits on forms and automatic texts

   The rules for them are in User/Admin/Backend/firestore.rules.
   ══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const firestore = require('../../../Admin/Backend/src/firestore');
const adminConfig = require('../../../Admin/Backend/src/config');

const SUBMISSIONS = adminConfig.SUBMISSIONS_COLLECTION;
const REF_PATTERN = /^MOW-([DRI])-(\d{4})-(\d{5,9})$/;

// A test run keeps its numbers and counts apart from the real ones (never set on the real server)
const TEST_RUN = process.env.MOWMMAS_TEST_RUN ? String(process.env.MOWMMAS_TEST_RUN).replace(/[^a-z0-9]/gi, '').slice(0, 12) : '';
const limitId = (id) => (TEST_RUN ? TEST_RUN + '-' : '') + id;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
// "2026-09-24T15" in Manila time: .slice(0, 10) is the day, .slice(0, 4) the year
const manilaHour = (ms) => new Date((ms == null ? Date.now() : ms) + MANILA_OFFSET_MS).toISOString().slice(0, 13);
const refYear = () => (TEST_RUN ? '9999' : manilaHour().slice(0, 4));

const plain = (doc) => {
  if (!doc) return null;
  const out = Object.assign({}, doc);
  delete out._id;
  delete out._updateTime;
  return out;
};
const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/* ───────────── submissions ───────────── */

async function highestRef(year) {
  let max = 0;
  for (const doc of await firestore.listDocs(SUBMISSIONS)) {
    const m = REF_PATTERN.exec(String(doc.ref || doc._id));
    if (m && m[2] === year) max = Math.max(max, Number(m[3]));
  }
  return max;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The marker of a save key: counters/save-<hash>, saved with the submission, naming its reference
const markerId = (saveKey) => 'save-' + hash('save|' + saveKey).slice(0, 40);

/* The submission a save key's marker names (the same form sent before), or null when there is
   no marker or its submission is gone (e.g. the admin removed it). Also resolves with the
   marker itself, so a gone one can be replaced. */
async function earlierSave(saveKey) {
  const marker = await firestore.getDoc('counters', markerId(saveKey));
  if (!marker) return { earlier: null, marker: null };
  const earlier = marker.ref ? await getSubmission(marker.ref) : null;
  return { earlier: earlier && earlier.saveId === saveKey ? earlier : null, marker };
}

/* Saves a new submission under the next reference number.
   build.refFor(number, year) → the reference; build.record(ref) → the Firestore record.
   saveKey (optional): the same form sent again has the same key (see submissions.prepare):
   it is saved once, and the first save comes back. Resolves with { record, again }.

   The same "optimistic" way as the admin pages' Firestore transactions: the counter is
   read, then the next number, the submission and the save key's marker are saved in one
   write that Firestore only accepts if the counter is still as it was read, no submission
   has that number and no other save has that key. If another form got a number meanwhile
   (here or on the other server), it reads again; a number already in use is skipped, never
   overwritten. So two forms never share a number, and one form is never saved twice. */
async function createSubmission(build, saveKey) {
  const year = refYear();
  const counterId = 'refs-' + year;
  // Marks this save, so a save whose answer was lost can be recognised (see below)
  const saveId = saveKey || crypto.randomUUID();
  let taken = 0;   // the highest number found in use while trying
  let scanned = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt) await pause(Math.floor(Math.random() * 100 * Math.min(attempt, 5)));   // forms at the same moment: spread out
    let marker = null;
    if (saveKey) {
      const found = await earlierSave(saveKey);
      if (found.earlier) return { record: found.earlier, again: true };
      marker = found.marker;   // a marker whose submission is gone is replaced
    }
    const counter = await firestore.getDoc('counters', counterId);
    const last = counter && Number.isInteger(counter.last) ? counter.last : await highestRef(year);
    const number = Math.max(last, taken) + 1;
    const ref = build.refFor(number, year);
    const record = Object.assign(build.record(ref), { saveId });
    const writes = [
      firestore.write('counters', counterId, { last: number, updatedAt: new Date() },
        counter ? { updateTime: counter._updateTime } : { exists: false }),
      // savedAt: Firestore's own clock, so the sweep of new forms never depends on a server's clock
      firestore.write(SUBMISSIONS, ref, record, { exists: false, serverTimes: ['savedAt'] })
    ];
    if (saveKey) {
      writes.push(firestore.write('counters', markerId(saveKey), { ref, createdAt: new Date() },
        marker ? { updateTime: marker._updateTime } : { exists: false }));
    }
    try {
      await firestore.commit(writes);
      return { record, again: false };
    } catch (err) {
      if (err.code === 'already-exists' || err.code === 'failed-precondition' || err.code === 'aborted') {
        // Refused: the counter moved (read it again), that number is in use (the next one),
        // or the same form was saved meanwhile (the next round finds its marker)
        const there = await firestore.getDoc(SUBMISSIONS, ref).catch(() => null);
        if (there) {
          taken = Math.max(taken, number);
          // The counter is behind numbers already in use (saved without it, e.g. by an older
          // server): skip past them all at once, and the next save moves the counter there
          if (!scanned) {
            scanned = true;
            taken = Math.max(taken, await highestRef(year).catch(() => 0));
          }
        }
        continue;
      }
      // No clear answer (the connection dropped, or Firestore took too long): it may have been
      // saved anyway. If this form's own copy is there, it was; otherwise she is asked to try
      // again (never saved under a second number here, which could leave her with two; the form
      // page sends the same save key again, so her next try finds it if it landed late).
      if (err.code === 'unavailable' || err.code === 'firestore-error') {
        const look = () => firestore.getDoc(SUBMISSIONS, ref);
        const saved = await look().catch(() => pause(1000).then(look)).catch(() => null);
        if (saved && saved.saveId === saveId) return { record, again: false };
      }
      throw err;
    }
  }
  const busy = new Error('Too many forms at the same moment. Please try again.');
  busy.status = 503;
  throw busy;
}

async function getSubmission(ref) {
  if (!REF_PATTERN.test(String(ref || ''))) return null;   // also keeps odd input out of Firestore paths
  const doc = await firestore.getDoc(SUBMISSIONS, ref);
  return doc ? Object.assign(plain(doc), { ref: doc.ref || doc._id }) : null;
}

/* The submissions an admin changed after `after` (adminUpdatedAt as Firestore stores it), oldest first */
async function changedByAdminSince(after) {
  const docs = await firestore.listAfter(SUBMISSIONS, 'adminUpdatedAt', after);
  return docs.map((doc) => Object.assign(plain(doc), { ref: doc.ref || doc._id, _at: doc._at }));
}

/* The submissions saved after `after` (savedAt: Firestore's clock when it was saved), oldest first */
async function savedSince(after) {
  const docs = await firestore.listAfter(SUBMISSIONS, 'savedAt', after);
  return docs.map((doc) => Object.assign(plain(doc), { ref: doc.ref || doc._id, _at: doc._at }));
}

/* ───────────── texts sent about a submission ───────────── */

const autoNoteId = (key) => 'auto-' + hash(key).slice(0, 40);

async function notesFor(ref) {
  return (await firestore.query('notifications', { where: [['ref', '==', ref]] })).map(plain);
}

// Whether the automatic text with this key was claimed (sent, being sent, or not sent on purpose)
async function hasNote(key) {
  return Boolean(await firestore.getDoc('notifications', autoNoteId(key)));
}

/* Claims an automatic text: resolves with its note's id, or null when this text
   (key) was already sent or is being sent, here or on the other server. */
async function claimNote(note) {
  const id = autoNoteId(note.key);
  try {
    await firestore.setDoc('notifications', id, Object.assign({ id, status: 'sending', createdAt: new Date().toISOString() }, note), { exists: false });
    return id;
  } catch (err) {
    if (err.code === 'already-exists') return null;
    throw err;
  }
}

async function settleNote(id, record) {
  await firestore.setDoc('notifications', id, {
    smsId: record.id, to: record.to, message: record.message, status: record.status, createdAt: record.sentAt
  }, { exists: true }, ['smsId', 'to', 'message', 'status', 'createdAt']);
}

/* The text went (or was refused), but its SMS record couldn't be saved in the log: the note
   keeps the record and stays "sending", so recovery adds it to the log with its real status */
async function keepUnlogged(id, record) {
  await firestore.setDoc('notifications', id, { pendingRecord: record }, { exists: true }, ['pendingRecord']);
}

/* A copy of a text an admin sent her (Track Submission shows it) */
async function addManualNote(ref, record) {
  await firestore.setDoc('notifications', record.id, {
    id: record.id, ref, key: 'manual|' + record.id, kind: 'manual', to: record.to, message: record.message, status: record.status, createdAt: record.sentAt
  });
}

/* The id of an automatic text's SMS record: fixed by its note, so it is logged once */
const smsIdFor = (noteId) => 'sms-' + noteId;

/* Automatic texts left "sending" for longer than `olderThanMs`: the server stopped before
   the text was settled. If its SMS record is in the log, the note takes its status (only
   the note's update was lost). If not, the record the note kept (the log was unreachable)
   is added, or else toRecord(note, id), as "unknown" (PhilSMS may or may not have sent it).
   Either happens once, whoever else looks at the same moment. Resolves with how many were
   added to the log. */
async function recoverStuckNotes(olderThanMs, toRecord) {
  const stuck = await firestore.query('notifications', { where: [['status', '==', 'sending']] });
  let added = 0;
  for (const note of stuck) {
    if (!(Date.now() - (Date.parse(note.createdAt) || 0) > olderThanMs)) continue;
    const id = smsIdFor(note._id);
    let logged = await firestore.getDoc('smsLog', id);
    if (!logged) {
      const kept = note.pendingRecord && typeof note.pendingRecord === 'object' && note.pendingRecord.id === id ? note.pendingRecord : null;
      const record = kept || await toRecord(plain(note), id);
      if (await addSmsIfMissing(record)) { logged = record; added++; } else logged = await firestore.getDoc('smsLog', id);
    }
    try {
      await firestore.setDoc('notifications', note._id, { status: (logged && logged.status) || 'unknown', smsId: id },
        { updateTime: note._updateTime }, ['status', 'smsId']);
    } catch (err) {
      if (err.code !== 'failed-precondition' && err.code !== 'not-found') throw err;   // settled meanwhile
    }
  }
  return added;
}

/* ───────────── the SMS log ───────────── */

// Saves an SMS record (an automatic text's replaces the "unknown" one recovery may have added first)
async function addSms(record) {
  await firestore.setDoc('smsLog', record.id, record);
}

// Adds it only if no record has that id yet; resolves with whether it was added
async function addSmsIfMissing(record) {
  try {
    await firestore.setDoc('smsLog', record.id, record, { exists: false });
    return true;
  } catch (err) {
    if (err.code === 'already-exists') return false;
    throw err;
  }
}

async function getSms(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) return null;
  return plain(await firestore.getDoc('smsLog', id));
}

// The newest `limit` SMS, newest first
async function listSms(limit) {
  return (await firestore.query('smsLog', { orderBy: [['sentAt', 'desc']], limit })).map(plain);
}

async function saveDelivery(record) {
  await firestore.setDoc('smsLog', record.id, { delivery: record.delivery || null, deliveryCheckedAt: record.deliveryCheckedAt || null },
    { exists: true }, ['delivery', 'deliveryCheckedAt']);
}

/* ───────────── SMS templates ───────────── */

async function templates() {
  const out = {};
  for (const doc of await firestore.listDocs('smsTemplates')) {
    out[doc._id] = { text: doc.text, updatedAt: doc.updatedAt || null, updatedBy: doc.updatedBy || null };
  }
  return out;
}

async function saveTemplate(key, saved) {
  await firestore.setDoc('smsTemplates', key, saved);
}

/* ───────────── limits ─────────────
   Each count is one document (limits/<id>), added to in one step, so requests running
   at the same moment (on any server) are all counted. */
const LIMIT_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // expiresAt: when the count no longer matters

async function count(id) {
  const doc = await firestore.getDoc('limits', limitId(id));
  return doc && Number.isFinite(doc.count) ? doc.count : 0;
}

// Adds n to each count (created at 0) and resolves with the new values, in order
async function add(ids, n) {
  const expiresAt = new Date(Date.now() + LIMIT_TTL_MS);
  return firestore.increment(ids.map((id) => ({ collection: 'limits', id: limitId(id), field: 'count', n, data: { expiresAt } })));
}

// Year 9999 belongs to test runs only: a test server handles only those, the real server never does
const isTestRef = (ref) => /^MOW-[DRI]-9999-/.test(String(ref || ''));
const isOwn = (ref) => (TEST_RUN ? isTestRef(ref) : !isTestRef(ref));

module.exports = {
  REF_PATTERN, manilaHour, hash, isOwn,
  createSubmission, getSubmission, changedByAdminSince, savedSince,
  notesFor, hasNote, claimNote, settleNote, keepUnlogged, addManualNote, recoverStuckNotes, autoNoteId, smsIdFor,
  addSms, addSmsIfMissing, getSms, listSms, saveDelivery,
  templates, saveTemplate,
  count, add, limitId
};
