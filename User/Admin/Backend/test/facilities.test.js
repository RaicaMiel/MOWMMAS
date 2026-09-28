'use strict';
/* scripts/facilities.js without Firebase: an in-memory store that behaves like
   src/firestore.js (preconditions, update masks with dotted paths, updateTime).
   Run: npm test   (or node --test test/) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tool = require('../scripts/facilities');

const NOW = new Date('2026-09-29T02:00:00.000Z');
const BEFORE_CUTOFF = '2026-09-20T09:00:00.000Z';
const AFTER_CUTOFF = '2026-09-28T15:00:00.000Z';   // 23:00 in Manila, after 22:47:36

/* ───────────── an in-memory Firestore ───────────── */

function firestoreError(code, message) {
  const err = new Error(message);
  err.name = 'FirebaseError';
  err.code = code;
  return err;
}

function getPath(object, path) {
  let node = object;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object' || !(key in node)) return { found: false };
    node = node[key];
  }
  return { found: true, value: node };
}

function setPath(object, path, value) {
  const keys = path.split('.');
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function deletePath(object, path) {
  const keys = path.split('.');
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') return;
    node = node[key];
  }
  delete node[keys[keys.length - 1]];
}

function fakeStore(initial) {
  const docs = new Map(); // 'collection/id' → { data, updateTime }
  let clock = 0;
  const version = () => new Date(Date.UTC(2026, 8, 28, 0, 0, ++clock)).toISOString().replace('Z', '123456Z');
  const store = {
    writes: [],
    reads: 0,
    afterList: null,
    put(collection, id, data) {
      docs.set(collection + '/' + id, { data: structuredClone(data), updateTime: version() });
    },
    data(collection, id) {
      const hit = docs.get(collection + '/' + id);
      return hit ? structuredClone(hit.data) : null;
    },
    updateTime(collection, id) {
      const hit = docs.get(collection + '/' + id);
      return hit ? hit.updateTime : null;
    },
    // An admin saving the facility in the browser meanwhile
    touch(collection, id, changes) {
      const hit = docs.get(collection + '/' + id);
      Object.assign(hit.data, changes || {});
      hit.updateTime = version();
    },
    ids(collection) {
      return [...docs.keys()].filter((k) => k.startsWith(collection + '/')).map((k) => k.slice(collection.length + 1)).sort();
    },
    async listDocs(collection) {
      store.reads++;
      const out = [];
      for (const [key, hit] of docs) {
        if (!key.startsWith(collection + '/')) continue;
        out.push(Object.assign(structuredClone(hit.data), { _id: key.slice(collection.length + 1), _updateTime: hit.updateTime }));
      }
      if (store.afterList) store.afterList();
      return out;
    },
    async getDoc(collection, id) {
      store.reads++;
      const hit = docs.get(collection + '/' + id);
      return hit ? Object.assign(structuredClone(hit.data), { _id: id, _updateTime: hit.updateTime }) : null;
    },
    async setDoc(collection, id, data, precondition, onlyFields) {
      store.writes.push({ collection, id, data: structuredClone(data), precondition, onlyFields });
      const key = collection + '/' + id;
      const hit = docs.get(key);
      if (precondition && precondition.exists === false && hit) throw firestoreError('already-exists', 'That document already exists in Firestore.');
      if (precondition && precondition.exists === true && !hit) throw firestoreError('not-found', 'Not found in Firestore.');
      if (precondition && precondition.updateTime && (!hit || hit.updateTime !== precondition.updateTime)) {
        throw firestoreError('failed-precondition', 'Firestore refused the change: the document changed meanwhile.');
      }
      if (onlyFields) {
        // Like Firestore's updateMask: each path takes its value from data; a path missing from data is deleted
        const target = hit ? hit.data : {};
        for (const path of onlyFields) {
          const v = getPath(data, path);
          if (v.found) setPath(target, path, structuredClone(v.value));
          else deletePath(target, path);
        }
        docs.set(key, { data: target, updateTime: version() });
      } else {
        docs.set(key, { data: structuredClone(data), updateTime: version() });
      }
      return { id, updateTime: docs.get(key).updateTime };
    }
  };
  for (const [path, data] of Object.entries(initial || {})) {
    const [collection, id] = path.split('/');
    store.put(collection, id, data);
  }
  return store;
}

/* ───────────── sample data ───────────── */

const OSM = {
  fetchedAt: '2026-09-23T23:51:02.958Z',
  province: 'Antique',
  municipalities: [
    { name: 'Anini-y', center: { lat: 10.431129, lon: 121.926053 } },
    { name: 'Bugasong', center: { lat: 11.04, lon: 122.07 } },
    { name: 'San Jose de Buenavista', center: { lat: 10.75, lon: 121.94 } }
  ],
  facilities: [
    {
      id: 'osm-w1', osm: { type: 'way', id: 1, url: 'https://www.openstreetmap.org/way/1' },
      // also mapped as a node (like osm-w290801272 in osm-facilities.json)
      alsoMappedAs: ['https://www.openstreetmap.org/node/13142018020'],
      name: 'Angel Salazar Memorial General Hospital', kind: 'hospital', kindLabel: 'Hospital',
      lat: 10.75374, lon: 121.942424, municipality: 'San Jose de Buenavista', province: 'Antique',
      addressText: 'Tobias Fornier St., San Jose de Buenavista, Antique',
      phone: '+6336 5407133', email: 'amsgh.email@gmail.com', website: null, openingHours: null, operator: 'Province of Antique'
    },
    {
      id: 'osm-w2', osm: { type: 'way', id: 2, url: 'https://www.openstreetmap.org/way/2' },
      name: 'Anini-y Polyclinic', kind: 'health_center', kindLabel: 'Rural health unit / primary care',
      lat: 10.4321234567, lon: 121.9, municipality: 'Anini-y', province: 'Antique',
      addressText: 'Anini-y, Antique', phone: null, email: null, website: null, openingHours: 'Mo-Fr 08:00-17:00', operator: null
    },
    {
      id: 'osm-n3', osm: { type: 'node', id: 3, url: 'https://www.openstreetmap.org/node/3' },
      name: 'Bugasong Medicare Community Hospital', kind: 'hospital', kindLabel: 'Hospital',
      lat: 11.04, lon: 122.07, municipality: 'Bugasong', province: 'Antique',
      addressText: 'Antique-Aklan Road, Brgy. Ilaures, Bugasong, Antique', phone: null, email: null, website: null, openingHours: null, operator: null
    }
  ]
};

