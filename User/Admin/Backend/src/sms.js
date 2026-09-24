'use strict';
/* SMS through PhilSMS (API v3, https://dashboard.philsms.com/api/v3). It runs
   inside the MOWMMAS server (User/Mother/Backend/src/app.js), on a computer
   and online.

   send({ to, message, type, event, ref, name, facility, by, auto, resendOf, id })
       texts one Philippine mobile number through PhilSMS and records it with
       the log writer (useLog): the server keeps the SMS log in Firestore
       (smsLog), which the admin's Message log, Dashboard and Records read
       through its admin API. Resolves with that record: status "sent", "failed" (error
       says why), "unknown" (PhilSMS didn't answer, so it may or may not have
       gone out) or "skipped" (an automatic text over its limit). It doesn't
       throw for a gateway problem; the record says what happened.
   useLog(write)         write(record) saves one record (it may return a promise)
   gateway()             { configured, sender, keyHint, connected, balance, expiresOn, error,
                           problem: "unreachable" | "refused" | null }
                         (reads PhilSMS's balance; nothing is sent)
   checkDelivery(records) asks PhilSMS whether recent sent SMS were delivered
                         (GET /sms/<uid>, e.g. "Delivered") and sets record.delivery;
                         resolves with how many changed
   verifyAdmin(idToken)  { uid, email } when the Firebase ID token belongs to an
                         admin (admins/<uid> can be read with it), else throws
                         an error with .status 401 or 403. Firebase only checks
                         who is signing in; the SMS themselves go through PhilSMS.
   toRecipient(mobile)   "0917 123 4567" → "639171234567" (PhilSMS's format), or null
   mobileKey(mobile)     "+63 917 123 4567" → "09171234567", or null

   PhilSMS answers errors with HTTP 200 and { status: "error", message }, so
   the answer's status field decides, not the HTTP status. The token is only
   ever sent to PhilSMS, never to a browser. */
const config = require('./config');
const firestore = require('./firestore');

const SEND_TIMEOUT_MS = 20 * 1000;
const GATEWAY_CACHE_MS = 60 * 1000;
// The longest text sent (3 SMS). The admin's forms keep manual texts to 160 characters.
const MAX_LENGTH = 459;

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/* ───────────── numbers and text ───────────── */

function mobileKey(value) {
  let digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('63')) digits = '0' + digits.slice(2);
  if (digits.length === 10 && digits.startsWith('9')) digits = '0' + digits;
  return /^09\d{9}$/.test(digits) ? digits : null;
}

function toRecipient(value) {
  const key = mobileKey(value);
  return key ? '63' + key.slice(1) : null;
}

// Plain text an SMS carries well: curly quotes, long dashes and the like become their plain
// forms, and letters outside the SMS alphabet (á, í, ó, ú, ₱ ...) their nearest plain ones,
// so a text stays at 160 characters an SMS
const PLAIN_LETTERS = { 'á': 'a', 'â': 'a', 'ã': 'a', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'À': 'A', 'ê': 'e', 'ë': 'e', 'Ê': 'E', 'È': 'E', 'Ë': 'E',
  'í': 'i', 'î': 'i', 'ï': 'i', 'Í': 'I', 'Î': 'I', 'Ì': 'I', 'Ï': 'I', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ò': 'O',
  'ú': 'u', 'û': 'u', 'Ú': 'U', 'Û': 'U', 'Ù': 'U', 'ç': 'c', 'ý': 'y', '₱': 'P' };
