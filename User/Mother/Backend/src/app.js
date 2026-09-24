'use strict';
/* ══════════════════════════════════════════════════════════════════
   The MOWMMAS API. The same code answers on a computer (server.js) and
   online (Vercel: vercel.json sends every /api/… request to api/index.js).
   Its records are in Firestore (src/cloud.js), so both see the same data.

     GET  /api/health
     GET  /api/facilities              OpenStreetMap + the admin's facilities (Firestore)
     GET  /api/facilities/:id
     GET  /api/photos/:file            a facility photo in data/photos
     POST /api/submissions             donate / request / inquire form
     POST /api/submissions/track       track a submission { ref, mobile }
     GET  /api/submissions/:ref?mobile=09…   the same (older pages)
     POST /api/admin/sms               an admin texts a mother (PhilSMS)       admin sign-in required
     GET  /api/admin/sms/gateway       is SMS set up, and the credit left      admin sign-in required
     GET  /api/admin/sms/log           every SMS sent (newest LOG_LIMIT)       admin sign-in required
     GET  /api/admin/sms/templates     the SMS page's templates                admin sign-in required
     POST /api/admin/sms/templates     save one template { key, text }         admin sign-in required
     POST /api/admin/notify            text the mother the admin's updates:    admin sign-in required
                                       { ref } one submission (the admin pages
                                       ask right after saving), {} every update
                                       of the last day not texted yet

   It texts mothers on its own (src/notify.js): her reference number when she
   sends a form, and each update the admin makes (status, referral, message).
   MOWMMAS is not a milk bank: it only shares information and passes requests
   on to the health facilities.
   ══════════════════════════════════════════════════════════════════ */
const config = require('./config');
const cloud = require('./cloud');
const facilities = require('./facilities');
const submissions = require('./submissions');
const notify = require('./notify');
const {
  BODY_LIMIT_BYTES, httpError, setCors, sendJson, readJson, createRouter, serveStatic
} = require('./http');

const NOT_FOUND_SUBMISSION = "We couldn't find a submission with that reference number and mobile number.";

/* ───────────── SMS: sent with the Admin backend's sms.js (PhilSMS) ─────────────
   Its settings (the PhilSMS token) are in User/Admin/Backend/.env, or Vercel's
   Environment Variables. Without them, everything else works and the admin pages
   say SMS isn't set up. */
const LOG_LIMIT = 1000;   // the Message log shows the newest this many (and says so when there are more)
let sms = null;
try {
  sms = require('../../../Admin/Backend/src/sms');
  const adminConfig = require('../../../Admin/Backend/src/config');
  // Without the PhilSMS key this server texts nobody automatically, and so claims no text:
  // the other server (online, or on the computer) sends them
  notify.use(adminConfig.SMS_API_TOKEN ? sms : null, { perNumberHourly: adminConfig.SMS_AUTO_PER_NUMBER_HOURLY, daily: adminConfig.SMS_AUTO_DAILY_LIMIT, receivedPerNumberDaily: adminConfig.SMS_RECEIVED_PER_NUMBER_DAILY }, sms);
  sms.useLog((record) => cloud.addSms(record));
} catch (err) {
  console.warn('[sms] Sending SMS is off: ' + err.message);
}

/* Work that goes on after the answer (texting her reference number). Online, Vercel is
   asked to keep the function running until it is done; without that, the answer
   waits for it (at most `maxMs`). On a computer the server keeps running anyway. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function afterAnswer(job, maxMs) {
  if (!config.ONLINE) return;
  const holder = globalThis[Symbol.for('@vercel/request-context')];
  const context = holder && typeof holder.get === 'function' ? holder.get() : null;
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(job);
    return;
  }
  await Promise.race([job, pause(maxMs)]);
}

const later = (promise, what) => Promise.resolve(promise).catch((err) => console.warn('[sms] ' + what + ' failed: ' + (err && err.message)));

/* ───────────── who is asking ─────────────
   Online, Vercel puts the visitor's address in x-real-ip / x-forwarded-for (and
   replaces what a visitor sends there). On a computer, the connection's address. */
