/* ==========================================================================
   MOWMMAS Admin · Facilities

   Everything on this page comes from Firestore (facilities/<id>):
     - the four KPI cards, the town filter and the facility table
       (10 facilities a page, with numbered pages under it)
     - Public toggle        → saves participating
     - Update status        → saves HMB status, donor milk and the note
     - Add / Edit facility  → creates or updates the facility, with its
                              location picked on a map (Leaflet + OpenStreetMap;
                              addresses found with OpenStreetMap Nominatim)
   Every save stamps dataStatus.updatedAt / updatedBy with the signed-in admin.
   ========================================================================== */

import { ready, auth, db, esc, toast, showPageError, errorMessage } from "./admin-session.js";
import { holdDialog, createPager } from "./admin-ui.js";
import {
  getFacilities,
  cachedFacilities,
  isParticipating,
  hasDonorMilk,
  isOverdue,
  hmbStatus,
  HMB,
  DONOR_MILK,
  donorMilk,
  facilityUpdatedAt,
  daysSince,
  daysAgo,
  formatDateTime,
  isoDay
} from "./admin-data.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  GeoPoint,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ───────────── what things mean ───────────── */

var PROVINCE = "Antique";
var SAVE_TIMEOUT = 20000;

// Same types as the mother backend (User/Mother/Backend/src/osm.js)
var KIND_LABEL = {
  hospital: "Hospital",
  health_center: "Rural health unit / primary care",
  birthing: "Birthing / lying-in facility",
  clinic: "Clinic"
};

// Services shown in the table, in this order, and the filter / checkbox for each
var SERVICES = [
  { key: "lactationServices", label: "Lactation", filter: "lactation", field: "service_lactation" },
  { key: "acceptsDonations", label: "Donations", filter: "donations", field: "service_donations" },
  { key: "providesDonorMilk", label: "Donor milk", filter: "donor_milk", field: "service_donor_milk" },
  { key: "milkStorage", label: "Milk storage", filter: "milk_storage" }
];

// HMB status (form value) → what is saved
var HMB_SAVE = {
  verified: { milkBank: true, verified: true },
  not_verified: { milkBank: true, verified: false },
  no: { milkBank: false, verified: false },
  unknown: { milkBank: null, verified: false }
};
var HMB_FORM_LABEL = {
  verified: "Verified HMB",
  not_verified: "HMB, not verified",
  no: "Not an HMB",
  unknown: "Not reported"
};

// Donor milk: Firestore value ↔ form value
var DONOR_TO_FORM = { available: "available", limited: "limited", none: "not_available", unknown: "unknown" };
var DONOR_SAVE = { available: "available", limited: "limited", not_available: "none", unknown: null };

/* ───────────── the page ───────────── */

var page = {
  filters: document.querySelector(".mw-filters"),
  search: document.getElementById("filter_search"),
  town: document.getElementById("filter_town"),
  hmb: document.getElementById("filter_hmb_status"),
  service: document.getElementById("filter_service"),
  tableWrap: document.querySelector(".mw-table-wrap"),
  rows: document.querySelector("[data-facility-rows]"),
  caption: document.querySelector("[data-table-caption]"),
  empty: document.querySelector("[data-empty]"),
  emptyTitle: document.querySelector("[data-empty-title]"),
  emptyText: document.querySelector("[data-empty-text]"),
  clear: document.querySelector("[data-clear-filters]"),
  add: document.querySelector('.mw-page-header [data-modal-open="facility_modal"]'),
  error: document.querySelector(".mw-page > .mw-alert--error[role='alert']"),
  townOptions: document.getElementById("town_options")
};

var facilityDialog = document.getElementById("facility_modal");
var facilityForm = facilityDialog.querySelector("form");
var facilityAlert = facilityForm.querySelector(".mw-alert--error");
var facilitySave = facilityForm.querySelector('button[type="submit"]');

var statusDialog = document.getElementById("update_status_modal");
var statusForm = statusDialog.querySelector("form");
var statusAlert = statusForm.querySelector(".mw-alert--error");
var statusSave = statusForm.querySelector('button[type="submit"]');

var state = {
  session: null,
  facilities: [],
  loaded: false,
  towns: []            // Antique's towns from map/antique, for the Town field
};

var pager = createPager({ after: page.tableWrap, label: "Facilities pages", onChange: function () { render(); } });

var editing = null;      // the facility in the Edit dialog (null while adding)
var editingBefore = null; // the Edit form's values when it opened
var statusTarget = null; // the facility in the Update status dialog
var saving = false;
var pageErrorFromSave = false;

/* ───────────── small helpers ───────────── */

function text(value) {
  return value == null ? "" : String(value).trim();
}

function orNull(value) {
  var t = text(value);
  return t ? t : null;
}

function round6(value) {
  return Number(Number(value).toFixed(6));
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

function byId(id) {
  for (var i = 0; i < state.facilities.length; i++) {
    if (state.facilities[i].id === id) return state.facilities[i];
  }
  return null;
}

function adminEmail() {
  var user = (state.session && state.session.user) || auth.currentUser;
  return (user && user.email) || "admin";
}

function stamp() {
  return { at: new Date().toISOString(), by: adminEmail() };
}

function mapUrl(lat, lon) {
  return "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon;
}

function directionsUrl(lat, lon) {
  return "https://www.openstreetmap.org/directions?route=%3B" + lat + "%2C" + lon + "#map=15/" + lat + "/" + lon;
}

// Where a facility is, or null
function pointOf(f) {
  if (!f) return null;
  var lat = f.lat == null ? NaN : Number(f.lat);
  var lon = f.lon == null ? NaN : Number(f.lon);
  if ((!isFinite(lat) || !isFinite(lon)) && f.location) {
    lat = f.location.lat == null ? NaN : Number(f.location.lat);
    lon = f.location.lon == null ? NaN : Number(f.location.lon);
  }
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat: lat, lon: lon };
}

