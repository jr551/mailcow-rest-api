'use strict';

// Web Push subscription store. Subscriptions are scoped to a user (the
// session creator) so we can fan out a single new-mail event to every
// device that user is logged into.

const Database = require('better-sqlite3');

function createPushStore({ filePath }) {
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS push_subs (
            endpoint TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user);
    `);

    const insert = db.prepare(`
        INSERT INTO push_subs (endpoint, user, p256dh, auth_key, created_at, last_used_at)
        VALUES (@endpoint, @user, @p256dh, @auth_key, @now, @now)
        ON CONFLICT(endpoint) DO UPDATE SET
            user = excluded.user,
            p256dh = excluded.p256dh,
            auth_key = excluded.auth_key,
            last_used_at = excluded.last_used_at
    `);
    const removeForUserEndpoint = db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user = ?');
    const removeForUser = db.prepare('DELETE FROM push_subs WHERE user = ?');
    const listForUser = db.prepare('SELECT endpoint, p256dh, auth_key FROM push_subs WHERE user = ?');
    const listAll = db.prepare('SELECT endpoint, user, p256dh, auth_key FROM push_subs');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM push_subs');

    return {
        upsert({ user, subscription }) {
            const endpoint = subscription && subscription.endpoint;
            const keys = subscription && subscription.keys;
            if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw new Error('invalid subscription');
            insert.run({
                endpoint,
                user,
                p256dh: keys.p256dh,
                auth_key: keys.auth,
                now: Date.now()
            });
            return { endpoint };
        },
        // User scope is required to prevent IDOR — a session can only drop
        // its own subscriptions, even if it knows another user's endpoint URL.
        delete({ endpoint, user }) {
            if (!user) throw new Error('user required');
            return removeForUserEndpoint.run(endpoint, user).changes;
        },
        deleteForUser({ user }) { removeForUser.run(user); },
        listForUser({ user }) { return listForUser.all(user); },
        listUsers() { return db.prepare('SELECT DISTINCT user FROM push_subs').all().map((r) => r.user); },
        listAll() { return listAll.all(); },
        count() { return countStmt.get().n; },
        close() { db.close(); }
    };
}

module.exports = { createPushStore };
