/* ==========================================================================
   MOWMMAS Admin · Small helpers the pages share
   (mobile numbers, SMS text, table cells and pages, forms and dialogs)
   ========================================================================== */

import { esc } from "./admin-session.js";

/* The page's HTML is parsed (module scripts run just before DOMContentLoaded) */
export var domReady = new Promise(function (resolve) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resolve, { once: true });
  else resolve();
});

/* ───────────── mobile numbers ───────────── */

// "0917-123-4567", "+63 917 123 4567", "9171234567" → "09171234567"
export function mobileKey(value) {
  var digits = String(value == null ? "" : value).replace(/\D/g, "");
  if (digits.length === 12 && digits.indexOf("63") === 0) digits = "0" + digits.slice(2);
  if (digits.length === 10 && digits.charAt(0) === "9") digits = "0" + digits;
  return digits;
}

export function isMobile(key) {
  return /^09\d{9}$/.test(key);
}

// "09171234567" → "0917-123-4567"; anything else stays as it was typed
export function formatMobile(value) {
  var key = mobileKey(value);
  if (isMobile(key)) return key.slice(0, 4) + "-" + key.slice(4, 7) + "-" + key.slice(7);
  return String(value == null ? "" : value).trim();
}

/* ───────────── text ───────────── */

// "Juana Dela Cruz" → "Juana"; "Ma. Cristina Reyes" → "Ma. Cristina" (as the mother backend does)
export function firstName(name) {
  var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (/^(ma|sta|sto)\.$/i.test(parts[0]) && parts[1]) return parts[0] + " " + parts[1];
  return parts[0];
}

export function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

export function plainText(html) {
  return String(html).replace(/<[^>]*>/g, "");
}

// Table cell pieces from the design: muted text, and a second line under a value
export function muted(text) {
  return '<span class="mw-text-muted">' + esc(text) + "</span>";
}

export function sub(text) {
  return text ? '<span class="mw-table__sub">' + esc(text) + "</span>" : "";
}

/* ───────────── SMS ───────────── */

export var SMS_MAX = 160;

// The first message that fits in one SMS
export function fitSms(options) {
  for (var i = 0; i < options.length; i++) {
    if (options[i].length <= SMS_MAX) return options[i];
  }
  return options[options.length - 1].slice(0, SMS_MAX);
}

/* ───────────── forms and dialogs ───────────── */

export function hasEmptyRequired(form) {
  return Array.prototype.some.call(form.querySelectorAll("[required]:not(:disabled)"), function (control) {
    if (control.type === "checkbox") return !control.checked;
    return String(control.value || "").trim() === "";
  });
}

/* A dialog's message bar back to hidden, in its error style */
export function hideFormError(dialog) {
  var alert = dialog && dialog.querySelector(".mw-alert--error, .mw-alert--warning");
  if (!alert) return;
  alert.hidden = true;
  alert.className = "mw-alert mw-alert--error";
}

/* An action that isn't connected yet: it says so and never claims success.
   Registered before mowmmas.js's own submit listeners (module scripts run
   before DOMContentLoaded). With a required field empty, the design's check
   runs and shows the field error. message: the sentence to show, or null to
   show the text the page ships in the form's error bar. */
export function notConnected(form, message) {
  if (!form) return;
  var alert = form.querySelector(".mw-alert--error");
  form.addEventListener("submit", function (event) {
    if (hasEmptyRequired(form)) {
      if (alert) alert.hidden = true;
      return;
    }
    event.preventDefault();
    if (!alert) return;
    if (message) alert.textContent = message;
    alert.hidden = false;
  });
  var dialog = form.closest("dialog");
  if (dialog && alert) dialog.addEventListener("close", function () { alert.hidden = true; });
}

