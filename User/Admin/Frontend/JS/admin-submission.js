/* ==========================================================================
   MOWMMAS Admin · A mother's submission: what she sent, and its status
   (Donation inquiries, Milk requests, Records & reports)

   setUpSubmissionView({ modal, submission, onSaved, reveal })
     modal       the <dialog> (#submission_modal)
     submission  ref → that submission as the page has it
     onSaved     (submission as it is now) → the page redraws it
     reveal      optional: ref → the page draws that row (e.g. turns to its table page)

   View (a row's [data-modal-open="submission_modal"]) opens the dialog with
   everything the mother sent: her contact details, her answers, her
   question or notes, where she was referred, and the status history. Below
   that the admin sets the status and can leave her a message, which she
   sees on Track Submission.

   Saving: admin-data.js updateSubmissionStatus (a Firestore transaction).
   While it runs the dialog stays open. If Firebase is slow to answer, after
   SLOW_SAVE_MS the dialog says so and can be closed, and a message says
   later whether it was saved. One save at a time; a result only ever acts
   on the dialog it came from.

   A link with ?ref=<reference> (the bell) opens that submission's dialog:
   call openFromLink() once the page has drawn its rows, or
   openFromLink({ fresh: false }) when they are the tab's saved copy because
   Firebase couldn't be read.
   ========================================================================== */

import { auth, esc, toast, showPageError } from "./admin-session.js";
import {
  updateSubmissionStatus,
  STATUS_FLOW,
  motherStatusLabel,
  statusLabel,
  formatDate,
  formatDateTime
} from "./admin-data.js";
import { formatMobile, capitalize, hideFormError, holdDialog } from "./admin-ui.js";

var SLOW_SAVE_MS = 12000;

// A reference number, like MOW-D-2026-00002 (same as the backends)
var REF_PATTERN = /^MOW-[DRI]-\d{4}-\d{5,}$/;

/* ───────────── what the mother's answers mean ─────────────
   The options on her forms (User/Mother/Frontend/js/form.js) */
export var ANSWERS = {
  donate: {
    babyAge: { "0-1m": "less than 1 month", "1-3m": "1 to 3 months", "4-6m": "4 to 6 months", "7-12m": "7 to 12 months", "12m+": "over 12 months" },
    delivery: { dropoff: "Drop-off", pickup: "Pick-up" },
    preferredTime: { morning: "morning", afternoon: "afternoon", any: "any time" },
    screening: [
      ["healthy", "In good health right now"],
      ["nonSmoker", "Doesn't smoke or vape"],
      ["noMedication", "Not taking any regular medicine"],
      ["noTransfusion", "No blood transfusion in the last 12 months"],
      ["willingToScreen", "Willing to have the facility's screening and blood tests"]
    ]
  },
  request: {
    relationship: { mother: "Mother", father: "Father", guardian: "Guardian or relative", health_worker: "Health worker" },
    babyAge: { "0-7d": "0 to 7 days", "1-4w": "1 to 4 weeks", "1-3m": "1 to 3 months", "4-6m": "4 to 6 months", "6m+": "over 6 months" },
    reasons: {
      preterm: "preterm",
      low_birth_weight: "low birth weight",
      low_supply: "low milk supply",
      mother_ill: "mother sick or on medicine",
      nicu: "in the NICU",
      adoption: "adopted or apart from the mother",
      other: "other reason"
    },
    admitted: { yes: "admitted now", scheduled: "admission scheduled" },
    urgency: {
      "24h": { label: "Within 24 hours", tone: "danger" },
      week: { label: "Within this week", tone: "warning" },
      planning: { label: "Planning ahead", tone: "info" }
    },
    hasReferral: { yes: "Yes", no: "No", unsure: "Not sure" }
  },
  inquire: {
    topic: {
      availability: "Donor milk availability",
      requirements: "Requirements and documents",
      donating: "How to donate milk",
      requesting: "How to request milk",
      lactation: "Breastfeeding help",
      other: "Something else"
    },
    preferredContact: { sms: "Text message (SMS)", call: "Phone call" }
  }
};

