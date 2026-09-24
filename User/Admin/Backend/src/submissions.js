'use strict';
/* The mothers' donations, requests and inquiries in Firestore:
   submissions/<reference>, e.g. submissions/MOW-D-2026-00001.

   save(submission)          copy one submission from the mother backend
   list({ type, status })    newest first; type is donate, request or inquire
   get(ref)                  one submission, or null
   changedByAdminSince(after) only the submissions an admin changed after `after`
                             (their adminUpdatedAt, set by Firestore's clock), oldest first

   Each document also carries readable labels (typeLabel, statusLabel), so the
   Firestore console and the admin pages don't have to look them up. */
const config = require('./config');
const firestore = require('./firestore');
const { FirebaseError } = require('./auth');
const { TYPES, FINAL, statusLabel } = require('./statuses');

const REF = /^MOW-[DRI]-\d{4}-\d{5,}$/;

/* What the mother sent. Once a submission is in Firestore, the sync only ever
   writes these fields again. Everything else (status, statusLabel, isFinal,
   statusHistory, updatedAt, adminUpdatedAt, referral) belongs to the admin and is never overwritten. */
const MOTHER_FIELDS = ['ref', 'type', 'typeLabel', 'facilityId', 'facilityName', 'contact', 'details', 'consent', 'createdAt', 'source', 'syncedAt'];
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
// Only these fields are times; they are stored as Firestore timestamps. Everything a mother typed stays text.
const when = (v) => {
  const t = text(v);
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
};

function isRef(ref) {
  return typeof ref === 'string' && REF.test(ref);
}

/* The mother backend's submission → the Firestore document */
function toRecord(sub) {
  if (!sub || !isRef(sub.ref)) {
    throw new FirebaseError('invalid-argument', 'A submission without a valid reference number was skipped.', 400);
  }
  const type = Object.prototype.hasOwnProperty.call(TYPES, sub.type) ? sub.type : null;
  const status = text(sub.status) || 'submitted';
  const contact = sub.contact && typeof sub.contact === 'object' ? sub.contact : {};
  return {
    ref: sub.ref,
    type,
    typeLabel: type ? TYPES[type].label : null,
    facilityId: text(sub.facilityId),
    facilityName: text(sub.facilityName),
    status,
    statusLabel: statusLabel(status),
    isFinal: FINAL.includes(status),
    statusHistory: (Array.isArray(sub.statusHistory) ? sub.statusHistory : [])
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        status: text(h.status),
        statusLabel: h.status ? statusLabel(h.status) : null,
        at: when(h.at),
        by: text(h.by),
        note: text(h.note)
      })),
    contact: {
      name: text(contact.name),
      mobile: text(contact.mobile),
      email: text(contact.email),
      municipality: text(contact.municipality),
      barangay: text(contact.barangay)
    },
    details: sub.details && typeof sub.details === 'object' && !Array.isArray(sub.details) ? sub.details : {},
    consent: sub.consent === true,
    createdAt: when(sub.createdAt),
    updatedAt: when(sub.updatedAt) || when(sub.createdAt),
    source: 'mother-website',
    syncedAt: new Date()
  };
}

/* The Firestore document → what the admin API returns */
function toView(doc) {
  const view = Object.assign({}, doc);
  view.ref = doc.ref || doc._id;
  view.firestoreUpdatedAt = doc._updateTime || null;
  delete view._id;
  delete view._updateTime;
  return view;
}

/* The same submission = the same reference AND the same moment it was created */
function sameSubmission(existing, record) {
  const a = Date.parse(existing && existing.createdAt);
  const b = record.createdAt ? record.createdAt.getTime() : NaN;
  return !Number.isNaN(a) && a === b;
}

/* Saves a submission without ever replacing a DIFFERENT one that has the same
   reference number (e.g. after the mother backend's data file was cleared and
   the numbering started again). Such a clash is reported, not overwritten. */
async function save(sub, attempt) {
  const record = toRecord(sub);
  const col = config.SUBMISSIONS_COLLECTION;
  const existing = await firestore.getDoc(col, record.ref);
  if (existing && !sameSubmission(existing, record)) {
    throw new FirebaseError('ref-collision', 'Reference ' + record.ref + ' is already used in Firestore by another submission' +
      (existing.createdAt ? ' (sent ' + existing.createdAt + ')' : '') + ', so it was not replaced.', 409);
  }
  try {
    if (existing) {
      const mine = {};
      for (const key of MOTHER_FIELDS) mine[key] = record[key];
      await firestore.setDoc(col, record.ref, mine, { updateTime: existing._updateTime }, MOTHER_FIELDS);
    } else {
      await firestore.setDoc(col, record.ref, record, { exists: false });
    }
  } catch (err) {
    // Someone saved it between our read and our write: look again, once.
    if (!attempt && (err.code === 'already-exists' || err.code === 'failed-precondition')) return save(sub, 1);
    throw err;
  }
  return record;
}

const time = (iso) => Date.parse(iso) || 0;

async function list(filter) {
  const f = filter || {};
  const docs = await firestore.listDocs(config.SUBMISSIONS_COLLECTION);
  return docs
    .map(toView)
    .filter((s) => (!f.type || s.type === f.type) && (!f.status || s.status === f.status))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || String(b.ref).localeCompare(String(a.ref)));
}

async function get(ref) {
  if (!isRef(ref)) return null;
  const doc = await firestore.getDoc(config.SUBMISSIONS_COLLECTION, ref);
  return doc ? toView(doc) : null;
}

/* Submissions an admin changed after `after` (see firestore.listAfter), oldest first.
   Each has _at: its adminUpdatedAt exactly as Firestore stores it. */
async function changedByAdminSince(after) {
  const docs = await firestore.listAfter(config.SUBMISSIONS_COLLECTION, 'adminUpdatedAt', after);
  return docs.map((doc) => Object.assign(toView(doc), { _at: doc._at }));
}

module.exports = { MOTHER_FIELDS, isRef, toRecord, save, list, get, changedByAdminSince };