// "a.b" = value on a plain object (keeps the local copy in step with an updateDoc)
function setPath(target, path, value) {
  var keys = path.split(".");
  var node = target;
  for (var i = 0; i < keys.length - 1; i++) {
    if (!node[keys[i]] || typeof node[keys[i]] !== "object") node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

function applyLocally(f, updates) {
  Object.keys(updates).forEach(function (key) {
    var value = updates[key];
    if (value instanceof GeoPoint) value = { lat: value.latitude, lon: value.longitude };
    setPath(f, key, value);
  });
}

// Runs a Firestore write. A write that throws straight away (e.g. invalid data)
// rejects like any other failure, and one the server hasn't confirmed in time
// counts as failed here.
function withTimeout(write) {
  var promise;
  try {
    promise = Promise.resolve(write());
  } catch (error) {
    promise = Promise.reject(error);
  }
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      var error = new Error("timeout");
      error.code = "timeout";
      reject(error);
    }, SAVE_TIMEOUT);
    promise.then(function (value) {
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* What a failed save means for the admin, in one sentence.
   (errorMessage in admin-session.js is worded for reading.) */
function saveErrorMessage(error, what) {
  var code = (error && error.code) || "";
  if (code === "permission-denied") return "Firebase didn't allow saving " + what + ". Check that you're signed in as an admin and the Firestore rules are published.";
  if (code === "unavailable") return "Can't reach Firebase, so " + what + " wasn't saved. Check the internet connection, then try again.";
  if (code === "not-found") return "This facility is no longer in Firebase, so " + what + " wasn't saved. Refresh the page to see the current list.";
  if (code === "timeout") return "Firebase hasn't confirmed saving " + what + ". Check the internet connection, then refresh the page to see what was saved.";
  return what.charAt(0).toUpperCase() + what.slice(1) + " couldn't be saved (" + (code || "unknown error") + "). Try again.";
}

function showAlert(alert, message) {
  alert.textContent = message;
  alert.hidden = false;
}

function setBusy(button, busy) {
  button.classList.toggle("is-loading", busy);
  button.setAttribute("aria-busy", String(busy));
}

function focusRowControl(selector) {
  var control = page.rows.querySelector(selector);
  if (control) control.focus();
}

/* The rules every page shares (public, donor milk, needs updating) are in admin-data.js. */

/* ───────────── KPI cards ───────────── */

function setStat(key, value) {
  var el = document.querySelector('.mw-stat__value[data-stat="' + key + '"]');
  if (el) el.textContent = String(value);
}

function renderStats() {
  var all = state.facilities;
  var participating = all.filter(isParticipating);
  setStat("participating", participating.length);
  setStat("verified", all.filter(function (f) { return hmbStatus(f) === "verified"; }).length);
  setStat("donor_milk", all.filter(hasDonorMilk).length);
  setStat("overdue", participating.filter(isOverdue).length);

  var caption = document.querySelector('[data-stat-caption="participating"]');
  if (caption) caption.textContent = "Marked public, out of " + all.length + (all.length === 1 ? " facility" : " facilities");
}

/* ───────────── filters ───────────── */

function townsInData() {
  var seen = {};
  state.facilities.forEach(function (f) {
    var town = text(f.municipality);
    if (town) seen[town] = true;
  });
  return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
}

var townFilterKey = null;

function fillTownFilter() {
  var current = page.town.value;
  var towns = townsInData();
  var key = towns.join("|");
  if (key === townFilterKey) return;
  townFilterKey = key;
  page.town.innerHTML = '<option value="">All towns</option>' + towns.map(function (town) {
    return '<option value="' + esc(town) + '">' + esc(town) + "</option>";
  }).join("");
  page.town.value = towns.indexOf(current) === -1 ? "" : current;
}

// The Town field in the dialog suggests Antique's towns (and any other town in the list)
function fillTownOptions() {
  var seen = {};
  state.towns.concat(townsInData()).forEach(function (town) { if (town) seen[town] = true; });
  page.townOptions.innerHTML = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); }).map(function (town) {
    return '<option value="' + esc(town) + '"></option>';
  }).join("");
}

function readFilters() {
  return {
    words: text(page.search.value).toLowerCase().split(/\s+/).filter(Boolean),
    town: page.town.value,
    hmb: page.hmb.value,
    service: page.service.value
  };
}

function matches(f, filter) {
  if (filter.town && text(f.municipality) !== filter.town) return false;
  if (filter.hmb && hmbStatus(f) !== filter.hmb) return false;
  if (filter.service) {
    var service = SERVICES.filter(function (s) { return s.filter === filter.service; })[0];
    if (!service || !(f.services && f.services[service.key] === true)) return false;
  }
  if (filter.words.length) {
    var haystack = [f.name, f.address, f.municipality].map(text).join(" ").toLowerCase();
    for (var i = 0; i < filter.words.length; i++) {
      if (haystack.indexOf(filter.words[i]) === -1) return false;
    }
  }
  return true;
}

/* ───────────── table ───────────── */

function chip(meaning) {
  return '<span class="mw-chip' + (meaning.tone ? " mw-chip--" + meaning.tone : "") + '">' + esc(meaning.label) + "</span>";
}

// The address without the province (every facility is in Antique)
function shortAddress(f) {
  var address = text(f.address).replace(/,\s*Antique\s*$/i, "");
  return address || text(f.municipality);
}

