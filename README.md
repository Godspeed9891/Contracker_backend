# ConTracker backend

A real server + database for ConTracker: hashed passwords checked
server-side, every bonded terminal's devices reading and writing the same
shared data, and live updates pushed to every open screen within about a
second over WebSocket — scoped correctly across terminals, SCTL, and Customs.

It's a small Node.js (Express) app backed by PostgreSQL. It does not serve
the frontend — `contracker.html` and `contracker-mobile.html` stay exactly
what they are (files you can open directly, or host anywhere); they just now
talk to this server over the internet instead of to the browser's own storage.

## What's real here, and what isn't yet

- **Real**: password hashing (bcrypt), signed session tokens (JWT), every
  request other than login/registration requires a valid session, and the
  two most sensitive collections are protected by real server-side,
  terminal-aware rules:
  - `users` — SCTL can manage every account anywhere; a terminal's own
    Admin-department account can add, edit, suspend, or remove accounts **at
    their own terminal only** (checked by diffing the proposed change against
    what's stored, not just trusted from the browser); everyone else can only
    ever change their own profile.
  - `terminals` — only SCTL can add, edit, suspend, or remove a bonded
    terminal, except for the one case every terminal starts from: a new
    terminal self-registering, pending SCTL approval.
  - `containers` — scoped to the caller's own terminal (an account can never
    touch a job at a different terminal; SCTL is exempt) and checked
    field-by-field against the same department/stage rules the UI uses to
    hide buttons: who may register a new job, advance which stage, set the
    transfer letter / invoice / exit numbers, record a transporter, or touch
    invoices. A terminal's own Admin-department account may advance a job to
    any stage at its terminal, matching the frontend's own rule for that role.
- **Not yet re-implemented server-side**: `activity-log`, `referrals`, and
  `messages` still accept any write from a signed-in account, same as the
  original static file — nobody is impersonable (that requires a valid
  session), but role/terminal-based restrictions on those three, if you want
  them, would need the same kind of field-diff check `containers` now has.

## 1. Create a Postgres database

Any Postgres works. Two easy free options: **Neon** (neon.tech, free
serverless Postgres) or **Render Postgres** (created from the same dashboard
as the web service below). Either way, copy the connection string.

## 2. Deploy the server (Render, free tier)

1. Put this folder in its own GitHub repo (or a folder in one — **use a
   different repo/service from the Belburge backend**, since these are two
   separate deployments).
2. On [render.com](https://render.com), **New → Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add environment variables:
   - `DATABASE_URL` — the connection string from step 1.
   - `JWT_SECRET` — any long random string (e.g.
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
5. Deploy. You'll get a public URL like `https://contracker-backend.onrender.com`.

## 3. Point the frontend at it

Open `contracker.html` (or the mobile version) in a browser. The first time,
it asks for your backend's URL — paste the Render URL from step 2. It's saved
in that browser going forward (every device needs to be told the URL once).

The first time any device talks to a freshly deployed backend, the frontend
automatically seeds it with the familiar demo dataset (terminals, seed
accounts, demo containers), so signing in with the demo accounts and password
`demo123` works immediately. This only happens once per database.

## Local development

```
npm install
createdb contracker
export DATABASE_URL=postgresql://localhost/contracker
export JWT_SECRET=dev-secret-change-me
npm start
```

Then set the frontend's backend URL to `http://localhost:4000`.

## API shape (for reference)

Same shape as the Belburge backend (see its README), with two differences:

- Login tokens also carry `terminalId`.
- `PUT /api/storage/terminals` is restricted to SCTL, with the same
  one-time unauthenticated self-registration carve-out as `users`.
- The collection keys the frontend uses are: `terminals`, `containers`,
  `users`, `activity-log`, `referrals`, `messages`, `platform-settings`
  (not `settings` — both `terminals` and `platform-settings` are public to GET).
