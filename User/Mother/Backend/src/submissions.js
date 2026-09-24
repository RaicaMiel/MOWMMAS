'use strict';
/* Donations, requests and inquiries sent by mothers.

   validate(payload, facility)        checks a form exactly as described in
                                      the build contract (§5) and returns
                                      { value, fields } — `fields` is null when
                                      everything is fine, otherwise
                                      { fieldName: "friendly message" }
   prepare(payload), save(form)       checks a form, then saves it in Firestore
                                      (submissions/<ref>), giving it a reference
                                      like MOW-D-2026-00001; resolves with
                                      { summary, submission, again }
   create(payload)                    the two in one
   lookup(ref, mobile)                the mother's own view of one submission
                                      (null unless BOTH ref and mobile match)
   publicView(submission, notifications, facility?)
                                      what a mother may see: first name only,
                                      status history and messages (newest first)

   Field names in `fields` are the plain input names (name, mobile, age,
   preferredDate, willingToScreen, …). They never clash across the three forms. */
const cloud = require('./cloud');
const facilities = require('./facilities');
const adminSubmissions = require('../../../Admin/Backend/src/submissions');
const { TYPES, FINAL, statusLabel } = require('./statuses');
const { httpError } = require('./http');

// The 18 municipalities of Antique (used when the OSM cache has no list)
const ANTIQUE_MUNICIPALITIES = [
  'Anini-y', 'Barbaza', 'Belison', 'Bugasong', 'Caluya', 'Culasi', 'Hamtic', 'Laua-an', 'Libertad',
  'Pandan', 'Patnongon', 'San Jose de Buenavista', 'San Remigio', 'Sebaste', 'Sibalom', 'Tibiao',
  'Tobias Fornier', 'Valderrama'
];
// Common short forms people type
const MUNICIPALITY_ALIASES = { sanjose: 'San Jose de Buenavista', sjdb: 'San Jose de Buenavista', dao: 'Tobias Fornier' };

const DONATE = {
  babyAge: ['0-1m', '1-3m', '4-6m', '7-12m', '12m+'],
  preferredTime: ['morning', 'afternoon', 'any'],
  delivery: ['dropoff', 'pickup'],
  screening: ['healthy', 'nonSmoker', 'noMedication', 'noTransfusion', 'willingToScreen']
};
const REQUEST = {
  relationship: ['mother', 'father', 'guardian', 'health_worker'],
  babyAge: ['0-7d', '1-4w', '1-3m', '4-6m', '6m+'],
  reasons: ['preterm', 'low_birth_weight', 'low_supply', 'mother_ill', 'nicu', 'adoption', 'other'],
  admitted: ['no', 'yes', 'scheduled'],
  urgency: ['24h', 'week', 'planning'],
  hasReferral: ['yes', 'no', 'unsure']
};
const INQUIRE = {
  topic: ['availability', 'requirements', 'donating', 'requesting', 'lactation', 'other'],
  preferredContact: ['sms', 'call']
};

const MOBILE_HINT = 'Please enter a mobile number like 0917 123 4567';
const REF_PATTERN = /^MOW-([DRI])-(\d{4})-(\d{5,9})$/;

/* ───────────────────────── small helpers ───────────────────────── */

const isType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const length = (s) => Array.from(s).length;

/* Trimmed text. Single-line fields have all whitespace collapsed; multi-line
   fields keep their line breaks. Control characters are removed. Anything
   that is not a string or number counts as empty. */
function text(value, multiline) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  let s = value.normalize('NFC');
  if (multiline) {
    s = s.replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/[\u0000-\u001F\u007F\s]+/g, ' ');
  }
  return s.trim();
}

/* Philippine mobile numbers → 09XXXXXXXXX (accepts +639…, 639…, spaces and dashes) */
function normalizeMobile(value) {
  const s = text(value).replace(/[\s\-().]/g, '');
  if (/^09\d{9}$/.test(s)) return s;
  if (/^\+639\d{9}$/.test(s)) return '0' + s.slice(3);
  if (/^639\d{9}$/.test(s)) return '0' + s.slice(2);
  return null;
}

