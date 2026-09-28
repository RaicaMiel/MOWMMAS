'use strict';
/* Submission types and the statuses a health worker can move them through.
   MOWMMAS only reviews forms and gives information, next steps or a referral: no status
   is a medical decision. The Mother backend keeps an identical copy (User/Mother/Backend/src/statuses.js) — change both together. */

const TYPES = {
  donate:  { label: 'Donation Inquiry',  short: 'Donation',  refLetter: 'D' },
  request: { label: 'Receiving Inquiry', short: 'Receiving', refLetter: 'R' },
  inquire: { label: 'Inquiry',           short: 'Inquiry',   refLetter: 'I' }
};

const STATUS_LABELS = {
  submitted:        'New',
  under_review:     'Under Review',
  referral_needed:  'Referral Needed',
  next_steps:       'Referral/Next Steps Provided',
  information_sent: 'Information Sent',
  answered:         'Answered',
  completed:        'Completed',
  closed:           'Closed'
};

// "submitted" is named after what she sent
const SUBMITTED_LABELS = {
  donate:  'New Donation Inquiry',
  request: 'New Receiving Inquiry',
  inquire: 'New Question'
};

// Allowed statuses for each type, in the order they normally happen
const STATUS_FLOW = {
  donate:  ['submitted', 'under_review', 'next_steps', 'information_sent', 'completed', 'closed'],
  request: ['submitted', 'under_review', 'referral_needed', 'information_sent', 'completed', 'closed'],
  inquire: ['submitted', 'answered', 'closed']
};

// Statuses after which nothing more is expected
const FINAL = ['completed', 'closed'];

// type: the submission's type (only "submitted" depends on it). An unknown status shows as its key.
const statusLabel = (status, type) =>
  (status === 'submitted' && SUBMITTED_LABELS[type]) || STATUS_LABELS[status] || status;

module.exports = { TYPES, STATUS_LABELS, SUBMITTED_LABELS, STATUS_FLOW, FINAL, statusLabel };