const allServices = (value) => ({ lactationServices: value, milkReferral: value, milkStorage: value, acceptsDonations: value, providesDonorMilk: value });

// A facility as the admin page saves it
function facility(id, name, extra) {
  return Object.assign({
    id,
    name,
    kind: 'hospital',
    kindLabel: 'Hospital',
    lat: 10.7,
    lon: 121.9,
    municipality: 'San Jose de Buenavista',
    province: 'Antique',
    address: 'San Jose de Buenavista, Antique',
    contactNumber: '036 540 0000',
    smsNumber: null,
    email: null,
    website: null,
    operatingHours: 'Open 24 hours',
    participating: false,
    services: Object.assign({ milkBank: false }, allServices(null)),
    donorMilkAvailability: null,
    milkStock: null,
    requirements: [],
    notes: null,
    dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: AFTER_CUTOFF, updatedBy: 'admin@example.com' },
    source: 'admin'
  }, extra || {});
}

async function runTool(argv, store, extra) {
  const out = [];
  const err = [];
  const code = await tool.run(argv, Object.assign({
    store,
    osm: OSM,
    now: () => NOW,
    log: (line) => out.push(line),
    error: (line) => err.push(line)
  }, extra || {}));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/* ───────────── seed ───────────── */

test('seed without --apply is a dry run: prints what it would create, writes nothing', async () => {
  const store = fakeStore({ 'facilities/osm-w1': facility('osm-w1', 'Angel Salazar Memorial General Hospital') });
  const r = await runTool(['seed'], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  assert.match(r.out, /Seed: 2 facilities to create in facilities\/, 1 already there/);
  assert.match(r.out, /\+ facilities\/osm-w2 {2}Anini-y Polyclinic \(Anini-y\)/);
  assert.match(r.out, /\+ facilities\/osm-n3 /);
  assert.doesNotMatch(r.out, /\+ facilities\/osm-w1/);
  assert.match(r.out, /participating: false/);
  assert.match(r.out, /\+ map\/antique/);
  assert.match(r.out, /\(only if it does not exist yet: \{ exists: false \}\)/);
  assert.match(r.out, /Nothing was written \(dry run\)\. Add --apply to write\.$/);
});

test('seed --apply creates only the missing facilities, shaped like the admin page, and map/antique', async () => {
  const existing = facility('osm-w1', 'Angel Salazar (edited by an admin)', { participating: true, services: Object.assign({ milkBank: false }, allServices(true)) });
  const store = fakeStore({ 'facilities/osm-w1': existing });
  const r = await runTool(['seed', '--apply'], store);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(store.ids('facilities'), ['osm-n3', 'osm-w1', 'osm-w2']);
  assert.deepEqual(store.data('facilities', 'osm-w1'), existing, 'an existing facility is never changed');
  assert.ok(store.writes.every((w) => w.precondition && w.precondition.exists === false && !w.onlyFields), 'every write only creates');
  assert.deepEqual(store.writes.map((w) => w.collection + '/' + w.id), ['facilities/osm-w2', 'facilities/osm-n3', 'map/antique']);
  assert.match(r.out, /Created facilities\/osm-w2/);
  assert.match(r.out, /Seed finished: 3 created, 0 skipped \(already there\), 0 failed\./);

  const doc = store.data('facilities', 'osm-w2');
  assert.deepEqual(doc, {
    id: 'osm-w2',
    name: 'Anini-y Polyclinic',
    kind: 'health_center',
    kindLabel: 'Rural health unit / primary care',
    lat: 10.432123,
    lon: 121.9,
    municipality: 'Anini-y',
    province: 'Antique',
    address: 'Anini-y, Antique',
    contactNumber: null,
    smsNumber: null,
    email: null,
    website: null,
    operatingHours: 'Mo-Fr 08:00-17:00',
    operator: null,
    participating: false,
    infoOnly: false,
    services: { milkBank: null, lactationServices: null, milkReferral: null, milkStorage: null, acceptsDonations: null, providesDonorMilk: null },
    donorMilkAvailability: null,
    milkStock: null,
    requirements: [],
    notes: null,
    photo: null,
    dataStatus: { hasProfile: false, sample: false, verified: false, updatedAt: null, updatedBy: null },
    osm: { type: 'way', id: 2, url: 'https://www.openstreetmap.org/way/2' },
    mapUrl: 'https://www.openstreetmap.org/?mlat=10.432123&mlon=121.9#map=17/10.432123/121.9',
    directionsUrl: 'https://www.openstreetmap.org/directions?route=%3B10.432123%2C121.9#map=15/10.432123/121.9',
    source: 'osm',
    osmFetchedAt: OSM.fetchedAt,
    savedAt: NOW,
    adminUpdatedAt: NOW
  });
  assert.equal(store.data('facilities', 'osm-n3').address, 'Antique-Aklan Road, Brgy. Ilaures, Bugasong, Antique');

  const map = store.data('map', 'antique');
  assert.deepEqual(map.municipalities, OSM.municipalities.map((m) => ({ name: m.name, center: m.center })));
  assert.equal(map.province, 'Antique');
});

test('seed uses the OpenStreetMap phone as the contact number', () => {
  const doc = tool.newFacility(OSM.facilities[0], OSM, NOW);
  assert.equal(doc.contactNumber, '+6336 5407133');
  assert.equal(doc.operatingHours, null);
  assert.equal(doc.operator, 'Province of Antique');
  assert.equal(doc.email, 'amsgh.email@gmail.com');
  assert.equal(typeof doc.lat, 'number');
  assert.equal(typeof doc.lon, 'number');
});

test('seed leaves an existing map/antique alone and has nothing to do when all are there', async () => {
  const map = { municipalities: [{ name: 'Custom town', center: null }] };
  const store = fakeStore({
    'facilities/osm-w1': facility('osm-w1', 'A'),
    'facilities/osm-w2': facility('osm-w2', 'B'),
    'facilities/osm-n3': facility('osm-n3', 'C'),
    'map/antique': map
  });
  const r = await runTool(['seed', '--apply'], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.data('map', 'antique'), map);
  assert.match(r.out, /Nothing to create\./);
});

test('seed never overwrites: a facility created meanwhile is skipped and kept as it is', async () => {
  const store = fakeStore({ 'map/antique': { municipalities: [] } });
  const createdMeanwhile = facility('osm-w2', 'Saved by an admin a moment ago', { participating: true });
  store.afterList = () => { store.afterList = null; store.put('facilities', 'osm-w2', createdMeanwhile); };
  const r = await runTool(['seed', '--apply'], store);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(store.data('facilities', 'osm-w2'), createdMeanwhile);
  assert.match(r.out, /Skipped facilities\/osm-w2 {2}Anini-y Polyclinic: already in Firestore \(not changed\)/);
  assert.match(r.out, /Seed finished: 2 created, 1 skipped \(already there\), 0 failed\./);
});

test('osmIdOfUrl: an OpenStreetMap link → the id in osm-facilities.json', () => {
  assert.equal(tool.osmIdOfUrl('https://www.openstreetmap.org/node/13142018020'), 'osm-n13142018020');
  assert.equal(tool.osmIdOfUrl('https://www.openstreetmap.org/way/290801272'), 'osm-w290801272');
  assert.equal(tool.osmIdOfUrl('https://www.openstreetmap.org/relation/5'), 'osm-r5');
  assert.equal(tool.osmIdOfUrl('https://example.com/node/1'), null);
  assert.equal(tool.osmIdOfUrl(null), null);
});

test('seed never duplicates: a facility in Firestore under an alsoMappedAs id (osm-n13142018020) is not created again', async () => {
  const existing = facility('osm-n13142018020', 'Angel Salazar Hospital (the node)', { participating: true });
  const store = fakeStore({ 'facilities/osm-n13142018020': existing, 'map/antique': { municipalities: [] } });
  const dry = await runTool(['seed'], store);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Seed: 2 facilities to create in facilities\/, 1 already there \(never changed\); map\/antique already there\./);
  assert.match(dry.out, /= facilities\/osm-w1 {2}Angel Salazar Memorial General Hospital \(San Jose de Buenavista\): already in Firestore as osm-n13142018020 \(not created\)/);
  assert.doesNotMatch(dry.out, /\+ facilities\/osm-w1/);
  assert.equal(store.writes.length, 0);

  const r = await runTool(['seed', '--apply'], store);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already in Firestore as osm-n13142018020/);
  assert.deepEqual(store.writes.map((w) => w.id), ['osm-w2', 'osm-n3']);
  assert.deepEqual(store.ids('facilities'), ['osm-n13142018020', 'osm-n3', 'osm-w2']);
  assert.deepEqual(store.data('facilities', 'osm-n13142018020'), existing, 'never changed');
});

