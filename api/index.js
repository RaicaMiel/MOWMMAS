'use strict';
/* MOWMMAS on Vercel: every /api/… request comes here (vercel.json) and is
   answered by the MOWMMAS API in User/Mother/Backend/src/app.js. */
const app = require('../User/Mother/Backend/src/app');

module.exports = (req, res) => {
  // vercel.json passes the address that was asked for as __path (/api/:path* → /api/index?__path=:path*)
  const url = new URL(req.url, 'http://localhost');
  const asked = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  if (asked !== null && /^\/api\/index(\.js)?\/?$/.test(url.pathname)) url.pathname = '/api/' + asked;
  req.url = url.pathname + url.search;
  return app.handle(req, res);
};