function servicesHtml(f) {
  var s = f.services || {};
  var offered = SERVICES.filter(function (service) { return s[service.key] === true; }).map(function (service) { return service.label; });
  if (offered.length) return esc(offered.join(", "));
  var reported = Object.keys(s).some(function (key) { return s[key] === true || s[key] === false; });
  return '<span class="mw-text-muted">' + (reported ? "None" : "Not reported") + "</span>";
}

function updatedCell(f) {
  var iso = facilityUpdatedAt(f);
  var overdue = isOverdue(f);
  var when = daysSince(iso) === null
    ? esc(daysAgo(iso))
    : '<time datetime="' + esc(isoDay(iso)) + '" title="' + esc(formatDateTime(iso)) + '">' + esc(daysAgo(iso)) + "</time>";
  return "<td" + (overdue ? ' class="mw-text-warning"' : "") + ">" + when +
    (overdue ? '<span class="mw-visually-hidden"> (overdue)</span>' : "") + "</td>";
}

function toggleId(f) {
  return "public_" + String(f.id).replace(/[^A-Za-z0-9_-]/g, "_");
}

function rowHtml(f) {
  var id = esc(f.id);
  var name = esc(f.name);
  return "<tr>" +
    "<td>" +
      '<span class="mw-table__name">' + name + "</span>" +
      '<span class="mw-table__sub">' + esc(shortAddress(f)) + "</span>" +
    "</td>" +
    "<td>" + esc(text(f.municipality)) + "</td>" +
    "<td>" + esc(f.kindLabel || KIND_LABEL[f.kind] || "") + "</td>" +
    "<td>" + chip(HMB[hmbStatus(f)]) + "</td>" +
    "<td>" + servicesHtml(f) + "</td>" +
    "<td>" + chip(DONOR_MILK[donorMilk(f)]) + "</td>" +
    updatedCell(f) +
    "<td>" +
      '<label class="mw-toggle">' +
        '<input class="mw-toggle__input" id="' + esc(toggleId(f)) + '" name="' + esc(toggleId(f)) + '" type="checkbox" role="switch" data-facility-id="' + id + '"' + (isParticipating(f) ? " checked" : "") + ">" +
        '<span class="mw-visually-hidden">Show ' + name + " in the public directory</span>" +
      "</label>" +
    "</td>" +
    '<td class="mw-table__js">' +
      '<div class="mw-table__actions">' +
        '<button class="mw-link" type="button" data-modal-open="facility_modal" data-modal-heading="Edit facility" data-action="edit" data-facility-id="' + id + '">Edit<span class="mw-visually-hidden"> ' + name + "</span></button>" +
        '<button class="mw-link" type="button" data-modal-open="update_status_modal" data-modal-context="' + name + '" data-action="status" data-facility-id="' + id + '">Update status<span class="mw-visually-hidden"> for ' + name + "</span></button>" +
      "</div>" +
    "</td>" +
  "</tr>";
}

// showId: turn to the page that has this facility (e.g. the one just saved)
function render(showId) {
  renderStats();
  fillTownFilter();
  fillTownOptions();

  var filter = readFilters();
  var list = state.facilities.filter(function (f) { return matches(f, filter); });
  var total = state.facilities.length;
  if (showId) pager.show(list.findIndex(function (f) { return f.id === showId; }));

  page.rows.innerHTML = pager.slice(list).map(rowHtml).join("");
  page.caption.textContent = (list.length === total
    ? "Facilities, " + plural(total, "record")
    : "Facilities, " + list.length + " of " + plural(total, "record")) + pager.caption();

  var none = list.length === 0;
  page.tableWrap.hidden = none;
  page.empty.hidden = !none;
  if (none) {
    var noData = total === 0;
    page.emptyTitle.textContent = noData ? "No facilities yet" : "No facilities match these filters";
    page.emptyText.textContent = noData
      ? "Add a facility to start the list."
      : "Try another town or status, or clear the filters to see every facility.";
    page.clear.hidden = noData;
  }
}

function showLoadFailed(error) {
  showPageError(errorMessage(error, "the facilities"));
  page.rows.innerHTML = "";
  page.tableWrap.hidden = true;
  page.empty.hidden = true;
}

/* ───────────── loading ───────────── */

var domReady = new Promise(function (resolve) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  } else {
    resolve();
  }
});

// Antique's 18 towns, saved with the map data. Only used as suggestions.
function loadTowns() {
  return getDoc(doc(db, "map", "antique"))
    .then(function (snapshot) {
      var list = snapshot.exists() ? snapshot.data().municipalities : null;
      return Array.isArray(list) ? list.map(function (m) { return m && text(m.name); }).filter(Boolean) : [];
    })
    .catch(function () { return []; });
}

/* What this browser tab already has (from the last page) shows at once;
   the fresh copy from Firestore replaces it a moment later. */
domReady.then(function () {
  var remembered = cachedFacilities();
  if (!remembered || state.loaded) return;
  state.facilities = remembered;
  state.loaded = true;
  render();
});

Promise.all([ready, domReady]).then(function (results) {
  state.session = results[0];
  loadTowns().then(function (towns) {
    state.towns = towns;
    fillTownOptions();
  });
  return getFacilities()
    .then(function (list) {
      state.facilities = list;
      state.loaded = true;
      render();
    })
    .catch(showLoadFailed);
}).catch(function (error) {
  // The sign-in check failed (admin-session.js shows why). Keep what's on screen if it came from the tab's memory.
  if (!state.loaded) showLoadFailed(error);
});

/* ───────────── filters: live ───────────── */

