'use strict';
/* Combines the two sources of facility information:

   1. OpenStreetMap (osm.js)          → name, type, location, municipality,
                                         and any address / phone / hours mapped in OSM
   2. MOWMMAS facility profiles       → milk bank, milk storage, donations, donor milk,
      (data/facility-profiles.json)       lactation services, availability, stock,
                                         confirmed contact number and hours — kept up to
                                         date by the facilities' own health workers

   3. Facility photos                  → a real photo of the facility with its credit
      (data/facility-photos.json)         (Wikimedia Commons, or a file in data/photos/)

   4. The admin's facilities            → the facilities as managed on the admin
      (Firestore: facilities/<id>)         Facilities page, read from Firestore (see the
                                          end of this file). Once read they are the list
                                          mothers see: only the facilities in Firestore
                                          are shown (one removed there is gone from the
                                          map too), and OpenStreetMap only fills gaps.
                                          A facility that isn't public shows only its
                                          basic facts; one the admin added (not on
                                          OpenStreetMap) shows only when public.

   A profile value always wins over OSM. Anything neither source knows is
   returned as null, and the website shows it as "Not reported yet" — it is
   never guessed. Donor milk availability and stock are given only for a verified
   milk bank (HMB): MOWMMAS is not a milk bank, and any other facility's figures
   would read like an offer. */
const osm = require('./osm');
const store = require('./store');
const firestore = require('../../../Admin/Backend/src/firestore');
const adminConfig = require('../../../Admin/Backend/src/config');

// milkReferral: human milk-related information & referral
const SERVICE_KEYS = ['milkBank', 'milkStorage', 'acceptsDonations', 'providesDonorMilk', 'lactationServices', 'milkReferral'];
const AVAILABILITY = ['available', 'limited', 'none'];

const triState = (v) => (v === true || v === false ? v : null);

// A verified milk bank (HMB) in the public directory: the only kind whose donor milk is shown
const verifiedHmb = (shown, services, verified) => shown && services.milkBank === true && verified;

/* Only real photos of the facility itself, each with its credit. A local file
   (data/photos/NAME.jpg) is served by the API at photos/NAME.jpg; the website
   resolves that path against the API address. No photo → null (never a stand-in). */
function photoOf(entry) {
  if (!entry || (!entry.url && !entry.file)) return null;
  const url = entry.file ? 'photos/' + encodeURIComponent(entry.file) : entry.url;
  return {
    url,
    width: Number(entry.width) || null,
    height: Number(entry.height) || null,
    credit: {
      author: entry.author || null,
      license: entry.license || null,
      licenseUrl: entry.licenseUrl || null,
      source: entry.source || null,
      sourcePage: entry.sourcePage || null
    }
  };
}

function merge(base, profile, photo) {
  const p = profile || {};
  const lat = base.lat;
  const lon = base.lon;
  const services = {};
  for (const key of SERVICE_KEYS) services[key] = triState(p[key]);
  const participating = Boolean(profile && p.participating !== false);
  const hmb = verifiedHmb(participating, services, Boolean(p.verified));

  return {
    id: base.id,
    name: base.name,
    kind: base.kind,
    kindLabel: base.kindLabel,
    lat,
    lon,
    municipality: base.municipality,
    province: base.province,
    address: p.address || base.addressText,
    contactNumber: p.contactNumber || base.phone || null,
    smsNumber: p.smsNumber || null,
    email: base.email || null,
    website: base.website || null,
    operatingHours: p.operatingHours || base.openingHours || null,
    operator: base.operator || null,
    about: p.about || null,
    infoOnly: Boolean(p.infoOnly),
    participating,
    services,
    donorMilkAvailability: hmb && AVAILABILITY.includes(p.donorMilkAvailability) ? p.donorMilkAvailability : null,
    milkStock: hmb && p.milkStock && Number.isFinite(p.milkStock.bottles)
      ? { bottles: p.milkStock.bottles, volumeMl: Number(p.milkStock.volumeMl) || 0 }
      : null,
    requirements: Array.isArray(p.requirements) ? p.requirements : [],
    notes: p.notes || null,
    photo: photoOf(photo),
    dataStatus: {
      hasProfile: Boolean(profile),
      sample: Boolean(p.sample),
      verified: Boolean(p.verified),
      updatedAt: p.updatedAt || null,
      updatedBy: p.updatedBy || null
    },
    osm: base.osm,
    mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
    directionsUrl: `https://www.openstreetmap.org/directions?route=%3B${lat}%2C${lon}#map=15/${lat}/${lon}`
  };
}

/* A facility as the admin manages it in Firestore (see 4. above).
   base: the OpenStreetMap record, or null for a facility the admin added. */
