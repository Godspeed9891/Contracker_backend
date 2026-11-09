// Moved from the download handler: a person who did not upload a file may open it only if it is attached to a
// message they can read, or to a job (document or invoice) they can see.

const { channelAllowed, canSeeIdImage } = require('./visibility.policy');
const { jobVisibleTo } = require('./container.policy');

function canOpenSharedFile(user, profile, file, containers, messages) {
  let ok = messages.some(m => m && m.fileId === file.id && channelAllowed(user, profile, m.channel, m));
  if (!ok) ok = containers.some(c => jobVisibleTo(user, profile, c) &&
    ((c.documents || []).some(d => d && d.fileId === file.id) || (c.invoices || []).some(i => i && i.fileId === file.id)));
  return ok;
}

// An ID photo belongs to the account that uploaded it (`owner`, whose record must point at this file). It may be opened
// by whoever may see that account's ID: SCTL, the account itself, and the Admin of the same terminal.
function canOpenIdPhoto(user, owner, file) {
  return !!owner && owner.idFileId === file.id && canSeeIdImage(user, owner);
}

module.exports = { canOpenSharedFile, canOpenIdPhoto };