page.filters.addEventListener("submit", function (event) { event.preventDefault(); });
// New filters: back to page 1
page.search.addEventListener("input", function () { pager.reset(); if (state.loaded) render(); });
[page.town, page.hmb, page.service].forEach(function (select) {
  select.addEventListener("change", function () { pager.reset(); if (state.loaded) render(); });
});
page.clear.addEventListener("click", function (event) {
  event.preventDefault();
  page.filters.reset();
  pager.reset();
  render();
  page.search.focus();
});

/* ───────────── Public toggle ───────────── */

function showSaveErrorOnPage(message) {
  showPageError(message);
  pageErrorFromSave = true;
  if (page.error) page.error.scrollIntoView({ block: "nearest" });
}

function clearSaveErrorOnPage() {
  if (pageErrorFromSave && page.error) page.error.hidden = true;
  pageErrorFromSave = false;
}

page.rows.addEventListener("change", function (event) {
  var input = event.target.closest(".mw-toggle__input[data-facility-id]");
  if (!input) return;
  var f = byId(input.getAttribute("data-facility-id"));
  if (!f) return;

  var show = input.checked;
  var when = stamp();
  input.disabled = true;

  withTimeout(function () {
    return updateDoc(doc(db, "facilities", f.id), {
      participating: show,
      "dataStatus.updatedAt": when.at,
      "dataStatus.updatedBy": when.by,
      adminUpdatedAt: serverTimestamp()
    });
  })
    .then(function () {
      applyLocally(f, { participating: show, "dataStatus.updatedAt": when.at, "dataStatus.updatedBy": when.by });
      clearSaveErrorOnPage();
      render(f.id);
      focusRowControl("#" + CSS.escape(toggleId(f)));
      toast(show ? f.name + " is now marked public." : f.name + " is now marked not public.");
    })
    .catch(function (error) {
      input.checked = !show;
      input.disabled = false;
      showSaveErrorOnPage(saveErrorMessage(error, "the change to " + f.name));
    });
});

/* ───────────── row actions: Edit and Update status ───────────── */

page.rows.addEventListener("click", function (event) {
  var button = event.target.closest("button[data-action][data-facility-id]");
  if (!button) return;
  event.preventDefault(); // this page opens these dialogs itself (mowmmas.js leaves them alone)
  var f = byId(button.getAttribute("data-facility-id"));
  if (!f) return;
  if (button.getAttribute("data-action") === "edit") openEdit(f, button);
  else openStatus(f, button);
});

/* ───────────── Update status dialog ─────────────
   While saving, the dialog stays open (Cancel, X, Esc and the backdrop do
   nothing), and the result only acts on the dialog of the facility it saved. */

var statusHold = holdDialog(statusDialog);

function openStatus(f, trigger) {
  statusTarget = f;
  statusDialog.querySelectorAll("[data-modal-context-target]").forEach(function (el) { el.textContent = f.name; });

  // "No change" says what the status is now
  var hmbSelect = statusForm.elements.hmb_status;
  var donorSelect = statusForm.elements.donor_milk;
  hmbSelect.options[0].textContent = "No change (now: " + HMB_FORM_LABEL[hmbStatus(f)] + ")";
  donorSelect.options[0].textContent = "No change (now: " + DONOR_MILK[donorMilk(f)].label + ")";
  hmbSelect.value = "";
  donorSelect.value = "";
  statusForm.elements.status_note.value = f.notes || "";

  statusAlert.hidden = true;
  statusDialog.returnFocusTo = trigger;
  statusDialog.showModal();
}

statusForm.addEventListener("submit", function (event) {
  event.preventDefault();
  if (saving || !statusTarget) return;
  var f = statusTarget;
  var hmb = statusForm.elements.hmb_status.value;
  var donor = statusForm.elements.donor_milk.value;
  var note = text(statusForm.elements.status_note.value);
  var when = stamp();

  var updates = {
    "dataStatus.updatedAt": when.at,
    "dataStatus.updatedBy": when.by,
    "dataStatus.hasProfile": true
  };
  if (HMB_SAVE[hmb]) {
    updates["services.milkBank"] = HMB_SAVE[hmb].milkBank;
    updates["dataStatus.verified"] = HMB_SAVE[hmb].verified;
  }
  if (Object.prototype.hasOwnProperty.call(DONOR_SAVE, donor)) updates.donorMilkAvailability = DONOR_SAVE[donor];
  if (note !== text(f.notes)) updates.notes = note || null;

  saving = true;
  statusHold.hold();
  statusAlert.hidden = true;
  setBusy(statusSave, true);
  var ownDialog = function () { return statusDialog.open && statusTarget === f; };

  withTimeout(function () { return updateDoc(doc(db, "facilities", f.id), Object.assign({ adminUpdatedAt: serverTimestamp() }, updates)); })
    .then(function () {
      applyLocally(f, updates);
      saving = false;
      statusHold.release();
      if (ownDialog()) statusDialog.close();
      render(f.id);
      focusRowControl('button[data-action="status"][data-facility-id="' + CSS.escape(f.id) + '"]');
      toast("Status saved for " + f.name + ".");
    })
    .catch(function (error) {
      var message = saveErrorMessage(error, "the status of " + f.name);
      if (ownDialog()) showAlert(statusAlert, message);
      else showSaveErrorOnPage(message);
    })
    .then(function () {
      saving = false;
      statusHold.release();
      setBusy(statusSave, false);
    });
});

statusDialog.addEventListener("close", function () {
  statusTarget = null;
  statusAlert.hidden = true;
});

/* ───────────── Add / Edit facility dialog ───────────── */

var fields = facilityForm.elements;