function fromFirestore(base, doc, photo) {
  const b = base || {};
  const value = (key) => (doc[key] !== undefined && doc[key] !== null && doc[key] !== '' ? doc[key] : null);
  const loc = doc.location && typeof doc.location === 'object' ? doc.location : {};
  const lat = typeof doc.lat === 'number' ? doc.lat : typeof loc.lat === 'number' ? loc.lat : b.lat;
  const lon = typeof doc.lon === 'number' ? doc.lon : typeof loc.lon === 'number' ? loc.lon : b.lon;
  const shared = doc.participating === true;   // "Show in the public directory"
  const s = doc.services && typeof doc.services === 'object' ? doc.services : {};
  const services = {};
  for (const key of SERVICE_KEYS) services[key] = shared ? triState(s[key]) : null;
  const verified = shared && Boolean(doc.dataStatus && doc.dataStatus.verified);
  const hmb = verifiedHmb(shared, services, verified);
  const stock = doc.milkStock;
  return {
    id: doc.id || b.id,
    name: value('name') || b.name,
    kind: value('kind') || b.kind,
    kindLabel: value('kindLabel') || b.kindLabel,
    lat,
    lon,
    municipality: value('municipality') || b.municipality || null,
    province: value('province') || b.province || 'Antique',
    address: value('address') || b.addressText || null,
    contactNumber: value('contactNumber') || b.phone || null,
    smsNumber: shared ? value('smsNumber') : null,
    email: value('email') || b.email || null,
    website: value('website') || b.website || null,
    operatingHours: value('operatingHours') || b.openingHours || null,
    operator: value('operator') || b.operator || null,
    about: typeof doc.about === 'string' && doc.about.trim() ? doc.about.trim() : null,
    // Listed for information only (e.g. a diagnostic center): breastfeeding support is N/A
    // and mothers can't send it forms
    infoOnly: doc.infoOnly === true,
    participating: shared,
    services,
    donorMilkAvailability: hmb && AVAILABILITY.includes(doc.donorMilkAvailability) ? doc.donorMilkAvailability : null,
    milkStock: hmb && stock && Number.isFinite(stock.bottles) ? { bottles: stock.bottles, volumeMl: Number(stock.volumeMl) || 0 } : null,
    requirements: shared && Array.isArray(doc.requirements) ? doc.requirements.filter((r) => typeof r === 'string') : [],
    notes: shared ? value('notes') : null,
    photo: photoOf(photo),
    dataStatus: {
      hasProfile: shared,
      sample: false,
      verified,
      updatedAt: (doc.dataStatus && doc.dataStatus.updatedAt) || null,
      updatedBy: null   // the admin's email stays private
    },
    osm: b.osm || null,
    mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
    directionsUrl: `https://www.openstreetmap.org/directions?route=%3B${lat}%2C${lon}#map=15/${lat}/${lon}`
  };
}

function source(cache) {
  return Object.assign({}, cache.source, { fetchedAt: cache.fetchedAt });
}

function osmCache() {
  const cache = osm.getCached();
  if (!cache) {
    const err = new Error('Facility data has not been downloaded from OpenStreetMap yet. Run: node scripts/refresh-osm.js');
    err.status = 503;
    throw err;
  }
  return cache;
}

/* managed: the admin's facilities by id (see 4. above), or null when there are none to show.
   Participating ones first, then by name. */
function combine(cache, managed) {
  const photos = store.read('photos', {}).photos || {};
  let facilities;
  if (managed) {
    // The admin's facilities (Firestore) are the list; OpenStreetMap fills any gaps
    // of the ones that came from it. One the admin added shows only when public.
    const osmById = new Map(cache.facilities.map((f) => [f.id, f]));
    facilities = [];
    for (const [id, doc] of Object.entries(managed)) {
      if (!doc) continue;
      const base = osmById.get(id) || null;
      if (!base && (doc.participating !== true || !doc.name)) continue;
      const f = fromFirestore(base, Object.assign({ id }, doc), photos[id]);
      if (f.name && typeof f.lat === 'number' && typeof f.lon === 'number') facilities.push(f);
    }
  } else {
    // No copy from Firestore yet (first start, or Firebase not set up): local profiles.
    const profiles = store.read('profiles', {});
    facilities = cache.facilities.map((f) => merge(f, profiles[f.id], photos[f.id]));
  }
  facilities.sort((a, b) => (b.participating - a.participating) || a.name.localeCompare(b.name));
  return { province: cache.province, source: source(cache), municipalities: cache.municipalities, facilities };
}

/* ───────────── the admin's facilities, straight from Firestore ─────────────
   Read without signing in (public, like the map) at most once every LIVE_MS. If
   Firestore can't be read, the last copy read is used; with none yet, the
   OpenStreetMap facts only (like a first start). */
const LIVE_MS = 60 * 1000;
let live = null;      // { at, managed }: the last copy read
let reading = null;   // one read at a time
const readAll = () => firestore.listPublic(adminConfig.FACILITIES_COLLECTION);

function managedFacilities() {
  if (live && Date.now() - live.at < LIVE_MS) return Promise.resolve(live.managed);
  if (!reading) {
    reading = readAll()
      .then((docs) => {
        const managed = {};
        for (const doc of docs) {
          const id = doc.id || doc._id;
          if (!id) continue;
          const plain = Object.assign({}, doc, { id });
          delete plain._id;
          delete plain._updateTime;
          managed[id] = plain;
        }
        live = { at: Date.now(), managed };
        return managed;
      })
      .catch((err) => {
        console.warn('[facilities] Could not read the facilities from Firestore: ' + err.message);
        return live ? live.managed : null;
      })
      .finally(() => { reading = null; });
  }
  return reading;
}

/* All facilities, participating ones first, then by name */
async function list() {
  const cache = osmCache();
  return combine(cache, await managedFacilities());
}

async function get(id) {
  const data = await list();
  const facility = data.facilities.find((f) => f.id === id) || null;
  return { facility, source: data.source };
}

module.exports = { SERVICE_KEYS, AVAILABILITY, merge, list, get };
