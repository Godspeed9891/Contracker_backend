// Moved verbatim from the original server.js (lines 53-62): the Postgres pool and initSchema().
// Only change: schema.sql is now looked up at the project root (two folders up from here).

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { DATABASE_URL } = require("./env");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// If Postgres drops a connection that is sitting idle in the pool (a restart, a network blip), the pool emits an
// 'error' event. With no listener Node treats that as fatal and stops the whole server. Log it and carry on:
// the pool throws the dead connection away and opens a new one for the next request.
pool.on("error", (err) =>
  console.error("Idle database connection lost:", err.message),
);

async function initSchema() {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "..", "schema.sql"),
    "utf8",
  );
  await pool.query(sql);
  console.log("Schema ready.");
}
// Runs fn(client) between BEGIN and COMMIT on one connection. If fn returns an object with rollback: true the
// work is rolled back instead (a refused request); if fn throws it is rolled back and the error is re-thrown.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(result && result.rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, withTransaction };