test('seed never duplicates: a facility with the same name and town (adm-…) is not created, only reported', async () => {
  const lookalike = facility('adm-7', 'ANINI-Y  polyclinic', { municipality: 'anini-y' });
  const otherTown = facility('adm-8', 'Bugasong Medicare Community Hospital', { municipality: 'San Jose de Buenavista' });
  const store = fakeStore({ 'facilities/adm-7': lookalike, 'facilities/adm-8': otherTown, 'map/antique': { municipalities: [] } });
  const r = await runTool(['seed', '--apply'], store);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Seed: 2 facilities to create in facilities\/, 0 already there \(never changed\), 1 like one already there \(not created\);/);
  assert.match(r.out, /\? facilities\/osm-w2 {2}Anini-y Polyclinic \(Anini-y\): looks like adm-7 \(same name and town\), not created — check it/);
  assert.deepEqual(store.writes.map((w) => w.id), ['osm-w1', 'osm-n3'], 'the same name in another town is another facility');
  assert.deepEqual(store.data('facilities', 'adm-7'), lookalike);
  assert.match(r.out, /Seed finished: 2 created, 0 skipped \(already there\), 0 failed\./);
});

/* ───────────── cleanup ───────────── */

function cleanupStore() {
  return fakeStore({
    // not an HMB, with donor milk: cleared
    'facilities/osm-w1': facility('osm-w1', 'Alpha Hospital', {
      donorMilkAvailability: 'available',
      milkStock: { bottles: 4, volumeMl: 400 },
      participating: true,
      services: Object.assign({ milkBank: false }, allServices(null), { milkStorage: false, lactationServices: true }),
      dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: BEFORE_CUTOFF, updatedBy: 'admin@example.com' }
    }),
    // HMB not verified, with donor milk: cleared
    'facilities/osm-w2': facility('osm-w2', 'Bravo Hospital', {
      donorMilkAvailability: 'limited',
      services: Object.assign({ milkBank: true }, allServices(null)),
      dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: AFTER_CUTOFF, updatedBy: 'admin@example.com' }
    }),
    // verified HMB: its donor milk stays
    'facilities/osm-n3': facility('osm-n3', 'Charlie Milk Bank', {
      donorMilkAvailability: 'available',
      milkStock: { bottles: 10, volumeMl: 1000 },
      participating: true,
      services: Object.assign({ milkBank: true }, allServices(true), { acceptsDonations: false }),
      dataStatus: { hasProfile: true, sample: false, verified: true, updatedAt: BEFORE_CUTOFF, updatedBy: 'admin@example.com' }
    }),
    // false saved after the cutoff: a real "Not offered", kept
    'facilities/adm-4': facility('adm-4', 'Delta Clinic', {
      services: Object.assign({ milkBank: false }, allServices(false)),
      dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: AFTER_CUTOFF, updatedBy: 'admin@example.com' }
    }),
    // never saved by an admin, with old false values
    'facilities/adm-5': facility('adm-5', 'Echo Health Center', {
      services: Object.assign({ milkBank: false }, allServices(null), { milkReferral: false, providesDonorMilk: false }),
      dataStatus: { hasProfile: false, sample: false, verified: false, updatedAt: null, updatedBy: null }
    })
  });
}

