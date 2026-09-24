'use strict';
/* Signs the backend in to Firebase Authentication as the admin account
   (email + password from .env) and keeps its ID token fresh.
   Firestore checks that token against the security rules, so the backend
   can do exactly what the admin account may do, nothing more.

   getSession()   → { idToken, uid }  (signs in or refreshes when needed)
   invalidate()   forget the token, e.g. after Firestore said it's not valid */
const config = require('./config');

class FirebaseError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'FirebaseError';
    this.code = code;
    this.status = status || 500;
  }
}

const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';

// What Firebase Auth's error codes mean for whoever runs the backend
const AUTH_MESSAGES = {
  INVALID_LOGIN_CREDENTIALS: 'The admin email or password in User/Admin/Backend/.env is wrong.',
  INVALID_PASSWORD: 'The admin password in User/Admin/Backend/.env is wrong.',
  EMAIL_NOT_FOUND: 'The admin account in User/Admin/Backend/.env is not in Firebase Authentication.',
  USER_DISABLED: 'The admin account is disabled in Firebase Authentication.',
  OPERATION_NOT_ALLOWED: 'Email/Password sign-in is turned off in the Firebase console (Authentication, Sign-in method).',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Firebase is blocking sign-in for a while after too many tries. Wait a few minutes.',
  API_KEY_INVALID: 'The FIREBASE_API_KEY in User/Admin/Backend/.env is not valid.'
};

let session = null;   // { idToken, refreshToken, uid, expiresAt }
let inFlight = null;  // one sign-in at a time

async function post(url, body, contentType) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw new FirebaseError('unavailable', "Can't reach Firebase. Check the internet connection.", 503);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = (data.error && data.error.message) || String(response.status);
    const key = raw.split(' ')[0].split(':')[0].trim();
    throw new FirebaseError('auth/' + key.toLowerCase().replace(/_/g, '-'),
      AUTH_MESSAGES[key] || 'Firebase sign-in failed: ' + raw, 401);
  }
  return data;
}

async function signIn() {
  if (!config.API_KEY || !config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    throw new FirebaseError('config', 'Set FIREBASE_API_KEY, FIREBASE_ADMIN_EMAIL and FIREBASE_ADMIN_PASSWORD in User/Admin/Backend/.env.', 500);
  }
  const data = await post(SIGN_IN_URL + '?key=' + encodeURIComponent(config.API_KEY),
    JSON.stringify({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD, returnSecureToken: true }),
    'application/json');
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000
  };
}

async function refresh(refreshToken) {
  const data = await post(REFRESH_URL + '?key=' + encodeURIComponent(config.API_KEY),
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    'application/x-www-form-urlencoded');
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    uid: data.user_id,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
}

/* A valid ID token, refreshed a minute before it runs out (tokens last an hour) */
async function getSession() {
  if (session && Date.now() < session.expiresAt - 60 * 1000) return session;
  if (!inFlight) {
    const previous = session;
    inFlight = (previous && previous.refreshToken ? refresh(previous.refreshToken).catch(() => signIn()) : signIn())
      .then((fresh) => { session = fresh; return fresh; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

function invalidate() {
  session = null;
}

module.exports = { FirebaseError, getSession, invalidate };
