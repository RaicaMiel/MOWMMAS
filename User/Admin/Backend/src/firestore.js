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
  FAILED_PRECONDITION: ['failed-precondition', 'Firestore is not ready. Check that the database exists in the Firebase console.', 412]
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = (data.error && data.error.status) || '';
    const known = STATUS_CODES[status];
    const detail = data.error && data.error.message ? ' (' + data.error.message + ')' : '';
    if (known) throw new FirebaseError(known[0], known[1] + (known[0] === 'invalid-argument' ? detail : ''), known[2]);
    throw new FirebaseError('firestore-error', 'Firestore error ' + response.status + detail, 502);
  }
  return data;
}

const docPath = (collection, id) => '/' + encodeURIComponent(collection) + '/' + encodeURIComponent(id);
const idOf = (name) => decodeURIComponent(String(name).split('/').pop());

/* Create or replace a document.
   precondition (optional): { exists: false }    only create it ('already-exists' if it is there)
                            { updateTime: '…' }  only replace that exact version ('failed-precondition' if it changed)
   onlyFields (optional):   top-level field names; only those are written, every other field is kept */
async function setDoc(collection, id, data, precondition, onlyFields) {
  const params = [];
  if (precondition && precondition.exists === false) params.push('currentDocument.exists=false');
  else if (precondition && precondition.updateTime) params.push('currentDocument.updateTime=' + encodeURIComponent(precondition.updateTime));
  for (const field of onlyFields || []) params.push('updateMask.fieldPaths=' + encodeURIComponent(field));
  const query = params.length ? '?' + params.join('&') : '';
  const saved = await request('PATCH', docPath(collection, id) + query, { fields: encodeFields(data) });
  return { id: idOf(saved.name), updateTime: saved.updateTime };
}

async function getDoc(collection, id) {
  try {
    const doc = await request('GET', docPath(collection, id));
    return Object.assign(decodeFields(doc.fields), { _id: idOf(doc.name), _updateTime: doc.updateTime });
  } catch (err) {
    if (err.code === 'not-found') return null;
    throw err;
  }
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
  const docs = [];
  let pageToken = '';
  do {
    const query = '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const page = await request('GET', '/' + encodeURIComponent(collection) + query);
    for (const doc of page.documents || []) {
      docs.push(Object.assign(decodeFields(doc.fields), { _id: idOf(doc.name), _updateTime: doc.updateTime }));
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return docs;
}

module.exports = { baseUrl, encode, decode, encodeFields, decodeFields, setDoc, getDoc, deleteDoc, listDocs, listAfter };
