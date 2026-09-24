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
      (data/firestore-facilities.json)     Facilities page (Firestore), copied here by the
                                          Admin backend's sync. Once that copy exists it
                                          replaces the local profiles (2): mothers see what
                                          the admin manages. A facility that isn't public
                                          shows only its basic facts; one the admin added
                                          (not on OpenStreetMap) shows only when public.

   A profile value always wins over OSM. Anything neither source knows is
   returned as null, and the website shows it as "Not reported yet" — it is
   never guessed. */
const osm = require('./osm');
const store = require('./store');

const SERVICE_KEYS = ['milkBank', 'milkStorage', 'acceptsDonations', 'providesDonorMilk', 'lactationServices'];
const AVAILABILITY = ['available', 'limited', 'none'];

const triState = (v) => (v === true || v === false ? v : null);

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
    participating: Boolean(profile && p.participating !== false),
    services,
    donorMilkAvailability: AVAILABILITY.includes(p.donorMilkAvailability) ? p.donorMilkAvailability : null,
    milkStock: p.milkStock && Number.isFinite(p.milkStock.bottles)
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
    participating: shared,
    services,
    donorMilkAvailability: shared && AVAILABILITY.includes(doc.donorMilkAvailability) ? doc.donorMilkAvailability : null,
    milkStock: shared && stock && Number.isFinite(stock.bottles) ? { bottles: stock.bottles, volumeMl: Number(stock.volumeMl) || 0 } : null,
    requirements: shared && Array.isArray(doc.requirements) ? doc.requirements.filter((r) => typeof r === 'string') : [],
    notes: shared ? value('notes') : null,
    photo: photoOf(photo),
    dataStatus: {
      hasProfile: shared,
      sample: false,
      verified: shared && Boolean(doc.dataStatus && doc.dataStatus.verified),
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

/* All facilities, participating ones first, then by name. */
function list() {
  const cache = osm.getCached();
  if (!cache) {
    const err = new Error('Facility data has not been downloaded from OpenStreetMap yet. Run: node scripts/refresh-osm.js');
    err.status = 503;
    throw err;
  }
  const photos = store.read('photos', {}).photos || {};
  const mirror = store.read('firestoreFacilities', null);
  const managed = mirror && mirror.facilities && typeof mirror.facilities === 'object' ? mirror.facilities : null;
  let facilities;
  if (managed) {
    // The admin's facilities (Firestore) are the source; OpenStreetMap fills any gaps.
    const seen = new Set();
    facilities = cache.facilities.map((f) => {
      seen.add(f.id);
      return managed[f.id] ? fromFirestore(f, managed[f.id], photos[f.id]) : merge(f, null, photos[f.id]);
    });
    for (const [id, doc] of Object.entries(managed)) {
      if (seen.has(id) || !doc || doc.participating !== true || !doc.name) continue;
      const added = fromFirestore(null, Object.assign({ id }, doc), photos[id]);
      if (typeof added.lat === 'number' && typeof added.lon === 'number') facilities.push(added);
    }
  } else {
    // No copy from Firestore yet (first start, or Firebase not set up): local profiles.
    const profiles = store.read('profiles', {});
    facilities = cache.facilities.map((f) => merge(f, profiles[f.id], photos[f.id]));
  }
  facilities.sort((a, b) => (b.participating - a.participating) || a.name.localeCompare(b.name));
  return { province: cache.province, source: source(cache), municipalities: cache.municipalities, facilities };
}

function get(id) {
  const data = list();
  const facility = data.facilities.find((f) => f.id === id) || null;
  return { facility, source: data.source };
}

module.exports = { SERVICE_KEYS, AVAILABILITY, merge, list, get };
