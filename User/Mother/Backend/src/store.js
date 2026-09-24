'use strict';
/* Tiny JSON-file database shared by the Mother and Admin backends.

   - Each collection is one pretty-printed JSON file in DB_DIR.
   - Writes go to a temp file first and are then renamed over the original,
     so a crash never leaves a half-written file.
   - update() takes a short cross-process lock, so the Mother backend
     (creating submissions) and the Admin backend (changing their status)
     can never overwrite each other's changes. */
const fs = require('fs');
const path = require('path');
const { DB_DIR } = require('./config');

const FILES = {
  osm: 'osm-facilities.json',
  profiles: 'facility-profiles.json',
  photos: 'facility-photos.json',
  firestoreFacilities: 'firestore-facilities.json',
  submissions: 'submissions.json',
  notifications: 'notifications.json',
  smsLog: 'sms-log.json',             // every SMS sent through PhilSMS, newest first (the admin's Message log)
  smsTemplates: 'sms-templates.json', // the SMS page's templates, as the admin saved them
  users: 'users.json'
};

function file(name) {
  return path.join(DB_DIR, FILES[name] || name);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function write(name, data) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const target = file(name);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // Windows can briefly refuse the rename if another process is reading the file
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 20) throw err;
      sleep(25);
    }
  }
}

function lock(name) {
  const lockFile = file(name) + '.lock';
  const started = Date.now();
  fs.mkdirSync(DB_DIR, { recursive: true });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      return () => { try { fs.unlinkSync(lockFile); } catch (e) { /* already gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        // a lock older than 5 s belongs to a crashed process
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 5000) fs.unlinkSync(lockFile);
      } catch (e) { /* removed by its owner meanwhile */ }
      if (Date.now() - started > 3000) {
        const busy = new Error('The database is busy. Please try again.');
        busy.status = 503;
        throw busy;
      }
      sleep(20);
    }
  }
}

/* Read → change → write, all under the lock.
   `mutate` edits `data` in place and may return a value, which update() returns. */
function update(name, fallback, mutate) {
  const release = lock(name);
  try {
    const data = read(name, fallback);
    const result = mutate(data);
    write(name, data);
    return result;
  } finally {
    release();
  }
}

module.exports = { FILES, file, read, write, update };
