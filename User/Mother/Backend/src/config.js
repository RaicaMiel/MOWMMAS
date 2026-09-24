'use strict';
/* Central settings for the MOWMMAS Mother backend.
   Every value can be overridden with an environment variable. */
const path = require('path');

// C:\MOWMMA  (src → Backend → Mother → User → MOWMMA)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

module.exports = {
  PROJECT_ROOT,
  PORT: Number(process.env.MOWMMA_MOTHER_PORT) || 3000,

  // JSON "database" (OpenStreetMap cache, facility profiles, submissions, …).
  // It lives inside the Mother backend; the Admin backend reads and writes the same folder.
  DB_DIR: process.env.MOWMMA_DB_DIR || path.join(__dirname, '..', 'data'),
  PHOTOS_DIR: path.join(__dirname, '..', 'data', 'photos'),

  // The mother-side website, served at http://localhost:3000/
  FRONTEND_DIR: path.join(PROJECT_ROOT, 'User', 'Mother', 'Frontend'),

  // OpenStreetMap / Overpass
  PROVINCE: 'Antique',
  OSM_MAX_AGE_MS: 24 * 60 * 60 * 1000, // refresh facility data once a day
  OVERPASS_ENDPOINTS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ],
  // Overpass asks every client to identify itself
  USER_AGENT: 'MOWMMAS/0.1 (Mothers Online With Milk Management, Access, and Support; capstone prototype)'
};
