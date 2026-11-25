const { deepEqual } = require('../utils/compare');
const { isTopUser, messageVisibleTo, channelAllowed, stampTerminal } = require('../policies/visibility.policy');
const { restoreUndeleted } = require('./merge.helpers');

const EDITABLE = ['text', 'edited', 'editedAt', 'mentions'];
const pick = (o, keys) => keys.reduce((r, k) => (k in o ? (r[k] = o[k], r) : r), {});
const strip = m => { const x = Object.assign({}, m); EDITABLE.forEach(k => delete x[k]); return x; };

// Someone may edit the words of a message they sent (nothing else about it) and delete their own messages.
function checkOwnEdit(m, n, profile) {
  if (!profile || m.from !== profile.name) return 'Messages cannot be edited.';
  if (!deepEqual(strip(m), strip(n))) return 'Only the text of a message can be edited.';
  const hasFile = !!(m.file || m.fileId || m.attachment || m.fileName);
  const text = typeof n.text === 'string' ? n.text : '';
  if (text.length > 2000) return 'A message cannot be longer than 2000 characters.';
  if (!text.trim() && !hasFile) return 'A message cannot be empty.';
  if (n.mentions !== undefined && !(Array.isArray(n.mentions) && n.mentions.length <= 50 && n.mentions.every(x => typeof x === 'string' && x.length <= 120))) return 'Invalid mentions.';
  return null;
}

function checkAndMergeMessages(full, parsed, user, profile, body) {
  const view = full.filter(m => messageVisibleTo(user, profile, m));
  parsed = restoreUndeleted(view, parsed, body, user);
  const visible = new Set(view.map(m => m.id)), fullIds = new Set(full.map(m => m.id));
  if (parsed.some(m => fullIds.has(m.id) && !visible.has(m.id))) return { error: 'One of those messages belongs to a conversation you are not in.' };
  const incoming = new Map(parsed.map(m => [m.id, m]));
  const own = m => !!profile && m.from === profile.name;
  const edits = new Map();
  for (const m of view) {
    const n = incoming.get(m.id);
    if (!n) { if (!isTopUser(user) && !own(m)) return { error: 'You can only delete your own messages.' }; continue; }
    if (!deepEqual(m, n) && !isTopUser(user)) {
      const err = checkOwnEdit(m, n, profile);
      if (err) return { error: err };
      edits.set(m.id, n);
    }
  }
  const added = [];
  for (const n of parsed) {
    if (fullIds.has(n.id)) continue;
    if (!profile || n.from !== profile.name) return { error: 'A message must be sent under your own name.' };
    if (!channelAllowed(user, profile, n.channel, null)) return { error: 'You are not part of that conversation.' };
    added.push(stampTerminal(n, user));
  }
  const out = [];
  for (const c of full) {
    if (!visible.has(c.id)) { out.push(c); continue; }
    const n = incoming.get(c.id);
    if (!n) continue;
    if (isTopUser(user)) out.push(n);
    else if (edits.has(c.id)) out.push(Object.assign({}, c, pick(n, EDITABLE)));
    else out.push(c);
  }
  return { merged: out.concat(added) };
}

module.exports = { checkAndMergeMessages };