var TITLES = { donate: "Donation inquiry", request: "Milk request", inquire: "Question" };

// What the mother reads on Track Submission for each status (User/Mother/Frontend/js/status.js)
var MOTHER_SEES = {
  under_review: "A health worker is checking your details.",
  screening_scheduled: "Your health screening has a date. Watch for an SMS with the details.",
  accepted: "Your donation was accepted. The facility will tell you how to bring or send your milk.",
  approved: "Your request was approved. The facility will tell you how to get the milk.",
  ready_for_pickup: "The donor milk is ready. Please go to the facility to collect it, and call first if you can.",
  answered: "A health worker answered your question. See the messages below or your SMS.",
  completed: "All done. Thank you for using MOWMMAS.",
  closed: "This question is closed. You can send a new question anytime.",
  declined: "The facility could not go ahead this time. Check the messages below, or call the facility to ask why."
};

/* ───────────── what she sent, as rows ───────────── */

function text(value) {
  return value == null ? "" : String(value).trim();
}

// Text as HTML, with its line breaks kept
function lines(value) {
  return esc(value).replace(/\r?\n/g, "<br>");
}

// One row: a small label, then the value, then optional lines under it
function fact(label, value, extra) {
  if (!text(value)) return "";
  return '<li class="mw-list__item"><p class="mw-list__meta">' + esc(label) + "</p>" +
    '<p class="mw-list__title">' + esc(value) + "</p>" +
    (extra || []).filter(function (line) { return text(line); }).map(function (line) {
      return '<p class="mw-list__meta">' + lines(line) + "</p>";
    }).join("") + "</li>";
}

function donateFacts(d) {
  var a = ANSWERS.donate;
  var plan = [];
  var how = a.delivery[d.delivery] || "";
  var when = formatDate(d.preferredDate);
  if (how && when) plan.push(how + " on " + when);
  else if (how || when) plan.push(how || "On " + when);
  if (a.preferredTime[d.preferredTime]) plan.push(a.preferredTime[d.preferredTime]);

  var screening = d.screening || {};
  var yes = a.screening.filter(function (q) { return screening[q[0]] === true; }).map(function (q) { return q[1]; });
  var no = a.screening.filter(function (q) { return screening[q[0]] !== true; }).map(function (q) { return q[1]; });

  return fact("Her age", d.age) +
    fact("Baby's age", capitalize(a.babyAge[d.babyAge] || "")) +
    fact("Plan", plan.join(", ")) +
    fact("Amount", d.estimatedVolume) +
    fact("Health answers she ticked", yes.join("; ") || "None", no.length ? ["Not ticked: " + no.join("; ")] : []);
}

function requestFacts(d) {
  var a = ANSWERS.request;
  var reasons = (Array.isArray(d.reasons) ? d.reasons : (d.reasons ? [d.reasons] : [])).map(function (r) { return a.reasons[r] || String(r); });
  if (a.admitted[d.admitted]) reasons.push(a.admitted[d.admitted]);
  var baby = [text(d.babyName), a.babyAge[d.babyAge] || ""].filter(Boolean).join(", ");
  var urgency = a.urgency[d.urgency];
  return fact("Who is asking", a.relationship[d.relationship]) +
    fact("Baby", capitalize(baby)) +
    fact("Why the baby needs donor milk", capitalize(reasons.join(", "))) +
    fact("How soon", urgency ? urgency.label : "") +
    fact("Amount needed", d.amountNeeded) +
    fact("Doctor's referral", a.hasReferral[d.hasReferral]);
}

function inquireFacts(d) {
  var a = ANSWERS.inquire;
  return fact("About", a.topic[d.topic] || d.topic) +
    fact("Reply by", a.preferredContact[d.preferredContact]);
}