test('cleanup without --apply is a dry run and prints each change', async () => {
  const store = cleanupStore();
  const r = await runTool(['cleanup'], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  assert.match(r.out, /Cleanup: 2 facilities to correct\./);
  assert.match(r.out, /~ facilities\/osm-w1 {2}Alpha Hospital/);
  assert.match(r.out, /donorMilkAvailability: "available" → null {3}not a verified HMB: mothers never see it/);
  assert.match(r.out, /milkStock: \{"bottles":4,"volumeMl":400\} → null/);
  assert.match(r.out, /3 facilities have "Not offered" services saved before 2026-09-28T22:47:36\+08:00; add --reset-unticked/);
  assert.doesNotMatch(r.out, /services\./, 'no service change without --reset-unticked');
  assert.match(r.out, /Nothing was written \(dry run\)\. Add --apply to write\.$/);
});

test('cleanup --apply clears donor milk only where it is not a verified HMB, with updateTime and only those fields', async () => {
  const store = cleanupStore();
  const before = {
    w1: store.data('facilities', 'osm-w1'),
    w2: store.data('facilities', 'osm-w2'),
    n3: store.data('facilities', 'osm-n3'),
    t1: store.updateTime('facilities', 'osm-w1'),
    t2: store.updateTime('facilities', 'osm-w2')
  };
  const r = await runTool(['cleanup', '--apply'], store);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(store.writes.map((w) => [w.id, w.onlyFields, w.precondition]), [
    ['osm-w1', ['donorMilkAvailability', 'milkStock'], { updateTime: before.t1 }],
    ['osm-w2', ['donorMilkAvailability'], { updateTime: before.t2 }]
  ]);
  assert.deepEqual(store.data('facilities', 'osm-w1'), Object.assign({}, before.w1, { donorMilkAvailability: null, milkStock: null }));
  assert.deepEqual(store.data('facilities', 'osm-w2'), Object.assign({}, before.w2, { donorMilkAvailability: null }));
  assert.deepEqual(store.data('facilities', 'osm-n3'), before.n3, 'a verified HMB keeps its donor milk');
  assert.equal(store.data('facilities', 'osm-w1').services.milkStorage, false, 'false stays without --reset-unticked');
  assert.match(r.out, /Cleanup finished: 2 updated, 0 failed\./);
});

test('cleanup --reset-unticked --apply: only false values saved before the cutoff, never true, dotted paths', async () => {
  const store = cleanupStore();
  const before = {
    w1: store.data('facilities', 'osm-w1'),
    n3: store.data('facilities', 'osm-n3'),
    d4: store.data('facilities', 'adm-4'),
    e5: store.data('facilities', 'adm-5')
  };
  const r = await runTool(['cleanup', '--reset-unticked', '--apply'], store);
  assert.equal(r.code, 0, r.out);

  const w1 = store.data('facilities', 'osm-w1');
  assert.equal(w1.services.milkStorage, null);
  assert.equal(w1.services.lactationServices, true, 'true is never changed');
  assert.equal(w1.services.milkBank, false, 'HMB is never changed');
  assert.equal(w1.participating, true);
  assert.equal(w1.contactNumber, before.w1.contactNumber);
  assert.deepEqual(w1.dataStatus, before.w1.dataStatus, 'dataStatus.updatedAt is not touched');

  const n3 = store.data('facilities', 'osm-n3');
  assert.equal(n3.services.acceptsDonations, null, 'a verified HMB saved before the cutoff: its old false is reset');
  assert.deepEqual(Object.assign({}, n3, { services: before.n3.services }), before.n3, 'nothing else on it changes');
  assert.deepEqual(store.data('facilities', 'adm-4'), before.d4, 'saved after the cutoff: untouched');
  assert.deepEqual(store.data('facilities', 'adm-5').services, Object.assign({}, before.e5.services, { milkReferral: null, providesDonorMilk: null }));

  const w1Write = store.writes.find((w) => w.id === 'osm-w1');
  assert.deepEqual(w1Write.onlyFields, ['donorMilkAvailability', 'milkStock', 'services.milkStorage']);
  assert.deepEqual(w1Write.data, { donorMilkAvailability: null, milkStock: null, services: { milkStorage: null } });
  assert.deepEqual(store.writes.find((w) => w.id === 'adm-5').onlyFields, ['services.milkReferral', 'services.providesDonorMilk']);
  assert.ok(!store.writes.some((w) => w.id === 'adm-4'));
  assert.ok(store.writes.every((w) => w.precondition && w.precondition.updateTime));
});

test('cleanup --before moves the cutoff', async () => {
  // later than the cutoff, still before now (NOW is 10:00 in Manila)
  const later = await runTool(['cleanup', '--reset-unticked', '--before=2026-09-29T09:30:00+08:00', '--apply'], cleanupStore());
  assert.equal(later.code, 0);
  assert.match(later.out, /Updated facilities\/adm-4 {2}Delta Clinic: services\.lactationServices, services\.milkReferral, services\.milkStorage, services\.acceptsDonations, services\.providesDonorMilk → null/);

  const store = cleanupStore();
  const earlier = await runTool(['cleanup', '--reset-unticked', '--before=2026-09-01T00:00:00Z', '--apply'], store);
  assert.equal(earlier.code, 0);
  assert.equal(store.data('facilities', 'osm-w1').services.milkStorage, false, 'saved after an earlier cutoff: kept');
  assert.equal(store.data('facilities', 'adm-5').services.milkReferral, null, 'never saved: counts as before any cutoff');
});

test('cleanup: a facility saved meanwhile fails safely, is reported, and the others are still written', async () => {
  const store = cleanupStore();
  store.afterList = () => { store.afterList = null; store.touch('facilities', 'osm-w1', { notes: 'Saved by an admin meanwhile' }); };
  const r = await runTool(['cleanup', '--apply'], store);
  assert.equal(r.code, 3);
  const w1 = store.data('facilities', 'osm-w1');
  assert.equal(w1.donorMilkAvailability, 'available', 'not written over the newer version');
  assert.equal(w1.notes, 'Saved by an admin meanwhile');
  assert.equal(store.data('facilities', 'osm-w2').donorMilkAvailability, null, 'the next facility is still cleaned');
  assert.match(r.out, /Failed {2}facilities\/osm-w1 {2}Alpha Hospital: it changed since it was read/);
  assert.match(r.out, /Cleanup finished: 1 updated, 1 failed\./);
});

test('cleanup --apply prints each written field (old → new), and marks those not written', async () => {
  const r = await runTool(['cleanup', '--apply'], cleanupStore());
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('"available" → null'));
  assert.match(r.out, /Updated facilities\/osm-w1 {2}Alpha Hospital: donorMilkAvailability, milkStock → null\n {4}donorMilkAvailability: "available" → null {3}not a verified HMB: mothers never see it\n {4}milkStock: \{"bottles":4,"volumeMl":400\} → null {3}not a verified HMB/);
  assert.match(r.out, /Updated facilities\/osm-w2 {2}Bravo Hospital: donorMilkAvailability → null\n {4}donorMilkAvailability: "limited" → null {3}not a verified HMB/);

  const store = cleanupStore();
  store.afterList = () => { store.afterList = null; store.touch('facilities', 'osm-w1', { notes: 'Saved by an admin meanwhile' }); };
  const failed = await runTool(['cleanup', '--reset-unticked', '--apply'], store);
  assert.equal(failed.code, 3);
  assert.match(failed.out, new RegExp('Failed {2}facilities/osm-w1 {2}Alpha Hospital: it changed since it was read[^\\n]*\\n' +
    ' {4}donorMilkAvailability: "available" → null {3}\\(not written: changed since it was read\\)\\n' +
    ' {4}milkStock: \\{"bottles":4,"volumeMl":400\\} → null {3}\\(not written: changed since it was read\\)\\n' +
    ' {4}services\\.milkStorage: false → null {3}\\(not written: changed since it was read\\)\\n'));
  assert.match(failed.out, /Updated facilities\/adm-5 {2}Echo Health Center: services\.milkReferral, services\.providesDonorMilk → null\n {4}services\.milkReferral: false → null {3}"Not offered" never saved by an admin: maybe an unticked box/);
});

