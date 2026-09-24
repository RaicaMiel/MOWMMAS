/* ==========================================================================
   MOWMMAS Admin · Sign-in page

   Sign in
     Firebase Authentication with the email and password typed in the form.
     Only admins get in: the account needs a record in Firestore admins/<uid>.
     "Remember me" keeps the admin signed in after the browser closes;
     otherwise the sign-in ends with the browser session.
     The password never goes into the page address.
   ========================================================================== */

import { app } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

var auth = getAuth(app);
var db = getFirestore(app);

var form = document.querySelector(".mw-auth__main .mw-form");
var email = document.getElementById("email");
var password = document.getElementById("password");
var remember = document.getElementById("remember");
var signInButton = form && form.querySelector("button[type='submit']");
var signInError = form && form.querySelector(".mw-alert--error");

/* What each Firebase error means for the person signing in */
var SIGN_IN_MESSAGES = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-login-credentials": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-email": "That email address isn't valid.",
  "auth/user-disabled": "This account has been turned off.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes, then try again.",
  "auth/network-request-failed": "Can't reach Firebase. Check the internet connection, then try again.",
  "not-admin": "This account isn't an admin account."
};

function showError(alert, code) {
  alert.textContent = SIGN_IN_MESSAGES[code] || "Couldn't sign in (" + (code || "unknown error") + "). Try again.";
  alert.hidden = false;
}

function filledIn() {
  return email.value.trim() !== "" && password.value !== "";
}

/* Signs in and confirms the account is an admin (admins/<uid> exists) */
function signInAsAdmin(keep) {
  return setPersistence(auth, keep ? browserLocalPersistence : browserSessionPersistence)
    .then(function () { return signInWithEmailAndPassword(auth, email.value.trim(), password.value); })
    .then(function (credential) {
      return getDoc(doc(db, "admins", credential.user.uid)).then(function (snapshot) {
        if (snapshot.exists()) return credential.user;
        return signOut(auth).then(function () {
          var error = new Error("not-admin");
          error.code = "not-admin";
          throw error;
        });
      });
    });
}

/* ───────────── sign in ───────────── */

var params = new URLSearchParams(window.location.search);
var busy = false;

// Anything remembered from an earlier sign-in in this tab (sidebar name, cached page data) goes.
if (params.has("signed_out") || params.has("not_admin")) {
  try {
    Object.keys(sessionStorage).forEach(function (key) {
      if (key.indexOf("mowmmas.") === 0) sessionStorage.removeItem(key);
    });
  } catch (error) { /* nothing stored */ }
}

if (form && signInButton && signInError) {
  // No sending the form to another page: the email and password must never show up in an address.
  signInButton.removeAttribute("formaction");

  if (params.has("not_admin")) showError(signInError, "not-admin");

  // Already signed in as an admin (and not just signed out): go straight to the dashboard.
  if (!params.has("signed_out") && !params.has("not_admin")) {
    var stop = onAuthStateChanged(auth, function (user) {
      stop();
      if (!user || busy) return;
      getDoc(doc(db, "admins", user.uid))
        .then(function (snapshot) { if (snapshot.exists()) window.location.replace("dashboard.html"); })
        .catch(function () { /* stay on the sign-in page */ });
    });
  }

  form.addEventListener("submit", function (event) {
    // Empty fields: let the design's required-field check show its messages.
    if (!filledIn()) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    signInError.hidden = true;
    signInButton.classList.add("is-loading");
    signInButton.disabled = true;

    signInAsAdmin(remember.checked)
      .then(function () { window.location.replace("dashboard.html"); })
      .catch(function (error) {
        busy = false;
        signInButton.classList.remove("is-loading");
        signInButton.disabled = false;
        showError(signInError, error && error.code);
        password.select();
      });
  });
}
