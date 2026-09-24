'use strict';
/* Central settings for the MOWMMAS Admin backend.
   Values come from environment variables first, then from ../.env. */
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
// C:\MOWMMA  (src → Backend → Admin → User → MOWMMA)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/* Reads KEY=value lines from .env. Existing environment variables are kept. */
function loadEnvFile(file) {
  let textContent;
  try {
    textContent = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return; // no .env: environment variables only
  }
  for (const line of textContent.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(BACKEND_DIR, '.env'));

const env = process.env;
// A whole number from the environment; 0 is kept (e.g. 0 = no automatic texts), blank or invalid gives the default
const count = (value, fallback) => (value !== undefined && String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);

module.exports = {
  PROJECT_ROOT,

  // Firebase
  API_KEY: env.FIREBASE_API_KEY || '',
  PROJECT_ID: env.FIREBASE_PROJECT_ID || '',
  ADMIN_EMAIL: env.FIREBASE_ADMIN_EMAIL || '',
  ADMIN_PASSWORD: env.FIREBASE_ADMIN_PASSWORD || '',

  // Firestore collection that holds the mothers' donations, requests and inquiries
  SUBMISSIONS_COLLECTION: env.FIRESTORE_SUBMISSIONS_COLLECTION || 'submissions',

  // The admin API (only this computer can reach it)
  PORT: Number(env.ADMIN_PORT) || 4000,
  HOST: env.ADMIN_HOST || '127.0.0.1',
  // Pages allowed to call the admin API from a browser (VS Code Live Server, this server)
  ALLOWED_ORIGINS: (env.ADMIN_ALLOWED_ORIGINS ||
    'http://127.0.0.1:5501,http://localhost:5501,http://127.0.0.1:5500,http://localhost:5500,http://localhost:4000,http://127.0.0.1:4000')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Which submissions are already in Firestore (written by the mother backend's sync)
  DATA_DIR: env.ADMIN_DATA_DIR || path.join(BACKEND_DIR, 'data'),
  // The mother backend's submissions, to report how many are still waiting
  MOTHER_SUBMISSIONS_FILE: path.join(env.MOWMMA_DB_DIR || path.join(PROJECT_ROOT, 'User', 'Mother', 'Backend', 'data'), 'submissions.json'),

  // How often waiting submissions are sent again
  SYNC_INTERVAL_MS: Number(env.FIRESTORE_SYNC_INTERVAL_MS) || 60 * 1000,
  // Facilities (managed on the admin Facilities page) are copied to the mother backend:
  // changes every run, and a full copy this often (also catches edits made in the Firebase console)
  FACILITIES_COLLECTION: env.FIRESTORE_FACILITIES_COLLECTION || 'facilities',
  FACILITY_FULL_REFRESH_MS: Number(env.FIRESTORE_FACILITY_REFRESH_MS) || 6 * 60 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 15 * 1000,

  // SMS through PhilSMS (https://dashboard.philsms.com/developers). The token is only used here, on the server.
  SMS_API_URL: (env.PHILSMS_API_URL || 'https://dashboard.philsms.com/api/v3').replace(/\/+$/, ''),
  SMS_API_TOKEN: env.PHILSMS_API_TOKEN || '',
  // An approved Sender ID (PhilSMS dashboard, Sending > Sender ID). Blank: PhilSMS uses the account's default.
  SMS_SENDER_ID: env.PHILSMS_SENDER_ID || '',
  // Automatic texts are capped, so a flood of forms can't use up the SMS credit (0 turns that kind off):
  //   SMS_AUTO_DAILY_LIMIT               "form received" texts a day in all
  //   SMS_RECEIVED_PER_NUMBER_DAILY      "form received" texts a day to one number
  //   SMS_AUTO_PER_NUMBER_HOURLY         automatic texts an hour to one number (received and status updates)
  // Status updates follow an admin's action, so the daily cap for forms doesn't hold them back.
  SMS_AUTO_DAILY_LIMIT: count(env.SMS_AUTO_DAILY_LIMIT, 100),
  SMS_RECEIVED_PER_NUMBER_DAILY: count(env.SMS_RECEIVED_PER_NUMBER_DAILY, 3),
  SMS_AUTO_PER_NUMBER_HOURLY: count(env.SMS_AUTO_PER_NUMBER_HOURLY, 5)
};
