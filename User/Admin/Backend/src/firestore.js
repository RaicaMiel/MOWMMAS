'use strict';
/* A small Firestore client over the REST API (Node built-ins only).
   Every call is signed in as the admin account (auth.js), so Firestore's
   security rules apply to it like to the admin in a browser.

   setDoc(collection, id, data)   create or replace a document
   getDoc(collection, id)         the document's data, or null
   deleteDoc(collection, id)
   listDocs(collection)           every document in the collection
   listAfter(collection, field, after)
                                  only documents whose timestamp field is later than
                                  `after`, oldest first (Firestore bills only those)

   Plain JavaScript values go in and come out:
     strings, numbers, booleans, null, arrays, objects, and
     Date objects → Firestore timestamps → ISO strings ("2026-09-23T08:15:00.000Z").
   Strings are always stored as text, even when a mother types something that
   looks like a date: only real Date objects become timestamps. */
const config = require('./config');
const auth = require('./auth');
const { FirebaseError } = auth;

function baseUrl() {
  if (!config.PROJECT_ID) throw new FirebaseError('config', 'Set FIREBASE_PROJECT_ID in User/Admin/Backend/.env.', 500);
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(config.PROJECT_ID) + '/databases/(default)/documents';
}

/* ───────────── JavaScript ⇄ Firestore values ───────────── */

function encode(value, where) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { nullValue: null };
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { nullValue: null } : { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    if (value.some(Array.isArray)) {
      throw new FirebaseError('invalid-argument', 'Firestore cannot store a list inside a list (' + (where || 'value') + ').', 400);
    }
    return { arrayValue: { values: value.map((v, i) => encode(v, (where || '') + '[' + i + ']')) } };
  }
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value, where) } };
  return { stringValue: String(value) };
}

function encodeFields(object, where) {
  const fields = {};
  for (const [key, v] of Object.entries(object)) {
    if (v === undefined) continue;
    fields[key] = encode(v, where ? where + '.' + key : key);
  }
  return fields;
}

function decode(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) {
    const t = new Date(v.timestampValue);
    return Number.isNaN(t.getTime()) ? v.timestampValue : t.toISOString();
  }
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  if ('geoPointValue' in v) return { lat: v.geoPointValue.latitude || 0, lon: v.geoPointValue.longitude || 0 };
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, v] of Object.entries(fields || {})) out[key] = decode(v);
  return out;
}

/* ───────────── requests ───────────── */

// Firestore's error status → a short code and a message for whoever runs the backend
const STATUS_CODES = {
  PERMISSION_DENIED: ['permission-denied', 'Firestore refused. Publish the rules in User/Admin/Backend/firestore.rules (Firebase console, Firestore Database, Rules).', 403],
  UNAUTHENTICATED: ['unauthenticated', 'Firestore did not accept the admin sign-in.', 401],
  NOT_FOUND: ['not-found', 'Not found in Firestore.', 404],
  ALREADY_EXISTS: ['already-exists', 'That document already exists in Firestore.', 409],
  INVALID_ARGUMENT: ['invalid-argument', 'Firestore could not store this data.', 400],
  RESOURCE_EXHAUSTED: ['resource-exhausted', 'The Firestore quota is used up for now. Try again later.', 429],
  UNAVAILABLE: ['unavailable', "Firestore can't be reached right now. It will be tried again.", 503],
  FAILED_PRECONDITION: ['failed-precondition', 'Firestore refused the change: the document changed meanwhile, or the database is not ready.', 412],
  ABORTED: ['aborted', 'Firestore was busy with the same document. Try again.', 409],
  DEADLINE_EXCEEDED: ['unavailable', "Firestore didn't answer in time. Try again.", 503]
};

