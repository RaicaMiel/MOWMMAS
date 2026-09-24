/* ==========================================================================
   MOWMMAS Admin · Settings

   - Program profile: there are no program settings in Firebase yet, so
     Save profile says it isn't connected and saves nothing.
   - SMS gateway: PhilSMS, as the MOWMMAS server reports it (admin-sms.js getGateway):
     the sender name, the last 4 characters of the key, and whether it's connected.
   - Admin accounts: the signed-in admin (admins/<uid>). Firestore lets an
     admin read only their own record, so only that account is listed.
   - Data freshness: STALE_AFTER_DAYS (admin-data.js), the rule every page uses for "Needs updating".
   ========================================================================== */

import { ready, esc } from "./admin-session.js";
import { STALE_AFTER_DAYS } from "./admin-data.js";
import { notConnected } from "./admin-ui.js";
import { getGateway } from "./admin-sms.js";

var profileForm = document.querySelector("#program_profile form");
var accountList = document.querySelector("#admin_accounts .mw-inset-list");

/* ───────────── Save profile isn't connected yet ─────────────
   Registered before mowmmas.js adds its listeners on DOMContentLoaded,
   so this runs first. Empty required fields are left to the design's check. */

notConnected(profileForm, null);   // shows the "not connected" text the page ships

/* Data freshness: the same number every page uses */
var staleSelect = document.getElementById("stale_after_days");
if (staleSelect && staleSelect.querySelector('option[value="' + STALE_AFTER_DAYS + '"]')) staleSelect.value = String(STALE_AFTER_DAYS);

/* ───────────── SMS gateway ───────────── */

var senderInput = document.getElementById("sender_name");
var keyInput = document.getElementById("api_key");
var gatewayStatus = document.querySelector("#sms_gateway .mw-status");

// Only the words change: the icon the design puts before them stays
function setGatewayStatus(connected, text) {
  if (!gatewayStatus) return;
  gatewayStatus.className = "mw-status" + (connected ? " mw-status--success" : "");
  var icon = gatewayStatus.querySelector("svg");
  gatewayStatus.textContent = text;
  if (icon) gatewayStatus.insertBefore(icon, gatewayStatus.firstChild);
}

function showGateway() {
  getGateway()
    .then(function (g) {
      if (!g.configured) {
        setGatewayStatus(false, "Not set up yet. Add PHILSMS_API_TOKEN to User/Admin/Backend/.env, then restart the MOWMMAS server.");
        return;
      }
      if (senderInput) senderInput.value = g.sender || "PhilSMS default sender";
      if (keyInput) keyInput.value = "••••••••••••" + (g.keyHint || "");
      if (g.connected && g.senderProblem) {
        setGatewayStatus(false, "Connected to PhilSMS, but it hasn't approved the sender name" + (g.sender ? ' "' + g.sender + '"' : "") +
          " yet, so no SMS can go out. Check Sending > Sender ID in the PhilSMS dashboard." + (g.balance ? " " + g.balance + " credit left." : ""));
      } else if (g.connected) {
        setGatewayStatus(true, "Connected to PhilSMS" + (g.balance ? ". " + g.balance + " credit left" : "") + (g.expiresOn ? ", valid until " + g.expiresOn : "") + ".");
      } else {
        setGatewayStatus(false, g.problem === "refused"
          ? "Set up, but PhilSMS refused the key: " + (g.error || "").replace(/^PhilSMS: /, "") + " Check PHILSMS_API_TOKEN in User/Admin/Backend/.env."
          : "Set up, but PhilSMS can't be reached right now. " + (g.error || ""));
      }
    })
    .catch(function (error) {
      setGatewayStatus(false, (error && error.message) || "The SMS gateway couldn't be checked.");
    });
}

/* ───────────── the signed-in admin ───────────── */

function roleLabel(role) {
  var text = String(role || "admin").replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

ready.then(function (session) {
  showGateway();
  if (!accountList) return;
  var user = session.user || {};
  var admin = session.admin || {};
  var email = user.email || admin.email || "";
  // Same name as "Signed in as" in the sidebar, with the email and role under it.
  var name = admin.name || "Admin";
  var meta = (email ? email + " · " : "") + roleLabel(admin.role);

  accountList.innerHTML =
    '<li class="mw-inset">' +
      "<div>" +
        '<p class="mw-inset__title">' + esc(name) + "</p>" +
        '<p class="mw-inset__meta">' + esc(meta) + "</p>" +
      "</div>" +
      '<span class="mw-chip mw-chip--success">Active</span>' +
    "</li>";
}).catch(function () {
  // Firebase unreachable: admin-session.js shows the error; the page keeps its static text.
});