function factsHtml(s) {
  var c = s.contact || {};
  var d = s.details || {};
  var html = fact("Name", c.name || "Name not given") +
    fact("Mobile", formatMobile(c.mobile) || "Not given", [c.email]) +
    fact("Address", [c.barangay, c.municipality].filter(function (v) { return text(v); }).join(", ") || "Not given") +
    fact("Sent to", s.facilityName || "No facility chosen", [s.createdAt ? "On " + formatDateTime(s.createdAt) : ""]);
  var r = s.referral;
  if (r && r.facilityName) {
    html += fact("Referred to", r.facilityName, [
      [r.referredAt ? "On " + formatDateTime(r.referredAt) : "", r.referredBy ? "by " + r.referredBy : ""].filter(Boolean).join(" "),
      r.note ? "Note: " + r.note : ""
    ]);
  }
  if (s.type === "donate") html += donateFacts(d);
  else if (s.type === "request") html += requestFacts(d);
  else if (s.type === "inquire") html += inquireFacts(d);
  return html;
}

// Her question, or her notes, in full
function writing(s) {
  var d = s.details || {};
  if (s.type === "inquire") return { title: "Her question", text: text(d.question) };
  return { title: "Her notes", text: text(d.notes) };
}

function historyHtml(s) {
  var list = Array.isArray(s.statusHistory) ? s.statusHistory.slice().reverse() : [];
  return list.map(function (h) {
    var by = h.by === "mother" ? "by the mother" : h.byEmail ? "by " + h.byEmail : h.by === "admin" ? "by an admin" : "";
    return '<li class="mw-list__item"><p class="mw-list__title">' + esc(h.status === "submitted" ? "Sent" : motherStatusLabel(h.status)) + "</p>" +
      '<p class="mw-list__meta">' + esc([formatDateTime(h.at), by].filter(Boolean).join(" · ")) + "</p>" +
      (h.note ? '<p class="mw-list__meta">' + lines(h.status === "submitted" || h.by !== "admin" ? h.note : "Message: " + h.note) + "</p>" : "") +
      "</li>";
  }).join("");
}

/* ───────────── the dialog ───────────── */

function statusError(error) {
  var code = (error && error.code) || "";
  if (code === "changed") return "Someone else changed it to " + statusLabel(error.detail) + " since you opened it. Check it, then save again.";
  if (code === "no-change") return "Choose a new status, or write a message for the mother.";
  if (code === "bad-status") return "Choose a status from the list.";
  if (code === "not-found") return "This submission is no longer in Firebase. Refresh the page.";
  if (code === "permission-denied") return "Firebase didn't allow saving it. Sign out and sign in again, then try again.";
  if (code === "unavailable" || code === "failed-precondition" || code === "auth/network-request-failed") {
    return "Can't reach Firebase, so it wasn't saved. Check the internet connection, then try again.";
  }
  return "It couldn't be saved (" + (code || "unknown error") + "). Try again.";
}

