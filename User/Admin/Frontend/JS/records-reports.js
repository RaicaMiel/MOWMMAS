/* ==========================================================================
   MOWMMAS Admin · Records & reports

   Everything on this page comes from Firestore:
     facilities/<id>     facility updates, the HMB chart
     submissions/<ref>   inquiries (donation offers, milk requests, questions)
                         and referrals (submission.referral, saved by Refer)
   and from the MOWMMAS server: every SMS sent through PhilSMS (admin-sms.js getSmsLog)

   "Show records up to" (report_date) limits the History tabs, the CSV and
   the first two KPI cards to records on or before that day.
   Export CSV downloads the History records as a CSV file.
   A mother's name in the Inquiries and Referrals tabs opens what she sent,
   and its status (admin-submission.js); this is where questions are
   answered. ?ref=<reference> (the bell) opens it for that submission.
   ========================================================================== */

import { ready, esc, toast, showPageError, errorMessage } from "./admin-session.js";
import {
  getFacilities,
  getSubmissions,
  cachedFacilities,
  cachedSubmissions,
  STALE_AFTER_DAYS,
  isParticipating,
  isOverdue,
  TYPES,
  statusChip,
  submissionChip,
  hmbStatus,
  facilityUpdatedAt,
  SMS_TYPES,
  smsStatusChip,
  isoDay
} from "./admin-data.js";
import { createPager, formatMobile } from "./admin-ui.js";
import { setUpSubmissionView } from "./admin-submission.js";
import { getSmsLog, cachedSmsLog, smsLogNote } from "./admin-sms.js";

var DAY = 24 * 60 * 60 * 1000;

var exportButton = document.querySelector("[data-export-csv]");
var dateInput = document.getElementById("report_date");
var statValues = document.querySelectorAll(".mw-stat-grid .mw-stat__value");
var statCaptions = document.querySelectorAll(".mw-stat-grid .mw-stat__caption");

var state = { facilities: [], submissions: [], sms: [], smsError: null, loaded: false };

/* ───────────── dates (Philippine time) ───────────── */

function today() {
  return isoDay(new Date().toISOString());
}

// "2026-09-23" plus n days, as "YYYY-MM-DD"
function addDays(day, n) {
  return isoDay(new Date(Date.parse(day + "T12:00:00+08:00") + n * DAY).toISOString());
}

// "Sep 23" (with the year when it isn't this year)
function shortDay(day) {
  var sameYear = day.slice(0, 4) === today().slice(0, 4);
  var options = { timeZone: "Asia/Manila", month: "short", day: "numeric" };
  if (!sameYear) options.year = "numeric";
  return new Date(Date.parse(day + "T12:00:00+08:00")).toLocaleDateString("en-US", options);
}

// "Today", "Yesterday" or "Sep 21", as in the design
function dayLabel(iso) {
  var day = isoDay(iso);
  if (!day) return "";
  var now = today();
  if (day === now) return "Today";
  if (day === addDays(now, -1)) return "Yesterday";
  return shortDay(day);
}

// "2026-09-23 06:05" in Philippine time, for the CSV
function stamp(iso) {
  var t = Date.parse(iso);
  if (!t) return "";
  return new Date(t + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// The day chosen in "Show records up to" (today when empty or in the future)
function reportDay() {
  var now = today();
  var value = dateInput && dateInput.value;
  if (!value || value > now) return now;
  return value;
}

function onOrBefore(iso, day) {
  var d = isoDay(iso);
  return !d || d <= day;
}

/* ───────────── what the records say ───────────── */

function capitalize(text) {
  text = String(text || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

var chipText = document.createElement("span");
function statusText(status) {
  chipText.innerHTML = statusChip(status);
  return chipText.textContent;
}

// Facility status in the History: public and fresh, public but overdue, or not public
function facilityState(f) {
  if (!isParticipating(f)) return { label: "Not public", tone: "" };
  if (isOverdue(f)) return { label: "Needs updating", tone: "warning" };
  return { label: "Published", tone: "success" };
}

function facilityUpdates(day) {
  return state.facilities
    .filter(function (f) {
      var at = facilityUpdatedAt(f);
      return at && isoDay(at) <= day;
    })
    .sort(function (a, b) {
      return (Date.parse(facilityUpdatedAt(b)) || 0) - (Date.parse(facilityUpdatedAt(a)) || 0);
    });
}

function inquiries(day) {
  return state.submissions.filter(function (s) { return onOrBefore(s.createdAt, day); });
}

function updatedByText(f) {
  var by = f.dataStatus && f.dataStatus.updatedBy;
  return by ? "By " + by : "";
}

/* Referrals made up to the chosen day, newest first */
function referrals(day) {
  return state.submissions.filter(function (s) {
    var at = s.referral && s.referral.referredAt;
    var d = at && isoDay(at);
    return d && d <= day;
  }).sort(function (a, b) {
    return (Date.parse(b.referral.referredAt) || 0) - (Date.parse(a.referral.referredAt) || 0);
  });
}

/* SMS up to the chosen day, newest first (the log is newest first already) */
function smsUpTo(day) {
  return state.sms.filter(function (r) { var d = isoDay(r.sentAt); return d && d <= day; });
}

// SMS actually sent (not failed or skipped) in the 7 days ending on day
function smsSentInWeek(day) {
  var from = addDays(day, -7);
  return state.sms.filter(function (r) {
    var d = isoDay(r.sentAt);
    return r.status === "sent" && d > from && d <= day;
  });
}

/* ───────────── KPI cards ───────────── */

function setStat(index, value, caption) {
  if (statValues[index]) statValues[index].textContent = value;
  if (caption && statCaptions[index]) statCaptions[index].textContent = caption;
}

function renderStats(day) {
  var from = addDays(day, -STALE_AFTER_DAYS);
  var recentUpdates = state.facilities.filter(function (f) {
    var d = isoDay(facilityUpdatedAt(f));
    return d && d > from && d <= day;
  }).length;

  var isToday = day === today();
  setStat(0, String(recentUpdates), isToday ? "In the last 30 days" : "In the 30 days to " + shortDay(day));
  setStat(1, String(inquiries(day).length));
  setStat(2, String(referrals(day).length));
  var from4 = addDays(day, -28);
  var smsSent = state.sms.filter(function (r) { var d = isoDay(r.sentAt); return r.status === "sent" && d > from4 && d <= day; }).length;
  var cut = smsCut(from4);
  setStat(3, state.smsError && !state.sms.length ? "–" : String(smsSent) + (cut ? "+" : ""),
    (isToday ? "In the last 4 weeks" : "In the 4 weeks to " + shortDay(day)) + (cut ? " (newest SMS only)" : ""));
}

/* When the server sent only the newest SMS (admin-sms.js smsLogNote), the loaded log is
   complete only after the day of its oldest SMS. smsCut(from): whether the days after
   `from` reach back past that, so a count over them may be short. */
function smsCut(from) {
  if (!smsLogNote() || !state.sms.length) return false;
  var oldest = isoDay(state.sms[state.sms.length - 1].sentAt);
  return Boolean(oldest) && from < oldest;
}

/* ───────────── charts ───────────── */

function n2(value) {
  return String(Math.round(value * 100) / 100);
}

// 0 to 4 steps, so the ticks stay whole numbers
function scaleStep(max) {
  return Math.max(1, Math.ceil(max / 4));
}

// Participating facilities by HMB status, as bars
function renderHmbChart() {
  var figure = document.querySelector("#hmb_chart_title") && document.querySelector("#hmb_chart_title").closest(".mw-card").querySelector(".mw-chart");
  if (!figure) return;
  var svg = figure.querySelector(".mw-chart__svg");
  var caption = figure.querySelector("figcaption");

  var participating = state.facilities.filter(isParticipating);
  var counts = { verified: 0, no: 0, not_verified: 0, unknown: 0 };
  participating.forEach(function (f) { counts[hmbStatus(f)] += 1; });

  // lines: how a label wraps when all four bars are shown
  var bars = [
    { key: "verified", label: "Verified", lines: ["Verified"], series: "mw-chart__series--1" },
    { key: "no", label: "No HMB", lines: ["No HMB"], series: "mw-chart__series--muted" },
    { key: "not_verified", label: "Not verified", lines: ["Not", "verified"], series: "mw-chart__series--2" }
  ];
  if (counts.unknown) bars.push({ key: "unknown", label: "Not reported", lines: ["Not", "reported"], series: "mw-chart__series--muted" });

  var left = 40, right = 428, bottom = 228, top = 16;
  var step = scaleStep(Math.max.apply(null, bars.map(function (b) { return counts[b.key]; })));
  var maxTick = step * 4;
  var y = function (value) { return bottom - (bottom - top) * value / maxTick; };
  var slot = (right - left) / bars.length;
  var barWidth = Math.min(100, slot - 29.33);
  var out = [];

  for (var i = 1; i <= 4; i++) {
    out.push('<line class="mw-chart__grid" x1="40" x2="428" y1="' + n2(y(step * i)) + '" y2="' + n2(y(step * i)) + '"/>');
  }

  bars.forEach(function (bar, index) {
    var value = counts[bar.key];
    if (!value) return;
    var cx = left + slot * (index + 0.5);
    var x0 = cx - barWidth / 2;
    var x1 = cx + barWidth / 2;
    var yTop = y(value);
    var r = Math.min(8, bottom - yTop, barWidth / 2);
    out.push('<path class="mw-chart__bar ' + bar.series + '" d="M' + n2(x0) + " " + bottom + "V" + n2(yTop + r) +
      "Q" + n2(x0) + " " + n2(yTop) + " " + n2(x0 + r) + " " + n2(yTop) +
      "H" + n2(x1 - r) + "Q" + n2(x1) + " " + n2(yTop) + " " + n2(x1) + " " + n2(yTop + r) +
      "V" + bottom + 'Z"/>');
  });

  for (var t = 0; t <= 4; t++) {
    var ty = n2(y(step * t));
    out.push('<line class="mw-chart__axis" x1="35" x2="40" y1="' + ty + '" y2="' + ty + '"/>');
    out.push('<text class="mw-chart__tick" x="30" y="' + ty + '" text-anchor="end" dominant-baseline="middle">' + step * t + "</text>");
  }

  out.push('<line class="mw-chart__axis" x1="40" x2="40" y1="12" y2="228"/>');
  out.push('<line class="mw-chart__axis" x1="40" x2="428" y1="228" y2="228"/>');

  // Four labels don't fit on one line on a phone, so with the "Not reported"
  // bar "Not verified" and "Not reported" go on two lines and the chart grows to fit them.
  var twoLines = bars.length > 3;
  svg.setAttribute("viewBox", twoLines ? "0 0 440 280" : "0 0 440 264");

  bars.forEach(function (bar, index) {
    var cx = n2(left + slot * (index + 0.5));
    out.push('<line class="mw-chart__axis" x1="' + cx + '" x2="' + cx + '" y1="228" y2="233"/>');
    if (twoLines && bar.lines.length > 1) {
      out.push('<text class="mw-chart__label" x="' + cx + '" y="250" text-anchor="middle">' +
        '<tspan x="' + cx + '">' + esc(bar.lines[0]) + "</tspan>" +
        '<tspan x="' + cx + '" dy="1.15em">' + esc(bar.lines[1]) + "</tspan></text>");
    } else {
      out.push('<text class="mw-chart__label" x="' + cx + '" y="' + (twoLines ? 250 : 256) + '" text-anchor="middle">' + esc(bar.label) + "</text>");
    }
  });

  svg.innerHTML = out.join("");

  var parts = [
    plural(counts.verified, "verified Human Milk Bank", "verified Human Milk Banks"),
    counts.no + " with no HMB",
    plural(counts.not_verified, "HMB not yet verified", "HMBs not yet verified")
  ];
  if (counts.unknown) {
    parts.push(counts.unknown + (counts.unknown === 1 ? " that hasn't reported its HMB status" : " that haven't reported their HMB status"));
  }
  caption.textContent = plural(participating.length, "participating facility", "participating facilities") + ": " +
    parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] + ".";
}

// SMS sent per week by type: Update (updates, status updates, "form received"), Reminder, Referral
function renderSmsChart(day) {
  var card = document.querySelector("#sms_chart_title") && document.querySelector("#sms_chart_title").closest(".mw-card");
  if (!card) return;
  var svg = card.querySelector(".mw-chart__svg");
  var table = card.querySelector(".mw-visually-hidden table");

  var weeks = [-21, -14, -7, 0].map(function (offset) {
    var week = { day: addDays(day, offset), update: 0, reminder: 0, referral: 0 };
    smsSentInWeek(week.day).forEach(function (r) {
      if (r.type === "reminder") week.reminder += 1;
      else if (r.type === "referral") week.referral += 1;
      else week.update += 1;
    });
    return week;
  });
  var total = weeks.reduce(function (sum, w) { return sum + w.update + w.reminder + w.referral; }, 0);

  var left = 40, right = 408, bottom = 196, top = 16;
  var step = scaleStep(Math.max.apply(null, weeks.map(function (w) { return Math.max(w.update, w.reminder, w.referral); })));
  var maxTick = step * 4;
  var y = function (value) { return bottom - (bottom - top) * value / maxTick; };
  var x = function (index) { return left + (right - left) * index / (weeks.length - 1); };
  var out = [];

  for (var i = 1; i <= 4; i++) {
    out.push('<line class="mw-chart__grid" x1="40" x2="408" y1="' + n2(y(step * i)) + '" y2="' + n2(y(step * i)) + '"/>');
  }
  for (var t = 0; t <= 4; t++) {
    var ty = n2(y(step * t));
    out.push('<line class="mw-chart__axis" x1="35" x2="40" y1="' + ty + '" y2="' + ty + '"/>');
    out.push('<text class="mw-chart__tick" x="30" y="' + ty + '" text-anchor="end" dominant-baseline="middle">' + step * t + "</text>");
  }
  out.push('<line class="mw-chart__axis" x1="40" x2="40" y1="12" y2="196"/>');
  out.push('<line class="mw-chart__axis" x1="40" x2="408" y1="196" y2="196"/>');
  weeks.forEach(function (week, index) {
    var wx = n2(x(index));
    out.push('<line class="mw-chart__axis" x1="' + wx + '" x2="' + wx + '" y1="196" y2="201"/>');
    out.push('<text class="mw-chart__label" x="' + wx + '" y="224" text-anchor="middle">' + esc(shortDay(week.day)) + "</text>");
  });

  // Drawn Referral, Reminder, then Update on top, as in the design.
  [["referral", "mw-chart__series--3"], ["reminder", "mw-chart__series--2"], ["update", "mw-chart__series--1"]].forEach(function (series) {
    var key = series[0];
    var cls = series[1];
    var d = weeks.map(function (week, index) {
      return (index ? "L" : "M") + n2(x(index)) + " " + n2(y(week[key]));
    }).join("");
    out.push('<path class="mw-chart__line ' + cls + '" d="' + d + '"/>');
    weeks.forEach(function (week, index) {
      out.push('<circle class="mw-chart__dot ' + cls + '" cx="' + n2(x(index)) + '" cy="' + n2(y(week[key])) + '" r="4"/>');
    });
  });

  svg.innerHTML = out.join("");

  if (table) {
    var cut = smsCut(addDays(day, -28));
    table.querySelector("caption").textContent = "SMS sent per week by type, 4 weeks to " + shortDay(day) + ", " + total + (cut ? " or more" : "") + " in total." +
      (cut ? " " + smsLogNote() : total ? "" : state.smsError && !state.sms.length ? " The SMS log couldn't be loaded." : " No SMS has been sent yet.");
    table.querySelector("tbody").innerHTML = weeks.map(function (week) {
      return '<tr><th scope="row"><time datetime="' + week.day + '">' + esc(shortDay(week.day)) + "</time></th>" +
        "<td>" + week.update + "</td><td>" + week.reminder + "</td><td>" + week.referral + "</td></tr>";
    }).join("");
  }
}

/* ───────────── History ───────────── */

/* Each History tab shows 10 records at a time, with numbered pages under the table (admin-ui.js createPager) */
var panels = {};   // panel id → { caption, rows, pager }

function renderPanel(panelId, captionText, rowsHtml) {
  var panel = document.getElementById(panelId);
  if (!panel) return;
  var data = panels[panelId];
  if (!data) {
    data = panels[panelId] = {
      pager: createPager({
        after: panel.querySelector(".mw-table-wrap"),
        label: captionText + " pages",
        onChange: function () { drawPanel(panelId); }
      })
    };
  }
  data.caption = captionText;
  data.rows = rowsHtml;
  drawPanel(panelId);
}

function drawPanel(panelId) {
  var panel = document.getElementById(panelId);
  var data = panels[panelId];
  var wrap = panel.querySelector(".mw-table-wrap");
  var empty = panel.querySelector(".mw-empty");
  var total = data.rows.length;
  var shown = data.pager.slice(data.rows);
  panel.querySelector("caption").textContent = data.caption + ", " + plural(total, "record", "records") + data.pager.caption();
  panel.querySelector("tbody").innerHTML = shown.join("");
  if (wrap) wrap.hidden = total === 0;
  if (empty) empty.hidden = total > 0;
}

// Shows the page of a History tab that has ref's row (a link from the bell may point to page 2)
function revealRef(ref) {
  var mark = 'data-ref="' + esc(ref) + '"';
  ["panel_inquiries", "panel_referrals"].some(function (panelId) {
    var data = panels[panelId];
    var index = data ? data.rows.findIndex(function (row) { return row.indexOf(mark) !== -1; }) : -1;
    if (index === -1) return false;
    data.pager.show(index);
    drawPanel(panelId);
    return true;
  });
}

function dateCell(iso) {
  if (!iso) return '<td class="mw-table__nowrap"><span class="mw-text-muted">Unknown</span></td>';
  return '<td class="mw-table__nowrap"><time datetime="' + esc(isoDay(iso)) + '">' + esc(dayLabel(iso)) + "</time></td>";
}

// The mother's name, which opens what she sent (the submission dialog)
function viewButton(s) {
  var name = (s.contact && s.contact.name) || "";
  return '<button class="mw-link" type="button" data-modal-open="submission_modal" data-modal-context="' + esc(name ? name + " · " + s.ref : s.ref) + '">' +
    esc(name || "Name not given") + '<span class="mw-visually-hidden"> (view)</span></button>';
}

function renderHistory(day) {
  renderPanel("panel_updates", "Facility updates history", facilityUpdates(day).map(function (f) {
    var s = facilityState(f);
    var by = updatedByText(f);
    return "<tr>" +
      dateCell(facilityUpdatedAt(f)) +
      "<td>Information updated" + (by ? '<span class="mw-table__sub">' + esc(by) + "</span>" : "") + "</td>" +
      "<td>" + esc(f.name) + "</td>" +
      '<td><span class="mw-chip' + (s.tone ? " mw-chip--" + s.tone : "") + '">' + esc(s.label) + "</span></td>" +
    "</tr>";
  }));

  renderPanel("panel_inquiries", "Inquiries history", inquiries(day).map(function (s) {
    var type = TYPES[s.type];
    return '<tr data-ref="' + esc(s.ref) + '">' +
      dateCell(s.createdAt) +
      "<td>" + viewButton(s) +
        '<span class="mw-table__sub">' + esc(type ? capitalize(type.verb) : (s.typeLabel || "Inquiry")) +
        (s.ref ? ' · <span class="mw-table__nowrap">' + esc(s.ref) + "</span>" : "") + "</span>" +
      "</td>" +
      "<td>" + (s.facilityName ? esc(s.facilityName) : '<span class="mw-text-muted">No facility chosen</span>') + "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
    "</tr>";
  }));

  renderPanel("panel_referrals", "Referrals history", referrals(day).map(function (s) {
    var type = TYPES[s.type];
    var ref = s.referral;
    var chose = s.facilityName && s.facilityName !== ref.facilityName ? "Mother chose " + s.facilityName : "";
    return '<tr data-ref="' + esc(s.ref) + '">' +
      dateCell(ref.referredAt) +
      "<td>" + viewButton(s) +
        '<span class="mw-table__sub">' + esc(type ? capitalize(type.verb) : (s.typeLabel || "Inquiry")) +
        (s.ref ? ' · <span class="mw-table__nowrap">' + esc(s.ref) + "</span>" : "") + "</span>" +
      "</td>" +
      "<td>" + esc(ref.facilityName || "") +
        (chose ? '<span class="mw-table__sub">' + esc(chose) + "</span>" : "") +
        (ref.referredBy ? '<span class="mw-table__sub">By ' + esc(ref.referredBy) + "</span>" : "") +
      "</td>" +
      "<td>" + submissionChip(s) + "</td>" +
    "</tr>";
  }));
}

function smsRows(day) {
  return smsUpTo(day).map(function (r) {
    var t = SMS_TYPES[r.type] || SMS_TYPES.update;
    return '<tr data-sms="' + esc(r.id) + '">' +
      dateCell(r.sentAt) +
      "<td>" + esc(r.name || "Name not given") +
        '<span class="mw-table__sub">' + esc(t.label) + ' · <span class="mw-table__nowrap">' + esc(formatMobile(r.to)) + "</span></span>" +
      "</td>" +
      "<td>" + (r.facility ? esc(r.facility) : r.ref ? esc(r.ref) : '<span class="mw-text-muted">No facility</span>') +
        (r.facility && r.ref ? '<span class="mw-table__sub mw-table__nowrap">' + esc(r.ref) + "</span>" : "") +
      "</td>" +
      "<td>" + smsStatusChip(r) + "</td>" +
    "</tr>";
  });
}

var SMS_EMPTY = (function () {
  var e = document.querySelector("#panel_sms .mw-empty__title");
  return e ? e.textContent : "";
})();

function renderAll() {
  var day = reportDay();
  var smsEmpty = document.querySelector("#panel_sms .mw-empty__title");
  if (smsEmpty) {
    smsEmpty.textContent = state.smsError && !state.sms.length ? "The SMS log couldn't be loaded"
      : smsLogNote() && state.sms.length ? "No SMS up to " + shortDay(day) + " among the newest ones"
      : SMS_EMPTY;
  }
  renderStats(day);
  renderHmbChart();
  renderSmsChart(day);
  renderHistory(day);
  renderPanel("panel_sms", "SMS history", smsRows(day));
  showSmsNote(document.getElementById("panel_sms"));
}

// When the server sent only the newest SMS, the SMS tab says so (the counts above cover those)
function showSmsNote(panel) {
  if (!panel) return;
  var note = panel.querySelector("[data-sms-note]");
  var text = smsLogNote();
  if (!note && text) {
    note = document.createElement("p");
    note.className = "mw-table__sub";
    note.setAttribute("data-sms-note", "");
    panel.appendChild(note);
  }
  if (note) {
    note.textContent = text;
    note.hidden = !text;
  }
}

/* ───────────── Export CSV ───────────── */

function csvCell(value) {
  var text = String(value == null ? "" : value);
  // Keep spreadsheet apps from running a cell as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function buildCsv(day) {
  var rows = [["Section", "Date (Philippine time)", "Record", "Details", "Facility", "Status", "Reference"]];

  facilityUpdates(day).forEach(function (f) {
    rows.push(["Facility update", stamp(facilityUpdatedAt(f)), "Information updated", updatedByText(f), f.name, facilityState(f).label, f.id]);
  });

  inquiries(day).forEach(function (s) {
    var contact = s.contact || {};
    var type = TYPES[s.type];
    rows.push(["Inquiry", stamp(s.createdAt), contact.name || "", type ? capitalize(type.verb) : (s.typeLabel || ""), s.facilityName || "", statusText(s.status), s.ref || ""]);
  });

  referrals(day).forEach(function (s) {
    var contact = s.contact || {};
    rows.push(["Referral", stamp(s.referral.referredAt), contact.name || "", s.referral.referredBy ? "Referred by " + s.referral.referredBy : "Referred",
      s.referral.facilityName || "", statusText(s.status), s.ref || ""]);
  });

  // When only the newest SMS were loaded, the file says so in its SMS section (not counted as a record)
  var partial = smsLogNote();
  if (partial) rows.push(["SMS", "", partial, "", "", "", ""]);
  smsUpTo(day).forEach(function (r) {
    var t = SMS_TYPES[r.type] || SMS_TYPES.update;
    rows.push(["SMS", stamp(r.sentAt), r.name || formatMobile(r.to), t.label + (r.event && r.event !== t.label ? ": " + r.event : "") + " · " + formatMobile(r.to),
      r.facility || "", r.status === "sent" ? (/^delivered$/i.test(r.delivery || "") ? "Delivered" : r.delivery ? "Sent (" + r.delivery + ")" : "Sent") : r.status === "skipped" ? "Not sent" : r.status === "unknown" ? "Not confirmed" : "Failed", r.ref || ""]);
  });

  return { text: rows.map(function (row) { return row.map(csvCell).join(","); }).join("\r\n") + "\r\n", count: rows.length - 1 - (partial ? 1 : 0) };
}

function download(text, fileName) {
  var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function exportCsv() {
  if (!exportButton || exportButton.classList.contains("is-loading")) return;
  exportButton.classList.add("is-loading");
  exportButton.setAttribute("aria-disabled", "true");

  // Read the latest records first, so the file matches Firestore right now.
  load(true)
    .then(function () {
      var day = reportDay();
      var csv = buildCsv(day);
      download(csv.text, "mowmmas-history-" + day + ".csv");
      toast((csv.count
        ? "CSV downloaded with " + plural(csv.count, "record", "records") + "."
        : "CSV downloaded. There are no records up to " + shortDay(day) + " yet.") +
        (smsLogNote() ? " Its SMS rows are the newest ones only: " + smsLogNote() : ""));
    })
    .catch(function (error) {
      showPageError(errorMessage(error, "the records for the CSV"));
    })
    .then(function () {
      exportButton.classList.remove("is-loading");
      exportButton.removeAttribute("aria-disabled");
    });
}

/* ───────────── load ───────────── */

// fresh: read Firestore again instead of sharing this page's read (Export CSV)
function load(fresh) {
  var options = fresh ? { fresh: true } : undefined;
  var sms = getSmsLog(options).then(function (list) {
    state.sms = list;
    state.smsError = null;
    return null;
  }, function (error) {
    state.smsError = error.message;
    return error;
  });
  return Promise.all([getFacilities(options), getSubmissions(undefined, options), sms]).then(function (results) {
    state.facilities = results[0];
    state.submissions = results[1];
    state.loaded = true;
    renderAll();
    if (results[2]) showPageError(results[2].message + " The SMS numbers show what this page had.");
  });
}

function showUnavailable() {
  statValues.forEach(function (value) { if (value.textContent === "…") value.textContent = "–"; });
  var hmbCaption = document.querySelector("#hmb_chart_title") && document.querySelector("#hmb_chart_title").closest(".mw-card").querySelector("figcaption");
  if (hmbCaption) hmbCaption.textContent = "Facilities by HMB status couldn't be loaded.";
}

if (dateInput) {
  dateInput.addEventListener("change", function () {
    // Another day's records: each tab starts again at page 1
    Object.keys(panels).forEach(function (panelId) { panels[panelId].pager.reset(); });
    if (state.loaded) renderAll();
  });
}

if (exportButton) exportButton.addEventListener("click", exportCsv);

var view = setUpSubmissionView({
  modal: document.getElementById("submission_modal"),
  submission: function (ref) {
    return state.submissions.filter(function (s) { return s.ref === ref; })[0] || null;
  },
  // A status was saved: that submission as it is now, everywhere on the page
  onSaved: function (updated) {
    state.submissions = state.submissions.map(function (s) { return s.ref === updated.ref ? updated : s; });
    renderAll();
  },
  reveal: revealRef
});

function prepareControls() {
  if (dateInput) {
    dateInput.max = today();
    if (!dateInput.value) dateInput.value = today();
  }
}

/* What this browser tab already has (from the last page) shows at once;
   the fresh copy from Firestore replaces it a moment later. */
(function showRemembered() {
  var facilities = cachedFacilities();
  var submissions = cachedSubmissions();
  if (!facilities || !submissions) return;
  prepareControls();
  state.facilities = facilities;
  state.submissions = submissions;
  state.sms = cachedSmsLog() || [];
  state.loaded = true;
  renderAll();
})();

ready
  .then(function () {
    prepareControls();
    if (exportButton) exportButton.hidden = false;
    return load();
  })
  .then(function () {
    view.openFromLink();
  })
  .catch(function (error) {
    showPageError(errorMessage(error, "reports"));
    showUnavailable();
    if (state.loaded) view.openFromLink({ fresh: false });
  });