function clean(text) {
  return String(text == null ? '' : text)
    .replace(/[áâãÁÂÃÀêëÊÈËíîïÍÎÌÏóôõÓÔÕÒúûÚÛÙçý₱]/g, (c) => PLAIN_LETTERS[c])
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

// How many SMS a text takes: 160 characters for one (153 each when split);
// with characters outside the GSM alphabet, 70 (67 each when split)
const GSM = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
const GSM_EXTENDED = /[\^{}\\[~\]|€]/g;
// Only characters from the SMS alphabet (160 an SMS); anything else makes it a unicode text (70)
function isGsm(text) {
  return GSM.test(String(text || ''));
}

function segments(text) {
  if (!text) return 0;
  if (GSM.test(text)) {
    const length = text.length + (text.match(GSM_EXTENDED) || []).length;
    return length <= 160 ? 1 : Math.ceil(length / 153);
  }
  const length = Array.from(text).length;
  return length <= 70 ? 1 : Math.ceil(length / 67);
}

/* ───────────── PhilSMS ───────────── */

function headers() {
  return { Authorization: 'Bearer ' + config.SMS_API_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' };
}

async function gatewayCall(method, path, body, timeoutMs) {
  let response;
  try {
    response = await fetch(config.SMS_API_URL + path, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs || config.REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, timedOut, problem: 'unreachable', error: timedOut ? "PhilSMS didn't answer in time." : "Can't reach PhilSMS. Check the internet connection." };
  }
  const data = await response.json().catch(() => null);
  if (data && data.status === 'success') return { ok: true, data: data.data };
  const said = data && typeof data.message === 'string' && data.message.trim() ? data.message.trim() : 'PhilSMS answered with error ' + response.status + '.';
  // A sender name PhilSMS doesn't allow: say where it's set
  const hint = /sender/i.test(said)
    ? ' PhilSMS only sends with an approved Sender ID. Check Sending > Sender ID in the PhilSMS dashboard: while it says Pending, no SMS can go out. Once it is approved, press Resend in the Message log.'
    : '';
  return { ok: false, problem: 'refused', error: 'PhilSMS: ' + said + hint };
}

// The id PhilSMS gives a sent SMS, wherever its answer puts it
function gatewayId(data) {
  const one = Array.isArray(data) ? data[0] : data;
  if (!one || typeof one !== 'object') return null;
  const id = one.uid || one.id || one.message_id || null;
  return id == null ? null : String(id);
}

let gatewayCache = null;

async function gateway() {
  const token = config.SMS_API_TOKEN;
  const base = {
    configured: Boolean(token),
    sender: config.SMS_SENDER_ID || null,
    keyHint: token ? token.slice(-4) : null,
    connected: false,
    balance: null,
    expiresOn: null,
    error: null,
    problem: null
  };
  if (!token) return base;
  if (gatewayCache && Date.now() - gatewayCache.at < GATEWAY_CACHE_MS) return gatewayCache.value;
  const answer = await gatewayCall('GET', '/balance');
  const value = Object.assign(base, answer.ok
    ? { connected: true, balance: (answer.data && answer.data.remaining_balance) || null, expiresOn: (answer.data && answer.data.expired_on) || null }
    : { error: answer.error, problem: answer.problem || 'unreachable' });
  gatewayCache = { at: Date.now(), value };
  return value;
}

/* ───────────── sending, and its record ───────────── */

let logWriter = null;

function useLog(write) {
  logWriter = typeof write === 'function' ? write : null;
}

function newId(at) {
  return 'sms-' + at.toISOString().replace(/[-:.TZ]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
}

async function send(options) {
  const o = options || {};
  const at = new Date();
  const message = clean(o.message).slice(0, MAX_LENGTH);
  const key = mobileKey(o.to);
  const record = {
    to: key || String(o.to || '').trim() || null,
    name: o.name || null,
    ref: o.ref || null,
    facility: o.facility || null,
    type: o.type || 'update',
    event: o.event || null,
    message,
    segments: segments(message),
    status: 'failed',
    error: null,
    gatewayUid: null,
    auto: Boolean(o.auto),
    sentAt: at,
    sentBy: o.by || null,
    resendOf: o.resendOf || null
  };

  if (!config.SMS_API_TOKEN) {
    record.error = "SMS isn't set up: PHILSMS_API_TOKEN is missing from User/Admin/Backend/.env.";
  } else if (!key) {
    record.error = "That isn't a Philippine mobile number (09XX XXX XXXX), so nothing was sent.";
  } else if (!message) {
    record.error = 'The message is empty, so nothing was sent.';
  } else if (o.skip) {
    record.status = 'skipped';
    record.error = o.skip;
  } else {
    // Always a text message: "plain", or "unicode" for characters outside the SMS alphabet.
    // (Without a type, PhilSMS recorded the message as "voice".)
    const body = { recipient: toRecipient(key), message, type: GSM.test(message) ? 'plain' : 'unicode' };
    if (config.SMS_SENDER_ID) body.sender_id = config.SMS_SENDER_ID;
    const answer = await gatewayCall('POST', '/sms/send', body, SEND_TIMEOUT_MS);
    if (answer.ok) {
      record.status = 'sent';
      record.gatewayUid = gatewayId(answer.data);
    } else {
      if (answer.timedOut) {
        // It may have gone out: never counted as failed, never resent without checking
        record.status = 'unknown';
        record.error = "PhilSMS didn't answer in time, so it may or may not have been sent. Check Reports in the PhilSMS dashboard before sending it again.";
      } else {
        record.error = answer.error;
      }
    }
  }

  // o.id: an id chosen by the caller (an automatic text's is fixed by its note, so it is logged once)
  record.id = typeof o.id === 'string' && /^sms-[\w-]{1,80}$/.test(o.id) ? o.id : newId(at);
  record.sentAt = at.toISOString();
  try {
    if (!logWriter) throw new Error('no SMS log is set up on this server');
    await logWriter(Object.assign({}, record));
    record.logged = true;
  } catch (err) {
    record.logged = false;
    record.logError = err.message;
    console.warn('[sms] Sent status "' + record.status + '", but it could not be added to the SMS log: ' + err.message);
  }
  if (record.status === 'failed' || record.status === 'unknown') console.warn('[sms] Not sent to ' + (record.to || 'an empty number') + ': ' + record.error);
  return record;
}

/* ───────────── was it delivered? ─────────────
   PhilSMS keeps each SMS's delivery status (GET /sms/<uid>: "Delivered", or
   e.g. "Undelivered"). Sent SMS from the last DELIVERY_DAYS are asked about
   until PhilSMS gives a final answer, at most once a minute each. */
const DELIVERY_DAYS = 3;
const DELIVERY_EVERY_MS = 60 * 1000;
const DELIVERY_BATCH = 10;
const FINAL_DELIVERY = /deliver|fail|reject|expire|block|invalid/i;   // "Delivered", "Undelivered", "Failed", ...

async function checkDelivery(records) {
  if (!config.SMS_API_TOKEN || !Array.isArray(records)) return 0;
  const now = Date.now();
  const due = records.filter((r) => r && r.status === 'sent' && r.gatewayUid &&
    !(r.delivery && FINAL_DELIVERY.test(r.delivery)) &&
    now - (Date.parse(r.sentAt) || 0) < DELIVERY_DAYS * 24 * 60 * 60 * 1000 &&
    !(now - (Date.parse(r.deliveryCheckedAt) || 0) < DELIVERY_EVERY_MS)).slice(0, DELIVERY_BATCH);
  const answers = await Promise.all(due.map((r) => gatewayCall('GET', '/sms/' + encodeURIComponent(r.gatewayUid), null, 8000)));
  let changed = 0;
  due.forEach((r, i) => {
    r.deliveryCheckedAt = new Date(now).toISOString();
    const status = answers[i].ok && answers[i].data && typeof answers[i].data.status === 'string' ? answers[i].data.status.trim() : '';
    if (status && status !== r.delivery) { r.delivery = status; changed++; }
  });
  return changed;
}

/* ───────────── who may use the admin SMS API ─────────────
   A browser sends the admin's Firebase ID token. It is checked by reading
   admins/<uid> with that token: Firestore only allows it when the token is
   genuine and unexpired and belongs to that admin (firestore.rules). */
const verified = new Map(); // token → { uid, email, until }
const VERIFY_CACHE_MS = 5 * 60 * 1000;

function claimsOf(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

async function verifyAdmin(idToken) {
  if (!idToken) throw failure(401, 'Sign in to the admin pages first.');
  const now = Date.now();
  for (const [token, entry] of verified) if (entry.until <= now) verified.delete(token);
  const hit = verified.get(idToken);
  if (hit) return { uid: hit.uid, email: hit.email };

  const claims = claimsOf(idToken);
  const uid = claims && (claims.user_id || claims.sub);
  if (!uid || claims.aud !== config.PROJECT_ID || !(claims.exp * 1000 > now)) {
    throw failure(401, 'Your admin sign-in has expired. Sign in again.');
  }
  let response;
  try {
    response = await fetch(firestore.baseUrl() + '/admins/' + encodeURIComponent(uid), {
      headers: { Authorization: 'Bearer ' + idToken },
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw failure(503, "Can't reach Firebase to check your admin sign-in. Try again in a moment.");
  }
  if (response.status === 401) throw failure(401, 'Your admin sign-in has expired. Sign in again.');
  if (response.status === 403 || response.status === 404) throw failure(403, 'Only MOWMMAS admins can send SMS.');
  if (!response.ok) throw failure(503, 'Firebase could not check your admin sign-in (error ' + response.status + '). Try again in a moment.');

  const entry = { uid, email: claims.email || null, until: Math.min(claims.exp * 1000, now + VERIFY_CACHE_MS) };
  verified.set(idToken, entry);
  return { uid, email: entry.email };
}

module.exports = { send, useLog, checkDelivery, gateway, verifyAdmin, toRecipient, mobileKey, clean, segments, isGsm, MAX_LENGTH };
