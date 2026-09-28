'use strict';
/* The facility data tool for MOWMMAS administrators (Node built-ins only).
   Compares the facilities in Firestore (facilities/<id>: the list mothers see)
   with the OpenStreetMap facilities (User/Mother/Backend/data/osm-facilities.json),
   creates the missing ones and corrects old values.

   Run in User/Admin/Backend. It signs in with the Firebase settings in
   User/Admin/Backend/.env (see .env.example), like the admin backend.

     npm run facilities                                report (read-only, the default)
     npm run facilities -- seed                        what seed would create (dry run)
     npm run facilities -- seed --apply                create them
     npm run facilities -- cleanup                     what cleanup would change (dry run)
     npm run facilities -- cleanup --reset-unticked    ... also old "Not offered" values
     npm run facilities -- cleanup --apply [--reset-unticked] [--before=<ISO time>]
   or: node scripts/facilities.js <command> [flags]

   report    Every facility in Firestore (Published, HMB, the five services, donor
             milk, contact number, hours, last update), then what needs attention:
             (a) OpenStreetMap facilities missing from Firestore (mothers don't see them)
             (b) Firestore facilities not on OpenStreetMap (admin-added; for information),
                 and those that are an OpenStreetMap facility under another id
                 (alsoMappedAs) or with the same name and town ("same facility as")
             (c) donor milk availability or milk stock on a facility that is not a
                 verified HMB (mothers never see it)
             (d) services saved as false ("Not offered") before the three-option
                 services went live: maybe old checkboxes nobody ticked
             (d2) "Not offered" last saved after the cutoff: the Published switch and
                 Update status also move the save date, so some may still be old
                 unticked boxes (check them in Edit)
             (e) documented services but not published (publish candidates); a "Yes"
                 last saved before the cutoff is marked: maybe an old tick
             (e2) published with "Yes — documented" only from before the cutoff:
                 confirm a source (values are never changed)
             (f) published with no documented service
             (g) no contact number or no operating hours
             (h) map/antique (Antique's towns for the Town field) missing
   seed      Creates facilities/<id> for each OpenStreetMap facility that has none:
             not published, every service "Not verified", no HMB, no donor milk.
             An OpenStreetMap facility already has one when any of its ids (its own,
             or an alsoMappedAs one) is in Firestore, or when a facility there has
             the same name and town (not created: check it).
             Only creates ({ exists: false }), so a document that is already there
             is never changed. Also creates map/antique when it's missing.
   cleanup   Donor milk availability and milk stock are shown to mothers only for a
             verified HMB, so on any other facility they become null.
             --reset-unticked: services saved as false before the cutoff (--before,
             default 2026-09-28T22:47:36+08:00, when the three-option services went
             live; a facility never saved counts as before) become null ("Not verified").
             --before can't be in the future (every "Not offered" would be reset).
             true values, facilities saved after the cutoff, Published, HMB and
             contacts are never changed, and neither is dataStatus.updatedAt (a data
             correction, not a facility update). Only the changed fields are written,
             each facility on condition that it is still the version read (updateTime):
             if an admin saved it meanwhile, that write fails, is reported, and the
             others go on. With --apply every field is printed as it was and as it
             is written (field: old → new), also those not written.

   Saved before the cutoff: every save time the facility records is before it:
   dataStatus.updatedAt (the admin's browser clock) and adminUpdatedAt (Firestore's
   clock, set by the admin page). Neither: never saved by an admin (counts as before).
   A time that can't be read counts as after: that facility is left alone.

   Nothing is written without --apply: the tool prints exactly what it would write.
   Exit codes: 0 done, 1 unknown command or flag, 2 Firebase settings missing,
   3 Firestore error or some writes failed.

   Tested without Firebase (test/facilities.test.js): run(argv, deps) takes
     deps.store       { listDocs, getDoc, setDoc } like src/firestore.js
     deps.osm         the OpenStreetMap data, or a function that reads it
     deps.now()       the current time (a Date)
     deps.log(line)   output; deps.error(line) for problems (default: log)
     deps.config      optional: src/config.js, to check the Firebase settings first
     deps.collection  optional: the facilities collection (default "facilities") */
const fs = require('fs');
const path = require('path');

const COLLECTION = 'facilities';
const MAP_COLLECTION = 'map';
const MAP_ID = 'antique';
const PROVINCE = 'Antique';
const ENV_FILE = 'User/Admin/Backend/.env';

// The three-option services (Phase 2) went live. A false saved before that came
// from the old checkboxes and may only mean "not ticked".
const PHASE2_CUTOFF = '2026-09-28T22:47:36+08:00';

// The five human milk-related services (MILK_SERVICES in the admin's admin-data.js)
const SERVICES = [
  { key: 'lactationServices', short: 'Lactation' },
  { key: 'milkReferral', short: 'Info & referral' },
  { key: 'milkStorage', short: 'Storage' },
  { key: 'acceptsDonations', short: 'Donations' },
  { key: 'providesDonorMilk', short: 'Donor milk' }
];
const SERVICE_KEYS = SERVICES.map((s) => s.key);

// A service's stored value: true "Yes — documented", null "Not verified", false "Not offered"
const SERVICE_LABEL = { yes: 'yes', unverified: 'not verified', no: 'not offered' };

const HMB_LABEL = { verified: 'verified', not_verified: 'not verified', none: 'no confirmed HMB' };

// Same types as the admin page and the mother backend (User/Mother/Backend/src/osm.js)
const KIND_LABEL = {
  hospital: 'Hospital',
  health_center: 'Rural health unit / primary care',
  birthing: 'Birthing / lying-in facility',
  clinic: 'Clinic'
};

