// Moved verbatim from legacy.routes.js: upload limits and the file types that are allowed.

const FILE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain'
};

module.exports = { FILE_MAX_BYTES, FILE_TYPES };