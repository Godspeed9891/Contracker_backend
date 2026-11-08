// Password hashing in one place (bcrypt, cost 10, as before).

const bcrypt = require('bcryptjs');

const hashPassword = plain => bcrypt.hash(plain, 10);
const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

module.exports = { hashPassword, checkPassword };