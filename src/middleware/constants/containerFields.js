const { FEN_BOL_DEPTS, FINANCE_DEPTS } = require('./stages');

const FIELD_LABELS = {
  transferLetterNumber: 'transfer letter number', invoiceNumber: 'invoice / charge number', transporter: 'transporter details',
  transportHistory: 'transporter history', exitNumber: 'exit number', invoices: 'invoices', bolComplete: 'Book of Life status',
  archived: 'archived status', aNumber: 'A-Number', cNumber: 'C-Number', containerNumber: 'container number', billOfLading: 'Bill of Lading',
  size: 'container size', item: 'cargo description', destination: 'destination'
};
const labelOf = k => FIELD_LABELS[k] || k;

const RESTRICTED_CONTAINER_FIELDS = {
  transferLetterNumber: ['Documentation', 'Operations', 'Admin'],
  invoiceNumber: ['Accountant', 'DTI', 'Operations', 'Admin'],
  transporter: ['Documentation', 'DTI', 'Transport', 'Admin'],
  transportHistory: ['Documentation', 'DTI', 'Transport', 'Admin'],
  exitNumber: ['Operations', 'Admin'],
  invoices: FINANCE_DEPTS,
  archived: ['Admin'],
  bolComplete: FEN_BOL_DEPTS,
  aNumber: FEN_BOL_DEPTS,
  cNumber: FEN_BOL_DEPTS,
  // Job identity details (fixing a mistyped container number etc.)
  containerNumber: FEN_BOL_DEPTS,
  billOfLading: FEN_BOL_DEPTS,
  size: FEN_BOL_DEPTS,
  item: FEN_BOL_DEPTS,
  destination: FEN_BOL_DEPTS
};

module.exports = { FIELD_LABELS, labelOf, RESTRICTED_CONTAINER_FIELDS };