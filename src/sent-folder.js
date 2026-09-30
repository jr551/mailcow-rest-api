'use strict';

const { withClient } = require('./imap');
const { hashCreds } = require('./cache');

// Copy an already-sent message into the sender's Sent folder over IMAP.
//
// Extracted from src/routes/send.js so the takeover worker's direct-send
// path can file its outgoing mail the same way the send route does. The
// semantics are unchanged and deliberately best-effort: the recipient has
// the mail whether or not the Sent copy lands, so no failure here may fail
// the send.
//
// Candidate folders are tried in order — servers name the folder differently
// (Dovecot "Sent", mailcow "INBOX.Sent", "Sent Items", "Sent Messages") — and
// the first append that succeeds wins. A cache write failure must never look
// like a failed APPEND, or the loop falls through and appends a duplicate
// copy to the next candidate folder.
async function appendToSent({ pool, imapCache, log, creds, raw }) {
    if (!pool || !raw) return;
    const hash = creds.hash || hashCreds(creds.user, creds.pass);
    const fullCreds = { ...creds, hash };

    const folders = ['Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages'];
    for (const folder of folders) {
        let appended = false;
        try {
            await withClient(pool, fullCreds, async (client) => {
                await client.append(folder, raw, ['\\Seen']);
            });
            appended = true;
        } catch (err) {
            const isMailboxNotFound = err?.problem?.status === 404 || /not found|nonexistent|does not exist/i.test(err?.message || '');
            if (!isMailboxNotFound) {
                // Log real errors (quota, auth, connection) but don't fail the SMTP send.
                log?.warn({ err, folder, user: creds.user }, 'Failed to append sent message to Sent folder');
            }
        }
        if (appended) {
            // Invalidate cache so the next listMessages sees the new
            // message. Best-effort AND outside the append try: a cache
            // write failure must not look like a failed APPEND, or the
            // loop falls through and appends a duplicate copy to the
            // next candidate folder.
            try {
                imapCache?.invalidateFolderUid(hash, folder);
                imapCache?.invalidateFolderStatus(hash, folder);
            } catch (err) {
                log?.warn({ err, folder, user: creds.user }, 'Could not invalidate sent-folder cache');
            }
            return;
        }
    }
    // All folders failed — still don't fail the request; the message is sent.
    log?.warn({ user: creds.user }, 'Could not append sent message to any Sent folder');
}

module.exports = { appendToSent };