function clientIp(req) {
  if (config.ONLINE) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// Counted per address without keeping the address itself
const ipKey = (req) => cloud.hash('ip|' + clientIp(req)).slice(0, 24);

/* The request body as JSON. Online, Vercel may have read it already (req.body). */
async function readBody(req) {
  if (!('body' in req)) return readJson(req);
  let body;
  try {
    body = req.body;
  } catch (err) {
    throw httpError(400, 'The request body is not valid JSON.');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) throw httpError(413, 'That is more information than we can accept at once (limit 100 KB). Please shorten your notes and try again.');
    if (!body.trim()) throw httpError(400, 'The request body is empty. Please send the form as JSON.');
    try {
      return JSON.parse(body);
    } catch (err) {
      throw httpError(400, 'The request body is not valid JSON.');
    }
  }
  if (body === undefined || body === null) throw httpError(400, 'The request body is empty. Please send the form as JSON.');
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT_BYTES) {
    throw httpError(413, 'That is more information than we can accept at once (limit 100 KB). Please shorten your notes and try again.');
  }
  return body;
}

/* Firestore trouble, told to a mother in words she can act on (the details go to the log) */
function forMother(message) {
  return (err) => {
    if (err && (err.name === 'FirebaseError' || !err.status)) {
      console.error('[firestore] ' + (err && err.message));
      throw httpError(503, message);
    }
    throw err;
  };
}

/* ───────────── limits per address ─────────────
   Each form can text a mother, so one address can send at most FORMS_PER_IP_HOURLY
   forms an hour (generous, since many phones can share one mobile-data address).
   Failed tracking lookups are limited too, against guessing. Counted in Firestore
   (limits/<id>), so every server counts the same.
   - A request that is wrong in itself (not JSON, a form with mistakes, no mobile number)
     is answered before anything is counted, so it costs no write.
   - Each try is then counted before the work, in one step, so tries at the same moment
     can't all slip under the limit. A try over the limit gives its place back (it didn't
     happen), and so does one that doesn't count: a form not saved because of our own
     trouble, a lookup that found hers, a lookup Firestore couldn't answer.
   - An address over its limit is then refused here for 30 seconds without asking Firestore
     (tries still under way may give their place back, so it asks again after that). */
const FORMS_PER_IP_HOURLY = 30;
const HOUR_MS = 60 * 60 * 1000;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_MAX_FAILURES = 30;
const refusedUntil = new Map();   // limit id → until when it is refused here

function refusedNow(id) {
  const until = refusedUntil.get(id);
  if (until && until > Date.now()) return true;
  if (until) refusedUntil.delete(id);
  return false;
}

/* Counts one try. Resolves with 'counted', 'over' (refused) or 'uncounted' (Firestore
   couldn't count it: it goes ahead, and the work itself says if Firestore is down) */
async function takeTry(id, max, windowEnd) {
  if (refusedNow(id)) return 'over';
  let count;
  try {
    [count] = await cloud.add([id], 1);
  } catch (err) {
    console.warn('[limits] Could not count ' + id.split('-')[0] + ': ' + err.message);
    return 'uncounted';
  }
  if (!(count > max)) return 'counted';
  let after = count - 1;
  try {
    [after] = await cloud.add([id], -1);
  } catch (err) {
    console.warn('[limits] Could not give back a refused try: ' + err.message);
  }
  if (refusedUntil.size > 5000) refusedUntil.clear();
  // Kept here for 30 s only: tries still under way (here or on another server) may give their place back
  refusedUntil.set(id, Math.min(windowEnd, Date.now() + 30 * 1000));
  return 'over';
}

function giveBack(id, taken) {
  if (taken !== 'counted') return Promise.resolve();
  refusedUntil.delete(id);   // a place came free
  return cloud.add([id], -1).catch((err) => console.warn('[limits] Could not give back a try: ' + err.message));
}

// Our own trouble (Firestore, a bug), not something wrong in the request
const ourTrouble = (err) => !err || !err.status || err.status >= 500;

/* ───────────────────────── API routes ───────────────────────── */
const router = createRouter();