async function request(method, path, body, retried) {
  const url = baseUrl() + path; // a missing project ID is a settings problem, not a network one
  const session = await auth.getSession();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + session.idToken },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw new FirebaseError('unavailable', "Can't reach Firestore. Check the internet connection.", 503);
  }
  if (response.status === 401 && !retried) {
    auth.invalidate(); // expired or revoked: sign in again once
    return request(method, path, body, true);
  }
  const text = await response.text().catch(() => null);
  let data = {};
  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      if (response.ok) throw new FirebaseError('unavailable', "Firestore's answer was cut off. Try again.", 503);
    }
  } else if (text === null && response.ok) {
    throw new FirebaseError('unavailable', "Firestore's answer was cut off. Try again.", 503);
  }
  // Most answers carry { error }. A query (:runQuery) answers with a list, and an error after
  // the first rows comes as a last [{ error }] with HTTP 200: the rows before it are not all.
  const rowError = Array.isArray(data) ? (data.find((row) => row && row.error) || {}).error || null : null;
  if (!response.ok || rowError) {
    const error = rowError || (data && !Array.isArray(data) && data.error) || null;
    const status = (error && error.status) || '';
    const known = STATUS_CODES[status];
    const detail = error && error.message ? ' (' + error.message + ')' : '';
    if (known) throw new FirebaseError(known[0], known[1] + (known[0] === 'invalid-argument' || known[0] === 'failed-precondition' ? detail : ''), known[2]);
    throw new FirebaseError('firestore-error', 'Firestore error ' + response.status + detail, 502);
  }
  return data;
}

const docPath = (collection, id) => '/' + encodeURIComponent(collection) + '/' + encodeURIComponent(id);
const idOf = (name) => decodeURIComponent(String(name).split('/').pop());
// The full name Firestore uses for a document in writes: projects/<id>/databases/(default)/documents/<collection>/<id>
const docName = (collection, id) => 'projects/' + config.PROJECT_ID + '/databases/(default)/documents/' + collection + '/' + id;
const fromDoc = (doc) => Object.assign(decodeFields(doc.fields), { _id: idOf(doc.name), _updateTime: doc.updateTime });

/* Create or replace a document.
   precondition (optional): { exists: false }    only create it ('already-exists' if it is there)
                            { exists: true }     only change it if it is there ('not-found' if not)
                            { updateTime: '…' }  only replace that exact version ('failed-precondition' if it changed)
   onlyFields (optional):   top-level field names; only those are written, every other field is kept */
async function setDoc(collection, id, data, precondition, onlyFields) {
  const params = [];
  if (precondition && precondition.exists === false) params.push('currentDocument.exists=false');
  else if (precondition && precondition.exists === true) params.push('currentDocument.exists=true');
  else if (precondition && precondition.updateTime) params.push('currentDocument.updateTime=' + encodeURIComponent(precondition.updateTime));
  for (const field of onlyFields || []) params.push('updateMask.fieldPaths=' + encodeURIComponent(field));
  const query = params.length ? '?' + params.join('&') : '';
  const saved = await request('PATCH', docPath(collection, id) + query, { fields: encodeFields(data) });
  return { id: idOf(saved.name), updateTime: saved.updateTime };
}

async function getDoc(collection, id) {
  try {
    return fromDoc(await request('GET', docPath(collection, id)));
  } catch (err) {
    if (err.code === 'not-found') return null;
    throw err;
  }
}

/* ───────────── several writes at once ─────────────
   await commit([write(…), write(…)]);   all or nothing
   Each write can carry a condition (below); if one isn't met, nothing is written and it
   fails with 'already-exists' or 'failed-precondition'. (Firestore doesn't let a signed-in
   user start a server-side transaction, so this is how the admin pages' transactions work too:
   read, then write only if what was read is unchanged.) */
async function commit(writes) {
  return request('POST', ':commit', { writes });
}

/* A write for commit(): the document's data, plus
     exists: false | true   only create it / only change an existing one
     updateTime: '…'        only if it is still the version read (its _updateTime)
     onlyFields: [...]      only these top-level fields are written
     increments: { field: n }  added to what is stored (a missing field counts as 0)
     serverTimes: [field]   set to Firestore's own clock when the write lands */
function write(collection, id, data, options) {
  const o = options || {};
  const w = { update: { name: docName(collection, id), fields: encodeFields(data || {}) } };
  if (o.exists === false || o.exists === true) w.currentDocument = { exists: o.exists };
  else if (o.updateTime) w.currentDocument = { updateTime: o.updateTime };
  if (o.onlyFields) w.updateMask = { fieldPaths: o.onlyFields };
  const transforms = [];
  for (const [fieldPath, n] of Object.entries(o.increments || {})) transforms.push({ fieldPath, increment: { integerValue: String(n) } });
  for (const fieldPath of o.serverTimes || []) transforms.push({ fieldPath, setToServerValue: 'REQUEST_TIME' });
  if (transforms.length) w.updateTransforms = transforms;
  return w;
}