export function setUpSubmissionView(options) {
  var modal = options.modal;
  var form = modal.querySelector("form");
  var title = modal.querySelector("h2");
  var alert = form.querySelector(".mw-alert--error");
  var button = form.querySelector("button[type='submit']");
  var select = document.getElementById("submission_status");
  var hint = document.getElementById("submission_status_hint");
  var message = document.getElementById("submission_message");
  var textBox = modal.querySelector("[data-submission-text]");
  var facts = modal.querySelector("[data-submission-facts]");
  var historyField = modal.querySelector("[data-submission-history]");
  var history = historyField.querySelector("ul");
  var hold = holdDialog(modal);

  var shown = null;     // { ref, expected }: the submission in the dialog, and the status it had
  var lastRef = null;   // the submission the dialog last showed (for focus when it closes)
  var lastWrap = null;  // the table it was opened from
  var opened = 0;       // counts openings, so a save acts only on the dialog it came from
  var saving = false;   // one save at a time

  // The message bar is at the top of the dialog: scroll up so it shows below the header
  function show(tone, text) {
    alert.className = "mw-alert mw-alert--" + tone;
    alert.textContent = text;
    alert.hidden = false;
    modal.scrollTop = 0;
  }

  function setLoading(on) {
    button.disabled = on;
    button.classList.toggle("is-loading", on);
  }

  function hintFor(status) {
    if (shown && status === shown.expected) {
      return "This is the status now. Choose a new one, or keep it and write her a message.";
    }
    return MOTHER_SEES[status] ? "She'll see: “" + MOTHER_SEES[status] + "”" : "";
  }

  // Shows s in the dialog. keepMessage: leave what the admin typed.
  function fill(s, keepMessage) {
    shown = s ? { ref: s.ref, expected: s.status } : null;
    title.textContent = (s && TITLES[s.type]) || "Submission";
    if (!keepMessage) message.value = "";
    if (!s) {
      facts.innerHTML = fact("Not found", "This submission isn't on the page anymore. Refresh the page.");
      textBox.hidden = true;
      historyField.hidden = true;
      select.innerHTML = "";
      button.disabled = true;
      return;
    }

    facts.innerHTML = factsHtml(s);
    var w = writing(s);
    textBox.hidden = !w.text;
    textBox.querySelector(".mw-preview__title").textContent = w.title;
    textBox.querySelector(".mw-preview__text").innerHTML = lines(w.text);
    history.innerHTML = historyHtml(s);
    historyField.hidden = !history.children.length;

    // Every status this kind of submission can move to, with the one it has
    // now chosen. A new one ("submitted") starts at its first step instead.
    select.innerHTML = "";
    var flow = (STATUS_FLOW[s.type] || []).filter(function (status) { return status !== "submitted"; });
    if (s.status && s.status !== "submitted" && flow.indexOf(s.status) === -1) flow.unshift(s.status);
    flow.forEach(function (status) {
      var option = document.createElement("option");
      option.value = status;
      option.textContent = statusLabel(status) + (status === s.status ? " (now)" : "");
      select.appendChild(option);
    });
    select.value = flow.indexOf(s.status) !== -1 ? s.status : flow[0] || "";
    hint.textContent = hintFor(select.value);
    button.disabled = !flow.length;
  }

  // The View button of ref's row (the rows are redrawn after a save). A
  // submission can be in more than one tab: the one on screen wins, else the first.
  function triggerFor(ref) {
    var buttons = Array.prototype.filter.call(document.querySelectorAll("[data-ref]"), function (el) {
      return el.getAttribute("data-ref") === ref;
    }).map(function (row) {
      return row.querySelector("[data-modal-open='" + modal.id + "']");
    }).filter(Boolean);
    var shownOnScreen = buttons.filter(function (button) { return button.getClientRects().length > 0; });
    return shownOnScreen[0] || buttons[0] || null;
  }

  select.addEventListener("change", function () { hint.textContent = hintFor(select.value); });

  modal.addEventListener("mw:modal-open", function (event) {
    opened += 1;
    var trigger = event.detail && event.detail.trigger;
    var row = trigger && trigger.closest("[data-ref]");
    var ref = row ? row.getAttribute("data-ref") : null;
    lastRef = ref;
    lastWrap = trigger ? trigger.closest(".mw-table-wrap[tabindex]") : null;
    hold.release();
    setLoading(false);
    hideFormError(modal);
    fill(ref ? options.submission(ref) : null);
    // Start at the top (a closed dialog keeps its scroll position); showModal runs after this event
    setTimeout(function () { if (modal.open) modal.scrollTop = 0; }, 0);
  });

  modal.addEventListener("close", function () {
    // Closed while saving (the browser lets a second Esc through): the save
    // carries on, and a message says how it went.
    hold.release();
    setLoading(false);
    hideFormError(modal);
    // The rows may have been redrawn while it was open: focus goes back to the
    // same row's button (runs before mowmmas.js's close listener, which focuses it)
    if (!modal.returnFocusTo || !modal.returnFocusTo.isConnected) {
      modal.returnFocusTo = (lastRef && triggerFor(lastRef)) ||
        (lastWrap && lastWrap.isConnected ? lastWrap : null) ||
        document.querySelector(".mw-filters--search input") || null;
    }
  });

  // A save finished for ref: an open dialog showing it shows the latest
  function refreshOpen(latest) {
    if (modal.open && shown && latest && shown.ref === latest.ref) fill(latest, true);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();   // the dialog closes itself once the change is saved
    if (!shown || button.disabled) return;
    if (saving) {
      show("warning", "Your last change is still saving. Wait for its message, then try again.");
      return;
    }
    var s = options.submission(shown.ref);
    if (!s) {
      show("error", "This submission isn't on the page anymore. Refresh the page.");
      return;
    }
    var status = select.value;
    var note = message.value.trim();
    if (status === shown.expected && !note) {
      show("error", "Choose a new status, or write a message for the mother.");
      return;
    }

    var mine = opened;
    var ownDialog = function () { return modal.open && opened === mine; };
    var who = (s.contact && s.contact.name) || s.ref;
    var user = auth.currentUser;

    saving = true;
    hold.hold();
    setLoading(true);
    alert.hidden = true;

    var slowTimer = setTimeout(function () {
      if (!ownDialog()) return;
      hold.release();
      show("warning", "This is taking longer than usual. You can close this window. A message will say when it's saved, or if it wasn't.");
    }, SLOW_SAVE_MS);

    updateSubmissionStatus(s.ref, { status: status, note: note, expected: shown.expected, adminEmail: user && user.email })
      .then(function (updated) {
        clearTimeout(slowTimer);
        saving = false;
        options.onSaved(updated);
        var done = status === s.status
          ? "Message saved for " + who + ". She sees it on Track Submission."
          : who + "'s " + (TITLES[s.type] || "submission").toLowerCase() + " is now " + statusLabel(status) + ". Saved in Firebase.";
        if (ownDialog()) {
          hold.release();
          modal.returnFocusTo = triggerFor(updated.ref) || modal.returnFocusTo;
          modal.close();
        } else if (modal.open) {
          // Closed after the slow notice, and another one is open now: it says so there too
          refreshOpen(updated);
          show("success", "Your last change is done. " + done);
        }
        toast(done);
      }, function (error) {
        clearTimeout(slowTimer);
        saving = false;
        if (error && error.current) options.onSaved(error.current);
        var text = statusError(error);
        if (ownDialog()) {
          hold.release();
          setLoading(false);
          if (error && error.current) fill(error.current, true);
          show("error", text);
        } else {
          refreshOpen(error && error.current);
          if (modal.open) show("error", "Your last change, for " + who + ", wasn't saved. " + text);
          showPageError("The change for " + who + " wasn't saved. " + text);
        }
      });
  });

  // Adds to the page's error bar, so an error already there (e.g. the list couldn't load) stays
  function addPageError(message) {
    var bar = document.querySelector(".mw-page > .mw-alert--error[role='alert']");
    showPageError(bar && !bar.hidden && bar.textContent ? bar.textContent + " " + message : message);
  }

  /* ?ref=<reference> in the address: open that submission once the rows are drawn.
     fresh: false when the page shows the tab's saved copy because Firebase couldn't be read. */
  var linkDone = false;
  function openFromLink(state) {
    if (linkDone) return;
    linkDone = true;
    var raw = new URLSearchParams(window.location.search).get("ref");
    if (raw === null) return;
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete("ref");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (error) { /* the address keeps ?ref= */ }

    // Only a real reference number: anything else in a link is ignored, never shown
    var ref = raw.trim().toUpperCase();
    if (!REF_PATTERN.test(ref)) return;

    if (options.reveal) options.reveal(ref);   // e.g. the table page that has its row
    var trigger = triggerFor(ref);
    if (!trigger) {
      addPageError(state && state.fresh === false
        ? ref + " isn't in the copy of the list shown here. Refresh the page once Firebase can be reached."
        : ref + " isn't in this list. It may have been removed from Firebase.");
      return;
    }
    // In a tab that isn't shown: show that tab first
    var panel = trigger.closest("[role='tabpanel']");
    if (panel && panel.hidden) {
      var tab = document.querySelector("[role='tab'][aria-controls='" + panel.id + "']");
      if (tab) tab.click();
    }
    trigger.click();
  }

  return { openFromLink: openFromLink };
}