function normalizeRef(value) {
  const s = text(value).toUpperCase().replace(/\s+/g, '');
  return REF_PATTERN.test(s) ? s : null;
}

const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && ['true', 'yes', 'on', '1'].includes(v.trim().toLowerCase()));

/* The Philippines has no daylight saving time, so Manila is always UTC+8.
   "Today" and the reference-number year follow the mothers' clock, not the server's. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const manilaDate = (date, addDays = 0) =>
  new Date(date.getTime() + MANILA_OFFSET_MS + addDays * 86400000).toISOString().slice(0, 10);

function isRealDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const nameKey = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

function matchMunicipality(value, names) {
  const key = nameKey(value);
  if (!key) return null;
  const hit = names.find((n) => nameKey(n) === key);
  if (hit) return hit;
  const alias = Object.prototype.hasOwnProperty.call(MUNICIPALITY_ALIASES, key) ? MUNICIPALITY_ALIASES[key] : null;
  return alias && names.includes(alias) ? alias : null;
}

/* "Juana Dela Cruz" → "Juana";  "Ma. Cristina Reyes" → "Ma. Cristina" */
function firstName(fullName) {
  const parts = text(fullName).split(' ').filter(Boolean);
  if (!parts.length) return '';
  if (/^(ma|sta|sto)\.$/i.test(parts[0]) && parts[1]) return parts[0] + ' ' + parts[1];
  return parts[0];
}

/* ───────────────────────── validation ───────────────────────── */

