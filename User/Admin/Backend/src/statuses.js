'use strict';
/* Submission types and the statuses a health worker can move them through.
   The Mother backend keeps an identical copy (User/Mother/Backend/src/statuses.js) — change both together. */

const TYPES = {
  donate:  { label: 'Donate Breast Milk',  short: 'Donation', refLetter: 'D' },
  request: { label: 'Request Breast Milk', short: 'Request',  refLetter: 'R' },
  inquire: { label: 'Inquiry',             short: 'Inquiry',  refLetter: 'I' }
};

const STATUS_LABELS = {
  submitted:           'Submitted',
  under_review:        'Under review',
  screening_scheduled: 'Screening scheduled',
  accepted:            'Donation accepted',
  approved:            'Approved',
  ready_for_pickup:    'Ready for pick-up',
  answered:            'Answered',
  completed:           'Completed',
  closed:              'Closed',
  declined:            'Declined'
};

// Allowed statuses for each type, in the order they normally happen
const STATUS_FLOW = {
  donate:  ['submitted', 'under_review', 'screening_scheduled', 'accepted', 'completed', 'declined'],
  request: ['submitted', 'under_review', 'approved', 'ready_for_pickup', 'completed', 'declined'],
  inquire: ['submitted', 'answered', 'closed']
};

// Statuses after which nothing more is expected
const FINAL = ['completed', 'closed', 'declined'];

const statusLabel = (status) => STATUS_LABELS[status] || status;

module.exports = { TYPES, STATUS_LABELS, STATUS_FLOW, FINAL, statusLabel };
