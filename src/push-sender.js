'use strict';

const webpush = require('web-push');
const { createPinnedHttpsAgent } = require('./utils/ssrf-guard');
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
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS push_last_seen (
            user TEXT PRIMARY KEY,
            unseen INTEGER NOT NULL DEFAULT 0,
            last_check INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS push_delivered (
            user TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            unseen INTEGER NOT NULL,
            PRIMARY KEY (user, endpoint)
        );
    `);
    const getLast = db.prepare('SELECT unseen FROM push_last_seen WHERE user = ?');
    const setLast = db.prepare(
        'INSERT INTO push_last_seen (user, unseen, last_check) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user) DO UPDATE SET unseen = excluded.unseen, last_check = excluded.last_check'
    );
    // Per-endpoint watermark: the unseen count through which that endpoint
    // has been notified. A notification whose send failed keeps the old
    // watermark so it is retried, while endpoints that already got it are
    // skipped instead of being re-sent. A missing row falls back to the
    // user-level watermark, which is also how a fresh subscription joins.
    const getDelivered = db.prepare('SELECT unseen FROM push_delivered WHERE user = ? AND endpoint = ?');
    const markDelivered = db.prepare(
        'INSERT INTO push_delivered (user, endpoint, unseen) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user, endpoint) DO UPDATE SET unseen = excluded.unseen'
    );
    const dropDelivered = db.prepare('DELETE FROM push_delivered WHERE user = ? AND endpoint = ?');
    const clearDelivered = db.prepare('DELETE FROM push_delivered WHERE user = ?');

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

            let settled = true;
            for (const sub of subs) {
                // Skip endpoints already notified at this count: a retry of
                // the event must not re-send to devices that got it.
                const deliveredRow = getDelivered.get(user, sub.endpoint);
                const watermark = deliveredRow ? deliveredRow.unseen : lastUnseen;
                if (unseen <= watermark) continue;

                let agent;
                try {
                    // Pin the connection to the address we checked. The
                    // endpoint was validated at subscribe time, but the name
                    // can be re-pointed at an internal address afterwards.
                    agent = await createPinnedHttpsAgent(sub.endpoint);
                } catch (err) {
                    if (logger) logger.warn({ err: err.message, user }, 'push endpoint blocked');
                    continue;
                }
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
                        payload,
                        agent ? { agent } : undefined
                    );
                    markDelivered.run(user, sub.endpoint, unseen);
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        pushStore.delete({ endpoint: sub.endpoint, user });
                        dropDelivered.run(user, sub.endpoint);
                        if (logger) logger.info({ user, endpoint: sub.endpoint }, 'removed expired push subscription');
                    } else {
                        // Retryable failure: keep this endpoint's watermark
                        // where it is so the next tick retries it, and hold
                        // back the user-level watermark so the notification
                        // cannot be dropped for good.
                        settled = false;
                        if (logger) logger.warn({ err: err.message, user }, 'push send failed');
                    }
                } finally {
                    // Each send builds its own pinned Agent, which owns a
                    // connection pool and keep-alive timers. Without this,
                    // repeated sends accumulate one pool each.
                    if (agent && typeof agent.destroy === 'function') agent.destroy();
                }
            }

            if (settled) {
                setLast.run(user, unseen, Date.now());
                // Every endpoint is now level with the user watermark, so the
                // per-endpoint rows only matter while a retry is outstanding.
                clearDelivered.run(user);
            } else {
                // Refresh last_check without moving the watermark: the count
                // is still owed to the endpoints that failed.
                setLast.run(user, lastUnseen, Date.now());
            }
        } else {
            // Nothing new to announce (the count fell or stayed level). Any
            // per-endpoint watermark above the current count would suppress
            // future notifications, so reset everything to the fresh count.
            clearDelivered.run(user);
            setLast.run(user, unseen, Date.now());
        }
    }

    // The poll currently in flight, so stop() can wait for it before closing
    // push.db: a confirmed send must be able to write its watermark first,
    // or the notification is lost or re-sent after the restart.
    let inFlight = null;

    function tick() {
        const p = runTick();
        inFlight = p;
        void p.finally(() => { if (inFlight === p) inFlight = null; });
        return p;
    }

    async function runTick() {
        if (!enabled || running) return;
        running = true;
        try {
            // We need credentials to check IMAP. Use active sessions. A null
            // cache (the documented fail-open mode) simply means no sessions
            // to poll — not a poll failure.
            const sessions = (cache && typeof cache.listActiveSessions === 'function')
                ? cache.listActiveSessions()
                : [];
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
        } catch (err) {
            // setInterval doesn't await us, so anything escaping here is an
            // unhandled rejection — which takes the whole process down and
            // 502s every in-flight request. A failed poll must not do that.
            if (logger) logger.error({ err }, 'push poll failed');
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
        // Close push.db only after the in-flight poll has finished its
        // writes (see the inFlight comment above), then release the handle:
        // this module is a second writer alongside pushStore, and leaving it
        // open leaked an fd per build() and left the WAL un-checkpointed
        // across restarts.
        return (inFlight || Promise.resolve()).then(() => {
            try { db.close(); } catch { /* already closed */ }
        });
    }

    return { start, stop, tick, enabled };
}

module.exports = { createPushSender };