router.add('GET /api/health', (req, res) => {
  sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

router.add('GET /api/facilities', async (req, res) => {
  sendJson(res, 200, await facilities.list());
});

router.add('GET /api/facilities/:id', async (req, res, params) => {
  const result = await facilities.get(params.id);
  if (!result.facility) throw httpError(404, 'Facility not found');
  sendJson(res, 200, result);
});

router.add('GET /api/photos/:file', (req, res, params) => {
  if (!/^[\w-][\w.-]*\.(jpe?g|png|webp|avif)$/i.test(params.file)) throw httpError(404, 'Photo not found');
  return serveStatic(req, res, config.PHOTOS_DIR, '/' + params.file);
});

router.add('POST /api/submissions', async (req, res) => {
  // Checked first: a request with mistakes is answered without counting (or writing) anything
  const body = await readBody(req);
  const form = await submissions.prepare(body);
  const hour = Math.floor(Date.now() / HOUR_MS);
  const limitId = 'form-' + ipKey(req) + '-' + hour;
  const taken = await takeTry(limitId, FORMS_PER_IP_HOURLY, (hour + 1) * HOUR_MS);
  if (taken === 'over') {
    throw httpError(429, 'Too many forms were sent from this connection in the last hour. Please try again later.', null, { 'Retry-After': '1800' });
  }
  let created;
  try {
    created = await submissions.save(form)
      .catch(forMother("We couldn't save your form right now. Please try again in a few minutes."));
  } catch (err) {
    if (ourTrouble(err)) await giveBack(limitId, taken);   // not saved because of us: it doesn't count
    throw err;
  }
  // Her reference number by SMS, after the answer. A form sent again (its first answer was lost)
  // may not have been texted then; the claim makes sure it is texted once, never twice.
  await afterAnswer(later(notify.received(created.submission), 'Texting the reference number'), 8000);
  sendJson(res, 201, created.summary);
});

/* Track Submission: her reference number AND mobile number. Sent in the body (POST), so
   neither shows in the address, where hosts keep request logs. GET ?mobile= still works. */
async function track(req, res, ref, mobile) {
  if (!mobile || !submissions.normalizeMobile(mobile)) {
    throw httpError(400, 'Please enter the mobile number you used on the form, like 0917 123 4567.',
      { mobile: submissions.MOBILE_HINT });
  }
  const slot = Math.floor(Date.now() / LOOKUP_WINDOW_MS);
  const limitId = 'lookup-' + ipKey(req) + '-' + slot;
  const taken = await takeTry(limitId, LOOKUP_MAX_FAILURES, (slot + 1) * LOOKUP_WINDOW_MS);
  if (taken === 'over') {
    throw httpError(429, 'Too many tries. Please wait a few minutes, then try again.', null, { 'Retry-After': '600' });
  }
  let view;
  try {
    view = await submissions.lookup(ref, mobile)
      .catch(forMother("We can't check your submission right now. Please try again in a few minutes."));
  } catch (err) {
    if (ourTrouble(err)) await giveBack(limitId, taken);   // couldn't look: not a failed try
    throw err;
  }
  if (!view) throw httpError(404, NOT_FOUND_SUBMISSION);   // a failed try: it stays counted
  await giveBack(limitId, taken);     // found hers: only failed tries count
  sendJson(res, 200, view);
}

router.add('POST /api/submissions/track', async (req, res) => {
  const body = await readBody(req);
  const value = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return track(req, res, value(body && body.ref), value(body && body.mobile));
});

router.add('GET /api/submissions/:ref', (req, res, params, url) => track(req, res, params.ref, url.searchParams.get('mobile')));

/* ───────────── the admin pages ─────────────
   They send the signed-in admin's Firebase ID token (Authorization: Bearer <token>);
   sms.verifyAdmin checks it is an admin's. */
const SMS_TYPES = new Set(['update', 'referral', 'reminder', 'status', 'received']);
const SMS_EVENTS = { update: 'Update', referral: 'Referral sent', reminder: 'Reminder', status: 'Status update', received: 'Form received' };
const REF_PATTERN = /^MOW-[DRI]-\d{4}-\d{5,9}$/;

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
  const recent = await cloud.listSms(50).catch(() => []);
  const last = recent.find((r) => r && (r.status === 'sent' || (r.status === 'failed' && /^PhilSMS: /.test(r.error || ''))));
  gateway.senderProblem = last && last.status === 'failed' && /sender id/i.test(last.error) ? last.error : null;
  sendJson(res, 200, gateway);
});

router.add('GET /api/admin/sms/log', async (req, res) => {
  await smsAdmin(req);
  // Automatic texts cut off by a stopped server show as "not confirmed"
  await notify.recover().catch((err) => console.warn('[sms] Could not check for cut-off texts: ' + err.message));
  const records = await cloud.listSms(LOG_LIMIT + 1);
  const more = records.length > LOG_LIMIT;   // older ones aren't shown: the page says so
  if (more) records.length = LOG_LIMIT;
  // Whether recent SMS were delivered (PhilSMS); the answers are kept in the log
  const checked = records.filter((r) => r && r.status === 'sent' && r.gatewayUid).slice(0, 50);
  const before = new Map(checked.map((r) => [r.id, JSON.stringify([r.delivery, r.deliveryCheckedAt])]));
  await sms.checkDelivery(checked).catch(() => 0);
  await Promise.all(checked
    .filter((r) => before.get(r.id) !== JSON.stringify([r.delivery, r.deliveryCheckedAt]))
    .map((r) => cloud.saveDelivery(r).catch((err) => console.warn('[sms] Could not save the delivery status of ' + r.id + ': ' + err.message))));
  sendJson(res, 200, { records, more, limit: LOG_LIMIT });
});

