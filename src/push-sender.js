'use strict';

const webpush = require('web-push');
const Database = require('better-sqlite3');
const { withClient } = require('./imap');

function createPushSender({ config, pushStore, pool, cache, logger }) {
    const vapidPublicKey = config.push.vapidPublicKey || '';
    const vapidPrivateKey = config.push.vapidPrivateKey || '';
    const vapidSubject = config.push.vapidSubject || 'mailto:admin@example.com';
    const pollIntervalMs = config.push.pollIntervalMs || 5 * 60 * 1000;

    const enabled = !!(vapidPublicKey && vapidPrivateKey);
    if (enabled) {
        webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    }

    // Track last-seen unread counts per user so we only push on genuine changes.
    const db = new Database(config.push.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS push_last_seen (
            user TEXT PRIMARY KEY,
            unseen INTEGER NOT NULL DEFAULT 0,
            last_check INTEGER NOT NULL DEFAULT 0
        );
    `);
    const getLast = db.prepare('SELECT unseen FROM push_last_seen WHERE user = ?');
    const setLast = db.prepare(
        'INSERT INTO push_last_seen (user, unseen, last_check) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user) DO UPDATE SET unseen = excluded.unseen, last_check = excluded.last_check'
    );

    let timer = null;
    let running = false;

    async function checkUser(user, pass) {
        const subs = pushStore.listForUser({ user });
        if (!subs || subs.length === 0) return;

        let unseen = 0;
        try {
            const hash = cache.hashCreds(user, pass);
            await withClient(pool, { user, pass, hash }, async (client) => {
                const status = await client.status('INBOX', { unseen: true });
                unseen = status.unseen || 0;
            });
        } catch (err) {
            if (logger) logger.warn({ err, user }, 'push sender IMAP check failed');
            return;
        }

        const lastRow = getLast.get(user);
        const lastUnseen = lastRow ? lastRow.unseen : 0;

        if (unseen > lastUnseen) {
            const diff = unseen - lastUnseen;
            const payload = JSON.stringify({
                title: diff === 1 ? 'New message' : `${diff} new messages`,
                body: `You have ${unseen} unread message${unseen === 1 ? '' : 's'}`,
                tag: 'webmail-new',
                url: '/webmail/mobile/',
                badge: '/webmail/icon.svg',
                unreadCount: unseen
            });

            for (const sub of subs) {
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
                        payload
                    );
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        pushStore.delete({ endpoint: sub.endpoint, user });
                        if (logger) logger.info({ user, endpoint: sub.endpoint }, 'removed expired push subscription');
                    } else {
                        if (logger) logger.warn({ err: err.message, user }, 'push send failed');
                    }
                }
            }
        }

        setLast.run(user, unseen, Date.now());
    }

    async function tick() {
        if (!enabled || running) return;
        running = true;
        try {
            // We need credentials to check IMAP. Use active sessions.
            const sessions = cache.listActiveSessions ? cache.listActiveSessions() : [];
            if (!sessions.length) return;

            // Deduplicate by user — a user may have multiple active sessions.
            const byUser = new Map();
            for (const s of sessions) {
                if (!byUser.has(s.user)) byUser.set(s.user, s.pass);
            }

            for (const [user, pass] of byUser) {
                try {
                    await checkUser(user, pass);
                } catch (err) {
                    if (logger) logger.warn({ err, user }, 'push check user failed');
                }
            }
        } finally {
            running = false;
        }
    }

    function start() {
        if (!enabled || timer) return;
        tick();
        timer = setInterval(tick, pollIntervalMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return { start, stop, tick, enabled };
}

module.exports = { createPushSender };