test('cutoff by both clocks: "Not offered" saved before by the browser but after by Firestore is left alone', async () => {
  const both = facility('adm-6', 'Foxtrot Clinic', {
    services: Object.assign({ milkBank: false }, allServices(null), { milkStorage: false }),
    dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: BEFORE_CUTOFF, updatedBy: 'admin@example.com' },
    adminUpdatedAt: AFTER_CUTOFF
  });
  const store = fakeStore({ 'facilities/adm-6': both, 'map/antique': { municipalities: [] } });
  const r = await runTool(['cleanup', '--reset-unticked', '--apply'], store);
  assert.equal(r.code, 0, r.out);
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.data('facilities', 'adm-6'), both, 'untouched');
  assert.match(r.out, /Left alone: 1 facility with "Not offered" services last saved after 2026-09-28T22:47:36\+08:00/);
  assert.match(r.out, /Nothing to clean up\./);

  const rep = await runTool(['report'], store);
  assert.match(rep.out, /\(d\) [^\n]*: 0\n {4}none\n/, 'not in (d)');
  assert.match(rep.out, /\(d2\) [^\n]*: 1\n {4}adm-6 {2}Foxtrot Clinic: services\.milkStorage \(last saved 2026-09-28T15:00:00\.000Z\)\n/);
});

