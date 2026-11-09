// One-time clean-up: moves ID photos that are stored inside the users record (base64 text) into the files table, and
// leaves only a small idFileId pointer on each account. The work happens inside the database, so the photos are
// never downloaded to this computer. Safe to run twice (it only touches accounts that still carry a photo).
// Stop the server first so nothing saves the users list while this runs.
//
//   node --env-file=.env scripts/move-id-photos.js

const { pool } = require('../src/config/db');

const SQL = `
WITH locked AS (SELECT value FROM kv_store WHERE key = 'users' FOR UPDATE),
photos AS (
  SELECT u->>'id' AS uid,
         u->>'idFileName' AS fname,
         (regexp_match(u->>'idImage', '^data:(image/(?:png|jpeg|webp));base64,'))[1] AS mime,
         decode(regexp_replace(u->>'idImage', '^data:[^,]*,', ''), 'base64') AS bytes,
         gen_random_uuid()::text AS fid
    FROM locked, jsonb_array_elements(locked.value) u
   WHERE jsonb_typeof(locked.value) = 'array' AND u->>'idImage' ~ '^data:image/(png|jpeg|webp);base64,'
),
ins AS (
  INSERT INTO files (id, name, mime, size, data, uploaded_by)
  SELECT fid,
         regexp_replace(coalesce(nullif(fname, ''), 'id-photo'), '\\.[A-Za-z0-9]+$', '') || CASE mime WHEN 'image/png' THEN '.png' WHEN 'image/webp' THEN '.webp' ELSE '.jpg' END,
         mime, length(bytes), bytes, uid
    FROM photos WHERE length(bytes) > 0
  RETURNING id, uploaded_by
)
UPDATE kv_store SET value = (
  SELECT jsonb_agg(CASE WHEN ins.id IS NOT NULL THEN (e.u - 'idImage') || jsonb_build_object('idFileId', ins.id) ELSE e.u END ORDER BY e.n)
    FROM jsonb_array_elements(kv_store.value) WITH ORDINALITY AS e(u, n)
    LEFT JOIN ins ON ins.uploaded_by = e.u->>'id'
), updated_at = now()
WHERE key = 'users' AND jsonb_typeof(value) = 'array' AND EXISTS (SELECT 1 FROM photos)
RETURNING (SELECT count(*) FROM photos) AS moved
`;

(async () => {
  const size = async () => Number((await pool.query("SELECT pg_column_size(value) AS b FROM kv_store WHERE key = 'users'")).rows[0]?.b || 0);
  const before = await size();
  const r = await pool.query(SQL);
  const after = await size();
  console.log((r.rows[0] ? r.rows[0].moved : 0) + ' ID photo(s) moved. users record: ' + (before / 1048576).toFixed(2) + ' MB -> ' + (after / 1048576).toFixed(2) + ' MB');
  await pool.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });