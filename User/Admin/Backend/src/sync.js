'use strict';
/* Keeps Firestore in step with the mother backend's submissions.

   It runs inside the mother backend (User/Mother/Backend/server.js):
     sync.start(() => store.read('submissions', []), { applyRemote })   on start, then every minute
     sync.push()                                        right after a mother sends a form

   It works both ways:
     mother → Firestore   new submissions, and what the mother sent
     Firestore → mother   the status the admin set (e.g. "Under review" after a
                          referral), its history and where she was referred, so
                          her Track Submission page shows it. applyRemote(ref, patch)
                          writes that into the mother backend's data.
                          The facilities the admin manages: applyFacilities({ full, docs })
                          keeps the mother backend's copy (firestore-facilities.json),
                          which the mother site shows. facilityMirrorAge() says how old
                          its last full copy is (Infinity when there is none).

   A submission counts as sent once Firestore has its latest version (its
   updatedAt). If Firestore can't be reached, or refuses, the submission stays
   waiting and is sent on the next run, so no form is ever lost. Which ones
   are sent is kept in data/sync-state.json (in the Admin backend).

   status(list)   { pending, lastRunAt, lastError } for the admin API's health check */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const firestore = require('./firestore');
const submissions = require('./submissions');

const STATE_FILE = path.join(config.DATA_DIR, 'sync-state.json');
// Errors that are about one submission's data; the others (sign-in, rules, network) stop the run.
const PER_ITEM_ERRORS = new Set(['invalid-argument', 'ref-collision']);
// Where the submissions go. If this changes (another project or collection), everything is sent again.
const target = () => config.PROJECT_ID + '/' + config.SUBMISSIONS_COLLECTION;

const emptyState = () => ({ target: target(), synced: {}, lastRunAt: null, lastError: null });
const versionOf = (sub) => (sub && (sub.updatedAt || sub.createdAt)) || '';

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state && typeof state === 'object' && state.synced && typeof state.synced === 'object' && state.target === target()) return state;
  } catch (err) {
    // missing or damaged: start again (sending again is safe, it just overwrites)
  }
  return emptyState();
}

/* Write to a temporary file, then swap it in, so a crash never leaves half a file.
   Windows can refuse the swap for a moment while another program reads the file. */
function writeState(state) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, STATE_FILE);
      return;
    } catch (err) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // wait 25 ms, then retry
    }
  }
}

/* Every reference ever sent from this computer, so the mother backend never hands one out again */
function knownRefs() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state && state.synced && typeof state.synced === 'object' ? Object.keys(state.synced) : [];
  } catch (err) {
    return [];
  }
}

function waiting(list, state) {
  return (Array.isArray(list) ? list : [])
    .filter((sub) => sub && submissions.isRef(sub.ref) && state.synced[sub.ref] !== versionOf(sub));
}

let getList = null;
let applyRemote = null;
let applyFacilities = null;
let facilityMirrorAge = null;
let running = null;
let again = false;
let lastLogged = '';

function log(line) {
  if (line === lastLogged) return; // don't repeat the same message every minute
  lastLogged = line;
  console.log('[firestore] ' + line);
}

/* Firestore → mother: copy back the status (and its history) of submissions the
   admin changed. Only the submissions changed since the last pull are read
   (their adminUpdatedAt is later than state.pulledUntil), so a quiet minute
   costs one Firestore read however many submissions there are.
   pulledUntil only moves past a change once it has been applied here, so a
   failure never loses one: it is read again on the next run.
   No clocks are compared: only an admin changes a submission's status (the
   mother backend never does), so when Firestore's status or history differs
   from the mother's copy, Firestore's is the newer one. Comparing Firestore's
   time with this computer's time would skip changes whenever this computer's
   clock runs ahead. Returns how many were copied. */
async function pullStatuses(list) {
  if (!applyRemote) return 0;
  const since = readState().pulledUntil || null;
  const docs = await submissions.changedByAdminSince(since);
  if (!docs.length) return 0;

  const local = new Map((Array.isArray(list) ? list : []).filter(Boolean).map((sub) => [sub.ref, sub]));
  let changed = 0;
  let reached = since;
  try {
    for (const doc of docs) {
      const sub = local.get(doc.ref);
      // The same reference number on a different submission (e.g. data/submissions.json was reset):
      // not hers, so nothing is copied onto it (and nothing is texted)
      const sameOne = sub && (!doc.createdAt || !sub.createdAt || Date.parse(doc.createdAt) === Date.parse(sub.createdAt));
      if (sub && !sameOne) log('Not copying ' + doc.ref + ' from Firestore: that reference number belongs to another submission there.');
      if (sub && sameOne && doc.status && Array.isArray(doc.statusHistory)) {
        const localHistory = Array.isArray(sub.statusHistory) ? sub.statusHistory : [];
        // Where she was referred, without the admin's note (that stays with the admin)
        const referral = doc.referral && doc.referral.facilityId
          ? { facilityId: doc.referral.facilityId, facilityName: doc.referral.facilityName || null, referredAt: doc.referral.referredAt || null }
          : null;
        const localReferral = sub.referral && sub.referral.facilityId ? sub.referral.facilityId : null;
        const differs = doc.status !== sub.status || doc.statusHistory.length !== localHistory.length ||
          (referral ? referral.facilityId : null) !== localReferral;
        if (differs) {
          applyRemote(sub.ref, {
            status: doc.status,
            statusHistory: doc.statusHistory.map((h) => ({ id: h.id || null, kind: h.kind || null, status: h.status, at: h.at, by: h.by === 'admin' ? 'admin' : (h.by || null), note: h.note || null,
              facilityId: h.facilityId || null, facilityName: h.facilityName || null })),
            referral,
            updatedAt: doc.updatedAt
          });
          changed++;
        }
      }
      reached = doc._at || reached;
    }
  } finally {
    if (reached && reached !== since) {
      const state = readState();
      state.pulledUntil = reached;
      writeState(state);
    }
  }
  return changed;
}

