'use strict';
/* ══════════════════════════════════════════════════════════════════
   MOWMMAS — Mothers Online With Milk Management, Access, and Support
   The MOWMMAS server on a computer (Node built-ins only — no npm install needed)

   Start:   node server.js          (or double-click start.bat)
   Open:    http://localhost:3000/html/index.html

   It does two jobs:
   1. Serves the mother-side website  (User/Mother/Frontend)
   2. Answers the website's and the admin pages' API calls (/api/…) with the
      same code as the MOWMMAS website online (src/app.js, see the list there).
      The forms, the SMS log and the rest are kept in Firestore, so this server
      and the one online (Vercel) share them.

   Every minute it also texts mothers any admin update not texted yet
   (src/notify.js), in case the admin page couldn't ask for it.
   MOWMMAS is not a milk bank: it only shares information and passes requests
   on to the health facilities.
   ══════════════════════════════════════════════════════════════════ */
const http = require('http');
const os = require('os');
const config = require('./src/config');
const osm = require('./src/osm');
const notify = require('./src/notify');
const app = require('./src/app');
const { httpError, setCors, sendJson, serveStatic } = require('./src/http');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

/* ───────────────────────── request handling ───────────────────────── */
const HOME_REDIRECTS = new Set(['/', '/index.html', '/html', '/html/']);
// Browsers ask for /favicon.ico on their own; answer with the same heart icon index.html uses.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#EC4A7B"/>' +
  '<path d="M24 35S11 27.4 11 19.6A6.6 6.6 0 0 1 24 17a6.6 6.6 0 0 1 13 2.6C37 27.4 24 35 24 35Z" fill="white"/></svg>';

function sendError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = Number(err && err.status) || 500;
  if (!err || !err.status) console.error('[error]', err);
  sendJson(res, status, { error: err && err.status ? err.message : 'Something went wrong on our side. Please try again in a moment.' }, err && err.headers);
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url.startsWith('/') ? 'http://localhost' + req.url : req.url);
  } catch (e) {
    throw httpError(400, 'That address is not valid.');
  }
  const { pathname } = url;

  if (pathname === '/api' || pathname.startsWith('/api/')) return app.handle(req, res);

  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    return res.end();
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

// Texts any admin update not texted yet (one sweep at a time)
let sweeping = null;
function sweep() {
  if (sweeping) return sweeping;
  sweeping = notify.sweep()
    .then((result) => { if (result.records.length) console.log('[sms] Texted ' + result.records.length + ' admin update(s).'); })
    .catch((err) => console.warn('[sms] Could not check for admin updates to text: ' + err.message))
    .finally(() => { sweeping = null; });
  return sweeping;
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
    checkFacilityData();
    console.log('Records:                Firestore (shared with the MOWMMAS website online)');
    const sms = app.sms();
    if (sms) {
      sms.gateway().then((g) => console.log('SMS (PhilSMS):          ' + (!g.configured
        ? 'not set up (add PHILSMS_API_TOKEN to User/Admin/Backend/.env)'
        : g.connected ? 'connected, ' + (g.balance || 'credit unknown') + ' left' : 'set up, but ' + g.error)));
      sweep();
      setInterval(sweep, SWEEP_MS).unref();
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
