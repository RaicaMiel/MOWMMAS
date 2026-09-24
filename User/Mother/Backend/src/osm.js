'use strict';
/* ══════════════════════════════════════════════════════════════════
   OpenStreetMap integration — health facilities in the Province of Antique

   Where the data comes from
   ─────────────────────────
   OpenStreetMap is queried through the Overpass API for every hospital,
   clinic, rural health unit, primary care facility and birthing facility
   inside the Antique provincial boundary. Each facility is then placed in
   its municipality using the official municipal boundaries (also from OSM).

   What OSM does NOT know
   ──────────────────────
   OSM tells us where facilities are, not whether they have a milk bank,
   store milk, accept donations or give donor milk. Those details live in
   facility-profiles.json and are kept up to date by the
   facilities themselves. See facilities.js for how the two are combined.

   Results are cached in data/osm-facilities.json and refreshed once a
   day, so the website keeps working when Overpass is slow or offline.
   Data © OpenStreetMap contributors, available under the ODbL.
   ══════════════════════════════════════════════════════════════════ */
const config = require('./config');
const store = require('./store');

const AREA = `area["name"="${config.PROVINCE}"]["boundary"="administrative"]["admin_level"="4"]->.province;`;

// Facility types relevant to breastfeeding and breast-milk services
const FACILITY_QUERY = `[out:json][timeout:90];
${AREA}
(
  nwr["amenity"~"^(hospital|clinic)$"](area.province);
  nwr["healthcare"~"^(hospital|clinic|birthing_center|centre|midwife)$"](area.province);
);
out center tags;`;

// The 18 municipalities of Antique, with boundary geometry
const MUNICIPALITY_QUERY = `[out:json][timeout:120];
${AREA}
rel["boundary"="administrative"]["admin_level"="6"](area.province);
out geom qt;`;

/* ───────────────────────── Overpass client ───────────────────────── */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function overpass(query, { attempts = 4, timeoutMs = 100000 } = {}) {
  const errors = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const endpoint of config.OVERPASS_ENDPOINTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'User-Agent': config.USER_AGENT,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'data=' + encodeURIComponent(query),
          signal: controller.signal
        });
        const text = await res.text();
        // Busy servers answer 429/504 with an HTML page — move on to the next one
        if (!res.ok || text.trimStart()[0] !== '{') {
          throw new Error(`HTTP ${res.status}`);
        }
        return JSON.parse(text);
      } catch (err) {
        errors.push(`${new URL(endpoint).host}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    await wait([3000, 8000, 15000][attempt] || 15000);
  }
  throw new Error('OpenStreetMap (Overpass) is unreachable right now: ' + errors.slice(-3).join('; '));
}

/* ───────────────────────── Municipalities ───────────────────────── */

function parseMunicipalities(json) {
  return (json.elements || [])
    .filter((el) => el.type === 'relation' && el.tags && el.tags.name)
    .map((rel) => {
      const lines = [];
      let centre = null;
      for (const m of rel.members || []) {
        if (m.type === 'way' && Array.isArray(m.geometry) && (m.role === 'outer' || m.role === 'inner' || m.role === '')) {
          lines.push(m.geometry.map((p) => [p.lat, p.lon]));
        }
        if (m.type === 'node' && (m.role === 'admin_centre' || m.role === 'label') && m.lat != null) {
          centre = centre && centre.role === 'admin_centre' ? centre : { lat: m.lat, lon: m.lon, role: m.role };
        }
      }
      const b = rel.bounds;
      const center = centre
        ? { lat: centre.lat, lon: centre.lon }
        : b ? { lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2 } : null;
      return { name: rel.tags.name, osmId: rel.id, center, lines };
    });
}

/* Even–odd ray casting over every boundary segment.
   The ways of a boundary join into closed rings, so counting crossings over
   consecutive points of each way is correct without assembling the rings. */
function containsPoint(muni, lat, lon) {
  let inside = false;
  for (const line of muni.lines) {
    for (let i = 1; i < line.length; i++) {
      const [aLat, aLon] = line[i - 1];
      const [bLat, bLon] = line[i];
      if ((aLat > lat) !== (bLat > lat)) {
        const crossLon = aLon + ((lat - aLat) / (bLat - aLat)) * (bLon - aLon);
        if (lon < crossLon) inside = !inside;
      }
    }
  }
  return inside;
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function locateMunicipality(munis, lat, lon) {
  const hit = munis.find((m) => containsPoint(m, lat, lon));
  if (hit) return { name: hit.name, matched: 'boundary' };
  // On a boundary line or just offshore: fall back to the nearest town centre
  let best = null;
  for (const m of munis) {
    if (!m.center) continue;
    const d = distanceKm(lat, lon, m.center.lat, m.center.lon);
    if (!best || d < best.d) best = { name: m.name, d };
  }
  return best ? { name: best.name, matched: 'nearest' } : { name: null, matched: 'none' };
}

/* ───────────────────────── Facilities ───────────────────────── */

const KIND_LABEL = {
  hospital: 'Hospital',
  health_center: 'Rural health unit / primary care',
  birthing: 'Birthing / lying-in facility',
  clinic: 'Clinic'
};

function classify(tags) {
  const name = tags.name || '';
  if (/birthing|lying[\s-]?in|maternity/i.test(name) || tags.healthcare === 'birthing_center' || tags.healthcare === 'midwife') {
    return 'birthing';
  }
  if (/rural health|\bRHU\b|primary (health )?care|health (center|centre|office|unit)|polyclinic/i.test(name) || tags.healthcare === 'centre') {
    return 'health_center';
  }
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'hospital';
  return 'clinic';
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);

function normalise(el, munis) {
  const tags = el.tags || {};
  const lat = el.lat != null ? el.lat : el.center && el.center.lat;
  const lon = el.lon != null ? el.lon : el.center && el.center.lon;
  if (!clean(tags.name) || lat == null || lon == null) return null;

  const located = locateMunicipality(munis, lat, lon);
  // The official boundary wins; the typed-in address is only a fallback
  // (it is often written as "Town, Antique" or misspelled)
  const typed = (clean(tags['addr:city']) || clean(tags['addr:municipality']) || '')
    .replace(new RegExp(`,?\\s*${config.PROVINCE}$`, 'i'), '').trim() || null;
  const municipality = located.matched === 'boundary' ? located.name : typed || located.name;
  let streetName = clean(tags['addr:street']);
  // A street named after a town ("Tobias Fornier") reads like that town — say it is a street
  if (streetName && !/\b(st|street|road|rd|ave|avenue|highway|hwy|blvd|boulevard|drive|dr|lane|ln|extension|ext)\b\.?/i.test(streetName) &&
      munis.some((m) => m.name.toLowerCase() === streetName.toLowerCase())) {
    streetName += ' St.';
  }
  const street = [clean(tags['addr:housenumber']), streetName].filter(Boolean).join(' ') || null;
  const barangay = clean(tags['addr:suburb']) || clean(tags['addr:village']) || clean(tags['addr:hamlet']) || clean(tags['addr:neighbourhood']);
  const kind = classify(tags);

  return {
    id: `osm-${el.type[0]}${el.id}`,
    osm: { type: el.type, id: el.id, url: `https://www.openstreetmap.org/${el.type}/${el.id}` },
    name: clean(tags.name),
    kind,
    kindLabel: KIND_LABEL[kind],
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    municipality,
    municipalityMatch: located.matched,
    province: config.PROVINCE,
    address: {
      street,
      barangay,
      municipality,
      province: config.PROVINCE,
      postcode: clean(tags['addr:postcode'])
    },
    addressText: [street, barangay && `Brgy. ${barangay}`, municipality, config.PROVINCE].filter(Boolean).join(', '),
    phone: clean(tags.phone) || clean(tags['contact:phone']),
    email: clean(tags.email) || clean(tags['contact:email']),
    website: clean(tags.website) || clean(tags['contact:website']),
    openingHours: clean(tags.opening_hours),
    operator: clean(tags.operator),
    operatorType: clean(tags['operator:type']),
    emergency: clean(tags.emergency)
  };
}

const nameKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/* The same hospital is sometimes mapped twice (a point and a building outline).
   Merge entries with the same name less than 300 m apart, keeping the richer one. */
function dedupe(list) {
  const out = [];
  for (const fac of list) {
    const twin = out.find((o) => nameKey(o.name) === nameKey(fac.name) &&
      distanceKm(o.lat, o.lon, fac.lat, fac.lon) < 0.3);
    if (!twin) { out.push(fac); continue; }
    const score = (f) => Object.values(f).filter((v) => v != null).length + (f.osm.type === 'node' ? 0 : 1);
    const [keep, drop] = score(fac) > score(twin) ? [fac, twin] : [twin, fac];
    for (const key of ['phone', 'email', 'website', 'openingHours', 'operator', 'operatorType', 'emergency']) {
      if (keep[key] == null && drop[key] != null) keep[key] = drop[key];
    }
    keep.alsoMappedAs = [...(keep.alsoMappedAs || []), drop.osm.url];
    out[out.indexOf(twin)] = keep;
  }
  return out;
}

function build(facilityJson, municipalityJson) {
  const munis = parseMunicipalities(municipalityJson);
  const raw = facilityJson.elements || [];
  const named = raw.map((el) => normalise(el, munis)).filter(Boolean);
  const facilities = dedupe(named).sort((a, b) => a.name.localeCompare(b.name));
  return {
    fetchedAt: new Date().toISOString(),
    source: {
      name: 'OpenStreetMap',
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0',
      licenseUrl: 'https://www.openstreetmap.org/copyright',
      api: 'Overpass API'
    },
    province: config.PROVINCE,
    stats: { elements: raw.length, unnamedSkipped: raw.length - named.length, duplicatesMerged: named.length - facilities.length },
    municipalities: munis
      .map((m) => ({ name: m.name, center: m.center && { lat: Number(m.center.lat.toFixed(6)), lon: Number(m.center.lon.toFixed(6)) } }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    facilities
  };
}

/* ───────────────────────── Cache ───────────────────────── */

async function fetchFromOverpass() {
  const facilities = await overpass(FACILITY_QUERY);
  const municipalities = await overpass(MUNICIPALITY_QUERY);
  return build(facilities, municipalities);
}

let refreshing = null;

async function refresh() {
  if (!refreshing) {
    refreshing = fetchFromOverpass()
      .then((data) => { store.write('osm', data); return data; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

function isStale(cache) {
  return !cache || !cache.fetchedAt || Date.now() - Date.parse(cache.fetchedAt) > config.OSM_MAX_AGE_MS;
}

/* Returns the cached OSM data immediately. If it is older than a day, a
   refresh starts in the background; the next request gets the new data. */
function getCached() {
  const cache = store.read('osm', null);
  if (isStale(cache)) {
    refresh().catch((err) => console.warn('[osm] background refresh failed:', err.message));
  }
  return cache;
}

module.exports = { FACILITY_QUERY, MUNICIPALITY_QUERY, overpass, build, refresh, getCached, isStale, distanceKm, KIND_LABEL };
