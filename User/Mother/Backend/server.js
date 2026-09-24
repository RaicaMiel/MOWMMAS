'use strict';
/* ══════════════════════════════════════════════════════════════════
   MOWMMAS — Mothers Online With Milk Management, Access, and Support
   Mother backend (Node built-ins only — no npm install needed)

   Start:   node server.js          (or double-click start.bat)
   Open:    http://localhost:3000/html/index.html

   It does two jobs:
   1. Serves the mother-side website  (User/Mother/Frontend)
   2. Answers the website's API calls:
        GET  /api/health
        GET  /api/facilities              health facilities in Antique (OpenStreetMap + MOWMMAS profiles)
        GET  /api/facilities/:id
        GET  /api/photos/:file            a facility photo stored in data/photos
        POST /api/submissions             donate / request / inquire form
        GET  /api/submissions/:ref?mobile=09…   track a submission
        POST /api/admin/sms               an admin texts a mother (PhilSMS)      admin sign-in required
        GET  /api/admin/sms/gateway       is SMS set up, and the credit left     admin sign-in required
        GET  /api/admin/sms/log           every SMS sent (data/sms-log.json)     admin sign-in required
        GET  /api/admin/sms/templates     the SMS page's templates               admin sign-in required
        POST /api/admin/sms/templates     save one template { key, text }        admin sign-in required
   3. Texts mothers on its own (src/notify.js): her reference number when she
      sends a form, and each update the admin makes (status, referral, message)

   All data is stored as JSON files in ./data. Every donation, request and
   inquiry is also copied to Firestore for the admin side, by the Admin
   backend's sync (User/Admin/Backend/src/sync.js). MOWMMAS is not a milk bank: it only shares
   information and passes requests on to the health facilities.
   ══════════════════════════════════════════════════════════════════ */
const http = require('http');
const os = require('os');
const path = require('path');
const config = require('./src/config');
const store = require('./src/store');
const osm = require('./src/osm');
const facilities = require('./src/facilities');
const submissions = require('./src/submissions');
const notify = require('./src/notify');
const {
  httpError, setCors, sendJson, readJson, createRouter, serveStatic
} = require('./src/http');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const NOT_FOUND_SUBMISSION = "We couldn't find a submission with that reference number and mobile number.";

/* ───────────── Firestore: copy each submission to the admin side ─────────────
   The code lives in the Admin backend. If it's missing or Firebase isn't set
   up, mothers can still send forms: they're kept here in data/submissions.json
   and copied to Firestore once it can be reached. */
let firestoreSync = null;
try {
  firestoreSync = require(path.join(config.PROJECT_ROOT, 'User', 'Admin', 'Backend', 'src', 'sync'));
  // A reference already sent to Firestore is never handed out again, even if data/submissions.json is cleared.
  submissions.reserveRefs(() => firestoreSync.knownRefs());
} catch (err) {
  console.warn('[firestore] Copying submissions to Firestore is off: ' + err.message);
}

/* ───────────── SMS: sent with the Admin backend's sms.js (PhilSMS) ─────────────
   Its settings (the PhilSMS token) are in User/Admin/Backend/.env. Without it,
   everything else works and the admin pages say SMS isn't set up. */
const SMS_LOG_MAX = 10000;
let sms = null;
try {
  sms = require(path.join(config.PROJECT_ROOT, 'User', 'Admin', 'Backend', 'src', 'sms'));
  const adminConfig = require(path.join(config.PROJECT_ROOT, 'User', 'Admin', 'Backend', 'src', 'config'));
  notify.use(sms, { perNumberHourly: adminConfig.SMS_AUTO_PER_NUMBER_HOURLY, daily: adminConfig.SMS_AUTO_DAILY_LIMIT, receivedPerNumberDaily: adminConfig.SMS_RECEIVED_PER_NUMBER_DAILY });
  // Every SMS is kept here, newest first (the most recent SMS_LOG_MAX)
  sms.useLog((record) => store.update('smsLog', [], (list) => {
    list.unshift(record);
    if (list.length > SMS_LOG_MAX) list.length = SMS_LOG_MAX;
  }));
  // Texts the server stopped before PhilSMS answered: in the log as "not confirmed"
  const unfinished = notify.recover((record) => store.update('smsLog', [], (list) => { list.unshift(record); }));
  if (unfinished) console.warn('[sms] ' + unfinished + ' automatic text(s) were cut off by a restart; they show in the Message log as not confirmed.');
} catch (err) {
  console.warn('[sms] Sending SMS is off: ' + err.message);
}