/* ───────────── pages under a long table ─────────────
   PAGE_SIZE rows at a time, with numbered pages under the table (mw-pager):
     var pager = createPager({ after: tableWrap, label: "Facilities pages", onChange: redraw });
     pager.slice(list)   the rows of the page shown (the page is kept in range),
                         and draws "Showing 1 to 10 of 18" with the page numbers
     pager.show(index)   turn to the page that has list[index]
     pager.reset()       back to page 1 (e.g. the filters changed)
     pager.caption()     ", page 2 of 3" for the table caption ("" with one page)
   Clicking a number calls onChange, which draws the table again. */
var PAGE_SIZE = 10;

// The page numbers to show: all of them, or the first, the last and the ones
// around the current page, with a gap (null) between
function pageNumbers(page, count) {
  if (count <= 7) return Array.from({ length: count }, function (x, i) { return i; });
  var list = [0];
  var start = Math.max(1, Math.min(page - 1, count - 4));
  var end = Math.min(count - 2, Math.max(page + 1, 3));
  if (start > 1) list.push(null);
  for (var i = start; i <= end; i++) list.push(i);
  if (end < count - 2) list.push(null);
  list.push(count - 1);
  return list;
}

export function createPager(options) {
  var nav = document.createElement("nav");
  nav.className = "mw-pager";
  nav.hidden = true;
  nav.setAttribute("aria-label", options.label);
  options.after.parentNode.insertBefore(nav, options.after.nextSibling);

  var pager = { page: 0, count: 1 };

  function draw(total, from, shown) {
    nav.hidden = pager.count <= 1;
    if (nav.hidden) {
      nav.innerHTML = "";
      return;
    }
    nav.innerHTML =
      '<p class="mw-pager__summary">Showing ' + (from + 1) + " to " + (from + shown) + " of " + total + "</p>" +
      '<div class="mw-pager__pages">' + pageNumbers(pager.page, pager.count).map(function (i) {
        if (i === null) return '<span class="mw-pager__gap" aria-hidden="true">…</span>';
        var current = i === pager.page;
        return '<button class="mw-btn mw-btn--sm ' + (current ? "mw-btn--primary" : "mw-btn--outline") + '" type="button" data-page="' + i + '"' +
          (current ? ' aria-current="page"' : "") + ' aria-label="Page ' + (i + 1) + '">' + (i + 1) + "</button>";
      }).join("") + "</div>";
  }

  pager.slice = function (list) {
    pager.count = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    pager.page = Math.min(Math.max(pager.page, 0), pager.count - 1);
    var from = pager.page * PAGE_SIZE;
    var rows = list.slice(from, from + PAGE_SIZE);
    draw(list.length, from, rows.length);
    return rows;
  };
  pager.show = function (index) {
    if (index >= 0) pager.page = Math.floor(index / PAGE_SIZE);
  };
  pager.reset = function () {
    pager.page = 0;
  };
  pager.caption = function () {
    return pager.count > 1 ? ", page " + (pager.page + 1) + " of " + pager.count : "";
  };

  nav.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-page]");
    if (!button || button.getAttribute("aria-current") === "page") return;
    pager.page = Number(button.getAttribute("data-page"));
    options.onChange();
    var current = nav.querySelector("[aria-current='page']");
    if (current) current.focus();
  });

  return pager;
}

/* Keep a dialog open while it saves: Cancel and X are disabled, and Esc or a
   click on the backdrop do nothing. (The browser still lets a second Esc
   through as a safety valve, so saves must also check the dialog is still theirs.) */
export function holdDialog(dialog) {
  var held = false;
  dialog.addEventListener("cancel", function (event) {
    if (held) event.preventDefault();
  });
  dialog.addEventListener("click", function (event) {
    // capture phase: runs before mowmmas.js's backdrop click, which would close the dialog
    if (held && event.target === dialog) event.stopImmediatePropagation();
  }, true);
  function set(on) {
    held = on;
    dialog.querySelectorAll("[data-modal-close]").forEach(function (button) { button.disabled = on; });
  }
  return {
    hold: function () { set(true); },
    release: function () { set(false); },
    isHeld: function () { return held; }
  };
}