// The Firebase settings every command needs: .env name → src/config.js name
const SETTINGS = [
  ['FIREBASE_API_KEY', 'API_KEY'],
  ['FIREBASE_PROJECT_ID', 'PROJECT_ID'],
  ['FIREBASE_ADMIN_EMAIL', 'ADMIN_EMAIL'],
  ['FIREBASE_ADMIN_PASSWORD', 'ADMIN_PASSWORD']
];

// The example values an older .env.example had: still there means not filled in
const EXAMPLE_VALUES = ['your-firebase-web-api-key', 'your-firebase-project-id', 'admin@example.com', 'your-admin-password'];

// Write failures that concern one document only: reported, and the next one is tried.
// Anything else (sign-in, permission, network) stops the run.
const ONE_DOC_ERRORS = ['already-exists', 'failed-precondition', 'not-found', 'aborted', 'invalid-argument'];

const COMMANDS = ['report', 'seed', 'cleanup'];

const USAGE = [
  'Usage (in User/Admin/Backend):',
  '  npm run facilities -- [report]                    compare Firestore with OpenStreetMap (read-only)',
  '  npm run facilities -- seed [--apply]              create the missing facilities and map/antique',
  '  npm run facilities -- cleanup [--apply] [--reset-unticked] [--before=<ISO time>]',
  '                                                    clear donor milk shown only for a verified HMB;',
  '                                                    --reset-unticked: old false services → null',
  '  (or: node scripts/facilities.js <command> [flags])',
  'Without --apply nothing is written: it prints what it would write.',
  '--before (with --reset-unticked) needs a time zone and can\'t be in the future, e.g. --before=' + PHASE2_CUTOFF
].join('\n');

class UsageError extends Error {}

/* ───────────── small helpers ───────────── */

const text = (value) => (value == null ? '' : String(value).trim());
const isSet = (value) => value !== null && value !== undefined;
const round6 = (value) => Number(Number(value).toFixed(6));
const plural = (n, word, many) => n + ' ' + (n === 1 ? word : many || word + 's');
const idOf = (doc) => doc._id || doc.id;
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id));

function mapUrl(lat, lon) {
  return 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=17/' + lat + '/' + lon;
}

function directionsUrl(lat, lon) {
  return 'https://www.openstreetmap.org/directions?route=%3B' + lat + '%2C' + lon + '#map=15/' + lat + '/' + lon;
}

// A value as it will be stored: Date → Firestore timestamp, anything else as JSON
function shown(value) {
  if (value instanceof Date) return value.toISOString() + ' (timestamp)';
  return JSON.stringify(value === undefined ? null : value);
}

/* ───────────── what the data means (same rules as the admin pages) ───────────── */

// "verified" | "not_verified" | "none" (hmbStatus in admin-data.js)
function hmbState(doc) {
  const s = doc && doc.services;
  if (!s || s.milkBank !== true) return 'none';
  return doc.dataStatus && doc.dataStatus.verified === true ? 'verified' : 'not_verified';
}

const isVerifiedHmb = (doc) => hmbState(doc) === 'verified';
const isPublished = (doc) => Boolean(doc) && doc.participating === true;

// "yes" | "no" | "unverified" (serviceState in admin-data.js: null or missing is "Not verified")
function serviceState(value) {
  return value === true ? 'yes' : value === false ? 'no' : 'unverified';
}

function servicesOf(doc) {
  return doc && doc.services && typeof doc.services === 'object' ? doc.services : {};
}

// The services marked "Yes — documented"
function documented(doc) {
  const s = servicesOf(doc);
  return SERVICES.filter((service) => s[service.key] === true).map((service) => service.short);
}

// The services stored as false ("Not offered")
function notOffered(doc) {
  const s = servicesOf(doc);
  return SERVICE_KEYS.filter((key) => s[key] === false);
}

// dataStatus.updatedAt: stamped by the admin page from the browser's clock
function lastSaved(doc) {
  return (doc && doc.dataStatus && doc.dataStatus.updatedAt) || null;
}

