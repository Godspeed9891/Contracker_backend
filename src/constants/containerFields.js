const { FEN_BOL_DEPTS, FINANCE_DEPTS } = require('./stages');

const FIELD_LABELS = {
  transferLetterNumber: 'transfer letter number', invoiceNumber: 'invoice / charge number', transporter: 'transporter details',
  transportHistory: 'transporter history', exitNumber: 'exit number', invoices: 'invoices', bolComplete: 'Book of Life status',
  archived: 'archived status', aNumber: 'A-Number', cNumber: 'C-Number', containerNumber: 'container number', billOfLading: 'Bill of Lading',
  size: 'container size', item: 'cargo description', destination: 'destination',
  alerts: 'alerts', steppedDown: 'stepped-down status', deliveryLocation: 'delivery location',
  returnDueDate: 'return-by date', leftTerminalDate: 'date left the terminal', returnedDate: 'date returned to the wharf',
  owner: 'importer', agent: 'clearing agent', deleteRequest: 'deletion request',
  eta: 'ETA', arrivedDate: 'vessel arrival date', arrivedBy: 'vessel arrival record', financial: 'financial breakdown',
  sealNumber: 'seal number', sealMismatch: 'seal check'
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
// The Accountant can do everything Documentation can, so it is listed wherever Documentation is.
const CAP_DEPTS = {
  fen: ['Admin', 'Documentation', 'Accountant', 'DTI'],
  bol: ['Admin', 'Documentation', 'Accountant', 'DTI'],
  alert: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Operations', 'Field Staff'],
  stepDown: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Field Staff', 'Operations'],
  exit: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Operations'],
  transporter: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Transport', 'Operations'],
  transferNo: ['Admin', 'Documentation', 'Accountant', 'Operations'],
  invoiceNo: ['Admin', 'Accountant', 'DTI', 'Operations'],
  deliveryLoc: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Transport', 'Operations'],
  finance: ['Admin', 'Accountant'],
  archiveView: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Operations'],
  archive: ['Admin'],
  returnDates: ['Admin', 'Documentation', 'Accountant', 'DTI', 'Transport', 'Operations'],
  seal: ['Admin', 'Documentation', 'DTI', 'Operations']
};
const FIELD_CAPS = {
  containerNumber: 'fen', billOfLading: 'fen', size: 'fen', item: 'fen', destination: 'fen', owner: 'fen', agent: 'fen',
  eta: 'fen', arrivedDate: 'fen', arrivedBy: 'fen',
  bolComplete: 'bol', aNumber: 'bol', cNumber: 'bol',
  sealNumber: 'seal', sealMismatch: 'seal',
  alerts: 'alert', steppedDown: 'stepDown', exitNumber: 'exit',
  transporter: 'transporter', transportHistory: 'transporter',
  transferLetterNumber: 'transferNo', invoiceNumber: 'invoiceNo',
  deliveryLocation: 'deliveryLoc', invoices: 'finance', financial: 'finance', archived: 'archive',
  returnDueDate: 'returnDates', leftTerminalDate: 'returnDates', returnedDate: 'returnDates',
  deleteRequest: 'archiveView'
};

module.exports = { FIELD_LABELS, labelOf, RESTRICTED_CONTAINER_FIELDS, CAP_DEPTS, FIELD_CAPS };