function readFacilityForm() {
  return {
    name: text(fields.facility_name.value),
    kind: fields.facility_type.value,
    town: text(fields.town.value),
    street: text(fields.address.value),
    barangay: text(fields.barangay.value).replace(/^(brgy\.?|barangay)\s+/i, ""),
    lat: fields.latitude.value,
    lon: fields.longitude.value,
    landline: text(fields.landline.value),
    mobile: text(fields.mobile.value),
    email: text(fields.email.value),
    hours: text(fields.operating_hours.value),
    open24: fields.open_24_hours.checked,
    lactation: fields.service_lactation.checked,
    donations: fields.service_donations.checked,
    donorMilk: fields.service_donor_milk.checked,
    hmb: fields.hmb_status.value,
    donor: fields.donor_milk.value,
    isPublic: fields.is_public.checked
  };
}

function isAllDay(hours) {
  return /^(24\/7|open 24 hours|24 hours)$/i.test(text(hours));
}

function hoursValue(v) {
  return v.open24 ? "Open 24 hours" : orNull(v.hours);
}

// "Street, Brgy. X, Town, Antique" (the mother side's address format) → its parts
function splitAddress(address, town) {
  var parts = text(address).split(",").map(text).filter(Boolean);
  if (parts.length && parts[parts.length - 1].toLowerCase() === PROVINCE.toLowerCase()) parts.pop();
  if (parts.length && town && parts[parts.length - 1].toLowerCase() === town.toLowerCase()) parts.pop();
  var barangay = "";
  var street = [];
  parts.forEach(function (part) {
    var match = /^(?:brgy\.?|barangay)\s+(.+)$/i.exec(part);
    if (match && !barangay) barangay = match[1];
    else street.push(part);
  });
  return { street: street.join(", "), barangay: barangay };
}

function composeAddress(street, barangay, town) {
  return [street, barangay ? "Brgy. " + barangay : "", town, PROVINCE].filter(Boolean).join(", ");
}

function setKind(kind, label) {
  var select = fields.facility_type;
  select.querySelectorAll("option[data-extra]").forEach(function (option) { option.remove(); });
  if (kind && !KIND_LABEL[kind]) {
    var option = document.createElement("option");
    option.value = kind;
    option.textContent = label || kind;
    option.setAttribute("data-extra", "");
    select.appendChild(option);
  }
  select.value = kind || "hospital";
}

function setEmailError(on) {
  var field = fields.email.closest(".mw-field");
  field.classList.toggle("has-error", on);
  document.getElementById("email_error").hidden = !on;
  if (on) fields.email.setAttribute("aria-invalid", "true");
  else fields.email.removeAttribute("aria-invalid");
}

// The alert is the first thing in the dialog. Scroll the dialog to the top so it
// shows below the sticky header (scrollIntoView left it hidden under the header).
function showFacilityAlert(message) {
  showAlert(facilityAlert, message);
  facilityDialog.scrollTop = 0;
}

function resetFacilityMessages() {
  facilityAlert.hidden = true;
  setEmailError(false);
  place.setError(false);
}

// Each opening of the facility dialog gets a number, so a save only acts on the dialog it came from
var facilityOpened = 0;
var facilityHold = holdDialog(facilityDialog);

function openEdit(f, trigger) {
  facilityOpened++;
  editing = f;
  facilityDialog.querySelectorAll("[data-modal-heading-target]").forEach(function (el) { el.textContent = "Edit facility"; });

  var parts = splitAddress(f.address, f.municipality);
  var hours = text(f.operatingHours);
  var s = f.services || {};

  fields.facility_name.value = text(f.name);
  setKind(f.kind, f.kindLabel);
  fields.town.value = text(f.municipality);
  fields.address.value = parts.street;
  fields.barangay.value = parts.barangay;
  fields.landline.value = text(f.contactNumber);
  fields.mobile.value = text(f.smsNumber);
  fields.email.value = text(f.email);
  fields.operating_hours.value = isAllDay(hours) ? "" : hours;
  fields.open_24_hours.checked = isAllDay(hours);
  SERVICES.forEach(function (service) {
    if (service.field) fields[service.field].checked = s[service.key] === true;
  });
  fields.hmb_status.value = hmbStatus(f);
  fields.donor_milk.value = DONOR_TO_FORM[donorMilk(f)];
  fields.is_public.checked = isParticipating(f);

  resetFacilityMessages();
  facilityDialog.returnFocusTo = trigger;
  facilityDialog.showModal();
  facilityDialog.scrollTop = 0; // the dialog keeps its scroll position from the last time
  place.open(pointOf(f));
  editingBefore = readFacilityForm();
}

// "Add facility" is opened by mowmmas.js; this listener runs just before it
if (page.add) {
  page.add.addEventListener("click", function () {
    facilityOpened++;
    editing = null;
    editingBefore = null;
    setKind("hospital");
    resetFacilityMessages();
    setTimeout(function () {
      if (!facilityDialog.open) return;
      facilityDialog.scrollTop = 0; // start at the top, not where the last facility was left
      place.open(null);
    }, 0);
  });
}

