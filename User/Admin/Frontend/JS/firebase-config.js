/* ==========================================================================
   MOWMMAS · Firebase (project "mowmmas")

   The web config from the Firebase console. It only identifies the project,
   so it is safe in the page; what each visitor may do is decided by
   Firebase (Authentication settings and security rules).

   The admin pages have no build step, so the SDK is loaded as ES modules
   from Google's CDN. Pages import `app` from this file:
     import { app } from "./firebase-config.js";
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAvIN2Hr93WwD0qLo5jbkBNOOhJw37Oyqc",
  authDomain: "mowmmas.firebaseapp.com",
  projectId: "mowmmas",
  storageBucket: "mowmmas.firebasestorage.app",
  messagingSenderId: "515420075487",
  appId: "1:515420075487:web:f55591caa457f0328b806a",
  measurementId: "G-KZQ9CSZRSL"
};

export const app = initializeApp(firebaseConfig);

// Analytics only where the browser supports it (it needs cookies and IndexedDB).
isSupported()
  .then(function (supported) { if (supported) getAnalytics(app); })
  .catch(function () { /* analytics is optional */ });