// The SMS page's four templates (the admin page has their starting wording)
const SMS_TEMPLATE_KEYS = new Set(['referral', 'availability', 'visit_reminder', 'followup_reminder']);

router.add('GET /api/admin/sms/templates', async (req, res) => {
  await smsAdmin(req);
  const saved = await cloud.templates();
  const templates = {};
  for (const [key, value] of Object.entries(saved)) if (SMS_TEMPLATE_KEYS.has(key) && value && typeof value.text === 'string') templates[key] = value;
  sendJson(res, 200, { templates });
});

router.add('POST /api/admin/sms/templates', async (req, res) => {
  const admin = await smsAdmin(req);
  const body = await readBody(req);
  const key = typeof body.key === 'string' ? body.key : '';
  const text = sms.clean(body.text);
  if (!SMS_TEMPLATE_KEYS.has(key)) throw httpError(422, 'That template does not exist.', { key: 'Unknown' });
  if (!text) throw httpError(422, 'Write the message first.', { text: 'Empty' });
  if (text.length > 160) throw httpError(422, 'Keep it to 160 characters, so it fits in one SMS.', { text: 'Too long' });
  const saved = { text, updatedAt: new Date().toISOString(), updatedBy: admin.email || null };
  await cloud.saveTemplate(key, saved);
  sendJson(res, 200, saved);
});

router.add('POST /api/admin/sms', async (req, res) => {
  const admin = await smsAdmin(req);
  const body = await readBody(req);
  const to = sms.mobileKey(body.to);
  const message = sms.clean(body.message);
  if (!to) throw httpError(422, 'Choose a mother with a Philippine mobile number (09XX XXX XXXX).', { to: 'Not a mobile number' });
  if (!message) throw httpError(422, 'Write the message first.', { message: 'Empty' });
  if (message.length > sms.MAX_LENGTH) throw httpError(422, 'Keep the message to ' + sms.MAX_LENGTH + ' characters.', { message: 'Too long' });

  const type = SMS_TYPES.has(body.type) ? body.type : 'update';
  const ref = typeof body.ref === 'string' && REF_PATTERN.test(body.ref) ? body.ref : null;
  const sub = ref ? await notify.submission(ref) : null;   // her submission, for her name and facility
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
  const original = body.resendOf ? await cloud.getSms(body.resendOf).catch(() => null) : null;
  if (sub && sms.mobileKey(sub.contact && sub.contact.mobile) === to && !(original && original.auto)) await notify.copy(sub, record);
  sendJson(res, 200, record);
});

router.add('POST /api/admin/notify', async (req, res) => {
  await smsAdmin(req);
  const body = await readBody(req).catch(() => ({}));
  // Online a request may run 60 s (vercel.json), and one text takes at most 20 s: no new text
  // starts after 20 s, and the rest waits for the next sweep
  const deadline = Date.now() + 20 * 1000;
  const ref = body && typeof body.ref === 'string' && REF_PATTERN.test(body.ref) ? body.ref : null;
  let result;
  if (ref) {
    const sub = await notify.submission(ref);
    if (!sub) throw httpError(404, 'That submission is no longer in Firestore.');
    const done = await notify.updated(sub, deadline);
    result = { checked: 1, records: done.records, done: done.done };
  } else {
    result = Object.assign({ done: true }, await notify.sweep(deadline));
  }
  sendJson(res, 200, {
    checked: result.checked,
    done: result.done,
    texts: result.records.map((r) => ({ id: r.id, ref: r.ref, status: r.status, event: r.event }))
  });
});

/* ───────────────────────── answering ───────────────────────── */

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

async function route(req, res, url) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    return res.end();
  }
  const found = router.match(req.method, url.pathname);
  if (!found) throw httpError(404, 'Not found: there is no MOWMMAS API at this address.');
  if (found.allowed) {
    throw httpError(405, `This address does not accept ${req.method} requests.`, null,
      { Allow: [...new Set([...found.allowed, 'OPTIONS'])].join(', ') });
  }
  return found.handler(req, res, found.params, url);
}

/* Answers one /api/… request (errors included) */
function handle(req, res) {
  return Promise.resolve()
    .then(() => {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch (e) {
        throw httpError(400, 'That address is not valid.');
      }
      return route(req, res, url);
    })
    .catch((err) => sendError(res, err));
}

module.exports = { handle, sms: () => sms };