// A save time in milliseconds (NaN if it can't be read): an ISO string, or a Date
function timeOf(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/* Every save time the facility records: dataStatus.updatedAt (the browser's clock)
   and adminUpdatedAt (Firestore's clock: serverTimestamp on the admin page). */
function saveTimes(doc) {
  return [lastSaved(doc), doc && doc.adminUpdatedAt].filter((at) => at !== null && at !== undefined && at !== '');
}

// The latest save time that can be read, as an ISO string, or null
function latestSave(doc) {
  const times = saveTimes(doc).map(timeOf).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

// "last saved <latest>", "never saved by an admin", plus any save time that can't be read
function saveNote(doc) {
  const times = saveTimes(doc);
  if (!times.length) return 'never saved by an admin';
  const unreadable = times.filter((at) => !Number.isFinite(timeOf(at)));
  const latest = latestSave(doc);
  return [latest ? 'last saved ' + latest : '', unreadable.length ? 'save date not readable: ' + unreadable.map(shown).join(', ') : '']
    .filter(Boolean).join('; ');
}

/* Last saved before the cutoff by both clocks, or never saved: every save time
   the facility records (dataStatus.updatedAt, adminUpdatedAt) is before it.
   A time that can't be read counts as after: such a facility is left alone. */
function savedBefore(doc, cutoff) {
  const limit = Date.parse(cutoff);
  return saveTimes(doc).every((at) => {
    const t = timeOf(at);
    return Number.isFinite(t) && t < limit;
  });
}

const hasContact = (doc) => text(doc.contactNumber) !== '' || text(doc.smsNumber) !== '';
const hasHours = (doc) => text(doc.operatingHours) !== '';

function osmFacilities(osm) {
  return osm && Array.isArray(osm.facilities) ? osm.facilities : [];
}

// The OpenStreetMap data, checked (deps.osm may be the data or a function reading it)
function loadOsm(source) {
  const osm = typeof source === 'function' ? source() : source;
  if (!osm || !Array.isArray(osm.facilities)) {
    throw new Error('The OpenStreetMap data has no facilities list. Run node scripts/refresh-osm.js in User/Mother/Backend.');
  }
  return osm;
}

// "https://www.openstreetmap.org/node/13142018020" → "osm-n13142018020" (the ids in osm-facilities.json)
function osmIdOfUrl(url) {
  const m = /^https?:\/\/(?:www\.)?openstreetmap\.org\/(node|way|relation)\/(\d+)\/?$/i.exec(text(url));
  return m ? 'osm-' + m[1][0].toLowerCase() + m[2] : null;
}

// An OpenStreetMap facility's ids: its own, then those of the other objects mapping it (alsoMappedAs)
function aliasesOf(f) {
  const ids = [f.id];
  for (const url of Array.isArray(f.alsoMappedAs) ? f.alsoMappedAs : []) {
    const id = osmIdOfUrl(url);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// A name or town for comparing: lowercase, letters and digits only
const normalized = (value) => text(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/* The Firestore document each OpenStreetMap facility already has, so it is never
   created twice: Map OSM id → { docId, how, alias }
     how 'id'     facilities/<its own id>
     how 'alias'  facilities/<an alsoMappedAs id> (alias: that id)
     how 'name'   a facility with the same name and town (to check) */
function matchOsm(docs, osm) {
  const byId = new Map();
  for (const doc of docs) if (doc._id) byId.set(doc._id, doc);
  for (const doc of docs) if (doc.id && !byId.has(doc.id)) byId.set(doc.id, doc);
  const byNameTown = new Map();
  for (const doc of docs) {
    const key = normalized(doc.name) && normalized(doc.name) + '|' + normalized(doc.municipality);
    if (key && !byNameTown.has(key)) byNameTown.set(key, doc);
  }
  const matches = new Map();
  for (const f of osmFacilities(osm)) {
    if (!f || !f.id || matches.has(f.id)) continue;
    const alias = aliasesOf(f).find((id) => byId.has(id));
    if (alias) {
      matches.set(f.id, { docId: idOf(byId.get(alias)), how: alias === f.id ? 'id' : 'alias', alias });
      continue;
    }
    const doc = normalized(f.name) ? byNameTown.get(normalized(f.name) + '|' + normalized(f.municipality)) : null;
    if (doc) matches.set(f.id, { docId: idOf(doc), how: 'name', alias: null });
  }
  return matches;
}

/* The names of the Firebase settings missing from src/config.js, or still an
   example value (the old .env.example's placeholders, an @example.com address) */
function missingSettings(config) {
  const unset = (value) => {
    const v = text(value).toLowerCase();
    return !v || EXAMPLE_VALUES.includes(v) || v.endsWith('@example.com');
  };
  return SETTINGS.filter(([, key]) => unset(config && config[key])).map(([name]) => name);
}

function settingsLine(missing) {
  const names = missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] : missing[0];
  return 'Firebase settings missing or still the example value: set ' + names + ' in ' + ENV_FILE + ' (copy .env.example there and fill it in).';
}

/* ───────────── command line ───────────── */

/* now (optional, a Date): a --before later than it is refused, since every
   "Not offered" saved until now would be reset. */
function parseArgs(argv, now) {
  const args = { command: null, apply: false, resetUnticked: false, before: null, help: false };
  for (const arg of argv || []) {
    if (arg === '--help' || arg === '-h' || arg === 'help') args.help = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--reset-unticked') args.resetUnticked = true;
    else if (arg.startsWith('--before=')) args.before = arg.slice('--before='.length);
    else if (arg.startsWith('-')) throw new UsageError('Unknown flag: ' + arg);
    else if (!COMMANDS.includes(arg)) throw new UsageError('Unknown command: ' + arg);
    else if (args.command && args.command !== arg) throw new UsageError('One command at a time (' + args.command + ' or ' + arg + ').');
    else args.command = arg;
  }
  args.command = args.command || 'report';
  if (args.help) return args;
  if (args.apply && args.command === 'report') throw new UsageError('report only reads: --apply works with seed and cleanup.');
  if (args.resetUnticked && args.command !== 'cleanup') throw new UsageError('--reset-unticked works only with cleanup.');
  if (args.before !== null) {
    if (args.command !== 'cleanup' || !args.resetUnticked) throw new UsageError('--before works only with cleanup --reset-unticked.');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(args.before) || !Number.isFinite(Date.parse(args.before))) {
      throw new UsageError('--before needs an ISO time with a time zone, e.g. --before=' + PHASE2_CUTOFF);
    }
    if (now instanceof Date && Date.parse(args.before) > now.getTime()) {
      throw new UsageError('--before is in the future: every "Not offered" would be reset.');
    }
  }
  return args;
}

/* ───────────── report ───────────── */

/* Everything the report shows. docs: the Firestore facilities (listDocs);
   mapDoc: map/antique or null. */
function analyze(docs, osm, mapDoc) {
  const cutoff = PHASE2_CUTOFF;
  const bases = new Map(osmFacilities(osm).map((f) => [f.id, f]));
  const matches = matchOsm(docs, osm);
  // Documents that are an OpenStreetMap facility under another id or by name and town
  const sameAs = new Map();
  for (const [osmId, m] of matches) {
    if (m.how !== 'id' && !sameAs.has(m.docId)) sameAs.set(m.docId, { osmId, how: m.how, alias: m.alias });
  }
  const facilities = docs.map((doc) => {
    const direct = bases.get(idOf(doc)) || bases.get(doc.id) || null;
    const same = direct ? null : sameAs.get(idOf(doc)) || null;
    return {
      id: idOf(doc),
      name: text(doc.name) || '(no name)',
      doc,
      base: direct || (same && bases.get(same.osmId)) || null,
      sameAs: same
    };
  }).sort(byName);
  const entry = (f) => ({ id: f.id, name: f.name });
  const withYes = (f) => documented(f.doc).length > 0;
  const oldYes = (f) => withYes(f) && savedBefore(f.doc, cutoff);

  return {
    cutoff,
    osmCount: bases.size,
    facilities,
    // (a)
    missing: osmFacilities(osm).filter((f) => !matches.has(f.id))
      .map((f) => ({ id: f.id, name: f.name, town: f.municipality || null })).sort(byName),
    // (b)
    adminAdded: facilities.filter((f) => !f.base).map((f) => Object.assign(entry(f), { published: isPublished(f.doc) })),
    // Built from the matches, so every OSM facility matched under another id or by name and town
    // is listed, even when the matching document is itself another OSM facility
    sameFacility: [...matches].filter(([, m]) => m.how !== 'id')
      .map(([osmId, m]) => {
        const f = facilities.find((x) => x.id === m.docId);
        return { id: m.docId, name: f ? f.name : m.docId, osmId, how: m.how, alias: m.alias };
      })
      .sort(byName),
    // (c)
    hiddenDonorMilk: facilities
      .filter((f) => !isVerifiedHmb(f.doc) && (isSet(f.doc.donorMilkAvailability) || isSet(f.doc.milkStock)))
      .map((f) => Object.assign(entry(f), {
        hmb: hmbState(f.doc),
        donorMilkAvailability: isSet(f.doc.donorMilkAvailability) ? f.doc.donorMilkAvailability : null,
        milkStock: isSet(f.doc.milkStock) ? f.doc.milkStock : null
      })),
    // (d)
    oldUnticked: facilities
      .filter((f) => notOffered(f.doc).length && savedBefore(f.doc, cutoff))
      .map((f) => Object.assign(entry(f), { keys: notOffered(f.doc), saved: saveNote(f.doc) })),
    // (d2)
    recentUnticked: facilities
      .filter((f) => notOffered(f.doc).length && !savedBefore(f.doc, cutoff))
      .map((f) => Object.assign(entry(f), { keys: notOffered(f.doc), saved: saveNote(f.doc) })),
    // (e)
    publishCandidates: facilities
      .filter((f) => !isPublished(f.doc) && withYes(f))
      .map((f) => Object.assign(entry(f), { services: documented(f.doc), oldYes: oldYes(f), savedAt: latestSave(f.doc) })),
    // (e2)
    publishedOldYes: facilities
      .filter((f) => isPublished(f.doc) && oldYes(f))
      .map((f) => Object.assign(entry(f), { services: documented(f.doc), savedAt: latestSave(f.doc) })),
    // (f)
    publishedNoService: facilities.filter((f) => isPublished(f.doc) && !documented(f.doc).length).map(entry),
    // (g)
    missingContactOrHours: facilities
      .filter((f) => !hasContact(f.doc) || !hasHours(f.doc))
      .map((f) => Object.assign(entry(f), {
        contact: hasContact(f.doc),
        hours: hasHours(f.doc),
        osmPhone: Boolean(f.base && text(f.base.phone)),
        osmHours: Boolean(f.base && text(f.base.openingHours))
      })),
    // (h)
    map: {
      missing: !mapDoc,
      noTowns: Boolean(mapDoc) && !(Array.isArray(mapDoc.municipalities) && mapDoc.municipalities.length)
    },
    published: facilities.filter((f) => isPublished(f.doc)).length,
    verifiedHmbs: facilities.filter((f) => isVerifiedHmb(f.doc)).length
  };
}

function facilityLines(f) {
  const d = f.doc;
  const s = servicesOf(d);
  const tags = [f.sameAs ? 'same facility as ' + f.sameAs.osmId : f.base ? 'OpenStreetMap' : 'admin-added'];
  if (d.infoOnly === true) tags.push('info only');
  const contact = hasContact(d) ? 'yes' : f.base && text(f.base.phone) ? 'no (OpenStreetMap has one)' : 'no';
  const hours = hasHours(d) ? 'yes' : f.base && text(f.base.openingHours) ? 'no (OpenStreetMap has them)' : 'no';
  return [
    '',
    '  ' + f.id + '  ' + f.name + '  [' + tags.join(', ') + ']',
    '    Town: ' + (text(d.municipality) || '(none)') + ' · Published: ' + (isPublished(d) ? 'yes' : 'no') +
      ' · HMB: ' + HMB_LABEL[hmbState(d)],
    '    Services: ' + SERVICES.map((service) => service.short + ': ' + SERVICE_LABEL[serviceState(s[service.key])]).join(' · '),
    '    Donor milk availability: ' + (isSet(d.donorMilkAvailability) ? shown(d.donorMilkAvailability) : 'not set') +
      (isSet(d.milkStock) ? ' · Milk stock: ' + shown(d.milkStock) : '') +
      ' · Contact number: ' + contact + ' · Operating hours: ' + hours +
      ' · Updated: ' + (lastSaved(d) || 'never')
  ];
}

// The mark on a publish candidate whose "Yes" values were last saved before the cutoff
function oldYesNote(savedAt) {
  return savedAt
    ? '("Yes" last saved ' + savedAt + ', before the three-option services: maybe an old tick — confirm a source before publishing)'
    : '("Yes" never saved by an admin, so from before the three-option services: maybe an old tick — confirm a source before publishing)';
}

function nextStep(a) {
  if (a.missing.length || a.map.missing) return 'npm run facilities -- seed   (shows what it would create; add --apply to create it)';
  if (a.hiddenDonorMilk.length || a.oldUnticked.length) {
    return 'npm run facilities -- cleanup' + (a.oldUnticked.length ? ' --reset-unticked' : '') + '   (shows what it would change; add --apply to write)';
  }
  if (a.publishedOldYes.length) return 'confirm a source for the "Yes — documented" services in (e2) on the admin Health Facilities page (Edit)';
  if (a.publishCandidates.length) return 'check the publish candidates (e) on the admin Health Facilities page and switch Published on where the information is documented';
  if (a.recentUnticked.length) return 'check the "Not offered" services in (d2) on the admin Health Facilities page (Edit)';
  if (a.publishedNoService.length || a.missingContactOrHours.length) return 'fill in the facilities in (f) and (g) on the admin Health Facilities page (Edit)';
  return 'nothing to fix';
}

function formatReport(a, info) {
  const out = [];
  const section = (title, items, line, empty) => {
    // A title that is a whole sentence gets its count after it: "… --before. Facilities: 2"
    out.push('', title + (title.endsWith('.') ? ' Facilities: ' : ': ') + items.length);
    if (!items.length) out.push('    ' + (empty || 'none'));
    for (const item of items) out.push('    ' + line(item));
  };
  out.push('Facility report · ' + info.at.toISOString() + ' · Firestore ' + info.collection + '/ vs ' +
    plural(a.osmCount, 'OpenStreetMap facility', 'OpenStreetMap facilities') + (info.osmFetchedAt ? ' (downloaded ' + info.osmFetchedAt + ')' : ''));
  out.push('Services: yes = "Yes — documented" (true), not verified = null, not offered = false.');
  out.push('', 'Facilities in Firestore: ' + a.facilities.length);
  if (!a.facilities.length) out.push('    none: the mother site lists only the facilities in Firestore');
  for (const f of a.facilities) out.push(...facilityLines(f));

  section('(a) OpenStreetMap facilities missing from Firestore (mothers don\'t see them; seed creates them)', a.missing,
    (f) => f.id + '  ' + f.name + (f.town ? ' (' + f.town + ')' : ''));
  section('(b) In Firestore, not on OpenStreetMap (admin-added; for information)', a.adminAdded,
    (f) => f.id + '  ' + f.name + (f.published ? '' : ' (not published: mothers don\'t see it at all)'));
  if (a.sameFacility.length) {
    out.push('    Not admin-added: the same facility as an OpenStreetMap one (so that one is not missing, and seed doesn\'t create it):');
    for (const f of a.sameFacility) {
      out.push('    ' + f.id + '  ' + f.name + ': same facility as ' + f.osmId +
        (f.how === 'alias' ? ' (OpenStreetMap also maps it as ' + f.alias + ')' : ' (same name and town — check it)'));
    }
  }
  section('(c) Donor milk availability or milk stock on a facility that is not a verified HMB (mothers never see it; cleanup clears it)', a.hiddenDonorMilk,
    (f) => f.id + '  ' + f.name + ' (HMB: ' + HMB_LABEL[f.hmb] + '): ' +
      [f.donorMilkAvailability !== null ? 'donorMilkAvailability ' + shown(f.donorMilkAvailability) : '',
        f.milkStock !== null ? 'milkStock ' + shown(f.milkStock) : ''].filter(Boolean).join(', '));
  section('(d) "Not offered" (false) last saved before ' + a.cutoff + ' (maybe old unticked boxes; cleanup --reset-unticked makes them "Not verified")', a.oldUnticked,
    (f) => f.id + '  ' + f.name + ': ' + f.keys.map((key) => 'services.' + key).join(', ') + ' (' + f.saved + ')');
  section('(d2) "Not offered" last saved after the cutoff — the Published switch and Update status also move the save date, so some may still be old unticked boxes. ' +
    'Check each in Edit, or rerun cleanup --reset-unticked with a later --before.', a.recentUnticked,
    (f) => f.id + '  ' + f.name + ': ' + f.keys.map((key) => 'services.' + key).join(', ') + ' (' + f.saved + ')');
  section('(e) Documented services but not published (publish candidates)', a.publishCandidates,
    (f) => f.id + '  ' + f.name + ': ' + f.services.join(', ') + (f.oldYes ? '  ' + oldYesNote(f.savedAt) : ''));
  section('(e2) Published with "Yes — documented" only from before the cutoff — confirm a source', a.publishedOldYes,
    (f) => f.id + '  ' + f.name + ': ' + f.services.join(', ') + ' (' + (f.savedAt ? 'last saved ' + f.savedAt : 'never saved by an admin') + ')');
  section('(f) Published with no documented service', a.publishedNoService, (f) => f.id + '  ' + f.name);
  section('(g) No contact number or no operating hours', a.missingContactOrHours,
    (f) => f.id + '  ' + f.name + ': ' + [
      f.contact ? '' : 'no contact number' + (f.osmPhone ? ' (OpenStreetMap has one)' : ''),
      f.hours ? '' : 'no operating hours' + (f.osmHours ? ' (OpenStreetMap has them)' : '')
    ].filter(Boolean).join(', '));
  out.push('', '(h) map/antique (Antique\'s towns for the Town field): ' +
    (a.map.missing ? 'missing (seed creates it)' : a.map.noTowns ? 'there, but with no municipalities list' : 'there'));

  const fromOsm = a.facilities.length - a.adminAdded.length;
  out.push('', 'Summary',
    '    Firestore: ' + plural(a.facilities.length, 'facility', 'facilities') + ' (' + fromOsm + ' from OpenStreetMap, ' + a.adminAdded.length + ' admin-added)' +
      ' · OpenStreetMap: ' + a.osmCount + ' · Published: ' + a.published + ' · Verified HMBs: ' + a.verifiedHmbs,
    '    (a) missing ' + a.missing.length + ' · (b) admin-added ' + a.adminAdded.length +
      (a.sameFacility.length ? ' (+ ' + a.sameFacility.length + ' same facility as an OpenStreetMap one)' : '') +
      ' · (c) hidden donor milk ' + a.hiddenDonorMilk.length + ' · (d) old "Not offered" ' + a.oldUnticked.length +
      ' · (d2) "Not offered" saved after the cutoff ' + a.recentUnticked.length +
      ' · (e) publish candidates ' + a.publishCandidates.length +
      (a.publishCandidates.some((f) => f.oldYes) ? ' (' + a.publishCandidates.filter((f) => f.oldYes).length + ' with an old "Yes")' : '') +
      ' · (e2) published, "Yes" only from before the cutoff ' + a.publishedOldYes.length +
      ' · (f) published, nothing documented ' + a.publishedNoService.length +
      ' · (g) no contact or hours ' + a.missingContactOrHours.length + ' · (h) map/antique ' + (a.map.missing ? 'missing' : a.map.noTowns ? 'no towns' : 'there'),
    'Next: ' + nextStep(a));
  return out;
}

/* ───────────── seed ───────────── */

/* A new facilities/<id> for an OpenStreetMap facility, shaped like the admin
   page's newFacility() (User/Admin/Frontend/JS/facilities.js): not published,
   every service null ("Not verified"), no HMB, no donor milk, never updated by
   an admin. lat/lon are numbers (the admin's pointOf and the mother's
   fromFirestore read them; the admin page adds a GeoPoint `location` when it
   saves a point, which the REST client here has no type for). */
function newFacility(f, osm, at) {
  const lat = Number.isFinite(f.lat) ? round6(f.lat) : null;
  const lon = Number.isFinite(f.lon) ? round6(f.lon) : null;
  const services = { milkBank: null };
  for (const key of SERVICE_KEYS) services[key] = null;
  const osmRef = f.osm && typeof f.osm === 'object'
    ? { type: f.osm.type || null, id: f.osm.id != null ? f.osm.id : null, url: f.osm.url || null }
    : null;
  return {
    id: f.id,
    name: f.name,
    kind: f.kind || null,
    kindLabel: f.kindLabel || KIND_LABEL[f.kind] || f.kind || null,
    lat,
    lon,
    municipality: f.municipality || null,
    province: f.province || (osm && osm.province) || PROVINCE,
    address: f.addressText || [f.municipality, PROVINCE].filter(Boolean).join(', '),
    contactNumber: text(f.phone) || null,
    smsNumber: null,
    email: text(f.email) || null,
    website: text(f.website) || null,
    operatingHours: text(f.openingHours) || null,
    operator: text(f.operator) || null,
    participating: false,
    infoOnly: false,
    services,
    donorMilkAvailability: null,
    milkStock: null,
    requirements: [],
    notes: null,
    photo: null,
    dataStatus: {
      hasProfile: false,
      sample: false,
      verified: false,
      updatedAt: null,
      updatedBy: null
    },
    osm: osmRef,
    mapUrl: lat !== null && lon !== null ? mapUrl(lat, lon) : null,
    directionsUrl: lat !== null && lon !== null ? directionsUrl(lat, lon) : null,
    source: 'osm',
    osmFetchedAt: (osm && osm.fetchedAt) || null,
    savedAt: at,
    adminUpdatedAt: at
  };
}

/* map/antique: Antique's towns (the admin's Facilities page offers them in the Town field) */
function newMap(osm, at) {
  const towns = (osm && Array.isArray(osm.municipalities) ? osm.municipalities : [])
    .filter((m) => m && text(m.name))
    .map((m) => ({
      name: text(m.name),
      center: m.center && Number.isFinite(Number(m.center.lat)) && Number.isFinite(Number(m.center.lon))
        ? { lat: Number(m.center.lat), lon: Number(m.center.lon) }
        : null
    }));
  return {
    province: (osm && osm.province) || PROVINCE,
    municipalities: towns,
    source: 'osm',
    osmFetchedAt: (osm && osm.fetchedAt) || null,
    savedAt: at
  };
}

/* What seed creates: { creates: [{ id, name, town, data }], existing: [id],
   aliased: [{ id, name, town, alias }], lookalikes: [{ id, name, town, docId }], map: data | null }
   existing: already in Firestore under its own id or an alsoMappedAs one (aliased);
   lookalikes: a facility there has the same name and town (not created: to check). */
function planSeed(docs, osm, mapDoc, at) {
  const matches = matchOsm(docs, osm);
  const creates = [];
  const existing = [];
  const aliased = [];
  const lookalikes = [];
  for (const f of osmFacilities(osm)) {
    if (!f || !f.id || !text(f.name)) continue;
    const m = matches.get(f.id);
    const item = { id: f.id, name: f.name, town: f.municipality || null };
    if (!m) creates.push(Object.assign(item, { data: newFacility(f, osm, at) }));
    else if (m.how === 'name') lookalikes.push(Object.assign(item, { docId: m.docId }));
    else {
      existing.push(f.id);
      if (m.how === 'alias') aliased.push(Object.assign(item, { alias: m.alias }));
    }
  }
  creates.sort(byName);
  aliased.sort(byName);
  lookalikes.sort(byName);
  return { creates, existing, aliased, lookalikes, map: mapDoc ? null : newMap(osm, at) };
}

// A document's fields, one a line (a long list one item a line)
function dataLines(data, indent) {
  const out = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 3) {
      out.push(indent + key + ': [');
      value.forEach((item, i) => out.push(indent + '  ' + shown(item) + (i < value.length - 1 ? ',' : '')));
      out.push(indent + ']');
    } else {
      out.push(indent + key + ': ' + shown(value));
    }
  }
  return out;
}

async function seed(args, ctx) {
  const { store, log, collection } = ctx;
  const docs = await store.listDocs(collection);
  const mapDoc = await store.getDoc(MAP_COLLECTION, MAP_ID);
  const plan = planSeed(docs, ctx.osm, mapDoc, ctx.at);

  log('Seed: ' + plural(plan.creates.length, 'facility', 'facilities') + ' to create in ' + collection + '/, ' +
    plan.existing.length + ' already there (never changed)' +
    (plan.lookalikes.length ? ', ' + plan.lookalikes.length + ' like one already there (not created)' : '') +
    '; map/antique ' + (plan.map ? 'to create' : 'already there') + '.');
  for (const s of plan.aliased) {
    log('= ' + collection + '/' + s.id + '  ' + s.name + (s.town ? ' (' + s.town + ')' : '') + ': already in Firestore as ' + s.alias + ' (not created)');
  }
  for (const s of plan.lookalikes) {
    log('? ' + collection + '/' + s.id + '  ' + s.name + (s.town ? ' (' + s.town + ')' : '') + ': looks like ' + s.docId +
      ' (same name and town), not created — check it');
  }
  if (!plan.creates.length && !plan.map) {
    log('Nothing to create.');
    return 0;
  }

  if (!args.apply) {
    for (const c of plan.creates) {
      log('');
      log('+ ' + collection + '/' + c.id + '  ' + c.name + (c.town ? ' (' + c.town + ')' : ''));
      dataLines(c.data, '    ').forEach((line) => log(line));
      log('    (only if it does not exist yet: { exists: false })');
    }
    if (plan.map) {
      log('');
      log('+ ' + MAP_COLLECTION + '/' + MAP_ID + '  Antique\'s towns (' + plan.map.municipalities.length + ')');
      dataLines(plan.map, '    ').forEach((line) => log(line));
      log('    (only if it does not exist yet: { exists: false })');
    }
    log('');
    log('Nothing was written (dry run). Add --apply to write.');
    return 0;
  }

  const done = { created: 0, skipped: 0, failed: 0 };
  const create = async (col, id, data, label) => {
    try {
      await store.setDoc(col, id, data, { exists: false });
      done.created++;
      log('Created ' + col + '/' + id + '  ' + label);
    } catch (err) {
      if (!err || !ONE_DOC_ERRORS.includes(err.code)) throw err;
      if (err.code === 'already-exists') {
        done.skipped++;
        log('Skipped ' + col + '/' + id + '  ' + label + ': already in Firestore (not changed)');
      } else {
        done.failed++;
        log('Failed  ' + col + '/' + id + '  ' + label + ': ' + err.message);
      }
    }
  };
  for (const c of plan.creates) await create(collection, c.id, c.data, c.name);
  if (plan.map) await create(MAP_COLLECTION, MAP_ID, plan.map, 'Antique\'s towns');
  log('Seed finished: ' + done.created + ' created, ' + done.skipped + ' skipped (already there), ' + done.failed + ' failed.');
  return done.failed ? 3 : 0;
}

/* ───────────── cleanup ───────────── */

const WHY_DONOR = 'not a verified HMB: mothers never see it';

/* What cleanup changes, per facility:
   [{ id, name, updateTime, changes: [{ field, from, to, why }], data, fields }]
   data: the new values nested ({ services: { milkStorage: null } }), fields: their
   paths ("services.milkStorage"), so only those are written.
   Also untickedLeft: facilities with old false values left alone (no --reset-unticked),
   and untickedRecent: facilities with false values last saved after the cutoff (always
   left alone; the Published switch and Update status also move the save date). */
function planCleanup(docs, options) {
  const o = options || {};
  const cutoff = o.before || PHASE2_CUTOFF;
  const plans = [];
  let untickedLeft = 0;
  let untickedRecent = 0;
  for (const doc of docs) {
    const changes = [];
    if (!isVerifiedHmb(doc)) {
      for (const field of ['donorMilkAvailability', 'milkStock']) {
        if (isSet(doc[field])) changes.push({ field, from: doc[field], to: null, why: WHY_DONOR });
      }
    }
    const before = savedBefore(doc, cutoff);
    const unticked = before ? notOffered(doc) : [];
    if (!before && notOffered(doc).length) untickedRecent++;
    if (unticked.length && !o.resetUnticked) untickedLeft++;
    if (o.resetUnticked) {
      const when = latestSave(doc) ? 'last saved ' + latestSave(doc) + ', before ' + cutoff : 'never saved by an admin';
      for (const key of unticked) {
        changes.push({ field: 'services.' + key, from: false, to: null, why: '"Not offered" ' + when + ': maybe an unticked box' });
      }
    }
    if (!changes.length) continue;
    plans.push({
      id: idOf(doc),
      name: text(doc.name) || '(no name)',
      town: text(doc.municipality) || null,
      updateTime: doc._updateTime || null,
      changes,
      data: nested(changes),
      fields: changes.map((c) => c.field)
    });
  }
  plans.sort(byName);
  return { cutoff, plans, untickedLeft, untickedRecent };
}

// One change as the dry run shows it, and --apply after writing it (note: instead of why)
function changeLine(c, note) {
  return '    ' + c.field + ': ' + shown(c.from) + ' → ' + shown(c.to) + '   ' + (note || c.why);
}

// [{ field: "services.milkStorage", to: null }] → { services: { milkStorage: null } }
function nested(changes) {
  const data = {};
  for (const c of changes) {
    const keys = c.field.split('.');
    let node = data;
    for (const key of keys.slice(0, -1)) node = node[key] = node[key] || {};
    node[keys[keys.length - 1]] = c.to;
  }
  return data;
}

async function cleanup(args, ctx) {
  const { store, log, collection } = ctx;
  const docs = await store.listDocs(collection);
  const { cutoff, plans, untickedLeft, untickedRecent } = planCleanup(docs, { resetUnticked: args.resetUnticked, before: args.before });

  log('Cleanup: ' + plural(plans.length, 'facility', 'facilities') + ' to correct' +
    (args.resetUnticked ? ' (--reset-unticked: false values last saved before ' + cutoff + ')' : '') + '.');
  if (untickedLeft) {
    log(plural(untickedLeft, 'facility has', 'facilities have') + ' "Not offered" services saved before ' + cutoff +
      '; add --reset-unticked to make them "Not verified".');
  }
  if (untickedRecent) {
    log('Left alone: ' + plural(untickedRecent, 'facility', 'facilities') + ' with "Not offered" services last saved after ' + cutoff +
      ' (the Published switch and Update status also move the save date: check them in Edit, see report (d2), or use a later --before).');
  }
  if (!plans.length) {
    log('Nothing to clean up.');
    return 0;
  }

  if (!args.apply) {
    for (const p of plans) {
      log('');
      log('~ ' + collection + '/' + p.id + '  ' + p.name + (p.town ? ' (' + p.town + ')' : ''));
      for (const c of p.changes) log(changeLine(c));
      log('    (only these fields, and only if unchanged since read: { updateTime: ' + shown(p.updateTime) + ' })');
    }
    log('');
    log('Nothing was written (dry run). Add --apply to write.');
    return 0;
  }

  // Each facility's fields are printed as written (or not written), for the record
  const done = { updated: 0, failed: 0 };
  for (const p of plans) {
    const label = collection + '/' + p.id + '  ' + p.name;
    if (!p.updateTime) {
      done.failed++;
      log('Failed  ' + label + ': Firestore gave no version (updateTime) to check against; not written.');
      for (const c of p.changes) log(changeLine(c, '(not written)'));
      continue;
    }
    try {
      await store.setDoc(collection, p.id, p.data, { updateTime: p.updateTime }, p.fields);
      done.updated++;
      log('Updated ' + label + ': ' + p.fields.join(', ') + ' → null');
      for (const c of p.changes) log(changeLine(c));
    } catch (err) {
      if (!err || !ONE_DOC_ERRORS.includes(err.code)) throw err;
      done.failed++;
      const why = err.code === 'failed-precondition'
        ? 'it changed since it was read (someone saved it meanwhile), so nothing was written to it. Run cleanup again to see it as it is now.'
        : err.code === 'not-found' ? 'it is no longer in Firestore.' : err.message;
      log('Failed  ' + label + ': ' + why);
      const note = err.code === 'failed-precondition' ? '(not written: changed since it was read)' : '(not written)';
      for (const c of p.changes) log(changeLine(c, note));
    }
  }
  log('Cleanup finished: ' + done.updated + ' updated, ' + done.failed + ' failed.');
  return done.failed ? 3 : 0;
}

/* ───────────── report ───────────── */

async function report(args, ctx) {
  const { store, log, collection } = ctx;
  const docs = await store.listDocs(collection);
  const mapDoc = await store.getDoc(MAP_COLLECTION, MAP_ID);
  const a = analyze(docs, ctx.osm, mapDoc);
  formatReport(a, { at: ctx.at, collection, osmFetchedAt: ctx.osm.fetchedAt || null }).forEach((line) => log(line));
  return 0;
}

/* ───────────── run ───────────── */

/* Runs one command. Resolves with the exit code; prints through deps.log / deps.error. */
async function run(argv, deps) {
  const d = deps || {};
  const log = d.log || ((line) => console.log(line));
  const error = d.error || log;
  const now = d.now ? d.now() : new Date();
  const at = now instanceof Date ? now : new Date(now);

  let args;
  try {
    args = parseArgs(argv, at);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    error(err.message);
    USAGE.split('\n').forEach((line) => error(line));
    return 1;
  }
  if (args.help) {
    USAGE.split('\n').forEach((line) => log(line));
    return 0;
  }

  const missing = d.config ? missingSettings(d.config) : [];
  if (missing.length) {
    error(settingsLine(missing));
    return 2;
  }

  try {
    const ctx = {
      store: d.store,
      osm: loadOsm(d.osm),
      at,
      log,
      collection: d.collection || COLLECTION
    };
    if (args.command === 'seed') return await seed(args, ctx);
    if (args.command === 'cleanup') return await cleanup(args, ctx);
    return await report(args, ctx);
  } catch (err) {
    if (err && err.code === 'config') {
      error(settingsLine(SETTINGS.map(([name]) => name)));
      return 2;
    }
    error('Stopped: ' + (err && err.message ? err.message : String(err)));
    return 3;
  }
}

module.exports = {
  PHASE2_CUTOFF, SERVICE_KEYS, COMMANDS, USAGE, UsageError,
  hmbState, isVerifiedHmb, serviceState, savedBefore, latestSave, missingSettings, settingsLine,
  osmIdOfUrl, matchOsm, parseArgs, analyze, formatReport, newFacility, newMap, planSeed, planCleanup, nested, run
};

if (require.main === module) {
  const config = require('../src/config'); // reads User/Admin/Backend/.env
  const osmFile = path.join(process.env.MOWMMA_DB_DIR || path.join(config.PROJECT_ROOT, 'User', 'Mother', 'Backend', 'data'), 'osm-facilities.json');
  run(process.argv.slice(2), {
    store: require('../src/firestore'),
    osm: () => {
      try {
        return JSON.parse(fs.readFileSync(osmFile, 'utf8'));
      } catch (err) {
        throw new Error("Can't read " + osmFile + ' (' + (err.code || err.message) + '). Run node scripts/refresh-osm.js in User/Mother/Backend.');
      }
    },
    now: () => new Date(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    config,
    collection: config.FACILITIES_COLLECTION
  }).then((code) => { process.exitCode = code; }, (err) => {
    console.error('Stopped: ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 3;
  });
}