function validate(payload, facility, municipalities) {
  const names = Array.isArray(municipalities) && municipalities.length ? municipalities : ANTIQUE_MUNICIPALITIES;
  const fields = {};
  const bad = (key, message) => { if (!fields[key]) fields[key] = message; };
  const p = isObject(payload) ? payload : {};

  /* Field checkers — each returns the cleaned value (or null) and records a message when invalid */
  const requiredText = (src, key, min, max, messages) => {
    const v = text(src[key], messages.multiline);
    if (!v) { bad(key, messages.missing); return null; }
    if (length(v) < min) { bad(key, messages.short || messages.missing); return null; }
    if (length(v) > max) { bad(key, messages.long); return null; }
    return v;
  };
  const optionalText = (src, key, max, message, multiline) => {
    const v = text(src[key], multiline);
    if (!v) return null;
    if (length(v) > max) { bad(key, message); return null; }
    return v;
  };
  const requiredChoice = (src, key, allowed, message) => {
    const v = text(src[key]);
    if (!allowed.includes(v)) { bad(key, message); return null; }
    return v;
  };
  const optionalChoice = (src, key, allowed, message) => {
    const v = text(src[key]);
    if (!v) return null;
    if (!allowed.includes(v)) { bad(key, message); return null; }
    return v;
  };

  /* What the mother wants to do */
  const type = text(p.type).toLowerCase();
  if (!isType(type)) bad('type', 'Please choose what you would like to do: donate breast milk, request breast milk, or ask a question.');

  /* Where */
  const facilityId = text(p.facilityId);
  if (!facilityId) {
    bad('facilityId', 'Please choose a health facility first.');
  } else if (!facility || facility.id !== facilityId) {
    bad('facilityId', "We couldn't find that health facility. Please go back and choose it again from the list.");
  } else if (type === 'donate' && facility.services && facility.services.acceptsDonations === false) {
    bad('facilityId', `${facility.name} does not accept breast milk donations. Please choose another facility, or send them a question instead.`);
  } else if (type === 'request' && facility.services && facility.services.providesDonorMilk === false) {
    bad('facilityId', `${facility.name} does not give out donor milk. Please choose another facility, or send them a question instead.`);
  }

  /* Who */
  const c = isObject(p.contact) ? p.contact : {};
  const name = requiredText(c, 'name', 2, 80, {
    missing: 'Please enter your name.',
    short: 'Please enter your name (at least 2 letters).',
    long: 'Please keep your name under 80 characters.'
  });
  let mobile = null;
  if (!text(c.mobile)) bad('mobile', 'Please enter your mobile number, like 0917 123 4567.');
  else if (!(mobile = normalizeMobile(c.mobile))) bad('mobile', MOBILE_HINT);

  let email = text(c.email) || null;
  if (email && (length(email) > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
    bad('email', 'Please enter a valid email address, like juana@example.com, or leave it blank.');
    email = null;
  }
  let municipality = null;
  if (!text(c.municipality)) bad('municipality', 'Please choose your municipality.');
  else if (!(municipality = matchMunicipality(text(c.municipality), names))) {
    bad('municipality', 'Please choose your municipality from the list of Antique municipalities.');
  }
  const barangay = optionalText(c, 'barangay', 80, 'Please keep the barangay name under 80 characters.');

  /* What they told us */
  const d = isObject(p.details) ? p.details : {};
  const notesTooLong = 'Please keep your notes under 1,000 characters.';
  let details = {};

  /* The checks below run in the order the fields appear on the form,
     so the first entry in `fields` is the first field to fix. */
  const ageField = () => {
    const raw = typeof d.age === 'string' ? d.age.trim() : d.age;
    if (raw == null || raw === '') { bad('age', 'Please enter your age.'); return null; }
    const age = typeof raw === 'number' ? raw : /^\d{1,3}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(age)) { bad('age', 'Please enter your age as a whole number, like 28.'); return null; }
    if (age < 18 || age > 55) {
      bad('age', 'Milk donors need to be between 18 and 55 years old. You can still send the facility a question.');
      return null;
    }
    return age;
  };
  const screeningField = () => {
    const input = isObject(d.screening) ? d.screening : {};
    const screening = {};
    for (const key of DONATE.screening) screening[key] = truthy(input[key]);
    if (!screening.willingToScreen) {
      bad('willingToScreen', 'To donate, please agree to a health screening at the facility. It keeps the babies who receive your milk safe.');
    }
    return screening;
  };
  const dateField = () => {
    const raw = text(d.preferredDate);
    const now = new Date();
    if (!raw) bad('preferredDate', 'Please choose the date you would like to come in.');
    else if (!isRealDate(raw)) bad('preferredDate', 'Please choose a real date, like 2026-10-05.');
    else if (raw < manilaDate(now)) bad('preferredDate', 'Please choose today or a later date.');
    else if (raw > manilaDate(now, 366)) bad('preferredDate', 'Please choose a date within the next 12 months.');
    else return raw;
    return null;
  };
  const reasonsField = () => {
    const raw = Array.isArray(d.reasons) ? d.reasons : d.reasons == null || d.reasons === '' ? [] : [d.reasons];
    const cleaned = [...new Set(raw.map((r) => text(r)).filter(Boolean))];
    if (!cleaned.length) bad('reasons', 'Please choose at least one reason why the baby needs donor milk.');
    else if (cleaned.some((r) => !REQUEST.reasons.includes(r))) bad('reasons', 'Please choose the reasons from the list.');
    else return cleaned;
    return null;
  };

  if (type === 'donate') {
    details = {
      age: ageField(),
      babyAge: requiredChoice(d, 'babyAge', DONATE.babyAge, "Please choose your baby's age."),
      screening: screeningField(),
      preferredDate: dateField(),
      preferredTime: optionalChoice(d, 'preferredTime', DONATE.preferredTime, 'Please choose morning, afternoon or any time.'),
      delivery: requiredChoice(d, 'delivery', DONATE.delivery, 'Please choose whether you will drop off the milk or need it picked up.'),
      estimatedVolume: optionalText(d, 'estimatedVolume', 80, 'Please keep the amount short (under 80 characters), like "about 500 ml".'),
      notes: optionalText(d, 'notes', 1000, notesTooLong, true)
    };
  } else if (type === 'request') {
    details = {
      relationship: requiredChoice(d, 'relationship', REQUEST.relationship, 'Please tell us who you are to the baby.'),
      babyName: requiredText(d, 'babyName', 1, 60, {
        missing: "Please enter the baby's name or initials.",
        long: "Please keep the baby's name under 60 characters."
      }),
      babyAge: requiredChoice(d, 'babyAge', REQUEST.babyAge, "Please choose the baby's age."),
      reasons: reasonsField(),
      admitted: optionalChoice(d, 'admitted', REQUEST.admitted, 'Please choose Yes, No or Scheduled.'),
      urgency: requiredChoice(d, 'urgency', REQUEST.urgency, 'Please tell us how soon the milk is needed.'),
      amountNeeded: optionalText(d, 'amountNeeded', 80, 'Please keep the amount short (under 80 characters), like "100 ml a day".'),
      hasReferral: optionalChoice(d, 'hasReferral', REQUEST.hasReferral, 'Please choose Yes, No or Not sure.'),
      notes: optionalText(d, 'notes', 1000, notesTooLong, true)
    };
  } else if (type === 'inquire') {
    details = {
      topic: requiredChoice(d, 'topic', INQUIRE.topic, 'Please choose what your question is about.'),
      question: requiredText(d, 'question', 10, 1000, {
        multiline: true,
        missing: 'Please write your question.',
        short: 'Please tell us a little more (at least 10 characters).',
        long: 'Please keep your question under 1,000 characters.'
      }),
      preferredContact: optionalChoice(d, 'preferredContact', INQUIRE.preferredContact, 'Please choose text message or phone call.')
    };
  }

  /* Agreement */
  if (p.consent !== true) {
    bad('consent', 'Please tick the box to agree that the facility may contact you about this.');
  }

  if (Object.keys(fields).length) return { value: null, fields };
  return {
    value: {
      type,
      facilityId,
      contact: { name, mobile, email, municipality, barangay },
      details,
      consent: true
    },
    fields: null
  };
}