/* Firestore → mother: the facilities the admin manages. A full copy when there is
   none yet or it's older than FACILITY_FULL_REFRESH_MS; otherwise only the ones an
   admin changed since the last run (their adminUpdatedAt), so a quiet minute costs
   one read. Returns how many facilities were updated. */
function plainFacility(doc) {
  const out = Object.assign({}, doc);
  out.id = doc.id || doc._id;
  delete out._id;
  delete out._updateTime;
  delete out._at;
  return out;
}

async function pullFacilities() {
  if (!applyFacilities) return 0;
  let count = 0;
  const age = facilityMirrorAge ? facilityMirrorAge() : Infinity;
  if (!(age < config.FACILITY_FULL_REFRESH_MS)) {
    const all = await firestore.listDocs(config.FACILITIES_COLLECTION);
    applyFacilities({ full: true, docs: all.map(plainFacility) });
    count = all.length;
  }
  const since = readState().facilitiesPulledUntil || null;
  const changed = await firestore.listAfter(config.FACILITIES_COLLECTION, 'adminUpdatedAt', since);
  if (changed.length) {
    applyFacilities({ full: false, docs: changed.map(plainFacility) });
    const state = readState();
    state.facilitiesPulledUntil = changed[changed.length - 1]._at || since;
    writeState(state);
    count = Math.max(count, changed.length);
  }
  return count;
}

/* Reading the admin's changes failed or works again: saved for /api/health and logged
   (once per new message, so a long outage doesn't fill the log) */
let lastPullLogged = '';
function notePull(error) {
  const state = readState();
  const next = error ? { code: error.code || 'error', message: error.message || String(error), at: new Date().toISOString() } : null;
  const had = state.pullError;
  if (next || had) {
    state.pullError = next;
    writeState(state);
  }
  const line = next
    ? 'Could not read the admin\'s changes from Firestore: ' + next.message + ' Trying again in a minute.'
    : had ? 'Reading the admin\'s changes from Firestore works again.' : '';
  if (line && line !== lastPullLogged) console.log('[firestore] ' + line);
  lastPullLogged = next ? line : '';
}

async function runOnce() {
  let list;
  try {
    list = getList ? getList() : [];
  } catch (err) {
    log('Could not read the submissions: ' + err.message);
    return;
  }
  let pullError = null;
  try {
    const pulled = await pullStatuses(Array.isArray(list) ? list : []);
    if (pulled) {
      lastLogged = '';
      log('Updated ' + pulled + ' submission' + (pulled === 1 ? '' : 's') + ' with the status set by the admin.');
      list = getList ? getList() : list;
    }
  } catch (err) {
    pullError = err;
  }
  try {
    const facilities = await pullFacilities();
    if (facilities) {
      lastLogged = '';
      log('Updated ' + facilities + ' facilit' + (facilities === 1 ? 'y' : 'ies') + ' from the admin\'s Firestore data.');
    }
  } catch (err) {
    pullError = pullError || err;
  }
  notePull(pullError);
  const state = readState();
  const todo = waiting(list, state);
  if (!todo.length) {
    if (state.lastError) { state.lastError = null; writeState(state); }
    log('All submissions are in Firestore.');
    return;
  }

  let sent = 0;
  let stopError = null;
  const skipped = [];
  for (const sub of todo) {
    try {
      await submissions.save(sub);
      state.synced[sub.ref] = versionOf(sub);
      sent++;
    } catch (err) {
      if (PER_ITEM_ERRORS.has(err.code)) { skipped.push(err.code === 'ref-collision' ? err.message : sub.ref + ': ' + err.message); continue; }
      stopError = err;
      break; // sign-in, rules or network: the rest waits for the next run
    }
  }

  state.lastRunAt = new Date().toISOString();
  const left = todo.length - sent;
  state.lastError = stopError || skipped.length
    ? { code: stopError ? stopError.code || 'error' : 'skipped', message: stopError ? stopError.message : skipped.join(' | '), at: state.lastRunAt }
    : null;
  writeState(state);

  if (sent) {
    lastLogged = '';
    log('Sent ' + sent + ' submission' + (sent === 1 ? '' : 's') + ' to Firestore (' + config.SUBMISSIONS_COLLECTION + ').');
  }
  if (left) log(left + ' submission' + (left === 1 ? '' : 's') + ' waiting for Firestore: ' + state.lastError.message);
}

/* One run at a time; a push during a run triggers one more run after it. */
function run() {
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      try { await runOnce(); } catch (err) { log('Sync stopped: ' + err.message); }
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

function start(listGetter, options) {
  getList = listGetter;
  applyRemote = options && typeof options.applyRemote === 'function' ? options.applyRemote : null;
  applyFacilities = options && typeof options.applyFacilities === 'function' ? options.applyFacilities : null;
  facilityMirrorAge = options && typeof options.facilityMirrorAge === 'function' ? options.facilityMirrorAge : null;
  run();
  setInterval(run, config.SYNC_INTERVAL_MS).unref();
}

function push() {
  run();
}

function status(list) {
  const state = readState();
  return {
    pending: waiting(list, state).length,
    sent: Object.keys(state.synced).length,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    // Reading the admin's changes (statuses, facilities) back from Firestore
    pullError: state.pullError || null
  };
}

module.exports = { start, push, run, status, knownRefs, STATE_FILE };