/* Adds n to a whole-number field of several documents at once (created when missing) and
   resolves with each one's new value, in order. Safe when many requests do it at the same moment.
   items: [{ collection, id, field, n, data? }]  (data: other fields to set on it) */
async function increment(items) {
  const answer = await commit(items.map((it) => write(it.collection, it.id, it.data || {}, {
    onlyFields: Object.keys(it.data || {}),
    increments: { [it.field]: it.n }
  })));
  return (answer.writeResults || []).map((r) => {
    const v = r && r.transformResults && r.transformResults[0];
    return v ? Number(v.integerValue != null ? v.integerValue : v.doubleValue) : NaN;
  });
}

/* ───────────── queries ─────────────
   query(collection, { where: [[field, op, value], …], orderBy: [[field, 'desc'|'asc'], …], limit })
   op: '==', '<', '<=', '>', '>='. Values as in setDoc (a Date is a timestamp). */
const OPS = { '==': 'EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL' };

async function query(collection, options) {
  const o = options || {};
  const filters = (o.where || []).map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: OPS[op], value: encode(value) } }));
  const structuredQuery = { from: [{ collectionId: collection }] };
  if (filters.length === 1) structuredQuery.where = filters[0];
  else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters } };
  if (o.orderBy) structuredQuery.orderBy = o.orderBy.map(([field, dir]) => ({ field: { fieldPath: field }, direction: dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }));
  if (o.limit) structuredQuery.limit = o.limit;
  const rows = await request('POST', ':runQuery', { structuredQuery });
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.document).map((row) => fromDoc(row.document));
}

async function deleteDoc(collection, id) {
  await request('DELETE', docPath(collection, id));
}

/* Documents whose timestamp `field` is later than `after` (a timestamp exactly as
   Firestore returned it, or null for "from the start"), oldest first.
   Firestore bills one read per document returned, and one read when none match,
   instead of one per document in the collection.
   Each document carries _at: its `field` exactly as stored, to pass back as `after`. */
async function listAfter(collection, field, after) {
  const rows = await request('POST', ':runQuery', {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN', value: { timestampValue: after || '1970-01-01T00:00:00Z' } } },
      orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }]
    }
  });
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.document)
    .map((row) => {
      const doc = row.document;
      const raw = doc.fields && doc.fields[field] && doc.fields[field].timestampValue;
      return Object.assign(decodeFields(doc.fields), { _id: idOf(doc.name), _updateTime: doc.updateTime, _at: raw || null });
    });
}

/* Every document, page by page (300 at a time) */
async function listDocs(collection) {
  return pages(collection, (path) => request('GET', path));
}

/* Every document of a collection anyone may read (the rules say read: if true, like
   facilities), without signing in: the mother site's map needs no admin account. */
async function listPublic(collection) {
  return pages(collection, async (path) => {
    let response;
    try {
      response = await fetch(baseUrl() + path, { signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new FirebaseError('unavailable', "Can't reach Firestore. Check the internet connection.", 503);
    }
    const text = await response.text().catch(() => null);
    let data = null;
    try { data = text && text.trim() ? JSON.parse(text) : null; } catch (err) { data = null; }
    if (!response.ok) {
      const known = STATUS_CODES[(data && data.error && data.error.status) || ''];
      throw known ? new FirebaseError(known[0], known[1], known[2]) : new FirebaseError('firestore-error', 'Firestore error ' + response.status, 502);
    }
    // A cut-off answer is not "no documents": the caller keeps what it had
    if (text === null || (text.trim() && !data) || (data && typeof data !== 'object')) {
      throw new FirebaseError('unavailable', "Firestore's answer was cut off. Try again.", 503);
    }
    return data || {};
  });
}

async function pages(collection, get) {
  const docs = [];
  let pageToken = '';
  do {
    const query = '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const page = await get('/' + encodeURIComponent(collection) + query);
    for (const doc of page.documents || []) {
      docs.push(Object.assign(decodeFields(doc.fields), { _id: idOf(doc.name), _updateTime: doc.updateTime }));
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

module.exports = {
  baseUrl, encode, decode, encodeFields, decodeFields, setDoc, getDoc, deleteDoc, listDocs, listPublic, listAfter,
  commit, write, increment, query
};
