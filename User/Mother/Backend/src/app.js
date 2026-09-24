'use strict';
/* ══════════════════════════════════════════════════════════════════
   The MOWMMAS API online (Vercel). vercel.json sends every /api/…
   request to api/index.js, which hands it to handle() here.

   Vercel keeps no files and runs no server between requests, so this
   reads what it needs straight from Firestore:
     GET  /api/health
     GET  /api/facilities              OpenStreetMap + the admin's facilities (Firestore)
     GET  /api/facilities/:id
     GET  /api/photos/:file            a facility photo in data/photos
   Forms, Track Submission and SMS answer 503 (not online yet) until they
   are moved here too.
   ══════════════════════════════════════════════════════════════════ */
const config = require('./config');
const facilities = require('./facilities');
const firestore = require('../../../Admin/Backend/src/firestore');
const adminConfig = require('../../../Admin/Backend/src/config');
const { httpError, setCors, sendJson, createRouter, serveStatic } = require('./http');

// The admin's facilities are public, like the map: read without signing in
const readFacilities = () => firestore.listPublic(adminConfig.FACILITIES_COLLECTION);

const router = createRouter();

router.add('GET /api/health', (req, res) => {
  sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

router.add('GET /api/facilities', async (req, res) => {
  sendJson(res, 200, await facilities.listLive(readFacilities));
});

router.add('GET /api/facilities/:id', async (req, res, params) => {
  const result = await facilities.getLive(params.id, readFacilities);
  if (!result.facility) throw httpError(404, 'Facility not found');
  sendJson(res, 200, result);
});

router.add('GET /api/photos/:file', (req, res, params) => {
  if (!/^[\w-][\w.-]*\.(jpe?g|png|webp|avif)$/i.test(params.file)) throw httpError(404, 'Photo not found');
  return serveStatic(req, res, config.PHOTOS_DIR, '/' + params.file);
});

const notYet = (message) => () => { throw httpError(503, message); };
router.add('POST /api/submissions', notYet("Sending forms on the MOWMMAS website isn't ready yet. Please call the facility for now."));
router.add('GET /api/submissions/:ref', notYet("Track Submission isn't ready yet on the MOWMMAS website."));
for (const spec of ['GET /api/admin/sms/gateway', 'GET /api/admin/sms/log', 'GET /api/admin/sms/templates', 'POST /api/admin/sms/templates', 'POST /api/admin/sms']) {
  router.add(spec, notYet("SMS isn't set up on the online MOWMMAS yet."));
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

async function route(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    return res.end();
  }
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    throw httpError(400, 'That address is not valid.');
  }
  const found = router.match(req.method, url.pathname);
  if (!found) throw httpError(404, 'Not found: there is no MOWMMAS API at this address.');
  if (found.allowed) {
    throw httpError(405, `This address does not accept ${req.method} requests.`, null,
      { Allow: [...new Set([...found.allowed, 'OPTIONS'])].join(', ') });
  }
  return found.handler(req, res, found.params, url);
}

function handle(req, res) {
  return Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => sendError(res, err));
}

module.exports = { handle };