/* ───────────────────────── create ───────────────────────── */

function summary(sub) {
  return {
    ref: sub.ref,
    type: sub.type,
    typeLabel: isType(sub.type) ? TYPES[sub.type].label : sub.type,
    status: sub.status,
    statusLabel: statusLabel(sub.status),
    facilityId: sub.facilityId,
    facilityName: sub.facilityName,
    createdAt: sub.createdAt
  };
}

const SAVE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Checks a form (400/422 when something needs fixing) and resolves with what save() needs.
   saveKey: the key the form page makes for each fill, sent again with every try */
async function prepare(payload) {
  if (!isObject(payload)) throw httpError(400, 'Please send the form details as a JSON object.');

  const data = await facilities.list();
  const wantedId = text(payload.facilityId);
  const facility = data.facilities.find((f) => f.id === wantedId) || null;
  const { value, fields } = validate(payload, facility, (data.municipalities || []).map((m) => m.name));
  if (fields) {
    throw httpError(422, 'Some details need a quick fix. Please check the highlighted fields.', fields);
  }
  // The page's key plus the answers themselves: the same form sent again is one save, but
  // answers she changed before sending again (e.g. a fixed mobile number) are a new form
  const key = typeof payload.saveId === 'string' && SAVE_KEY.test(payload.saveId) ? payload.saveId.toLowerCase() : null;
  const saveKey = key ? key + '.' + cloud.hash(JSON.stringify([value.type, value.facilityId, value.contact, value.details])).slice(0, 32) : null;
  return { value, facility, saveKey };
}

/* Saves a checked form. Resolves with { summary, submission, again }: again is true when
   the same form was saved before (its answer was lost, and she pressed Send again), and
   that first submission is what comes back, so she never ends up with two. */