function newFacility(v, when) {
  var lat = round6(v.lat);
  var lon = round6(v.lon);
  var hmb = HMB_SAVE[v.hmb] || HMB_SAVE.no;
  var id = "adm-" + Date.now().toString(36);
  return {
    id: id,
    name: v.name,
    kind: v.kind,
    kindLabel: KIND_LABEL[v.kind] || v.kind,
    lat: lat,
    lon: lon,
    municipality: v.town,
    province: PROVINCE,
    address: composeAddress(v.street, v.barangay, v.town),
    contactNumber: orNull(v.landline),
    smsNumber: orNull(v.mobile),
    email: orNull(v.email),
    website: null,
    operatingHours: hoursValue(v),
    operator: null,
    participating: v.isPublic,
    services: {
      milkBank: hmb.milkBank,
      milkStorage: null,
      acceptsDonations: v.donations,
      providesDonorMilk: v.donorMilk,
      lactationServices: v.lactation
    },
    donorMilkAvailability: Object.prototype.hasOwnProperty.call(DONOR_SAVE, v.donor) ? DONOR_SAVE[v.donor] : null,
    milkStock: null,
    requirements: [],
    notes: null,
    photo: null,
    dataStatus: {
      hasProfile: true,
      sample: false,
      verified: hmb.verified,
      updatedAt: when.at,
      updatedBy: when.by
    },
    osm: null,
    mapUrl: mapUrl(lat, lon),
    directionsUrl: directionsUrl(lat, lon),
    location: new GeoPoint(lat, lon),
    source: "admin",
    savedAt: serverTimestamp()
  };
}

// Only what the admin changed, so fields the form can't show exactly stay as they are
function changesFor(v, before, when) {
  var u = {};
  if (v.name !== before.name) u.name = v.name;
  if (v.kind !== before.kind) {
    u.kind = v.kind;
    u.kindLabel = KIND_LABEL[v.kind] || v.kind;
  }
  if (v.town !== before.town) u.municipality = v.town;
  if (v.street !== before.street || v.barangay !== before.barangay || v.town !== before.town) {
    u.address = composeAddress(v.street, v.barangay, v.town);
  }
  if (v.lat !== before.lat || v.lon !== before.lon) {
    var lat = round6(v.lat);
    var lon = round6(v.lon);
    u.lat = lat;
    u.lon = lon;
    u.location = new GeoPoint(lat, lon);
    u.mapUrl = mapUrl(lat, lon);
    u.directionsUrl = directionsUrl(lat, lon);
  }
  if (v.landline !== before.landline) u.contactNumber = orNull(v.landline);
  if (v.mobile !== before.mobile) u.smsNumber = orNull(v.mobile);
  if (v.email !== before.email) u.email = orNull(v.email);
  if (v.hours !== before.hours || v.open24 !== before.open24) u.operatingHours = hoursValue(v);
  if (v.lactation !== before.lactation) u["services.lactationServices"] = v.lactation;
  if (v.donations !== before.donations) u["services.acceptsDonations"] = v.donations;
  if (v.donorMilk !== before.donorMilk) u["services.providesDonorMilk"] = v.donorMilk;
  if (v.hmb !== before.hmb && HMB_SAVE[v.hmb]) {
    u["services.milkBank"] = HMB_SAVE[v.hmb].milkBank;
    u["dataStatus.verified"] = HMB_SAVE[v.hmb].verified;
  }
  if (v.donor !== before.donor) u.donorMilkAvailability = DONOR_SAVE[v.donor] === undefined ? null : DONOR_SAVE[v.donor];
  if (v.isPublic !== before.isPublic) u.participating = v.isPublic;
  u["dataStatus.updatedAt"] = when.at;
  u["dataStatus.updatedBy"] = when.by;
  u["dataStatus.hasProfile"] = true;
  return u;
}

function requiredEmpty(form) {
  return Array.prototype.some.call(form.querySelectorAll("[required]:not(:disabled)"), function (control) {
    return control.type === "checkbox" ? !control.checked : control.value.trim() === "";
  });
}

facilityForm.addEventListener("submit", function (event) {
  var pinned = place.hasPoint();

  // Empty required fields: the design's check in mowmmas.js marks them and stops the submit
  if (requiredEmpty(facilityForm)) {
    if (!pinned) place.setError(true);
    return;
  }
  event.preventDefault();
  if (saving) return;

  facilityAlert.hidden = true;
  var emailBad = fields.email.value.trim() !== "" && fields.email.validity.typeMismatch;
  setEmailError(emailBad);
  place.setError(!pinned);
  if (emailBad) {
    fields.email.focus();
    return;
  }
  if (!pinned) {
    place.focus();
    return;
  }
  if (!state.session) {
    showFacilityAlert("Still checking your sign-in. Try again in a moment.");
    return;
  }

  var v = readFacilityForm();
  var when = stamp();
  var f = editing;
  var data = null;
  var opened = facilityOpened;
  var ownDialog = function () { return facilityDialog.open && facilityOpened === opened; };

  saving = true;
  facilityHold.hold();
  setBusy(facilitySave, true);

  withTimeout(function () {
    if (f) {
      data = changesFor(v, editingBefore || v, when);
      return updateDoc(doc(db, "facilities", f.id), Object.assign({ adminUpdatedAt: serverTimestamp() }, data));
    }
    data = newFacility(v, when);
    return setDoc(doc(db, "facilities", data.id), Object.assign({ adminUpdatedAt: serverTimestamp() }, data));
  })
    .then(function () {
      var id;
      if (f) {
        applyLocally(f, data);
        id = f.id;
      } else {
        var local = Object.assign({}, data, {
          location: { lat: data.lat, lon: data.lon },
          savedAt: when.at
        });
        state.facilities.push(local);
        state.facilities.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        id = local.id;
      }
      saving = false;
      facilityHold.release();
      if (ownDialog()) facilityDialog.close();
      render(id);
      if (f) focusRowControl('button[data-action="edit"][data-facility-id="' + CSS.escape(id) + '"]');
      toast(f ? v.name + " was saved." : v.name + " was added.");
    })
    .catch(function (error) {
      var message = saveErrorMessage(error, v.name || "the facility");
      if (ownDialog()) {
        showFacilityAlert(message);
      } else {
        showSaveErrorOnPage(message);
      }
    })
    .then(function () {
      saving = false;
      facilityHold.release();
      setBusy(facilitySave, false);
    });
});

