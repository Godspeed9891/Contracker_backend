# ConTracker backend: salvaging server.js into MVC

Rule for every step: move code, do not change what it does. Fixes come later, one at a time.
`original/server.js` is the untouched 1,195-line file (read-only). Line numbers below refer to it.

## How it runs while we migrate

`src/legacy/legacy.routes.js` holds everything that has not been moved yet, line for line.
Each step moves a slice out of it into its proper folder. When it is empty, it is deleted.
The app starts and behaves like the original after every step.

## Step 1 (done): foundations

| New file | Came from original | Note |
|---|---|---|
| `server.js` | 646, 1186-1195 | boot only: http server, websocket attach, schema, listen, file cleanup timers |
| `src/app.js` | 64-67, 1180 | helmet, cors, json body, routes, error handler (same order) |
| `src/config/env.js` | 40-51 | PORT, JWT_SECRET, DATABASE_URL and the exit-if-missing checks |
| `src/config/db.js` | 53-62 | pool and initSchema; schema.sql is now looked up at the project root |
| `src/models/kv.model.js` | 88-99 | kvGet / kvSet, the only code that touches kv_store |
| `src/utils/compare.js` | 101-119, 371-388 | deepEqual, isBlankVal, looseEqual |
| `src/realtime/hub.js` | 645-668 | websocket server attach + broadcastChanged |
| `src/middleware/errorHandler.js` | 1180-1184 | last-resort error handler |
| `src/legacy/legacy.routes.js` | everything else | `app.get/post/put` became `router.get/post/put` |

Checked by running the original and this version side by side on the same requests (50 checks: login,
roles, scoped reads, container writes and conflicts, registration, password reset, file upload and
download, 25 MB limit, malformed JSON, WebSocket push). Responses were identical.

## Step 2 (done): auth

| New file | Came from original | Note |
|---|---|---|
| `src/routes/auth.routes.js` | new (paths from 876, 949, 967, 987, 1001) | the five `/api/auth/*` URLs and their `authRequired` guards |
| `src/controllers/auth.controller.js` | 868-1043 | register, login, setPassword, resetSeedCredentials, restoreDemoAccounts; bodies unchanged, still holding their own SQL and rules for now |
| `src/middleware/auth.js` | 73-84 | authOptional, authRequired |
| `src/utils/token.js` | 70-72 | signToken |
| `src/policies/role.policy.js` | 85-86 | isSctl, isTerminalAdmin |
| `src/models/user.model.js` | 461-464 | profileOf |

Checked with 75 side-by-side requests against the original, using your real `schema.sql`. That includes
the success paths of reset-seed-credentials, restore-demo-accounts and terminal-admin set-password.

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `JWT_SECRET`
   (for a Postgres on your own machine also set `PGSSLMODE=disable`).
3. `npm run dev` (Node 20.6 or newer; it loads `.env` itself because the code reads `process.env` directly).
4. Open http://localhost:4000/api/health and you should see `{"ok":true}`.

On Render or Railway, set the same variables in the dashboard and run `npm start`.

## Next steps, in order

3. Constants and policies: roles, departments, stage rules, field labels; the visibility and write-permission functions (user, terminal, container, document, message, referral, log) into `policies/`
4. Collections one at a time through `/api/storage/:key`: users, terminals, containers, then activity-log, referrals, messages (service per collection, views for redaction)
5. Files and documents: `/api/files`, `checkDocumentChanges`, `cleanupOrphanFiles`
6. Health and bootstrap routes, then `legacy.routes.js` is deleted
7. Thin the controllers: SQL into `models/`, rules into `services/` (auth first)
8. Optional, on its own: convert to ES modules (`"type": "module"`). It touches every file (`require` to `import`,
   `.js` extensions, no `__dirname`), so it gets its own step and the same side-by-side check.

## Still needed from you

- Your `package.json`, so dependency versions match what you run today. Express is pinned to 4.x here and npm picked the newest bcryptjs, helmet, pg and ws.

## Noticed, not fixed (original line numbers)

Two of these were reproduced against the original code on a scratch database.

1. **Any signed-in user can make themselves SCTL (confirmed).** A user may edit their own record in
   `users` (`checkUsersWrite`, 349-355), including `role`, and the next login signs a token from the
   stored role (960-963). An importer who saved `role: "sctl"` got an SCTL token on next login.
2. **A pending self-registered account can sign in as a terminal Admin (confirmed).** Registration
   takes `role` and `department` from the request (891, 929) and login never checks `status`
   (949-965). Registering as role `admin`, department `Admin` at any active terminal gave an
   Admin token for that terminal while still pending.
3. A terminal Admin may set any role, including `sctl`, on accounts at their own terminal (335-346).
4. Credentials-only register (882-888) is public and accepts any `id`, so it can attach a password to
   a user id that has none yet.
5. Role, department and terminal live in the token for 12 hours and are not re-read from the database
   (70-84), so a suspended or demoted account keeps its access until the token expires.
   `set-password` does not invalidate old tokens either.
6. Any signed-in user can PUT any other storage key (1171-1173), creating arbitrary rows.
7. `PUT /api/storage/:key` reads, checks and writes without a lock or transaction (1089-1178), so two
   saves at the same moment can overwrite each other; the `_v` check is not atomic.
8. Async route handlers have no try/catch. On Express 4 a database error inside one becomes an
   unhandled rejection that can stop the process.
9. No rate limiting on login or registration; passwords only need 6 characters; JSON bodies up to 25 MB
   are accepted on unauthenticated routes.
10. `bootstrap-demo-data` is open to anyone while the `users` collection does not exist (1045-1062).
11. WebSocket token is passed in the URL (650-661), sockets are never re-checked after connecting, and
    every socket is told about every change, whatever its role or terminal. The message carries only
    the collection name, not data.
12. Scale: each collection is one JSON row that is read and rewritten whole on every request, and
    `withDuplicateFlags` and file downloads scan whole collections. This is the main limit for
    expanding, and the reason to move to real tables later.
