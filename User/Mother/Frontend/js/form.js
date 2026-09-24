/* ══════════════════════════════════════════════════════════════════
   MOWMMAS · Mother side · Request / Donation form (form.html)
   form.html?type=donate|request|inquire&facility=<facility id>
   Flow step 6 of the MOWMMAS journey.

   - Builds the form for the chosen service (fields as in the build
     contract §5), grouped in numbered <fieldset> cards
   - Validates on blur and on submit with the same rules and wording as
     the server; a server 422 is mapped onto the same inline errors
   - Keeps a draft in sessionStorage (per service + facility)
   - Sends with MOWMMAS.api.submit(), remembers the submission on this
     device and opens confirm.html?ref=…
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var M = window.MOWMMAS;
  if (!M) return;
  var api = M.api, ui = M.ui, util = M.util, esc = util.esc;

  function $(id) { return document.getElementById(id); }

  var rawType = (util.param('type') || '').trim().toLowerCase();
  var TYPE = rawType === 'donation' ? 'donate' : rawType === 'inquiry' ? 'inquire' : rawType;
  var FACILITY_ID = (util.param('facility') || '').trim();
  var DRAFT_KEY = 'mowmmas.draft.' + TYPE + '.' + FACILITY_ID;

  var els = {
    back: $('backLink'), backLabel: $('backLabel'),
    eyebrow: $('formEyebrow'), title: $('pageTitle'), lede: $('pageLede'), meta: $('formMeta'),
    outline: $('formOutline'), side: $('facilityChip'), root: $('formRoot')
  };

  var TYPES = {
    donate: {
      title: 'Donate breast milk', eyebrow: 'Donate Breast Milk', icon: 'i-hand-heart',
      submit: 'Submit donation offer', minutes: 4,
      needs: 'acceptsDonations', needsLabel: 'Accepts donations',
      notOffered: 'does not accept breast milk donations',
      otherFacilities: 'Find a facility that accepts donations'
    },
    request: {
      title: 'Request donor breast milk', eyebrow: 'Request Breast Milk', icon: 'i-bottle',
      submit: 'Submit request', minutes: 3,
      needs: 'providesDonorMilk', needsLabel: 'Provides donor milk',
      notOffered: 'does not give out donor milk',
      otherFacilities: 'Find a facility with donor milk'
    },
    inquire: {
      title: 'Ask a question', eyebrow: 'Inquire', icon: 'i-chat',
      submit: 'Send my question', minutes: 2, needs: null
    }
  };
  var T = TYPES[TYPE] || null;

  /* ───────────── answer options: [value, label, extra] ───────────── */
  var OPT = {
    donateBabyAge: [['0-1m', 'Less than 1 month'], ['1-3m', '1–3 months'], ['4-6m', '4–6 months'],
                    ['7-12m', '7–12 months'], ['12m+', 'Over 12 months']],
    screening: [
      ['healthy', 'I am in good health right now'],
      ['nonSmoker', 'I do not smoke or vape'],
      ['noMedication', 'I am not taking any regular medicine'],
      ['noTransfusion', 'I have not had a blood transfusion in the last 12 months'],
      ['willingToScreen', 'I am willing to undergo the facility\'s screening and blood tests']
    ],
    delivery: [
      ['dropoff', 'I will bring it to the facility', 'You drop off the milk yourself.'],
      ['pickup', 'Please pick it up from me', 'A health worker collects it, if the facility can.']
    ],
    preferredTime: [['any', 'Any time'], ['morning', 'Morning'], ['afternoon', 'Afternoon']],
    relationship: [['mother', 'Mother'], ['father', 'Father'], ['guardian', 'Guardian or relative'], ['health_worker', 'Health worker']],
    requestBabyAge: [['0-7d', '0–7 days'], ['1-4w', '1–4 weeks'], ['1-3m', '1–3 months'], ['4-6m', '4–6 months'], ['6m+', 'Over 6 months']],
    reasons: [
      ['preterm', 'Born early (preterm)'],
      ['low_birth_weight', 'Low birth weight'],
      ['low_supply', 'Mother has little or no milk'],
      ['mother_ill', 'Mother is sick or taking medicine'],
      ['nicu', 'Baby is in the NICU'],
      ['adoption', 'Adopted, or apart from the mother'],
      ['other', 'Another reason (tell us in the notes)']
    ],
    admitted: [['no', 'No'], ['yes', 'Yes, admitted now'], ['scheduled', 'Admission is scheduled']],
    urgency: [
      ['24h', 'Within 24 hours', 'Urgent: the baby needs milk very soon.'],
      ['week', 'Within this week', 'Needed in the next few days.'],
      ['planning', 'Planning ahead', 'Not needed yet.']
    ],
    hasReferral: [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']],
    topic: [
      ['availability', 'Donor milk availability', 'i-droplet'],
      ['requirements', 'Requirements and documents', 'i-file'],
      ['donating', 'How to donate milk', 'i-hand-heart'],
      ['requesting', 'How to request milk', 'i-bottle'],
      ['lactation', 'Breastfeeding help', 'i-heart'],
      ['other', 'Something else', 'i-help']
    ],
    preferredContact: [['sms', 'Text message (SMS)', 'i-message'], ['call', 'Phone call', 'i-phone']]
  };

  /* Field order = validation order = error summary order */
  var KEYS = {
    donate: ['age', 'estimatedVolume', 'babyAge', 'willingToScreen', 'delivery', 'preferredDate', 'notes'],
    request: ['babyName', 'relationship', 'babyAge', 'admitted', 'reasons', 'urgency', 'amountNeeded', 'hasReferral', 'notes'],
    inquire: ['topic', 'question', 'preferredContact']
  };
  var CONTACT_KEYS = ['name', 'mobile', 'email', 'municipality', 'barangay'];

  /* ───────────── dates follow the mothers' clock (Manila, UTC+8, no DST) ───────────── */
  function manilaDate(addDays) {
    return new Date(Date.now() + 8 * 3600000 + (addDays || 0) * 86400000).toISOString().slice(0, 10);
  }
  var TODAY = manilaDate(0);
  var MAX_DATE = manilaDate(366);

  function realDate(ymd) {
    var p = ymd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

  /* ───────────── state ───────────── */
  var facility = null;
  var form = null;
  var touched = {};
  var shown = {};         // key → message currently shown inline
  var generalErrors = []; // server errors that belong to no field
  var attempted = false;  // the mother pressed submit at least once
  var sending = false;
  var sent = false;       // a submission went through (guards the back button)
  var saveTimer = null;
  var steps = [];         // [{ key, label, keys:[validation keys] }] — one form part per step
  var current = 0;        // step being shown
  var furthest = 0;       // furthest step reached (earlier/visited steps can be clicked)
  var summaryScope = null; // keys the error summary is about (null = whole form)

  /* ═════════════════════════ page frame ═════════════════════════ */

  function facilityHref(id) { return 'facility.html?id=' + encodeURIComponent(id) + (T ? '&service=' + TYPE : ''); }
  function hospitalsHref() { return 'hospitals.html' + (T ? '?service=' + TYPE : ''); }


  // opened from the Inquire page (…&from=inquire): "Back" returns there
  var FROM_INQUIRE = util.param('from') === 'inquire';

  function setBack(href, label) {
    if (FROM_INQUIRE) { href = 'inquire.html'; label = 'Back to Inquire'; }
    els.back.href = href;
    els.backLabel.textContent = label;
  }

  function setHead(title, lede) {
    els.title.textContent = title;
    els.lede.textContent = lede;
    document.title = title + ' | MOWMMAS';
  }

  function showEyebrow() {
    if (!T) return;
    els.eyebrow.innerHTML = ui.icon(T.icon, 'icon--sm') + esc(T.eyebrow);
    els.eyebrow.hidden = false;
  }

  function hideSide() {
    els.side.innerHTML = '';
    els.side.hidden = true;
    els.side.parentNode.classList.add('is-single');
  }

  function doneLoading() { els.root.setAttribute('aria-busy', 'false'); }

  /* Compact, branded state card (icon, title, text, actions) */
  function stateHtml(icon, title, text, actionsHtml) {
    return '<div class="state form-state">' +
      '<span class="state__icon">' + ui.icon(icon) + '</span>' +
      '<h2 class="state__title">' + esc(title) + '</h2>' +
      '<p class="state__text">' + esc(text) + '</p>' +
      (actionsHtml ? '<div class="state__actions">' + actionsHtml + '</div>' : '') + '</div>';
  }
  function linkBtn(href, label, kind, icon) {
    return '<a class="btn btn--' + (kind || 'primary') + '" href="' + esc(href) + '">' +
      (icon ? ui.icon(icon, 'icon--sm') : '') + esc(label) + '</a>';
  }

  /* ═════════════════════════ facility summary chip ═════════════════════════ */

  /* "Sending to" bar at the top of the form panel:
     facility · does it offer this service · phone · change facility */
  function chipHtml(f) {
    var facts = '';
    if (T && T.needs) {
      var value = f.services ? f.services[T.needs] : null;
      facts += '<span class="send-to__fact">' + esc(T.needsLabel) + ui.yesNo(value) + '</span>';
      if (TYPE === 'request' && value !== false && f.donorMilkAvailability) {
        facts += '<span class="send-to__fact">Right now' + ui.availability(f.donorMilkAvailability) + '</span>';
      }
    }
    var phone = f.contactNumber
      ? '<a class="send-to__phone" href="' + esc(util.telHref(f.contactNumber)) + '">' + ui.icon('i-phone', 'icon--sm') +
        '<span><span class="sr-only">Call </span>' + esc(f.contactNumber) + '</span></a>'
      : '<span class="send-to__phone is-missing">' + ui.icon('i-phone', 'icon--sm') + 'No number listed yet</span>';

    var note = f.dataStatus && f.dataStatus.sample
      ? '<p class="send-to__note">' + ui.icon('i-alert', 'icon--sm') + '<span><strong>Sample information.</strong> ' +
        'These service details have not been confirmed by the facility yet. Always call before you go.</span></p>'
      : '';

    return '<div class="send-to__main">' +
        '<span class="send-to__icon">' + ui.icon('i-hospital') + '</span>' +
        '<div class="send-to__id">' +
          '<p class="send-to__label">Sending to</p>' +
          '<p class="send-to__name">' + esc(f.name) + '</p>' +
          '<p class="send-to__meta">' + esc([f.kindLabel, f.municipality].filter(Boolean).join(' · ')) + '</p>' +
        '</div>' +
        '<div class="send-to__facts">' + facts + phone +
          '<a class="send-to__change" href="' + esc(hospitalsHref()) + '">' + ui.icon('i-refresh', 'icon--sm') + 'Change facility</a>' +
        '</div>' +
      '</div>' + note;
  }

  /* ═════════════════════════ building the form ═════════════════════════ */

  function attrs(obj) {
    return Object.keys(obj || {}).map(function (k) { return ' ' + k + '="' + esc(obj[k]) + '"'; }).join('');
  }
  function labelText(spec) {
    return esc(spec.label) + (spec.optional ? ' <span class="field__opt">(optional)</span>' : '');
  }
  function helpHtml(key, spec) {
    return spec.help ? '<p class="field__help" id="help-' + key + '">' + esc(spec.help) + '</p>' : '';
  }
  function errorHtml(key) { return '<p class="field__error" id="err-' + key + '" hidden></p>'; }

  /* text, tel, email, number, date, select, textarea */
  function inputField(key, spec) {
    var id = 'f-' + key;
    var described = spec.help ? ' aria-describedby="help-' + key + '"' : '';
    var req = spec.optional ? '' : ' required';
    var control;
    if (spec.kind === 'select') {
      control = '<select class="select" id="' + id + '" name="' + key + '"' + req + described + '>' +
        (spec.placeholder ? '<option value="">' + esc(spec.placeholder) + '</option>' : '') +
        spec.options.map(function (o, i) {
          return '<option value="' + esc(o[0]) + '"' + (spec.selected === o[0] || (!spec.placeholder && i === 0) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    } else if (spec.kind === 'textarea') {
      control = '<textarea class="textarea" id="' + id + '" name="' + key + '" rows="3"' + req + described + attrs(spec.attrs) + '></textarea>' +
        '<p class="field__count" id="count-' + key + '" aria-hidden="true">0 / ' + spec.attrs.maxlength + '</p>';
    } else {
      control = '<input class="input" id="' + id + '" name="' + key + '" type="' + spec.kind + '"' + req + described + attrs(spec.attrs) + ' />';
    }
    return '<div class="field' + (spec.span === 'full' ? ' field--full' : '') + '" data-field="' + key + '">' +
      '<label class="field__label" for="' + id + '">' + labelText(spec) + '</label>' +
      helpHtml(key, spec) + control + errorHtml(key) + '</div>';
  }

  /* chips / cards (radio), checks (checkbox list → array), flags (one checkbox per statement) */
  function groupField(key, spec) {
    var inputType = spec.kind === 'checks' || spec.kind === 'flags' ? 'checkbox' : 'radio';
    var described = spec.help ? ' aria-describedby="help-' + key + '"' : '';
    var listClass = spec.kind === 'chips' ? 'chip-list'
      : spec.kind === 'flags' ? 'choice-stack'
      : 'choice-grid choice-grid--' + (spec.cols || 2);

    var items = spec.options.map(function (o, i) {
      var name = spec.kind === 'flags' ? o[0] : key;
      var id = spec.kind === 'flags' ? 'f-' + o[0] : 'f-' + key + '-' + i;
      var value = spec.kind === 'flags' ? 'yes' : o[0];
      var must = spec.kind === 'flags' && o[0] === spec.mustKey;
      var req = (inputType === 'radio' && !spec.optional) || must ? ' required' : '';
      var checked = spec.checked === o[0] ? ' checked' : '';
      var cls = 'choice' + (spec.kind === 'chips' ? ' choice--chip' : '') +
        (spec.kind === 'cards' && spec.icons ? ' choice--icon' : '') + (must ? ' choice--must' : '');
      var inner;
      if (spec.kind === 'cards' && spec.icons) {
        inner = '<span class="choice__icon">' + ui.icon(o[2], 'icon--sm') + '</span><span class="choice__text"><span class="choice__title">' + esc(o[1]) + '</span></span>';
      } else if (spec.kind === 'cards' && o[2]) {
        inner = '<span class="choice__text"><span class="choice__title">' + esc(o[1]) + '</span><small>' + esc(o[2]) + '</small></span>';
      } else {
        inner = '<span class="choice__text">' + esc(o[1]) + '</span>' + (must ? '<span class="choice__tag">Required</span>' : '');
      }
      return '<label class="' + cls + '" for="' + id + '">' +
        '<input type="' + inputType + '" id="' + id + '" name="' + name + '" value="' + esc(value) + '"' + req + checked + described + ' />' +
        inner + '</label>';
    }).join('');

    var errKey = spec.kind === 'flags' ? spec.mustKey : key;
    return '<fieldset class="field field--group' + (spec.span === 'full' ? ' field--full' : '') + '" data-field="' + errKey + '">' +
      '<legend class="field__label">' + labelText(spec) + '</legend>' +
      helpHtml(key, spec) + '<div class="' + listClass + '">' + items + '</div>' + errorHtml(errKey) +
      (spec.after || '') + '</fieldset>';
  }

  function fieldHtml(key, spec) {
    return ['chips', 'cards', 'checks', 'flags'].indexOf(spec.kind) !== -1 ? groupField(key, spec) : inputField(key, spec);
  }

  function sectionsFor(f, municipalities) {
    var muniField = municipalities.length
      ? { kind: 'select', label: 'Municipality', placeholder: 'Choose your municipality',
          options: municipalities.map(function (m) { return [m, m]; }) }
      : { kind: 'text', label: 'Municipality', help: 'For example San Jose de Buenavista.', attrs: { maxlength: 80, autocomplete: 'address-level2' } };

    var about = {
      key: 'about', title: 'About you', short: 'About you',
      desc: 'So the health workers at ' + f.name + ' can contact you.',
      tip: { icon: 'i-message', text: 'Updates about this form are sent by SMS to your mobile number.' },
      fields: [
        ['name', { kind: 'text', label: 'Your full name', span: 'full',
          attrs: { autocomplete: 'name', autocapitalize: 'words', maxlength: 80, placeholder: 'e.g. Juana Dela Cruz' } }],
        ['mobile', { kind: 'tel', label: 'Mobile number', help: 'We send your updates here. For example 0917 123 4567.',
          attrs: { autocomplete: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '09XX XXX XXXX' } }],
        ['email', { kind: 'email', label: 'Email', optional: true, help: 'Another way for the health workers to reach you.',
          attrs: { autocomplete: 'email', inputmode: 'email', maxlength: 254, placeholder: 'e.g. juana@example.com' } }],
        ['municipality', muniField],
        ['barangay', { kind: 'text', label: 'Barangay', optional: true, attrs: { maxlength: 80, placeholder: 'e.g. Atabay' } }]
      ]
    };

    var notes = ['notes', { kind: 'textarea', label: 'Anything else the health workers should know?', optional: true, span: 'full',
      attrs: { maxlength: 1000 } }];

    var byType = {
      donate: [
        { key: 'donor', title: 'You and your baby', short: 'Your baby',
          desc: 'A few details help the facility plan for your donation.',
          tip: { icon: 'i-info', text: 'Milk donors need to be 18 to 55 years old.' },
          fields: [
            ['age', { kind: 'text', label: 'Your age', help: 'In years, for example 28.',
              attrs: { inputmode: 'numeric', maxlength: 3, autocomplete: 'off', placeholder: 'e.g. 28' } }],
            ['estimatedVolume', { kind: 'text', label: 'About how much milk can you share?', optional: true,
              help: 'For example “about 500 ml a week”.', attrs: { maxlength: 80 } }],
            ['babyAge', { kind: 'cards', label: 'How old is your baby?', span: 'full', options: OPT.donateBabyAge, cols: 5 }]
          ] },
        { key: 'health', title: 'Health check', short: 'Health check',
          desc: 'Donor milk goes to babies who are small or sick, so every donor is screened by the facility first.',
          tip: { icon: 'i-shield', text: 'Tick what is true for you. The facility makes the final decision after its screening.' },
          fields: [
            ['screening', { kind: 'flags', label: 'Tick the statements that are true for you', span: 'full',
              help: 'Only the last one is required.', options: OPT.screening, mustKey: 'willingToScreen' }]
          ] },
        { key: 'handover', title: 'Drop-off or pick-up', short: 'Drop-off',
          desc: 'Tell the facility how and when your milk can reach them.',
          tip: { icon: 'i-calendar', text: 'This is only your preference. The facility will confirm the date and time with you.' },
          fields: [
            ['delivery', { kind: 'cards', label: 'How will the milk reach the facility?', span: 'full', options: OPT.delivery, cols: 2 }],
            ['preferredDate', { kind: 'date', label: 'Preferred date', help: 'Today or any later day.',
              attrs: { min: TODAY, max: MAX_DATE } }],
            ['preferredTime', { kind: 'select', label: 'Preferred time of day', help: 'We pass this on to the facility.',
              options: OPT.preferredTime, selected: 'any' }],
            notes
          ] }
      ],
      request: [
        { key: 'baby', title: 'About the baby', short: 'The baby',
          desc: 'Tell us who the donor milk is for.',
          tip: { icon: 'i-shield', text: 'Only the health workers of ' + f.name + ' see these details.' },
          fields: [
            ['babyName', { kind: 'text', label: 'Baby\'s name or initials', help: 'Initials are fine, for example “Baby J.D.”',
              attrs: { maxlength: 60 } }],
            ['relationship', { kind: 'chips', label: 'Who are you to the baby?', options: OPT.relationship }],
            ['babyAge', { kind: 'cards', label: 'How old is the baby?', span: 'full', options: OPT.requestBabyAge, cols: 5 }],
            ['admitted', { kind: 'chips', label: 'Is the baby admitted in a hospital?', optional: true, span: 'full', options: OPT.admitted }]
          ] },
        { key: 'need', title: 'What the baby needs', short: 'Needs',
          desc: 'This helps the health workers understand how soon to respond.',
          tip: { icon: 'i-info', text: 'Donor milk is limited, so facilities may give it first to babies with the greatest medical need.' },
          fields: [
            ['reasons', { kind: 'checks', label: 'Why does the baby need donor milk?', help: 'Choose all that apply.',
              span: 'full', options: OPT.reasons, cols: 2 }],
            ['urgency', { kind: 'cards', label: 'How soon is the milk needed?', span: 'full', options: OPT.urgency, cols: 3,
              after: '<div class="form-urgent" id="urgentNote" aria-live="polite"></div>' }],
            ['amountNeeded', { kind: 'text', label: 'About how much milk is needed?', optional: true,
              help: 'For example “100 ml a day”.', attrs: { maxlength: 80 } }],
            ['hasReferral', { kind: 'chips', label: 'Do you have a doctor\'s referral?', optional: true,
              help: 'A prescription or note from a doctor.', options: OPT.hasReferral }],
            notes
          ] }
      ],
      inquire: [
        { key: 'question', title: 'Your question', short: 'Question',
          desc: 'Ask about breast milk services at ' + f.name + '.',
          tip: { icon: 'i-clock', text: 'Health workers reply during their working hours.' },
          fields: [
            ['topic', { kind: 'cards', label: 'What is your question about?', span: 'full', options: OPT.topic, cols: 'topics', icons: true }],
            ['question', { kind: 'textarea', label: 'Your question', span: 'full',
              help: 'Write it in your own words. English, Filipino or Kinaray‑a is fine.', attrs: { maxlength: 1000 } }],
            ['preferredContact', { kind: 'cards', label: 'How should they reply?', span: 'full', options: OPT.preferredContact,
              cols: 'pair', icons: true, checked: 'sms' }]
          ] }
      ]
    };
    return [about].concat(byType[TYPE]);
  }

  function sectionHtml(sec, n) {
    return '<fieldset class="form-card" id="sec-' + sec.key + '" aria-describedby="desc-' + sec.key + '">' +
      '<legend class="form-card__legend"><span class="form-card__num" aria-hidden="true">' + n + '</span>' +
        '<h2 class="form-card__title">' + esc(sec.title) + '</h2></legend>' +
      '<p class="form-card__desc" id="desc-' + sec.key + '">' + esc(sec.desc) + '</p>' +
      '<p class="form-card__tip">' + ui.icon(sec.tip.icon, 'icon--sm') + '<span>' + esc(sec.tip.text) + '</span></p>' +
      '<div class="form-card__body"><div class="field-grid field-grid--2">' +
        sec.fields.map(function (fd) { return fieldHtml(fd[0], fd[1]); }).join('') +
      '</div></div></fieldset>';
  }

  function sendSectionHtml(n, f) {
    return '<fieldset class="form-card form-card--send" id="sec-send" aria-describedby="desc-send">' +
      '<legend class="form-card__legend"><span class="form-card__num" aria-hidden="true">' + n + '</span>' +
        '<h2 class="form-card__title">Agree and send</h2></legend>' +
      '<p class="form-card__desc" id="desc-send">What happens after you send it:</p>' +
      '<ol class="form-next">' +
        '<li><span class="form-next__num" aria-hidden="true">1</span><span>The facility&#39;s health workers review your details.</span></li>' +
        '<li><span class="form-next__num" aria-hidden="true">2</span><span>They update your status.</span></li>' +
        '<li><span class="form-next__num" aria-hidden="true">3</span><span>You get an SMS, and can check anytime on Track Submission.</span></li>' +
      '</ol>' +
      '<div class="form-card__body">' +
        '<div class="field" data-field="consent">' +
          '<label class="choice form-consent" for="f-consent">' +
            '<input type="checkbox" id="f-consent" name="consent" value="yes" required />' +
            '<span class="choice__text">I agree that MOWMMAS may share these details with ' + esc(f.name) +
            ' and send me SMS updates about this submission</span></label>' +
          errorHtml('consent') +
        '</div>' +
        '<p class="form-send__note">' + ui.icon('i-info', 'icon--sm') + '<span><strong>MOWMMAS is not a milk bank.</strong> ' +
          esc(f.name) + ' does all screening, collection and sharing of breast milk. MOWMMAS only passes your details on.</span></p>' +
        '<div class="form-send__error" id="sendError"></div>' +
        '<p class="form-send__draft">' + ui.icon('i-lock', 'icon--xs') + 'Your answers stay on this device until you send them.</p>' +
      '</div></fieldset>';
  }

  /* ═════════════════════════ steps ═════════════════════════
     The form is shown one part at a time. The step bar in the band shows
     where the mother is: 1 About you — 2 Your baby — … — Send. */

  // validation keys that live in a form part ("screening" is checked as willingToScreen)
  function stepKeysOf(sec) {
    return sec.fields.map(function (fd) { return fd[0] === 'screening' ? 'willingToScreen' : fd[0]; })
      .filter(function (k) { return allKeys().indexOf(k) !== -1; });
  }

  function stepOfKey(key) {
    for (var i = 0; i < steps.length; i++) if (steps[i].keys.indexOf(key) !== -1) return i;
    return steps.length - 1;
  }

  function renderStepper() {
    els.outline.innerHTML = '<ol class="stepper__list">' + steps.map(function (s, i) {
      var state = i < current ? 'is-done' : i === current ? 'is-current' : 'is-next';
      var inner = '<span class="stepper__dot" aria-hidden="true">' + (i < current ? ui.icon('i-check', 'icon--xs') : String(i + 1)) + '</span>' +
        '<span class="stepper__label">' + esc(s.label) +
        '<span class="sr-only">' + (i < current ? ' (done)' : i === current ? ' (current step)' : '') + '</span></span>';
      // steps already reached can be revisited; later ones open with "Next"
      var node = i !== current && i <= furthest
        ? '<button class="stepper__item" type="button" data-goto="' + i + '">' + inner + '</button>'
        : '<span class="stepper__item"' + (i === current ? ' aria-current="step"' : '') + '>' + inner + '</span>';
      return '<li class="stepper__step ' + state + '">' + node + '</li>';
    }).join('') + '</ol>' +
      // phones show only the circles, so the current step is named underneath
      '<p class="stepper__caption" aria-hidden="true">Step ' + (current + 1) + ' of ' + steps.length +
      ': <strong>' + esc(steps[current].label) + '</strong></p>';
    els.outline.setAttribute('aria-label', 'Form steps: step ' + (current + 1) + ' of ' + steps.length);
    els.outline.hidden = false;
  }

  function renderNav() {
    var last = current === steps.length - 1;
    $('formNav').innerHTML =
      (current > 0
        ? '<button class="btn btn--outline btn--lg form-nav__back" type="button" data-step-back>' + ui.icon('i-arrow-left', 'icon--sm') + '<span>Back</span></button>'
        : '<span class="form-nav__spacer"></span>') +
      '<p class="form-nav__count">Step ' + (current + 1) + ' of ' + steps.length + '</p>' +
      (last
        // the last step sends the form from the same place "Next" was
        ? '<button class="btn btn--primary btn--lg form-nav__next form-send__btn" type="submit" id="submitBtn">' +
          '<span id="submitLabel">' + esc(sending ? 'Sending…' : T.submit) + '</span>' + ui.icon('i-send', 'icon--sm') + '</button>'
        : '<button class="btn btn--primary btn--lg form-nav__next" type="button" data-step-next><span>Next: ' +
          esc(steps[current + 1].label) + '</span>' + ui.icon('i-arrow-right', 'icon--sm') + '</button>');
  }

  function goTo(i, opts) {
    opts = opts || {};
    current = Math.max(0, Math.min(i, steps.length - 1));
    furthest = Math.max(furthest, current);
    steps.forEach(function (s, n) { $('sec-' + s.key).hidden = n !== current; });
    renderStepper();
    renderNav();
    if (!opts.keepSummary) { summaryScope = null; $('summarySlot').innerHTML = ''; }
    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (opts.scroll !== false) {
      var header = document.getElementById('siteHeader');
      var top = els.outline.getBoundingClientRect().top + window.pageYOffset - (header ? header.offsetHeight : 0) - 16;
      if (window.pageYOffset > top) window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
    }
    if (opts.focus !== false) {
      var title = $('sec-' + steps[current].key).querySelector('.form-card__title');
      if (title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
    }
  }

  // check one step; returns the keys that still need fixing
  function checkStep(i) {
    return steps[i].keys.filter(function (k) { return validate(k); });
  }

  function showStepErrors(i, bad) {
    attempted = true;
    if (i !== current) goTo(i, { focus: false, scroll: false });
    renderSummary(steps[i].keys);
    focusField(bad[0]);
  }

  function nextStep() {
    var bad = checkStep(current);
    if (bad.length) { showStepErrors(current, bad); return; }
    goTo(current + 1);
  }

  // jump from the step bar: going forward only passes steps that are complete
  function jumpTo(i) {
    if (i <= current) { goTo(i); return; }
    for (var s = current; s < i; s++) {
      var bad = checkStep(s);
      if (bad.length) { showStepErrors(s, bad); return; }
    }
    goTo(i);
  }

  function renderForm(f, municipalities) {
    var secs = sectionsFor(f, municipalities);
    els.root.innerHTML =
      '<form class="sub-form" id="subForm" novalidate>' +
        '<div class="form-slot" id="draftSlot"></div>' +
        '<div class="form-slot" id="summarySlot"></div>' +
        secs.map(function (s, i) { return sectionHtml(s, i + 1); }).join('') +
        sendSectionHtml(secs.length + 1, f) +
        '<div class="form-nav" id="formNav"></div>' +
      '</form>';
    form = $('subForm');
    steps = secs.map(function (s) { return { key: s.key, label: s.short || s.title, keys: stepKeysOf(s) }; })
      .concat([{ key: 'send', label: 'Send', keys: ['consent'] }]);
    bindForm();
    if (restoreDraft()) showDraftNote();
    // topic chosen on the Inquire page (…&topic=availability); a saved draft wins
    var topicParam = util.param('topic');
    if (TYPE === 'inquire' && topicParam && !radio('topic') &&
        OPT.topic.some(function (o) { return o[0] === topicParam; })) {
      var pick = form.querySelector('input[name="topic"][value="' + topicParam + '"]');
      if (pick) pick.checked = true;
    }
    updateCounters();
    updateUrgent();
    goTo(0, { scroll: false, focus: false });
  }

  /* ═════════════════════════ reading values ═════════════════════════ */

  function el(key) { return form.elements[key]; }
  function text(key) {
    var e = el(key);
    return e && typeof e.value === 'string' ? e.value.trim() : '';
  }
  function radio(key) {
    var c = form.querySelector('input[name="' + key + '"]:checked');
    return c ? c.value : '';
  }
  function checked(key) { var e = $('f-' + key); return Boolean(e && e.checked); }
  function checkedValues(key) {
    return Array.prototype.map.call(form.querySelectorAll('input[name="' + key + '"]:checked'), function (c) { return c.value; });
  }
  function len(s) { return Array.from(s).length; }

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* Same rules and words as User/Mother/Backend/src/submissions.js */
  function check(key) {
    var v, n;
    switch (key) {
      case 'name':
        v = text('name');
        if (!v) return 'Please enter your name.';
        if (len(v) < 2) return 'Please enter your name (at least 2 letters).';
        if (len(v) > 80) return 'Please keep your name under 80 characters.';
        return '';
      case 'mobile':
        v = text('mobile');
        if (!v) return 'Please enter your mobile number, like 0917 123 4567.';
        if (/[^\d\s\-+().]/.test(v) || !util.validMobile(v)) return 'Please enter a mobile number like 0917 123 4567.';
        return '';
      case 'email':
        v = text('email');
        if (v && (v.length > 254 || !EMAIL.test(v))) return 'Please enter a valid email address, like juana@example.com, or leave it blank.';
        return '';
      case 'municipality':
        return text('municipality') ? '' : 'Please choose your municipality.';
      case 'barangay':
        return len(text('barangay')) > 80 ? 'Please keep the barangay name under 80 characters.' : '';
      case 'age':
        v = text('age');
        if (!v) return 'Please enter your age.';
        if (!/^\d{1,3}$/.test(v)) return 'Please enter your age as a whole number, like 28.';
        n = Number(v);
        if (n < 18 || n > 55) return 'Milk donors need to be between 18 and 55 years old. You can still send the facility a question.';
        return '';
      case 'babyAge':
        return radio('babyAge') ? '' : TYPE === 'donate' ? 'Please choose your baby\'s age.' : 'Please choose the baby\'s age.';
      case 'willingToScreen':
        return checked('willingToScreen') ? ''
          : 'To donate, please agree to a health screening at the facility. It keeps the babies who receive your milk safe.';
      case 'delivery':
        return radio('delivery') ? '' : 'Please choose whether you will drop off the milk or need it picked up.';
      case 'preferredDate':
        v = text('preferredDate');
        if (!v) return 'Please choose the date you would like to come in.';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !realDate(v)) return 'Please choose a real date, like ' + MAX_DATE.slice(0, 4) + '-10-05.';
        if (v < TODAY) return 'Please choose today or a later date.';
        if (v > MAX_DATE) return 'Please choose a date within the next 12 months.';
        return '';
      case 'estimatedVolume':
        return len(text('estimatedVolume')) > 80 ? 'Please keep the amount short (under 80 characters), like "about 500 ml".' : '';
      case 'notes':
        return len(text('notes')) > 1000 ? 'Please keep your notes under 1,000 characters.' : '';
      case 'relationship':
        return radio('relationship') ? '' : 'Please tell us who you are to the baby.';
      case 'babyName':
        v = text('babyName');
        if (!v) return 'Please enter the baby\'s name or initials.';
        if (len(v) > 60) return 'Please keep the baby\'s name under 60 characters.';
        return '';
      case 'reasons':
        return checkedValues('reasons').length ? '' : 'Please choose at least one reason why the baby needs donor milk.';
      case 'urgency':
        return radio('urgency') ? '' : 'Please tell us how soon the milk is needed.';
      case 'amountNeeded':
        return len(text('amountNeeded')) > 80 ? 'Please keep the amount short (under 80 characters), like "100 ml a day".' : '';
      case 'topic':
        return radio('topic') ? '' : 'Please choose what your question is about.';
      case 'question':
        v = text('question');
        if (!v) return 'Please write your question.';
        if (len(v) < 10) return 'Please tell us a little more (at least 10 characters).';
        if (len(v) > 1000) return 'Please keep your question under 1,000 characters.';
        return '';
      case 'consent':
        return checked('consent') ? '' : 'Please tick the box to agree that the facility may contact you about this.';
      default:
        return '';
    }
  }

  function allKeys() { return CONTACT_KEYS.concat(KEYS[TYPE], ['consent']); }

  /* ═════════════════════════ showing errors ═════════════════════════ */

  function inputsOf(key) {
    if (key === 'willingToScreen' || key === 'consent') return [$('f-' + key)].filter(Boolean);
    return Array.prototype.slice.call(form.querySelectorAll('[name="' + key + '"]'));
  }
  function focusTarget(key) {
    var list = inputsOf(key);
    var picked = list.filter(function (i) { return i.checked; })[0];
    return picked || list[0] || null;
  }
  function describe(input, id, add) {
    var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (x) { return x && x !== id; });
    if (add) ids.push(id);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  }

  function setError(key, message) {
    var wrap = form.querySelector('[data-field="' + key + '"]');
    var err = $('err-' + key);
    if (!wrap || !err) return false;
    if (message) {
      err.innerHTML = ui.icon('i-alert', 'icon--sm') + '<span>' + esc(message) + '</span>';
      err.hidden = false;
      shown[key] = message;
    } else {
      err.innerHTML = '';
      err.hidden = true;
      delete shown[key];
    }
    wrap.classList.toggle('has-error', Boolean(message));
    inputsOf(key).forEach(function (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      describe(input, err.id, Boolean(message));
    });
    return true;
  }

  function validate(key) {
    var message = check(key);
    setError(key, message);
    return message;
  }

  /* Error summary at the top: a fresh role="alert" block so screen readers announce it */
  /* scope: the keys of one step (errors while moving between steps), or
     undefined for the whole form (when sending) */
  function renderSummary(scope) {
    if (scope !== undefined) summaryScope = scope;
    var slot = $('summarySlot');
    var keys = (summaryScope || allKeys()).filter(function (k) { return shown[k]; });
    var general = summaryScope ? [] : generalErrors;
    var total = keys.length + general.length;
    if (!total) { slot.innerHTML = ''; return; }
    var items = general.map(function (m) { return '<li>' + esc(m) + '</li>'; }).concat(keys.map(function (k) {
      var target = focusTarget(k);
      return '<li><a href="#' + (target ? target.id : 'f-' + k) + '" data-focus="' + k + '">' + esc(shown[k]) + '</a></li>';
    }));
    var action = current === steps.length - 1 ? 'before sending' : 'to continue';
    slot.innerHTML = '<div class="form-errors form-summary" role="alert" id="errorSummary">' +
      '<p class="form-summary__title">' + ui.icon('i-alert', 'icon--sm') +
      (total === 1 ? 'Please fix 1 thing ' + action + ':' : 'Please fix ' + total + ' things ' + action + ':') + '</p>' +
      '<ul>' + items.join('') + '</ul></div>';
  }

  function refreshSummaryIfShown() {
    if ($('errorSummary')) renderSummary();
  }

  function focusField(key) {
    // the field may be on another step: show that step first
    var s = stepOfKey(key);
    if (steps.length && s !== current) goTo(s, { focus: false, scroll: false, keepSummary: true });
    var target = focusTarget(key);
    if (!target) return;
    var wrap = form.querySelector('[data-field="' + key + '"]') || target;
    wrap.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
  }

  /* ═════════════════════════ events ═════════════════════════ */

  function keyOf(input) {
    if (!input || !input.name) return null;
    if (OPT.screening.some(function (o) { return o[0] === input.name; })) return input.name === 'willingToScreen' ? 'willingToScreen' : null;
    return input.name;
  }

  function bindForm() {
    form.addEventListener('input', function (e) {
      var key = keyOf(e.target);
      if (key) touched[key] = true;
      // While typing, only clear an error once it is fixed — never nag mid-word
      if (key && shown[key] && !check(key)) { setError(key, ''); refreshSummaryIfShown(); }
      if (e.target.tagName === 'TEXTAREA') updateCounters();
      scheduleSave();
    });

    form.addEventListener('change', function (e) {
      var key = keyOf(e.target);
      var t = e.target.type;
      if (key && (t === 'radio' || t === 'checkbox' || e.target.tagName === 'SELECT' || t === 'date')) {
        touched[key] = true;
        validate(key);
        refreshSummaryIfShown();
      }
      if (e.target.name === 'urgency') updateUrgent();
      scheduleSave();
    });

    // Blur: check a field once the mother has typed in it (or after she tried to send)
    form.addEventListener('focusout', function (e) {
      var key = keyOf(e.target);
      if (!key) return;
      var t = e.target.type;
      if (t === 'radio' || t === 'checkbox') {
        // leaving a whole group without choosing, after a first attempt
        if (attempted && !e.target.closest('[data-field]').contains(e.relatedTarget)) validate(key);
      } else if (touched[key] || attempted || shown[key]) {
        validate(key);
      }
      refreshSummaryIfShown();
    });

    form.addEventListener('click', function (e) {
      var link = e.target.closest('[data-focus]');
      if (link) { e.preventDefault(); focusField(link.getAttribute('data-focus')); }
      var clear = e.target.closest('[data-clear-draft]');
      if (clear) { e.preventDefault(); startOver(); }
      if (e.target.closest('[data-step-next]')) { e.preventDefault(); nextStep(); }
      if (e.target.closest('[data-step-back]')) { e.preventDefault(); goTo(current - 1); }
    });

    form.addEventListener('submit', onSubmit);
  }

  // the step bar sits in the page header band, outside the <form>
  els.outline.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-goto]');
    if (btn && form) jumpTo(Number(btn.getAttribute('data-goto')));
  });

  function onSubmit(e) {
    e.preventDefault();
    if (sending) return;
    // Enter pressed on an earlier step means "Next", not "send"
    if (current < steps.length - 1) { nextStep(); return; }
    attempted = true;
    generalErrors = [];
    $('sendError').innerHTML = '';
    var bad = allKeys().filter(function (k) { return validate(k); });
    if (bad.length) {
      var s = stepOfKey(bad[0]);
      if (s !== current) goTo(s, { focus: false, scroll: false });
      renderSummary(steps[s].keys);
      focusField(bad[0]);
      return;
    }
    renderSummary(null);
    send();
  }

  /* ═════════════════════════ sending ═════════════════════════ */

  function payload() {
    var details;
    if (TYPE === 'donate') {
      var screening = {};
      OPT.screening.forEach(function (o) { screening[o[0]] = checked(o[0]); });
      details = {
        age: Number(text('age')),
        babyAge: radio('babyAge'),
        screening: screening,
        preferredDate: text('preferredDate'),
        preferredTime: text('preferredTime') || 'any',
        delivery: radio('delivery'),
        estimatedVolume: text('estimatedVolume'),
        notes: text('notes')
      };
    } else if (TYPE === 'request') {
      details = {
        relationship: radio('relationship'),
        babyName: text('babyName'),
        babyAge: radio('babyAge'),
        reasons: checkedValues('reasons'),
        admitted: radio('admitted'),
        urgency: radio('urgency'),
        amountNeeded: text('amountNeeded'),
        hasReferral: radio('hasReferral'),
        notes: text('notes')
      };
    } else {
      details = { topic: radio('topic'), question: text('question'), preferredContact: radio('preferredContact') };
    }
    return {
      type: TYPE,
      facilityId: facility.id,
      consent: checked('consent'),
      contact: {
        name: text('name'),
        mobile: text('mobile'),
        email: text('email'),
        municipality: text('municipality'),
        barangay: text('barangay')
      },
      details: details
    };
  }

  function setBusy(busy) {
    var btn = $('submitBtn');
    btn.disabled = busy;
    btn.classList.toggle('is-loading', busy);
    btn.setAttribute('aria-busy', String(busy));
    $('submitLabel').textContent = busy ? 'Sending…' : T.submit;
  }

  function send() {
    sending = true;
    setBusy(true);
    var data = payload();
    api.submit(data).then(function (res) {
      util.rememberSubmission({
        ref: res.ref,
        mobile: util.normalizeMobile(data.contact.mobile),
        type: res.type,
        typeLabel: res.typeLabel,
        facilityId: res.facilityId,
        facilityName: res.facilityName,
        createdAt: res.createdAt
      });
      clearDraft();
      sent = true;
      // stay "sending" so nothing can be sent twice while the next page opens
      location.assign('confirm.html?ref=' + encodeURIComponent(res.ref));
    }).catch(function (err) {
      sending = false;
      setBusy(false);
      if (err && err.status === 422 && err.fields) {
        generalErrors = [];
        Object.keys(err.fields).forEach(function (k) {
          if (!setError(k, err.fields[k])) generalErrors.push(err.fields[k]);
        });
        // keep form order: go to the step of the earliest field that has an error
        var ordered = allKeys().filter(function (k) { return shown[k]; });
        if (ordered.length) {
          var step = stepOfKey(ordered[0]);
          if (step !== current) goTo(step, { focus: false, scroll: false });
          renderSummary(generalErrors.length ? null : steps[step].keys);
          focusField(ordered[0]);
        } else {
          renderSummary(null);
          var s = $('errorSummary'); if (s) { s.setAttribute('tabindex', '-1'); s.focus(); }
        }
        return;
      }
      $('sendError').innerHTML = '<div class="form-errors" role="alert"><p class="form-summary__title">' +
        ui.icon('i-alert', 'icon--sm') + esc(err && err.offline ? 'We couldn\'t send your form' : 'Your form was not sent') + '</p>' +
        '<p class="form-send__errtext">' + esc(err && err.offline
          ? 'MOWMMAS can\'t be reached right now. Check your internet connection and press the button again. Your answers are still here.'
          : (err && err.message) || 'Something went wrong. Please try again.') + '</p></div>';
      ui.toast('Your form was not sent. Please try again.', 'warn');
    });
  }

  /* ═════════════════════════ draft (sessionStorage) ═════════════════════════ */

  function collect() {
    var values = {};
    Array.prototype.forEach.call(form.elements, function (e) {
      if (!e.name || e.name === 'consent' || e.tagName === 'BUTTON') return;
      if (e.type === 'radio') { if (e.checked) values[e.name] = e.value; }
      else if (e.type === 'checkbox') {
        if (e.name === 'reasons') { values.reasons = values.reasons || []; if (e.checked) values.reasons.push(e.value); }
        else values[e.name] = e.checked;
      } else values[e.name] = e.value;
    });
    return values;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), values: collect() })); }
      catch (e) { /* storage unavailable — the form still works */ }
    }, 350);
  }

  function clearDraft() {
    clearTimeout(saveTimer);
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }

  function restoreDraft() {
    var draft = null;
    try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); } catch (e) { draft = null; }
    if (!draft || !draft.values || typeof draft.values !== 'object') return false;
    var meaningful = false;
    Object.keys(draft.values).forEach(function (name) {
      var v = draft.values[name];
      Array.prototype.forEach.call(form.querySelectorAll('[name="' + name.replace(/[^\w-]/g, '') + '"]'), function (e) {
        if (e.type === 'radio') e.checked = e.value === v;
        else if (e.type === 'checkbox') e.checked = Array.isArray(v) ? v.indexOf(e.value) !== -1 : v === true;
        else if (typeof v === 'string') e.value = v;
      });
      if ((typeof v === 'string' && v.trim() && !(name === 'preferredTime' && v === 'any') && !(name === 'preferredContact' && v === 'sms')) ||
          v === true || (Array.isArray(v) && v.length)) meaningful = true;
    });
    return meaningful;
  }

  function showDraftNote() {
    $('draftSlot').innerHTML = '<div class="form-draft" role="status">' + ui.icon('i-refresh', 'icon--sm') +
      '<p><strong>Welcome back.</strong> We filled in the answers you started earlier on this device.</p>' +
      '<button class="btn btn--outline btn--sm" type="button" data-clear-draft>Start over</button></div>';
  }

  function startOver() {
    form.reset();
    clearDraft();
    touched = {};
    attempted = false;
    generalErrors = [];
    allKeys().forEach(function (k) { if (shown[k]) setError(k, ''); });
    $('summarySlot').innerHTML = '';
    $('draftSlot').innerHTML = '';
    $('sendError').innerHTML = '';
    updateCounters();
    updateUrgent();
    furthest = 0;
    goTo(0, { focus: false });
    var first = $('f-name');
    if (first) first.focus();
    ui.toast('The form is empty again.');
  }

  /* ═════════════════════════ small live helpers ═════════════════════════ */

  function updateCounters() {
    Array.prototype.forEach.call(form.querySelectorAll('textarea'), function (t) {
      var c = $('count-' + t.name);
      if (c) c.textContent = len(t.value) + ' / ' + t.getAttribute('maxlength');
    });
  }

  /* An urgent request should never wait on a web form alone */
  function updateUrgent() {
    var box = $('urgentNote');
    if (!box) return;
    if (radio('urgency') !== '24h') { box.innerHTML = ''; return; }
    var call = facility.contactNumber
      ? 'please also call ' + esc(facility.name) + ' now at <a href="' + esc(util.telHref(facility.contactNumber)) + '">' + esc(facility.contactNumber) + '</a>'
      : 'please also go to ' + esc(facility.name) + ' or the nearest hospital now';
    box.innerHTML = '<p class="form-urgent__box">' + ui.icon('i-alert', 'icon--sm') +
      '<span><strong>Needed within 24 hours?</strong> Send this form, and ' + call + '. Don\'t wait for a reply.</span></p>';
  }

  /* ═════════════════════════ loading ═════════════════════════ */

  function showBadType() {
    setHead('Choose a service first', 'This form needs to know whether you want to donate milk, request milk or ask a question.');
    setBack(FACILITY_ID ? facilityHref(FACILITY_ID) : 'hospitals.html', FACILITY_ID ? 'Back to facility details' : 'Back to Hospitals Near Me');
    hideSide();
    els.root.innerHTML = stateHtml('i-list', 'Please choose a service',
      'Go back and choose Donate breast milk, Request breast milk or Inquire.',
      FACILITY_ID ? linkBtn(facilityHref(FACILITY_ID) + '#nextStep', 'Choose Donate or Request', 'primary', 'i-arrow-left')
                  : linkBtn('hospitals.html', 'Find a facility', 'primary', 'i-search'));
    doneLoading();
  }

  function showNoFacility() {
    setHead(T.title, 'We couldn\'t find the health facility for this form.');
    setBack(hospitalsHref(), 'Back to Hospitals Near Me');
    hideSide();
    els.root.innerHTML = stateHtml('i-hospital', 'Facility not found',
      'The link may be old or incomplete. Please choose the facility again from the list.',
      linkBtn(hospitalsHref(), 'Find a facility', 'primary', 'i-search'));
    doneLoading();
  }

  function showNotOffered(f) {
    setHead(T.title, f.name + ' ' + T.notOffered + ', according to the information shared with MOWMMAS.');
    els.side.innerHTML = chipHtml(f);
    els.root.innerHTML = stateHtml('i-info', 'This facility can\'t take this form',
      'You can ask ' + f.name + ' a question instead, or choose another facility.',
      linkBtn(hospitalsHref(), T.otherFacilities, 'primary', 'i-search') +
      linkBtn('form.html?type=inquire&facility=' + encodeURIComponent(f.id), 'Ask this facility a question', 'outline', 'i-chat'));
    doneLoading();
  }

  function load() {
    els.root.setAttribute('aria-busy', 'true');
    els.root.innerHTML = '<div class="form-skel" aria-hidden="true"><div class="skeleton form-skel__card"></div>' +
      '<div class="skeleton form-skel__card"></div></div><p class="sr-only">Loading the form…</p>';
    els.side.hidden = false;
    els.side.innerHTML = '<div class="skeleton form-skel-chip" aria-hidden="true"></div>';

    api.facilities().then(function (data) {
      var list = (data && data.facilities) || [];
      facility = list.filter(function (x) { return x.id === FACILITY_ID; })[0] || null;
      if (!facility) return showNoFacility();

      setBack(facilityHref(facility.id), 'Back to facility details');
      if (T.needs && facility.services && facility.services[T.needs] === false) return showNotOffered(facility);

      setHead(T.title, 'Your details will be sent to the health workers of ' + facility.name + '.');
      els.meta.innerHTML = '<span>' + ui.icon('i-clock', 'icon--xs') + 'Takes about ' + T.minutes + ' minutes</span>' +
        '<span>' + ui.icon('i-edit', 'icon--xs') + 'Questions marked (optional) can be skipped</span>';
      els.meta.hidden = false;
      els.side.innerHTML = chipHtml(facility);
      var municipalities = ((data && data.municipalities) || []).map(function (m) { return m && m.name; }).filter(Boolean);
      renderForm(facility, municipalities);
      doneLoading();
    }).catch(function (err) {
      els.side.innerHTML = '';
      els.side.hidden = true;
      els.root.innerHTML = ui.errorState(err, 'Try again');
      doneLoading();
    });
  }

  /* Coming back with the browser's Back button after sending: start with a
     fresh page, so the same form can't be sent twice by accident */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && sent) location.reload();
  });

  /* Retry buttons inside error states */
  els.root.addEventListener('click', function (e) {
    if (e.target.closest('[data-retry]')) load();
  });

  /* ═════════════════════════ start ═════════════════════════ */
  showEyebrow();
  if (!T) {
    showBadType();
  } else if (!FACILITY_ID) {
    showNoFacility();
  } else {
    setHead(T.title, 'Loading the facility…');
    setBack(facilityHref(FACILITY_ID), 'Back to facility details');
    load();
  }
})();
