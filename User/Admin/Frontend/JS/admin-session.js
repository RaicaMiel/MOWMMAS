/* ==========================================================================
   MOWMMAS Admin · Session (every page except the sign-in page)

   - Only a signed-in admin can use the admin pages. Anyone else goes back
     to login.html. An admin is a Firebase Authentication user who has a
     record in Firestore: admins/<uid>.
   - Fills in "Signed in as" in the sidebar from that record.
   - Sign out (in the sign-out dialog) signs out of Firebase.

   Page scripts wait for the admin before loading data:
     import { ready, toast, showPageError } from "./admin-session.js";
     ready.then(function (session) { ... session.user, session.admin ... });
   ========================================================================== */

import { app } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export var auth = getAuth(app);
export var db = getFirestore(app);

/* ───────────── small helpers every page uses ───────────── */

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* The page's toast (the design's single aria-live region) */
var toastTimer = null;
export function toast(message) {
  var region = document.querySelector("[data-toast-region]");
  var box = region && region.querySelector(".mw-toast");
  var text = region && region.querySelector("[data-toast-text]");
  if (!box || !text) return;
  text.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { box.hidden = true; }, 4000);
}

/* The page-level error bar that ships hidden under the page title */
export function showPageError(message) {
  var alert = document.querySelector(".mw-page > .mw-alert--error[role='alert']");
  if (!alert) {
    console.error(message);
    return;
  }
  alert.textContent = message;
  alert.hidden = false;
}

/* What a Firebase error means for the admin, in one sentence */
export function errorMessage(error, what) {
  var code = (error && error.code) || "";
  if (code === "permission-denied") return "Firebase didn't allow reading " + what + ". Check the Firestore rules (User/Admin/Backend/firestore.rules).";
  if (code === "unavailable" || code === "auth/network-request-failed") return "Can't reach Firebase, so " + what + " couldn't be loaded. Check the internet connection, then refresh the page.";
  return what.charAt(0).toUpperCase() + what.slice(1) + " couldn't be loaded (" + (code || "unknown error") + "). Refresh the page to try again.";
}

/* ───────────── who is signed in ───────────── */

/* "Signed in as": the admin's name (or "Admin" when the record has none), then the email.
   Both lines are cut with "…" by the CSS if they're too long; the full text shows on hover. */
function fillSidebar(user, admin) {
  var name = document.querySelector(".mw-sidebar__account .mw-user__name");
  var role = document.querySelector(".mw-sidebar__account .mw-user__role");
  var who = (admin && admin.name) || "Admin";
  if (name) { name.textContent = who; name.title = who; }
  if (role) { role.textContent = user.email || ""; role.title = user.email || ""; }
}

/* The signed-in admin is remembered for this browser tab, so "Signed in as"
   shows at once on every page instead of after Firebase answers.
   Cleared on sign-out (with any cached page data). */
var IDENTITY_KEY = "mowmmas.admin.identity";

function rememberIdentity(user, admin) {
  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify({ uid: user.uid, name: (admin && admin.name) || null, email: user.email || "" }));
  } catch (error) { /* storage blocked: the sidebar just fills a moment later */ }
}

export function forgetSession() {
  try {
    Object.keys(sessionStorage).forEach(function (key) {
      if (key.indexOf("mowmmas.") === 0) sessionStorage.removeItem(key);
    });
  } catch (error) { /* nothing stored */ }
}

(function fillFromMemory() {
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(IDENTITY_KEY)); } catch (error) { saved = null; }
  if (saved && saved.email) fillSidebar({ email: saved.email }, { name: saved.name });
})();

function goToSignIn(reason) {
  forgetSession();
  window.location.replace("login.html" + (reason ? "?" + reason : ""));
}

/* Reads admins/<uid>, trying again after 1 s and 3 s if Firebase can't be reached.
   "Not allowed" isn't retried: that account isn't an admin. */
function readAdmin(uid, attempt) {
  return getDoc(doc(db, "admins", uid)).catch(function (error) {
    if ((error && error.code === "permission-denied") || attempt >= 2) throw error;
    return new Promise(function (wait) { setTimeout(wait, attempt === 0 ? 1000 : 3000); })
      .then(function () { return readAdmin(uid, attempt + 1); });
  });
}

/* Resolves with { user, admin } once the signed-in user is confirmed as an admin.
   Rejects (after the retries) when Firebase can't be reached, so pages show an
   error instead of waiting forever; the error bar says what happened. */
export var ready = new Promise(function (resolve, reject) {
  var stop = onAuthStateChanged(auth, function (user) {
    stop();
    if (!user) {
      goToSignIn();
      return;
    }
    readAdmin(user.uid, 0)
      .then(function (snapshot) {
        if (!snapshot.exists()) {
          return signOut(auth).then(function () { goToSignIn("not_admin"); });
        }
        var admin = snapshot.data();
        fillSidebar(user, admin);
        rememberIdentity(user, admin);
        resolve({ user: user, admin: admin });
        // The bell's notifications panel (top bar), and the data the other pages use, fetched once in the background
        import("./admin-notifications.js").catch(function (error) { console.error("Notifications could not load:", error); });
        import("./admin-data.js").then(function (data) {
          return Promise.all([data.getSubmissions(), data.getFacilities()]);
        }).catch(function () { /* each page loads its own data anyway */ });
        import("./admin-sms.js").then(function (sms) {
          sms.sweepUpdates();   // any admin update not texted yet (at most once a minute)
          return sms.getSmsLog();
        }).catch(function () { /* the SMS pages say if the server can't be reached */ });
      })
      .catch(function (error) {
        if (error && error.code === "permission-denied") {
          signOut(auth).then(function () { goToSignIn("not_admin"); });
          return;
        }
        showPageError(errorMessage(error, "your admin account"));
        reject(error);
      });
  });
});

/* ───────────── sign out ───────────── */

document.addEventListener("click", function (event) {
  var link = event.target.closest("#signout_modal a[href^='login.html']");
  if (!link) return;
  event.preventDefault();
  forgetSession();
  signOut(auth)
    .catch(function () { /* signed out locally anyway */ })
    .then(function () { window.location.href = "login.html?signed_out"; });
});
