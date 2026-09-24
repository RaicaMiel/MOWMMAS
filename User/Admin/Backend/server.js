'use strict';
/* ══════════════════════════════════════════════════════════════════
   MOWMMAS Admin backend (Node built-ins only — no npm install needed)

   Start:   node server.js          (or double-click start.bat)
   Check:   http://localhost:4000/api/health

   Mothers' donations, requests and inquiries are saved in Firestore
   (collection "submissions", one document per reference number). The mother
   backend copies each one there as soon as it is sent (src/sync.js). This
   server lets the admin side fetch them:

     GET /api/health                              Firebase sign-in and sync status
     GET /api/submissions                         all, newest first
     GET /api/submissions?type=donate             donate | request | inquire
     GET /api/submissions?type=request&status=submitted
     GET /api/submissions/MOW-D-2026-00001        one submission

   It listens on this computer only (127.0.0.1): the answers include mothers'
   names and mobile numbers.
   ══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const config = require('./src/config');
const auth = require('./src/auth');
const submissions = require('./src/submissions');
const sync = require('./src/sync');
const { TYPES, STATUS_LABELS } = require('./src/statuses');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(json);
}

/* Browsers may call the API only from the listed pages (Live Server, this server) */
function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && config.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  res.setHeader('Vary', 'Origin');
}

function motherSubmissions() {
  try {
    const list = JSON.parse(fs.readFileSync(config.MOTHER_SUBMISSIONS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

/* ───────────────────────── routes ───────────────────────── */

async function health() {
  let firebase;
  try {
    const session = await auth.getSession();
    firebase = { project: config.PROJECT_ID, signedInAs: config.ADMIN_EMAIL, uid: session.uid, ok: true };
  } catch (err) {
    firebase = { project: config.PROJECT_ID, ok: false, error: err.message };
  }
  return {
    ok: firebase.ok,
    service: 'MOWMMAS Admin backend',
    time: new Date().toISOString(),
    firebase,
    collection: config.SUBMISSIONS_COLLECTION,
    sync: sync.status(motherSubmissions())
  };
}

async function listSubmissions(url) {
  const type = (url.searchParams.get('type') || '').trim().toLowerCase();
  const status = (url.searchParams.get('status') || '').trim().toLowerCase();
  if (type && !Object.prototype.hasOwnProperty.call(TYPES, type)) {
    throw new HttpError(400, 'bad-type', 'type must be donate, request or inquire.');
  }
  if (status && !Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) {
    throw new HttpError(400, 'bad-status', 'status must be one of: ' + Object.keys(STATUS_LABELS).join(', ') + '.');
  }
  const list = await submissions.list({ type: type || null, status: status || null });
  const counts = { donate: 0, request: 0, inquire: 0 };
  for (const s of list) if (counts[s.type] !== undefined) counts[s.type]++;
  return { count: list.length, counts, fetchedAt: new Date().toISOString(), submissions: list };
}

async function getSubmission(ref) {
  let wanted;
  try {
    wanted = decodeURIComponent(ref).trim().toUpperCase();
  } catch (err) {
    throw new HttpError(400, 'bad-ref', 'A reference number looks like MOW-D-2026-00001.');
  }
  if (!submissions.isRef(wanted)) {
    throw new HttpError(400, 'bad-ref', 'A reference number looks like MOW-D-2026-00001.');
  }
  const found = await submissions.get(wanted);
  if (!found) throw new HttpError(404, 'not-found', 'No submission ' + wanted + ' in Firestore.');
  return found;
}

async function route(req, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/api/health') return [200, await health()];
  if (path === '/api/submissions') return [200, await listSubmissions(url)];
  const one = /^\/api\/submissions\/([^/]+)$/.exec(path);
  if (one) return [200, await getSubmission(one[1])];
  throw new HttpError(404, 'not-found', 'There is no MOWMMAS admin API at ' + path + '.');
}

let listeningPort = config.PORT;

/* Only requests addressed to this computer by name. This stops a web page that
   points its own domain at 127.0.0.1 (DNS rebinding) from reading the API. */
function allowedHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === 'localhost:' + listeningPort || host === '127.0.0.1:' + listeningPort || host === '[::1]:' + listeningPort;
}

async function onRequest(req, res) {
  if (!allowedHost(req)) {
    return send(res, 421, { error: { code: 'bad-host', message: 'Open the admin API at http://localhost:' + listeningPort + '.' } });
  }
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    return res.end();
  }
  try {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'The admin API only answers GET requests.');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      throw new HttpError(400, 'bad-url', 'That address is not valid.');
    }
    const [status, body] = await route(req, url);
    send(res, status, body);
  } catch (err) {
    // HttpError: our own; FirebaseError: sign-in or Firestore (it carries a status and a clear message)
    const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
    if (status >= 500 && !err.code) console.error('[admin api]', err);
    send(res, status, { error: { code: err.code || 'server-error', message: err.message || 'Something went wrong.' } });
  }
}

function start(port = config.PORT, host = config.HOST) {
  listeningPort = port;
  const server = http.createServer(onRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is already in use. The admin backend may already be running in another window.`);
      console.error('Close that window, or set ADMIN_PORT in User/Admin/Backend/.env to another port.\n');
    } else {
      console.error('The MOWMMAS Admin backend could not start:', err.message);
    }
    process.exit(1);
  });
  server.listen(port, host, async () => {
    console.log(`MOWMMAS Admin backend: http://localhost:${port}/api/health`);
    console.log(`Submissions:           http://localhost:${port}/api/submissions`);
    console.log(`Firestore project:     ${config.PROJECT_ID} (collection "${config.SUBMISSIONS_COLLECTION}")`);
    try {
      const session = await auth.getSession();
      console.log(`Signed in to Firebase:  ${config.ADMIN_EMAIL} (${session.uid})`);
    } catch (err) {
      console.error(`Firebase sign-in failed: ${err.message}`);
    }
    console.log('Press Ctrl+C to stop.');
  });
  process.on('SIGINT', () => {
    console.log('\nStopping the MOWMMAS Admin backend…');
    server.close();
    process.exit(0);
  });
  return server;
}

if (require.main === module) start();

module.exports = { start, onRequest };