test('cleanup with nothing to do', async () => {
  const store = fakeStore({ 'facilities/a': facility('a', 'Fine Hospital') });
  const r = await runTool(['cleanup', '--reset-unticked', '--apply'], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  assert.match(r.out, /Nothing to clean up\./);
});

/* ───────────── report ───────────── */

function reportStore() {
  return fakeStore({
    // (c) donor milk without a verified HMB, (e) documented but not published, (g) no contact, no hours
    'facilities/osm-w1': facility('osm-w1', 'Angel Salazar Memorial General Hospital', {
      contactNumber: null, operatingHours: null, donorMilkAvailability: 'available',
      services: Object.assign({ milkBank: false }, allServices(null), { lactationServices: true })
    }),
    // (d) false saved before the cutoff, (f) published with nothing documented
    'facilities/osm-w2': facility('osm-w2', 'Anini-y Polyclinic', {
      participating: true,
      services: Object.assign({ milkBank: false }, allServices(null), { milkStorage: false }),
      dataStatus: { hasProfile: true, sample: false, verified: false, updatedAt: BEFORE_CUTOFF, updatedBy: 'admin@example.com' }
    }),
    // (b) admin-added; a verified HMB with donor milk is fine
    'facilities/adm-x': facility('adm-x', 'Provincial Milk Bank', {
      participating: true, donorMilkAvailability: 'limited',
      services: Object.assign({ milkBank: true }, allServices(null), { providesDonorMilk: true }),
      dataStatus: { hasProfile: true, sample: false, verified: true, updatedAt: AFTER_CUTOFF, updatedBy: 'admin@example.com' }
    })
    // (a) osm-n3 missing; (h) no map/antique
  });
}

test('report lists every facility and flags (a)–(h), writing nothing', async () => {
  const store = reportStore();
  const r = await runTool([], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  const o = r.out;
  assert.match(o, /Facilities in Firestore: 3/);
  assert.match(o, /osm-w1 {2}Angel Salazar Memorial General Hospital {2}\[OpenStreetMap\]/);
  assert.match(o, /Town: San Jose de Buenavista · Published: no · HMB: no confirmed HMB/);
  assert.match(o, /Services: Lactation: yes · Info & referral: not verified · Storage: not verified · Donations: not verified · Donor milk: not verified/);
  assert.match(o, /Donor milk availability: "available" · Contact number: no \(OpenStreetMap has one\) · Operating hours: no · Updated: 2026-09-28T15:00:00.000Z/);
  assert.match(o, /adm-x {2}Provincial Milk Bank {2}\[admin-added\]/);
  assert.match(o, /HMB: verified/);
  assert.match(o, /Storage: not offered/);
  assert.match(o, /\(a\) OpenStreetMap facilities missing from Firestore[^\n]*: 1\n {4}osm-n3 {2}Bugasong Medicare Community Hospital \(Bugasong\)/);
  assert.match(o, /\(b\) In Firestore, not on OpenStreetMap[^\n]*: 1\n {4}adm-x {2}Provincial Milk Bank\n/);
  assert.match(o, /\(c\) [^\n]*: 1\n {4}osm-w1 {2}Angel Salazar Memorial General Hospital \(HMB: no confirmed HMB\): donorMilkAvailability "available"\n/);
  assert.match(o, /\(d\) [^\n]*: 1\n {4}osm-w2 {2}Anini-y Polyclinic: services\.milkStorage \(last saved 2026-09-20T09:00:00.000Z\)/);
  assert.match(o, /\(e\) [^\n]*: 1\n {4}osm-w1 {2}Angel Salazar Memorial General Hospital: Lactation\n/);
  assert.match(o, /\(f\) [^\n]*: 1\n {4}osm-w2 {2}Anini-y Polyclinic\n/);
  assert.match(o, /\(g\) [^\n]*: 1\n {4}osm-w1 {2}Angel Salazar Memorial General Hospital: no contact number \(OpenStreetMap has one\), no operating hours\n/);
  assert.match(o, /\(h\) map\/antique[^\n]*: missing \(seed creates it\)/);
  assert.match(o, /Published: 2 · Verified HMBs: 1/);
  assert.match(o, /Next: npm run facilities -- seed/);
});

test('analyze returns the flagged lists', () => {
  const docs = [
    Object.assign(facility('osm-w1', 'One', { participating: true }), { _id: 'osm-w1' }),
    Object.assign(facility('osm-w2', 'Two', { milkStock: { bottles: 1, volumeMl: 100 }, services: Object.assign({ milkBank: true }, allServices(null)) }), { _id: 'osm-w2' }),
    Object.assign(facility('osm-n3', 'Three', { smsNumber: '09171234567', contactNumber: null, operatingHours: '' }), { _id: 'osm-n3' })
  ];
  const a = tool.analyze(docs, OSM, { municipalities: [] });
  assert.deepEqual(a.missing, []);
  assert.deepEqual(a.adminAdded, []);
  assert.deepEqual(a.hiddenDonorMilk.map((f) => [f.id, f.hmb]), [['osm-w2', 'not_verified']]);
  assert.deepEqual(a.publishedNoService.map((f) => f.id), ['osm-w1']);
  assert.deepEqual(a.missingContactOrHours.map((f) => [f.id, f.contact, f.hours]), [['osm-n3', true, false]], 'a mobile number counts as a contact number');
  assert.deepEqual(a.map, { missing: false, noTowns: true });
});

test('report suggests cleanup once everything is in Firestore', async () => {
  const store = reportStore();
  store.put('facilities', 'osm-n3', facility('osm-n3', 'Bugasong Medicare Community Hospital'));
  store.put('map', 'antique', { municipalities: [{ name: 'Anini-y', center: null }] });
  const r = await runTool(['report'], store);
  assert.match(r.out, /Next: npm run facilities -- cleanup --reset-unticked/);
});

test('report (d2): "Not offered" last saved after the cutoff has its own section and count; cleanup says how many it left alone', async () => {
  const store = cleanupStore();
  const r = await runTool(['report'], store);
  assert.equal(r.code, 0);
  assert.equal(store.writes.length, 0);
  assert.ok(r.out.includes('\n(d2) "Not offered" last saved after the cutoff — the Published switch and Update status also move the save date, ' +
    'so some may still be old unticked boxes. Check each in Edit, or rerun cleanup --reset-unticked with a later --before. Facilities: 1\n'));
  assert.match(r.out, /\(d2\) [^\n]*: 1\n {4}adm-4 {2}Delta Clinic: services\.lactationServices, services\.milkReferral, services\.milkStorage, services\.acceptsDonations, services\.providesDonorMilk \(last saved 2026-09-28T15:00:00\.000Z\)\n/);
  assert.match(r.out, /\(d\) [^\n]*: 3\n/);
  assert.match(r.out, /\(d\) old "Not offered" 3 · \(d2\) "Not offered" saved after the cutoff 1 · /);

  for (const argv of [['cleanup'], ['cleanup', '--reset-unticked']]) {
    const c = await runTool(argv, store);
    assert.match(c.out, /Left alone: 1 facility with "Not offered" services last saved after 2026-09-28T22:47:36\+08:00 \(the Published switch and Update status also move the save date/, argv.join(' '));
  }
  const later = await runTool(['cleanup', '--reset-unticked', '--before=2026-09-29T09:30:00+08:00'], store);
  assert.doesNotMatch(later.out, /Left alone/, 'a later --before takes them in');
});

test('report: an old "Yes" is marked in (e), published ones are listed in (e2), and the values are never changed', async () => {
  const saved = (updatedAt) => ({ hasProfile: true, sample: false, verified: false, updatedAt, updatedBy: 'admin@example.com' });
  const yes = (keys) => Object.assign({ milkBank: false }, allServices(null), Object.fromEntries(keys.map((k) => [k, true])));
  const store = fakeStore({
    // not published, "Yes" from before the cutoff: marked
    'facilities/adm-11': facility('adm-11', 'Golf Hospital', { services: yes(['lactationServices']), dataStatus: saved(BEFORE_CUTOFF) }),
    // not published, "Yes" saved after the cutoff: not marked
    'facilities/adm-12': facility('adm-12', 'Hotel Clinic', { services: yes(['milkReferral']) }),
    // published, "Yes" from before the cutoff: (e2)
    'facilities/adm-13': facility('adm-13', 'India Hospital', { participating: true, services: yes(['milkStorage', 'acceptsDonations']), dataStatus: saved(BEFORE_CUTOFF) }),
    // published, before by the browser's clock, after by Firestore's: not (e2)
    'facilities/adm-14': facility('adm-14', 'Juliet Hospital', { participating: true, services: yes(['lactationServices']), dataStatus: saved(BEFORE_CUTOFF), adminUpdatedAt: AFTER_CUTOFF }),
    // published, never saved by an admin: (e2)
    'facilities/adm-15': facility('adm-15', 'Kilo Health Center', { participating: true, services: yes(['providesDonorMilk']), dataStatus: saved(null) })
  });
  const before = store.ids('facilities').map((id) => store.data('facilities', id));
  const r = await runTool(['report'], store);
  assert.equal(r.code, 0);
  assert.match(r.out, /\(e\) [^\n]*: 2\n {4}adm-11 {2}Golf Hospital: Lactation {2}\("Yes" last saved 2026-09-20T09:00:00\.000Z, before the three-option services: maybe an old tick — confirm a source before publishing\)\n {4}adm-12 {2}Hotel Clinic: Info & referral\n/);
  assert.match(r.out, /\n\(e2\) Published with "Yes — documented" only from before the cutoff — confirm a source: 2\n {4}adm-13 {2}India Hospital: Storage, Donations \(last saved 2026-09-20T09:00:00\.000Z\)\n {4}adm-15 {2}Kilo Health Center: Donor milk \(never saved by an admin\)\n/);
  assert.match(r.out, /\(e\) publish candidates 2 \(1 with an old "Yes"\) · \(e2\) published, "Yes" only from before the cutoff 2 · /);

  const a = tool.analyze(await store.listDocs('facilities'), { facilities: [] }, { municipalities: [{ name: 'Anini-y' }] });
  assert.deepEqual(a.publishedOldYes.map((f) => f.id), ['adm-13', 'adm-15']);
  const report = tool.formatReport(a, { at: NOW, collection: 'facilities' }).join('\n');
  assert.match(report, /Next: confirm a source for the "Yes — documented" services in \(e2\)/);

  const c = await runTool(['cleanup', '--reset-unticked', '--apply'], store);
  assert.equal(c.code, 0);
  assert.equal(store.writes.length, 0, 'a "Yes" is never changed');
  assert.deepEqual(store.ids('facilities').map((id) => store.data('facilities', id)), before);
});

test('report: a facility under an alsoMappedAs id, or with the same name and town, is the same facility: not admin-added, not missing', async () => {
  const store = fakeStore({
    'facilities/osm-n13142018020': facility('osm-n13142018020', 'Angel Salazar Memorial General Hospital'),
    'facilities/adm-7': facility('adm-7', 'Anini-y Polyclinic', { municipality: 'Anini-y' }),
    'facilities/adm-8': facility('adm-8', 'Provincial Milk Bank'),
    'map/antique': { municipalities: [{ name: 'Anini-y', center: null }] }
  });
  const r = await runTool(['report'], store);
  assert.equal(r.code, 0);
  const o = r.out;
  assert.match(o, /osm-n13142018020 {2}Angel Salazar Memorial General Hospital {2}\[same facility as osm-w1\]/);
  assert.match(o, /adm-7 {2}Anini-y Polyclinic {2}\[same facility as osm-w2\]/);
  assert.match(o, /adm-8 {2}Provincial Milk Bank {2}\[admin-added\]/);
  assert.match(o, /\(a\) [^\n]*: 1\n {4}osm-n3 {2}Bugasong Medicare Community Hospital \(Bugasong\)\n\n/, 'only osm-n3 is missing');
  assert.match(o, new RegExp('\\(b\\) [^\\n]*: 1\\n {4}adm-8 {2}Provincial Milk Bank \\(not published[^\\n]*\\n' +
    ' {4}Not admin-added: the same facility as an OpenStreetMap one[^\\n]*\\n' +
    ' {4}osm-n13142018020 {2}Angel Salazar Memorial General Hospital: same facility as osm-w1 \\(OpenStreetMap also maps it as osm-n13142018020\\)\\n' +
    ' {4}adm-7 {2}Anini-y Polyclinic: same facility as osm-w2 \\(same name and town — check it\\)\\n'));
  assert.match(o, /Firestore: 3 facilities \(2 from OpenStreetMap, 1 admin-added\)/);
  assert.match(o, /\(a\) missing 1 · \(b\) admin-added 1 \(\+ 2 same facility as an OpenStreetMap one\)/);
});

/* ───────────── command line ───────────── */

test('unknown command or bad flag: usage and exit code 1, nothing read', async () => {
  for (const argv of [['publish'], ['seed', '--force'], ['report', '--apply'], ['seed', '--reset-unticked'],
    ['cleanup', '--before=2026-09-28T22:47:36+08:00'], ['cleanup', '--reset-unticked', '--before=2026-09-28'],
    ['cleanup', '--reset-unticked', '--before=yesterday'], ['seed', 'cleanup']]) {
    const store = fakeStore();
    const r = await runTool(argv, store);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /Usage \(in User\/Admin\/Backend\):/, argv.join(' '));
    assert.equal(store.reads + store.writes.length, 0, argv.join(' '));
  }
});

test('--help prints the usage, exit code 0', async () => {
  const r = await runTool(['--help'], fakeStore());
  assert.equal(r.code, 0);
  assert.match(r.out, /npm run facilities -- seed \[--apply\]/);
});

test('missing Firebase settings: one line naming the .env file and the variables, exit code 2', async () => {
  const store = fakeStore();
  const r = await runTool(['report'], store, { config: { API_KEY: 'x', PROJECT_ID: '', ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: '' } });
  assert.equal(r.code, 2);
  assert.equal(r.err, 'Firebase settings missing or still the example value: set FIREBASE_PROJECT_ID and FIREBASE_ADMIN_PASSWORD in User/Admin/Backend/.env (copy .env.example there and fill it in).');
  assert.equal(store.reads, 0);
  assert.equal(r.out, '');
});

test('Firebase settings still the example values count as missing: exit code 2, Firestore never called', async () => {
  const store = fakeStore();
  const r = await runTool(['cleanup', '--apply'], store, {
    config: { API_KEY: 'your-firebase-web-api-key', PROJECT_ID: 'your-firebase-project-id', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'your-admin-password' }
  });
  assert.equal(r.code, 2);
  assert.equal(r.err, 'Firebase settings missing or still the example value: set FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_ADMIN_EMAIL and FIREBASE_ADMIN_PASSWORD in User/Admin/Backend/.env (copy .env.example there and fill it in).');
  assert.equal(store.reads + store.writes.length, 0);
  assert.equal(r.out, '');

  const real = { API_KEY: 'AIzaSyReal', PROJECT_ID: 'mowmmas-1', ADMIN_EMAIL: 'admin@mowmmas.ph', ADMIN_PASSWORD: 's3cret' };
  assert.deepEqual(tool.missingSettings(real), []);
  assert.deepEqual(tool.missingSettings(Object.assign({}, real, { ADMIN_EMAIL: 'Nurse@Example.com' })), ['FIREBASE_ADMIN_EMAIL'], 'any @example.com address');
  assert.deepEqual(tool.missingSettings(Object.assign({}, real, { PROJECT_ID: ' your-firebase-project-id ' })), ['FIREBASE_PROJECT_ID']);
});

test('.env.example leaves the four Firebase settings empty, with the hint in the comment above each', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').split(/\r?\n/);
  const values = {};
  for (const name of ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_ADMIN_EMAIL', 'FIREBASE_ADMIN_PASSWORD']) {
    const i = lines.findIndex((line) => line.startsWith(name + '='));
    assert.ok(i > 0, name + ' is in .env.example');
    assert.equal(lines[i], name + '=', name + ' is empty');
    assert.match(lines[i - 1], /^# \S/, name + ' has a hint above it');
    values[name] = lines[i].slice(name.length + 1);
  }
  assert.doesNotMatch(lines.join('\n'), /your-firebase|your-admin-password|admin@example\.com/);
  const config = { API_KEY: values.FIREBASE_API_KEY, PROJECT_ID: values.FIREBASE_PROJECT_ID, ADMIN_EMAIL: values.FIREBASE_ADMIN_EMAIL, ADMIN_PASSWORD: values.FIREBASE_ADMIN_PASSWORD };
  assert.equal(tool.missingSettings(config).length, 4, 'a copied, unfilled .env stops at exit code 2');
});

test('--before in the future is refused: exit code 1 with usage, nothing read', async () => {
  for (const argv of [['cleanup', '--reset-unticked', '--before=2026-09-29T11:00:00+08:00'],
    ['cleanup', '--reset-unticked', '--apply', '--before=2027-01-01T00:00:00Z']]) {
    const store = cleanupStore();
    const r = await runTool(argv, store);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /^--before is in the future: every "Not offered" would be reset\.\nUsage \(in User\/Admin\/Backend\):/, argv.join(' '));
    assert.equal(store.reads + store.writes.length, 0, argv.join(' '));
    assert.equal(r.out, '');
  }
  const argv = ['cleanup', '--reset-unticked', '--before=2026-09-29T02:00:00.001Z'];
  assert.throws(() => tool.parseArgs(argv, NOW), /--before is in the future/);
  assert.doesNotThrow(() => tool.parseArgs(['cleanup', '--reset-unticked', '--before=2026-09-29T10:00:00+08:00'], NOW), 'now itself is fine');
});

test('a settings error from the Firestore client also gives exit code 2, without a stack trace', async () => {
  const store = fakeStore();
  store.listDocs = async () => { throw firestoreError('config', 'Set FIREBASE_PROJECT_ID in User/Admin/Backend/.env.'); };
  const r = await runTool(['seed'], store);
  assert.equal(r.code, 2);
  assert.equal(r.err.split('\n').length, 1);
  assert.match(r.err, /FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_ADMIN_EMAIL and FIREBASE_ADMIN_PASSWORD in User\/Admin\/Backend\/\.env/);
});

test('other Firestore errors stop with exit code 3 and a one-line message', async () => {
  const store = fakeStore();
  store.listDocs = async () => { throw firestoreError('permission-denied', 'Firestore refused. Publish the rules.'); };
  const r = await runTool(['cleanup'], store);
  assert.equal(r.code, 3);
  assert.equal(r.err, 'Stopped: Firestore refused. Publish the rules.');
});

test('parseArgs', () => {
  assert.deepEqual(tool.parseArgs([]), { command: 'report', apply: false, resetUnticked: false, before: null, help: false });
  assert.deepEqual(tool.parseArgs(['--apply', 'cleanup', '--reset-unticked', '--before=2026-09-28T14:47:36Z']),
    { command: 'cleanup', apply: true, resetUnticked: true, before: '2026-09-28T14:47:36Z', help: false });
  assert.throws(() => tool.parseArgs(['seed', '--before=2026-09-28T14:47:36Z']), tool.UsageError);
});

test('savedBefore: missing counts as before, an unreadable date as after', () => {
  const at = (updatedAt) => ({ dataStatus: { updatedAt } });
  assert.equal(tool.savedBefore({}, tool.PHASE2_CUTOFF), true);
  assert.equal(tool.savedBefore(at('2026-09-28T14:47:35.999Z'), tool.PHASE2_CUTOFF), true);
  assert.equal(tool.savedBefore(at('2026-09-28T14:47:36.000Z'), tool.PHASE2_CUTOFF), false);
  assert.equal(tool.savedBefore(at('not a date'), tool.PHASE2_CUTOFF), false);
});

test('savedBefore uses both clocks: dataStatus.updatedAt (browser) and adminUpdatedAt (Firestore)', () => {
  const C = tool.PHASE2_CUTOFF;
  const doc = (updatedAt, adminUpdatedAt) => ({ dataStatus: { updatedAt }, adminUpdatedAt });
  assert.equal(tool.savedBefore(doc(BEFORE_CUTOFF, AFTER_CUTOFF), C), false, 'the browser clock may be behind');
  assert.equal(tool.savedBefore(doc(AFTER_CUTOFF, BEFORE_CUTOFF), C), false);
  assert.equal(tool.savedBefore(doc(BEFORE_CUTOFF, BEFORE_CUTOFF), C), true);
  assert.equal(tool.savedBefore(doc(null, BEFORE_CUTOFF), C), true);
  assert.equal(tool.savedBefore(doc(null, AFTER_CUTOFF), C), false);
  assert.equal(tool.savedBefore(doc(null, new Date(AFTER_CUTOFF)), C), false, 'a Date counts as well');
  assert.equal(tool.savedBefore(doc(BEFORE_CUTOFF, 'not a date'), C), false, 'unreadable: left alone');
  assert.equal(tool.savedBefore(doc(null, null), C), true, 'never saved by an admin');
  assert.equal(tool.latestSave(doc(BEFORE_CUTOFF, AFTER_CUTOFF)), AFTER_CUTOFF);
  assert.equal(tool.latestSave(doc(null, null)), null);
});