fields.email.addEventListener("input", function () {
  if (!fields.email.validity.typeMismatch) setEmailError(false);
});

facilityDialog.addEventListener("close", function () {
  editing = null;
  editingBefore = null;
  place.reset();
  setEmailError(false);
  facilityAlert.hidden = true;
});

/* ───────────── the location panel (map + address search) ───────────── */

var place = (function () {
  var ANTIQUE_BOUNDS = [[10.35, 121.70], [11.95, 122.25]];
  var CAPITAL = [10.7437, 121.9417]; // San Jose de Buenavista
  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // The mother side's pin (User/Mother/Frontend/js/map.js)
  var PIN_PATH = "M16 39S3 26.6 3 17a13 13 0 1 1 26 0c0 9.6-13 22-13 22Z";
  var SEARCH = "https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ph&limit=5&accept-language=en&q=";
  var IN_ANTIQUE = "&viewbox=121.70,11.95,122.25,10.35&bounded=1";
  var GAP = 1100; // Nominatim: at most one request a second

  var box = facilityForm.querySelector("[data-location]");
  var search = document.getElementById("location_search");
  var findButton = box.querySelector("[data-location-find]");
  var mapEl = box.querySelector("[data-location-map]");
  var statusEl = box.querySelector("[data-location-status]");
  var coordsEl = box.querySelector("[data-location-coords]");
  var osmLink = box.querySelector("[data-location-osm]");
  var matchesBox = box.querySelector("[data-location-matches]");
  var matchList = box.querySelector("[data-location-match-list]");
  var errorEl = document.getElementById("location_error");
  var latInput = fields.latitude;
  var lonInput = fields.longitude;

  var map = null;
  var marker = null;
  var controller = null;
  var lastRequest = 0;
  var results = [];
  var MOVED = "Pin moved. Save the facility to keep this spot.";

  function leaflet() {
    return typeof window.L !== "undefined" && typeof window.L.map === "function" ? window.L : null;
  }

  function setStatus(message, tone) {
    statusEl.textContent = message;
    statusEl.classList.toggle("is-found", tone === "found");
    statusEl.classList.toggle("is-warning", tone === "warning");
    statusEl.classList.toggle("is-busy", tone === "busy");
  }

  function setError(on) {
    box.classList.toggle("has-error", on);
    errorEl.hidden = !on;
    if (on) search.setAttribute("aria-invalid", "true");
    else search.removeAttribute("aria-invalid");
  }

  function hasPoint() {
    return latInput.value !== "" && lonInput.value !== "" && isFinite(Number(latInput.value)) && isFinite(Number(lonInput.value));
  }

  /* map */

  function pinIcon(L) {
    return L.divIcon({
      className: "fac-pin",
      html: '<svg viewBox="0 0 32 40" aria-hidden="true" focusable="false"><path d="' + PIN_PATH + '"/><circle cx="16" cy="16.5" r="5.6"/></svg>',
      iconSize: [40, 50],
      iconAnchor: [20, 49]
    });
  }

  function showFallback() {
    mapEl.innerHTML = '<div class="fac-location__fallback" role="note">' +
      '<svg class="mw-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>' +
      "<p>The map can't load right now. You can still find the address, and its location is saved with the facility.</p></div>";
  }

  function ensureMap() {
    if (map) return true;
    var L = leaflet();
    if (!L) {
      if (!mapEl.firstChild) showFallback();
      return false;
    }
    mapEl.innerHTML = ""; // drop the "can't load" note if the library arrived late
    map = L.map(mapEl, {
      center: CAPITAL,
      zoom: 10,
      minZoom: 6,
      maxZoom: 19,
      scrollWheelZoom: false // don't take over the dialog's scrolling
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    mapEl.setAttribute("role", "group");
    mapEl.setAttribute("aria-label", "Map of the facility's location. Click the map to move the pin.");

    // Wheel zoom only after the admin chooses the map
    map.on("click focus", function () { map.scrollWheelZoom.enable(); });
    map.on("mouseout blur", function () { map.scrollWheelZoom.disable(); });

    map.on("click", function (event) {
      setPoint(event.latlng.lat, event.latlng.lng);
      setStatus("Pin placed where you clicked. Drag it to the exact spot if needed.", "found");
    });

    // Arrow keys move the focused pin (Shift for bigger steps)
    mapEl.addEventListener("keydown", function (event) {
      if (!marker || event.target !== marker.getElement()) return;
      var step = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      var size = event.shiftKey ? 40 : 8;
      var point = map.latLngToContainerPoint(marker.getLatLng()).add([step[0] * size, step[1] * size]);
      var latlng = map.containerPointToLatLng(point);
      setPoint(latlng.lat, latlng.lng);
      map.panInside(latlng, { padding: [24, 24] });
      if (statusEl.textContent !== MOVED) setStatus(MOVED, "found");
    }, true);
    return true;
  }

  function placeMarker(lat, lon) {
    var L = leaflet();
    if (!map || !L) return;
    if (!marker) {
      marker = L.marker([lat, lon], {
        icon: pinIcon(L),
        draggable: true,
        autoPan: true,
        keyboard: true,
        title: "Facility location",
        riseOnHover: true
      });
      marker.on("add", function () {
        var el = marker.getElement();
        if (el) el.setAttribute("aria-label", "Facility pin. Drag it, or use the arrow keys, to move it.");
      });
      marker.on("dragend", function () {
        var latlng = marker.getLatLng();
        setPoint(latlng.lat, latlng.lng);
        setStatus(MOVED, "found");
      });
    }
    marker.setLatLng([lat, lon]);
    if (!map.hasLayer(marker)) marker.addTo(map);
  }

  function setPoint(lat, lon) {
    lat = round6(lat);
    lon = round6(lon);
    latInput.value = String(lat);
    lonInput.value = String(lon);
    coordsEl.textContent = lat.toFixed(6) + ", " + lon.toFixed(6);
    osmLink.href = mapUrl(lat, lon);
    osmLink.hidden = false;
    placeMarker(lat, lon);
    setError(false);
  }

  function clearPoint() {
    latInput.value = "";
    lonInput.value = "";
    coordsEl.textContent = "No location pinned";
    osmLink.hidden = true;
    osmLink.href = "https://www.openstreetmap.org/";
    if (marker && map && map.hasLayer(marker)) marker.remove();
  }

  /* address search (OpenStreetMap Nominatim) */

  function wait(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (ms <= 0) return resolve();
      var timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", function () {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  function request(url, signal) {
    return wait(lastRequest + GAP - Date.now(), signal)
      .then(function () {
        lastRequest = Date.now();
        return fetch(url, { signal: signal });
      })
      .then(function (response) {
        if (!response.ok) {
          var error = new Error("HTTP " + response.status);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })
      .then(function (list) { return Array.isArray(list) ? list : []; });
  }

  // In Antique first; if nothing there, anywhere in the Philippines
  function lookup(query, signal) {
    var url = SEARCH + encodeURIComponent(query);
    return request(url + IN_ANTIQUE, signal).then(function (list) {
      return list.length ? list : request(url, signal);
    });
  }

  function inAntique(lat, lon) {
    return lat >= ANTIQUE_BOUNDS[0][0] && lat <= ANTIQUE_BOUNDS[1][0] && lon >= ANTIQUE_BOUNDS[0][1] && lon <= ANTIQUE_BOUNDS[1][1];
  }

  function choose(index) {
    var result = results[index];
    if (!result) return;
    var lat = Number(result.lat);
    var lon = Number(result.lon);
    if (map) {
      map.invalidateSize();
      var bb = (result.boundingbox || []).map(Number);
      if (bb.length === 4 && bb.every(isFinite)) {
        map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17, padding: [16, 16] });
      } else {
        map.setView([lat, lon], 17);
      }
    }
    setPoint(lat, lon);
    var outside = !inAntique(lat, lon);
    setStatus(
      (outside ? "Found outside Antique: " : "Found: ") + result.display_name + (outside ? ". Check that it's the right place." : ""),
      outside ? "warning" : "found"
    );
    showMatches(index);
  }

  function showMatches(chosen) {
    var others = [];
    results.forEach(function (result, index) {
      if (index !== chosen) others.push({ result: result, index: index });
    });
    matchList.innerHTML = others.map(function (item) {
      return '<li><button class="mw-link" type="button" data-match="' + item.index + '">' + esc(item.result.display_name) + "</button></li>";
    }).join("");
    matchesBox.hidden = !others.length;
  }

  function clearMatches() {
    results = [];
    matchList.innerHTML = "";
    matchesBox.hidden = true;
  }

  function cancel() {
    if (controller) controller.abort();
    controller = null;
    setBusy(findButton, false);
  }

  function find() {
    if (controller) return; // one search at a time
    var query = text(search.value);
    if (!query) {
      var town = text(fields.town.value);
      var barangay = text(fields.barangay.value);
      if (!town && !barangay) {
        setStatus("Type an address first, or fill in the Town and Barangay fields.", "warning");
        search.focus();
        return;
      }
      query = [barangay, town, PROVINCE].filter(Boolean).join(", ");
      search.value = query;
    }

    clearMatches();
    setStatus("Looking up the address…", "busy");
    var current = new AbortController();
    controller = current;
    setBusy(findButton, true);

    lookup(query, current.signal)
      .then(function (list) {
        if (current.signal.aborted) return;
        results = list;
        if (!list.length) {
          setStatus("No place found for that address. Try adding the barangay or town, or drag the pin.", "warning");
          return;
        }
        choose(0);
      })
      .catch(function (error) {
        if (current.signal.aborted || (error && error.name === "AbortError")) return;
        setStatus(error && error.status === 429
          ? "The address search is busy. Wait a moment, then try again."
          : "The address search can't be reached right now. Check the internet connection, or click the map to place the pin.", "warning");
      })
      .then(function () {
        if (controller === current) {
          controller = null;
          setBusy(findButton, false);
        }
      });
  }

  findButton.addEventListener("click", find);
  search.addEventListener("keydown", function (event) {
    // Enter searches; it must not submit the facility form
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      find();
    }
  });
  matchList.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-match]");
    if (!button) return;
    choose(Number(button.getAttribute("data-match")));
    search.focus();
  });

  /* dialog life cycle */

  function open(point) {
    cancel();
    clearMatches();
    setError(false);
    search.value = "";
    var hasMap = ensureMap();
    if (hasMap) map.invalidateSize();

    if (point) {
      setPoint(point.lat, point.lon);
      if (hasMap) map.setView([point.lat, point.lon], 17);
      setStatus("This is the saved location. Find a new address or drag the pin to change it.", "");
    } else {
      clearPoint();
      if (hasMap) map.fitBounds(ANTIQUE_BOUNDS);
      setStatus("No pin yet. Find the address or click the map.", "");
    }
  }

  function reset() {
    cancel();
    clearMatches();
    setError(false);
    clearPoint();
    setStatus("No pin yet. Find the address or click the map.", "");
  }

  function focus() {
    search.focus();
  }

  return { open: open, reset: reset, setError: setError, hasPoint: hasPoint, focus: focus };
})();
