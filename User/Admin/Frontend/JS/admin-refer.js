/* ==========================================================================
   MOWMMAS Admin · The Refer dialog (Donation inquiries and Milk requests)

   setUpRefer({ modal, select, note, noun, submission, facility, onOpen, onSaved })
     modal       the <dialog> (#refer_modal)
     select      its facility <select>, note its note <textarea>
     noun        "donation inquiry" or "milk request", for messages
     submission  ref → the submission shown in that row
     facility    id → the facility chosen in the list
     onOpen      (submission, trigger) → the page's own touches (e.g. the hint)
     onSaved     (updated submission) → the page redraws its row

   Saving: admin-data.js referSubmission (a Firestore transaction). While it
   runs the dialog stays open; if Firebase is slow to answer, after
   SLOW_SAVE_MS the dialog says so and can be closed, and a message says later
   whether it was saved. A result only ever acts on its own mother's dialog.
   ========================================================================== */

import { ready, toast, showPageError } from "./admin-session.js";
import { referSubmission, statusLabel } from "./admin-data.js";
import { hideFormError, holdDialog } from "./admin-ui.js";

var SLOW_SAVE_MS = 12000;

function referError(error, noun) {
  var code = (error && error.code) || "";
  if (code === "final") return "This " + noun + " is already " + statusLabel(error.detail).toLowerCase() + ", so it can't be referred.";
  if (code === "same-facility") return "It's already referred to " + error.detail + ". Choose a different facility.";
  if (code === "not-found") return "This " + noun + " is no longer in Firebase. Refresh the page.";
  if (code === "permission-denied") return "Firebase didn't allow saving the referral. Sign out and sign in again, then try again.";
  if (code === "unavailable" || code === "failed-precondition" || code === "auth/network-request-failed") {
    return "Can't reach Firebase, so the referral wasn't saved. Check the internet connection, then try again.";
  }
  return "The referral couldn't be saved (" + (code || "unknown error") + "). Try again.";
}

export function setUpRefer(options) {
  var modal = options.modal;
  var form = modal.querySelector("form");
  var alert = form.querySelector(".mw-alert--error");
  var button = form.querySelector("button[type='submit']");
  var hold = holdDialog(modal);

  var session = null;
  ready.then(function (s) { session = s; }).catch(function () { /* the page shows the sign-in error */ });

  var openRef = null;     // the submission whose dialog is open
  var current = 0;        // the save that owns the dialog's buttons (0: none)

  modal.addEventListener("mw:modal-open", function (event) {
    var trigger = event.detail && event.detail.trigger;
    var row = trigger && trigger.closest("tr[data-ref]");
    openRef = row ? row.getAttribute("data-ref") : null;
    hideFormError(modal);
    if (options.onOpen) options.onOpen(openRef ? options.submission(openRef) : null, trigger);
  });
  modal.addEventListener("close", function () {
    hideFormError(modal);
  });

  function show(tone, message) {
    alert.className = "mw-alert mw-alert--" + tone;
    alert.textContent = message;
    alert.hidden = false;
  }

  form.addEventListener("submit", function (event) {
    if (current) { event.preventDefault(); return; }
    if (!options.select.value) return;          // the design's check shows "Choose a facility."
    event.preventDefault();

    var s = openRef ? options.submission(openRef) : null;
    var f = options.facility(options.select.value);
    if (!s || !f) {
      show("error", "Choose a facility from the list.");
      return;
    }

    var ref = s.ref;
    var who = (s.contact && s.contact.name) || ref;
    var id = Date.now() + Math.random();
    var mine = function () { return current === id; };
    var ownDialog = function () { return modal.open && openRef === ref; };
    var release = function () {
      if (!mine()) return;
      current = 0;
      hold.release();
      button.disabled = false;
      button.classList.remove("is-loading");
    };

    current = id;
    hold.hold();
    alert.hidden = true;
    button.disabled = true;
    button.classList.add("is-loading");

    var slow = false;
    var slowTimer = setTimeout(function () {
      if (!mine()) return;
      slow = true;
      release();
      if (ownDialog()) show("warning", "This is taking longer than usual. You can close this window. A message will say when the referral is saved, or if it wasn't.");
    }, SLOW_SAVE_MS);

    referSubmission(ref, f, options.note.value, session && session.user && session.user.email)
      .then(function (updated) {
        clearTimeout(slowTimer);
        var closeIt = ownDialog() && (mine() || slow);
        release();
        options.onSaved(updated);
        if (closeIt) modal.close();
        toast("Referred " + who + " to " + f.name + ". Saved in Firebase.");
      })
      .catch(function (error) {
        clearTimeout(slowTimer);
        var message = referError(error, options.noun);
        if (ownDialog() && (mine() || slow)) show("error", message);
        else showPageError("The referral for " + who + " wasn't saved. " + message);
        release();
      });
  });
}