async function save(form) {
  const { value, facility, saveKey } = form;

  // The reference number and the submission are saved together (cloud.js), so two
  // mothers sending a form at the same moment never share one.
  const at = new Date().toISOString();
  let submission = null;
  const saved = await cloud.createSubmission({
    refFor: (number, year) => `MOW-${TYPES[value.type].refLetter}-${year}-${String(number).padStart(5, '0')}`,
    record: (ref) => {
      submission = {
        ref,
        type: value.type,
        facilityId: facility.id,
        facilityName: facility.name,
        status: 'submitted',
        statusHistory: [{ status: 'submitted', at, by: 'mother', note: null }],
        contact: value.contact,
        details: value.details,
        consent: true,
        createdAt: at,
        updatedAt: at
      };
      // The same document the admin pages have always read (see Admin/Backend/src/submissions.js)
      return adminSubmissions.toRecord(submission);
    }
  }, saveKey);
  if (saved.again) return { summary: summary(saved.record), submission: saved.record, again: true };
  return { summary: summary(submission), submission, again: false };
}

async function create(payload) {
  return save(await prepare(payload));
}

/* ───────────────────────── the mother's view ───────────────────────── */

function publicView(submission, notifications, facility) {
  const s = submission;
  const f = facility || null;
  const time = (iso) => Date.parse(iso) || 0;
  const history = Array.isArray(s.statusHistory) ? s.statusHistory : [];
  // Copies of the SMS sent to her, and the messages the admin wrote her with a
  // status (not the automatic "Referred to <facility>" line of a referral)
  // Only the texts an admin wrote her: the automatic ones repeat her status history
  const sms = (Array.isArray(notifications) ? notifications : [])
    .filter((n) => n && n.ref === s.ref && n.message && (!n.kind || n.kind === 'manual') && (!n.status || n.status === 'sent'))
    .map((n) => ({ at: n.createdAt, message: n.message }));
  const isReferral = (h) => (h.kind ? h.kind === 'referral' : /^Referred to [^\n]*$/.test(h.note));
  const fromAdmin = history
    .filter((h) => h && h.by === 'admin' && typeof h.note === 'string' && h.note.trim() && !isReferral(h))
    .map((h) => ({ at: h.at, message: h.note }));
  const messages = sms.concat(fromAdmin).sort((a, b) => time(b.at) - time(a.at));

  // Referred by the admin: her facility is now the one she was referred to
  const referral = s.referral && s.referral.facilityId ? s.referral : null;
  return {
    ref: s.ref,
    type: s.type,
    typeLabel: isType(s.type) ? TYPES[s.type].label : s.type,
    status: s.status,
    statusLabel: statusLabel(s.status),
    isFinal: FINAL.includes(s.status),
    facility: {
      id: referral ? referral.facilityId : s.facilityId,
      name: (f && f.name) || (referral && referral.facilityName) || s.facilityName,
      referred: Boolean(referral),
      municipality: (f && f.municipality) || null,
      contactNumber: (f && f.contactNumber) || null,
      address: (f && f.address) || null
    },
    statusHistory: history.map((h) => ({
      status: h.status,
      statusLabel: statusLabel(h.status),
      at: h.at,
      note: h.note || null
    })),
    messages,
    contactName: firstName(s.contact && s.contact.name),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt || s.createdAt
  };
}

/* Returns the public view only when the reference AND the mobile number match.
   Anything else returns null, so nobody can tell whether a reference exists. */
async function lookup(ref, mobile) {
  const wantedRef = normalizeRef(ref);
  const wantedMobile = normalizeMobile(mobile);
  if (!wantedRef || !wantedMobile) return null;

  const sub = await cloud.getSubmission(wantedRef);
  if (!sub || !sub.contact || normalizeMobile(sub.contact.mobile) !== wantedMobile) return null;

  const notifications = await cloud.notesFor(sub.ref);
  let facility = null;
  try {
    // The facility she was referred to, if the admin referred her; else the one she chose
    facility = (await facilities.get((sub.referral && sub.referral.facilityId) || sub.facilityId)).facility;
  } catch (err) {
    // No facility data right now — show the name saved with the submission instead
  }
  return publicView(sub, notifications, facility);
}

module.exports = {
  ANTIQUE_MUNICIPALITIES,
  DONATE,
  REQUEST,
  INQUIRE,
  MOBILE_HINT,
  normalizeMobile,
  normalizeRef,
  firstName,
  validate,
  prepare,
  save,
  create,
  publicView,
  lookup
};
