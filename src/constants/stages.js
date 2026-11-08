const FEN_BOL_DEPTS = ['Admin', 'Documentation', 'DTI'];
const FINANCE_DEPTS = ['Admin', 'Accountant'];
const DEFAULT_DEPT_STAGE_ACCESS = {
  Documentation: [], DTI: [], 'Field Staff': [0, 1, 2, 3, 4, 5, 6, 7, 8],
  Operations: [9, 10, 11, 12], Transport: [13, 14], Accountant: []
};
const DERIVED_CONTAINER_KEYS = new Set(['duplicateFlag']); // computed by the app on load, not real edits

module.exports = { FEN_BOL_DEPTS, FINANCE_DEPTS, DEFAULT_DEPT_STAGE_ACCESS, DERIVED_CONTAINER_KEYS };