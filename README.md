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
- **Deleting / editing a job**: SCTL, or a terminal's own Admin department at its own terminal, can delete a job. Admin, Documentation and DTI at the job's terminal (and SCTL) can correct its container number, Bill of Lading, size, cargo description and destination. Anything else is refused with a plain-language message shown in a red banner.
- **Who sees which jobs**: enforced by the server on every read, not just hidden on screen. A terminal's staff, importers and agents are sent only their own terminal's jobs (importers/agents only their own); SCTL sees every terminal; customs sees all but no staff-only comments; archived jobs go to SCTL and the terminal's Admin only. Cross-terminal duplicate registrations are detected by the server and sent as a flag (terminal names only). Importers and agents may only fill in a delivery location, upload (pending) invoices, and add Bill of Lading, PAAR or Other documents (add-only, under their own name).
- **Uploaded files are really stored**: documents and invoices are saved as real files in the database (the `files` table, up to 10 MB each; PDF, PNG/JPG/WEBP, Word, Excel, CSV, text). The job only keeps a pointer to the file, and a file can be downloaded only by someone who can see that job (the uploader, staff of the job's terminal, and its importer/agent). The type is checked against the file's real contents, so a renamed program can't be uploaded. Files that were uploaded but never attached to a job are cleaned up after a day. **Note:** the free Neon database has about 0.5 GB of space, so very heavy use will need a paid plan or a bigger database.
- **Rejecting and replacing documents**: Admin, Documentation and DTI staff (and SCTL in ConTracker) can reject a document the importer or agent sent, with a written reason (recorded under their own name; staff documents can't be rejected). Admin, Documentation and DTI staff (and SCTL in ConTracker) can upload the correct document on the importer's or agent's behalf (recorded as "on behalf of"), and the importer or agent can upload a corrected one against the rejected document. Rejected documents are never deleted: nobody can remove, rename or edit an existing document, and an importer or agent cannot clear a rejection. All of this is checked on the server, not just hidden on screen.
- **Chat attachments**: a support or internal chat message can carry one file, stored the same way and downloadable only by people in that conversation.
- **Accounts, activity log, referrals, messages** are scoped the same way: a person is sent only the records they may see (importers and agents: their own account, referrals and conversations and no activity log; staff: what their role and terminal allow; ID-document images only to the Admin who verifies accounts), and every save is merged into the full list so a limited view can never overwrite or delete what it could not see. Nothing is deleted unless the app says so explicitly, so a screen that is a second out of date can no longer delete a just-added record. Ordinary staff cannot delete or edit history, messages or other people's referrals. Entries added by importers, agents or customs are limited to 5 per save, can't be marked as security alerts, and are always labelled with the author's real name. **Concurrent edits:** every job and account has a server-controlled version number; the apps tell the server which records they really edited, so a screen that is out of date can never overwrite other people's changes, and editing a record someone else just changed is refused with a clear message (the screen refreshes to the latest version).

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