function later(promise, what) {
  Promise.resolve(promise).catch((err) => console.warn('[sms] ' + what + ' failed: ' + (err && err.message)));
}

/* ───────────── Forms per address ─────────────
   Each form can text a mother, so one address can send at most FORMS_PER_IP_HOURLY
   forms an hour (generous, since many phones can share one mobile-data address). */
const FORMS_PER_IP_HOURLY = 30;
const formsByIp = new Map(); // ip → [timestamps]

function recentForms(ip) {
  const since = Date.now() - 60 * 60 * 1000;
  const list = (formsByIp.get(ip) || []).filter((t) => t > since);
  if (list.length) formsByIp.set(ip, list);
  else formsByIp.delete(ip);
  return list;
}
setInterval(() => { for (const ip of formsByIp.keys()) recentForms(ip); }, 10 * 60 * 1000).unref();

/* ───────────── Guard against guessing: failed tracking lookups per IP ───────────── */
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_MAX_FAILURES = 30;
const failedLookups = new Map(); // ip → [timestamps]

function recentFailures(ip) {
  const since = Date.now() - LOOKUP_WINDOW_MS;
  const list = (failedLookups.get(ip) || []).filter((t) => t > since);
  if (list.length) failedLookups.set(ip, list);
  else failedLookups.delete(ip);
  return list;
}
function recordFailure(ip) {
  const list = recentFailures(ip);
  list.push(Date.now());
  failedLookups.set(ip, list);
}
setInterval(() => { for (const ip of failedLookups.keys()) recentFailures(ip); }, LOOKUP_WINDOW_MS).unref();

/* ───────────────────────── API routes ───────────────────────── */
const router = createRouter();

router.add('GET /api/health', (req, res) => {
  sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

router.add('GET /api/facilities', (req, res) => {
  sendJson(res, 200, facilities.list());
});

router.add('GET /api/facilities/:id', (req, res, params) => {
  const result = facilities.get(params.id);
  if (!result.facility) throw httpError(404, 'Facility not found');
  sendJson(res, 200, result);
});

router.add('GET /api/photos/:file', (req, res, params) => {
  if (!/^[\w-][\w.-]*\.(jpe?g|png|webp|avif)$/i.test(params.file)) throw httpError(404, 'Photo not found');
  return serveStatic(req, res, config.PHOTOS_DIR, '/' + params.file);
});

router.add('POST /api/submissions', async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (recentForms(ip).length >= FORMS_PER_IP_HOURLY) {
    throw httpError(429, 'Too many forms were sent from this connection in the last hour. Please try again later.', null, { 'Retry-After': '1800' });
  }
  const body = await readJson(req);
  const created = submissions.create(body);
  formsByIp.set(ip, recentForms(ip).concat(Date.now()));
  sendJson(res, 201, created);
  if (firestoreSync) firestoreSync.push(); // to Firestore for the admin, right away
  later(notify.received(created.ref), 'Texting the reference number');
});

router.add('GET /api/submissions/:ref', (req, res, params, url) => {
  const mobile = url.searchParams.get('mobile');
  if (!mobile || !submissions.normalizeMobile(mobile)) {
    throw httpError(400, 'Please enter the mobile number you used on the form, like 0917 123 4567.',
      { mobile: submissions.MOBILE_HINT });
  }
  const ip = req.socket.remoteAddress || 'unknown';
  if (recentFailures(ip).length >= LOOKUP_MAX_FAILURES) {
    throw httpError(429, 'Too many tries. Please wait a few minutes, then try again.', null, { 'Retry-After': '600' });
  }
  const view = submissions.lookup(params.ref, mobile);
  if (!view) {
    recordFailure(ip);
    throw httpError(404, NOT_FOUND_SUBMISSION);
  }
  sendJson(res, 200, view);
});

/* ───────────── SMS from the admin pages ─────────────
   The admin pages send the signed-in admin's Firebase ID token
   (Authorization: Bearer <token>); sms.verifyAdmin checks it is an admin's. */
const SMS_TYPES = new Set(['update', 'referral', 'reminder', 'status', 'received']);
const SMS_EVENTS = { update: 'Update', referral: 'Referral sent', reminder: 'Reminder', status: 'Status update', received: 'Form received' };
const REF_PATTERN = /^MOW-[DRI]-\d{4}-\d{5,}$/;

async function smsAdmin(req) {
  if (!sms) throw httpError(503, "Sending SMS is off on this server: the Admin backend's sms.js couldn't be loaded.");
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  try {
    return await sms.verifyAdmin(m ? m[1] : '');
  } catch (err) {
    throw httpError(err.status || 401, err.message);
  }
}

const shortText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

router.add('GET /api/admin/sms/gateway', async (req, res) => {
  await smsAdmin(req);
  const gateway = Object.assign({}, await sms.gateway());
  // PhilSMS refusing the sender name (e.g. a Sender ID still waiting for approval) shows only when
  // sending, so the last SMS that went to PhilSMS says whether it is allowed now.
  const log = store.read('smsLog', []);
  const last = Array.isArray(log) ? log.find((r) => r && (r.status === 'sent' || (r.status === 'failed' && /^PhilSMS: /.test(r.error || '')))) : null;
  gateway.senderProblem = last && last.status === 'failed' && /sender id/i.test(last.error) ? last.error : null;
  sendJson(res, 200, gateway);
});

router.add('GET /api/admin/sms/log', async (req, res) => {
  await smsAdmin(req);
  const list = store.read('smsLog', []);
  const records = Array.isArray(list) ? list : [];
  // Whether recent SMS were delivered (PhilSMS); the answers are kept in the log
  const checked = records.filter((r) => r && r.status === 'sent' && r.gatewayUid).slice(0, 50);
  const before = JSON.stringify(checked.map((r) => [r.delivery, r.deliveryCheckedAt]));
  await sms.checkDelivery(checked).catch(() => 0);
  if (JSON.stringify(checked.map((r) => [r.delivery, r.deliveryCheckedAt])) !== before) {
    const byId = new Map(checked.map((r) => [r.id, r]));
    store.update('smsLog', [], (all) => {
      all.forEach((r) => {
        const fresh = r && byId.get(r.id);
        if (fresh) { r.delivery = fresh.delivery || null; r.deliveryCheckedAt = fresh.deliveryCheckedAt || null; }
      });
    });
  }
  sendJson(res, 200, { records });
});

// The SMS page's four templates (the admin page has their starting wording)
const SMS_TEMPLATE_KEYS = new Set(['referral', 'availability', 'visit_reminder', 'followup_reminder']);

router.add('GET /api/admin/sms/templates', async (req, res) => {
  await smsAdmin(req);
  const saved = store.read('smsTemplates', {});
  sendJson(res, 200, { templates: saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {} });
});

router.add('POST /api/admin/sms/templates', async (req, res) => {
  const admin = await smsAdmin(req);
  const body = await readJson(req);
  const key = typeof body.key === 'string' ? body.key : '';
  const text = sms.clean(body.text);
  if (!SMS_TEMPLATE_KEYS.has(key)) throw httpError(422, 'That template does not exist.', { key: 'Unknown' });
  if (!text) throw httpError(422, 'Write the message first.', { text: 'Empty' });
  if (text.length > 160) throw httpError(422, 'Keep it to 160 characters, so it fits in one SMS.', { text: 'Too long' });
  const saved = { text, updatedAt: new Date().toISOString(), updatedBy: admin.email || null };
  store.update('smsTemplates', {}, (all) => { all[key] = saved; });
  sendJson(res, 200, saved);
});

router.add('POST /api/admin/sms', async (req, res) => {
  const admin = await smsAdmin(req);
  const body = await readJson(req);
  const to = sms.mobileKey(body.to);
  const message = sms.clean(body.message);
  if (!to) throw httpError(422, 'Choose a mother with a Philippine mobile number (09XX XXX XXXX).', { to: 'Not a mobile number' });
  if (!message) throw httpError(422, 'Write the message first.', { message: 'Empty' });
  if (message.length > sms.MAX_LENGTH) throw httpError(422, 'Keep the message to ' + sms.MAX_LENGTH + ' characters.', { message: 'Too long' });

  const type = SMS_TYPES.has(body.type) ? body.type : 'update';
  const ref = typeof body.ref === 'string' && REF_PATTERN.test(body.ref) ? body.ref : null;
  const sub = ref ? notify.submission(ref) : null;   // her submission here, for her name and facility
  const record = await sms.send({
    to,
    message,
    type,
    event: shortText(body.event, 80) || SMS_EVENTS[type],
    ref,
    name: (sub && sub.contact && sub.contact.name) || shortText(body.name, 80),
    facility: (sub && ((sub.referral && sub.referral.facilityName) || sub.facilityName)) || shortText(body.facility, 120),
    by: admin.email,
    resendOf: shortText(body.resendOf, 80)
  });
  // A copy for her Track Submission page, when it went to the number on that submission.
  // A resend of an automatic text isn't a health worker's message, so it stays out.
  const log = store.read('smsLog', []);
  const original = body.resendOf && Array.isArray(log) ? log.find((r) => r && r.id === body.resendOf) : null;
  if (sub && sms.mobileKey(sub.contact && sub.contact.mobile) === to && !(original && original.auto)) notify.copy(sub, record);
  sendJson(res, 200, record);
});

/* ───────────────────────── request handling ───────────────────────── */
const HOME_REDIRECTS = new Set(['/', '/index.html', '/html', '/html/']);
// Browsers ask for /favicon.ico on their own; answer with the same heart icon index.html uses.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#EC4A7B"/>' +
  '<path d="M24 35S11 27.4 11 19.6A6.6 6.6 0 0 1 24 17a6.6 6.6 0 0 1 13 2.6C37 27.4 24 35 24 35Z" fill="white"/></svg>';

function parseUrl(req) {
  try {
    return new URL(req.url.startsWith('/') ? 'http://localhost' + req.url : req.url);
  } catch (e) {
    return null;
  }
}

async function handle(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    return res.end();
  }

  const url = parseUrl(req);
  if (!url) throw httpError(400, 'That address is not valid.');
  const { pathname } = url;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const found = router.match(req.method, pathname);
    if (!found) throw httpError(404, 'Not found: there is no MOWMMAS API at this address.');
    if (found.allowed) {
      throw httpError(405, `This address does not accept ${req.method} requests.`, null,
        { Allow: [...new Set([...found.allowed, 'OPTIONS'])].join(', ') });
    }
    return found.handler(req, res, found.params, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, 'Only GET requests are allowed for website files.', null, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (HOME_REDIRECTS.has(pathname)) {
    res.writeHead(302, { Location: '/html/index.html', 'Content-Length': '0', 'Cache-Control': 'no-cache' });
    return res.end();
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(FAVICON_SVG), 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : FAVICON_SVG);
  }
  return serveStatic(req, res, config.FRONTEND_DIR, pathname);
}

