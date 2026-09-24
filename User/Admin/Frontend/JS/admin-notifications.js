/* ==========================================================================
   MOWMMAS Admin · Notifications (the bell in the top bar, on every page)

   The bell gets a count badge, and opens a panel listing what needs the admin:
     - new submissions nobody has handled yet (status "submitted"):
       "<name> wants to donate", "<name> needs donor milk", "<name> asked a question"
       → opens it on Donation inquiries, Milk requests, or Records & reports
         (?ref=<reference>), where the admin sets its status; then it leaves the list
     - public facilities overdue for an update (admin-data.js isOverdue)
       → opens Facilities
   Submissions update live (Firestore onSnapshot), so a new form shows up
   without reloading. Without JavaScript the bell still links to SMS notifications.
   Loaded by admin-session.js once the admin is confirmed.
   ========================================================================== */

import { db, esc } from "./admin-session.js";
import { getFacilities, plain, TYPES, isOverdue, facilityUpdatedAt, daysSince, formatDate } from "./admin-data.js";
import {
  collection,
  query,
  where,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

var ICON_ATTRS = 'class="mw-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
var ICONS = {
  donate: '<svg ' + ICON_ATTRS + '><path d="M11 14h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 16"/><path d="m7 20 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 15 6 6"/><path d="M19.5 8.5c.7-.7 1.5-1.6 1.5-2.7A2.73 2.73 0 0 0 16 4a2.78 2.78 0 0 0-5 1.8c0 1.2.8 2 1.5 2.8L16 12Z"/></svg>',
  request: '<svg ' + ICON_ATTRS + '><path d="M8 2h8"/><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2"/><path d="M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/></svg>',
  inquire: '<svg ' + ICON_ATTRS + '><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  facility: '<svg ' + ICON_ATTRS + '><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
};
var PAGES = { donate: "donation-inquiries.html", request: "milk-requests.html", inquire: "records-reports.html" };

var bell = document.querySelector(".mw-topbar__actions a[aria-label='Notifications']");
var holder = bell && bell.parentElement;

var submissionItems = [];
var facilityItems = [];
var loaded = { submissions: false, facilities: false };
var failed = false;

if (bell && holder) setUp();

function setUp() {
  holder.classList.add("mw-notify");

  var badge = document.createElement("span");
  badge.className = "mw-notify__badge";
  badge.hidden = true;
  bell.appendChild(badge);

  var panel = document.createElement("div");
  panel.className = "mw-notify__panel";
  panel.id = "notify_panel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "notify_title");
  panel.innerHTML =
    '<div class="mw-notify__header">' +
      '<p class="mw-notify__title" id="notify_title">Notifications</p>' +
      '<p class="mw-notify__summary" data-notify-summary>Loading…</p>' +
    "</div>" +
    '<ul class="mw-notify__list" data-notify-list></ul>' +
    '<p class="mw-notify__empty" data-notify-empty hidden>You\'re all caught up. New donations, requests and questions show up here.</p>';
  holder.appendChild(panel);

  bell.setAttribute("role", "button");
  bell.setAttribute("aria-expanded", "false");
  bell.setAttribute("aria-controls", "notify_panel");

  function setOpen(open) {
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
  }

  bell.addEventListener("click", function (event) {
    event.preventDefault();
    setOpen(panel.hidden);
  });
  bell.addEventListener("keydown", function (event) {
    if (event.key === " ") { event.preventDefault(); setOpen(panel.hidden); }
  });
  document.addEventListener("click", function (event) {
    if (!panel.hidden && !holder.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      bell.focus();
    }
  });

  // New submissions, live
  onSnapshot(
    query(collection(db, "submissions"), where("status", "==", "submitted")),
    function (snapshot) {
      submissionItems = snapshot.docs.map(function (d) {
        var s = plain(d.data());
        s.ref = s.ref || d.id;
        return s;
      });
      loaded.submissions = true;
      render();
    },
    function () { failed = true; loaded.submissions = true; render(); }
  );

  // Facilities overdue for an update
  getFacilities()
    .then(function (list) {
      facilityItems = list.filter(isOverdue);
    })
    .catch(function () { failed = true; })
    .then(function () { loaded.facilities = true; render(); });
}

var time = function (iso) { return Date.parse(iso) || 0; };

function submissionItem(s) {
  var type = TYPES[s.type] ? s.type : "inquire";
  var name = (s.contact && s.contact.name) || "A mother";
  var when = formatDate(s.createdAt);
  var meta = esc(s.facilityName || "") + (s.facilityName && when ? " · " : "") + (when ? '<span class="mw-notify__when">' + esc(when) + "</span>" : "");
  return '<li><a class="mw-notify__item" href="' + PAGES[type] + "?ref=" + encodeURIComponent(s.ref) + '">' +
    '<span class="mw-notify__icon mw-notify__icon--' + type + '">' + ICONS[type] + "</span>" +
    '<span class="mw-notify__text"><span class="mw-notify__item-title">' + esc(name + " " + TYPES[type].verb) + "</span>" +
    '<span class="mw-notify__meta">' + meta + "</span></span></a></li>";
}

function facilityItem(f) {
  var days = daysSince(facilityUpdatedAt(f));
  var meta = days === null ? "No update on record" : "Not updated in " + days + " days";
  return '<li><a class="mw-notify__item" href="facilities.html">' +
    '<span class="mw-notify__icon mw-notify__icon--facility">' + ICONS.facility + "</span>" +
    '<span class="mw-notify__text"><span class="mw-notify__item-title">' + esc(f.name + " needs updating") + "</span>" +
    '<span class="mw-notify__meta">' + esc(meta) + "</span></span></a></li>";
}

function render() {
  var badge = bell.querySelector(".mw-notify__badge");
  var summary = holder.querySelector("[data-notify-summary]");
  var list = holder.querySelector("[data-notify-list]");
  var empty = holder.querySelector("[data-notify-empty]");
  if (!loaded.submissions || !loaded.facilities) return;

  var subs = submissionItems.slice().sort(function (a, b) { return time(b.createdAt) - time(a.createdAt); });
  var count = subs.length + facilityItems.length;

  list.innerHTML = subs.map(submissionItem).join("") + facilityItems.map(facilityItem).join("");
  list.hidden = count === 0;
  empty.hidden = count !== 0;
  summary.textContent = failed
    ? "Some notifications couldn't be loaded. Refresh the page to try again."
    : count === 0 ? "Nothing needs you right now" : count + (count === 1 ? " item needs you" : " items need you");

  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  bell.setAttribute("aria-label", count ? "Notifications, " + count + " new" : "Notifications");
}
