const { FEN_BOL_DEPTS, FINANCE_DEPTS } = require('./stages');

const FIELD_LABELS = {
  transferLetterNumber: 'transfer letter number', invoiceNumber: 'invoice / charge number', transporter: 'transporter details',
  transportHistory: 'transporter history', exitNumber: 'exit number', invoices: 'invoices', bolComplete: 'Book of Life status',
  archived: 'archived status', aNumber: 'A-Number', cNumber: 'C-Number', containerNumber: 'container number', billOfLading: 'Bill of Lading',
  size: 'container size', item: 'cargo description', destination: 'destination',
  alerts: 'alerts', steppedDown: 'stepped-down status', deliveryLocation: 'delivery location',
  returnDueDate: 'return-by date', leftTerminalDate: 'date left the terminal', returnedDate: 'date returned to the wharf'
};
const labelOf = k => FIELD_LABELS[k] || k;

const RESTRICTED_CONTAINER_FIELDS = {
  transferLetterNumber: ['Documentation', 'Operations', 'Admin'],
  invoiceNumber: ['Accountant', 'DTI', 'Operations', 'Admin'],
  transporter: ['Documentation', 'DTI', 'Transport', 'Admin'],
  transportHistory: ['Documentation', 'DTI', 'Transport', 'Admin'],
  exitNumber: ['Documentation', 'DTI', 'Operations', 'Admin'],
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

// What each department may do by default (the client's list). The terminal Admin can switch any of these on or off for one person.
const CAP_DEPTS = {
  fen: ['Admin', 'Documentation', 'DTI'],
  bol: ['Admin', 'Documentation', 'DTI'],
  alert: ['Admin', 'Documentation', 'DTI'],
  stepDown: ['Admin', 'Documentation', 'DTI', 'Field Staff'],
  exit: ['Admin', 'Documentation', 'DTI', 'Operations'],
  transporter: ['Admin', 'Documentation', 'DTI', 'Transport'],
  transferNo: ['Admin', 'Documentation', 'Operations'],
  invoiceNo: ['Admin', 'Accountant', 'DTI', 'Operations'],
  deliveryLoc: ['Admin', 'Documentation', 'DTI', 'Transport'],
  finance: ['Admin', 'Accountant'],
  archiveView: ['Admin', 'Documentation', 'DTI'],
  archive: ['Admin'],
  returnDates: ['Admin', 'Documentation', 'DTI', 'Transport']
};
const FIELD_CAPS = {
  containerNumber: 'fen', billOfLading: 'fen', size: 'fen', item: 'fen', destination: 'fen',
  bolComplete: 'bol', aNumber: 'bol', cNumber: 'bol',
  alerts: 'alert', steppedDown: 'stepDown', exitNumber: 'exit',
  transporter: 'transporter', transportHistory: 'transporter',
  transferLetterNumber: 'transferNo', invoiceNumber: 'invoiceNo',
  deliveryLocation: 'deliveryLoc', invoices: 'finance', archived: 'archive',
  returnDueDate: 'returnDates', leftTerminalDate: 'returnDates', returnedDate: 'returnDates',
};

module.exports = { FIELD_LABELS, labelOf, RESTRICTED_CONTAINER_FIELDS, CAP_DEPTS, FIELD_CAPS };