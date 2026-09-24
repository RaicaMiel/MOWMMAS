'use strict';
/* Small HTTP helpers for the MOWMMAS Mother backend (Node built-ins only):
   JSON responses, errors, CORS, request bodies, a tiny router and a safe
   static file server for the mother-side website. */
const fs = require('fs');
const path = require('path');

const BODY_LIMIT_BYTES = 100 * 1024;       // 100 KB — plenty for any form
const HARD_LIMIT_BYTES = 1024 * 1024;      // stop reading altogether after 1 MB

/* Throw one of these from anywhere; server.js turns it into
   { error, fields? } with the right status code. */
class HttpError extends Error {
  constructor(status, message, fields, headers) {
    super(message);
    this.status = status;
    if (fields) this.fields = fields;
    if (headers) this.headers = headers;
  }
}

const httpError = (status, message, fields, headers) => new HttpError(status, message, fields, headers);

/* ───────────────────────── CORS ───────────────────────── */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',   // Authorization: the admin pages' sign-in (SMS)
  'Access-Control-Max-Age': '600'
};

function setCors(res) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/* ───────────────────────── JSON ───────────────────────── */

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(res.req && res.req.method === 'HEAD' ? undefined : text);
}

/* Reads and parses a JSON request body.
   413 when it is bigger than `limitBytes`, 400 when it is empty or not JSON. */
function readJson(req, limitBytes = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooBig = Number(req.headers['content-length']) > limitBytes;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const tooLarge = () => httpError(413,
      'That is more information than we can accept at once (limit 100 KB). Please shorten your notes and try again.',
      null, { Connection: 'close' });

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { tooBig = true; chunks = null; }
      if (size > HARD_LIMIT_BYTES) {
        // Someone is sending far too much — answer now and stop reading.
        req.pause();
        finish(reject, tooLarge());
        return;
      }
      if (!tooBig) chunks.push(chunk);
    });
    req.on('end', () => {
      // A slightly-too-big body is read to the end (and thrown away) so the
      // browser reliably receives our 413 answer instead of a reset connection.
      if (tooBig) return finish(reject, tooLarge());
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish(reject, httpError(400, 'The request body is empty. Please send the form as JSON.'));
      try {
        finish(resolve, JSON.parse(text));
      } catch (e) {
        finish(reject, httpError(400, 'The request body is not valid JSON.'));
      }
    });
    // The phone lost its connection half-way through sending — not a server fault
    const interrupted = () => httpError(400, 'The form was only partly received. Please try again.');
    req.on('error', (err) => finish(reject, err && (err.code === 'ECONNRESET' || err.message === 'aborted') ? interrupted() : err));
    req.on('close', () => { if (!req.complete) finish(reject, interrupted()); });
  });
}

/* ───────────────────────── Router ─────────────────────────
   const router = createRouter();
   router.add('GET /api/facilities/:id', (req, res, params, url) => …);
   router.match('GET', '/api/facilities/osm-w1')
     → { handler, params: { id: 'osm-w1' } }   found
     → { allowed: ['GET'] }                    path exists, wrong method
     → null                                    no such path */
function createRouter() {
  const routes = [];
  const split = (p) => p.split('/').filter(Boolean);
  return {
    add(spec, handler) {
      const [method, pattern] = spec.trim().split(/\s+/);
      routes.push({ method: method.toUpperCase(), parts: split(pattern), handler });
      return this;
    },
    match(method, pathname) {
      const segments = split(pathname);
      const allowed = [];
      for (const route of routes) {
        if (route.parts.length !== segments.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < route.parts.length && ok; i++) {
          const part = route.parts[i];
          if (part[0] === ':') {
            try {
              params[part.slice(1)] = decodeURIComponent(segments[i]);
            } catch (e) {
              throw httpError(400, 'The address contains an invalid character.');
            }
          } else {
            ok = part === segments[i];
          }
        }
        if (!ok) continue;
        if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
          return { handler: route.handler, params };
        }
        allowed.push(route.method);
      }
      return allowed.length ? { allowed } : null;
    }
  };
}

/* ───────────────────────── Static files ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf'
};

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · MOWMMAS</title>
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="app-page">
<main id="main" class="app-main">
<div class="container">
<div class="state">
<h1 class="state__title">We couldn't find that page</h1>
<p class="state__text">The link may be old or mistyped. You can start again from the MOWMMAS home page.</p>
<div class="state__actions"><a class="btn btn--primary btn--sm" href="/html/home.html">Go to the home page</a></div>
</div>
</div>
</main>
</body>
</html>
`;

function sendNotFoundPage(res) {
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(NOT_FOUND_HTML),
    'Cache-Control': 'no-cache'
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : NOT_FOUND_HTML);
}

/* Maps a URL path to a file inside `rootDir`, or returns null when the path
   is unsafe (.., encoded .., backslashes, NUL bytes, drive letters, dotfiles)
   or would land outside rootDir. `urlPath` is the still-encoded pathname. */
function resolveInside(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;

  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  // The final check: whatever happened above, the file must be inside rootDir.
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/* Serves one file from `rootDir` (GET and HEAD). Sends 404 when the file
   does not exist, is a folder, or the path is not allowed. */
function serveStatic(req, res, rootDir, urlPath) {
  const target = resolveInside(rootDir, urlPath);
  if (!target) return sendNotFoundPage(res);

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return sendNotFoundPage(res);

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
      'ETag': etag
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = stat.size;
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    const stream = fs.createReadStream(target);
    stream.on('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
    stream.on('error', () => {
      if (!res.headersSent) sendNotFoundPage(res);
      else res.destroy();
    });
  });
}

module.exports = {
  BODY_LIMIT_BYTES,
  HttpError,
  httpError,
  CORS_HEADERS,
  setCors,
  sendJson,
  readJson,
  createRouter,
  MIME,
  resolveInside,
  serveStatic,
  sendNotFoundPage
};