function sendError(res, err) {
  if (res.headersSent) {
    console.error('[error] after response started:', err);
    res.destroy();
    return;
  }
  const status = Number(err && err.status) || 500;
  if (!err || !err.status) console.error('[error]', err);
  else if (status >= 500) console.warn(`[warn] ${status}: ${err.message}`);
  const body = { error: err && err.status ? err.message : 'Something went wrong on our side. Please try again in a moment.' };
  if (err && err.fields) body.fields = err.fields;
  sendJson(res, status, body, err && err.headers);
}

function onRequest(req, res) {
  const started = Date.now();
  // Log API calls (path only — the query can contain a mobile number, which is never logged)
  if (req.url.startsWith('/api')) {
    res.on('finish', () => {
      console.log(`[api] ${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
    });
  }
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => sendError(res, err));
}

/* ───────────────────────── start ───────────────────────── */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

function checkFacilityData() {
  try {
    const cache = osm.getCached();
    if (cache && Array.isArray(cache.facilities)) {
      const when = cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'unknown';
      console.log(`Facility data: ${cache.facilities.length} facilities in ${(cache.municipalities || []).length} municipalities ` +
        `(OpenStreetMap, updated ${when})${osm.isStale(cache) ? ', refreshing in the background…' : ''}`);
    } else {
      console.log('No facility data yet. Downloading it from OpenStreetMap in the background…');
    }
  } catch (err) {
    console.error('Could not read the facility data:', err.message);
  }
}

function start(port = config.PORT) {
  const server = http.createServer(onRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is already in use. MOWMMAS may already be running in another window.`);
      console.error('Close that window, or start on another port, for example:');
      console.error('  Command Prompt:  set MOWMMA_MOTHER_PORT=3001 && node server.js');
      console.error('  PowerShell:      $env:MOWMMA_MOTHER_PORT=3001; node server.js\n');
    } else {
      console.error('The MOWMMAS Mother backend could not start:', err.message);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`MOWMMAS Mother backend: http://localhost:${port}/html/index.html`);
    console.log(`API:                    http://localhost:${port}/api/health`);
    for (const ip of lanAddresses()) {
      console.log(`On a phone (same Wi-Fi): http://${ip}:${port}/html/index.html`);
    }
    console.log(`Data folder:            ${config.DB_DIR}`);
    checkFacilityData();
    if (firestoreSync) {
      console.log('Firestore:              every submission is copied for the admin (User/Admin/Backend)');
      if (sms) {
        sms.gateway().then((g) => console.log('SMS (PhilSMS):          ' + (!g.configured
          ? 'not set up (add PHILSMS_API_TOKEN to User/Admin/Backend/.env)'
          : g.connected ? 'connected, ' + (g.balance || 'credit unknown') + ' left' : 'set up, but ' + g.error)));
      }
      firestoreSync.start(() => store.read('submissions', []), {
        // The admin's status changes (e.g. a referral) come back here, so Track Submission shows them.
        // Each new update is also texted to her (src/notify.js).
        applyRemote: (ref, patch) => {
          let before = null;
          const sub = store.update('submissions', [], (list) => {
            const found = Array.isArray(list) ? list.find((s) => s && s.ref === ref) : null;
            if (found) {
              before = Array.isArray(found.statusHistory) ? found.statusHistory.slice() : [];
              Object.assign(found, patch);
            }
            return found;
          });
          if (sub) later(notify.updated(sub, before), 'Texting an update for ' + ref);
          return sub;
        },
        // The facilities the admin manages come here too, and the mother site shows them.
        applyFacilities: ({ full, docs }) => store.update('firestoreFacilities', { facilities: {} }, (data) => {
          if (full || !data.facilities || typeof data.facilities !== 'object') data.facilities = {};
          for (const doc of docs) if (doc && doc.id) data.facilities[doc.id] = doc;
          data.updatedAt = new Date().toISOString();
          if (full) data.fullAt = data.updatedAt;
        }),
        facilityMirrorAge: () => {
          const mirror = store.read('firestoreFacilities', null);
          return mirror && mirror.fullAt ? Date.now() - Date.parse(mirror.fullAt) : Infinity;
        }
      });
    }
    // Re-check every 6 hours; getCached() refreshes from OpenStreetMap when the data is over a day old.
    setInterval(() => {
      try { osm.getCached(); } catch (err) { console.error('[osm] check failed:', err.message); }
    }, SIX_HOURS).unref();
    console.log('Press Ctrl+C to stop.');
  });

  process.on('SIGINT', () => {
    console.log('\nStopping the MOWMMAS Mother backend…');
    server.close();
    process.exit(0);
  });

  return server;
}

if (require.main === module) start();

module.exports = { start, handle };
