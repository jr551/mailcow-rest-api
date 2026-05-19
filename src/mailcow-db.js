'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const ALIAS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomAlias(length = 10) {
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += ALIAS_ALPHABET[crypto.randomInt(ALIAS_ALPHABET.length)];
    }
    return out;
}

function isValidSenderPattern(sender) {
    if (!sender || typeof sender !== 'string') return false;
    return /^[a-zA-Z0-9@_.*-]+$/.test(sender);
}

function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createMailcowDb({ host, port, user, pass, name }) {
    if (!pass) return null;
    const pool = mysql.createPool({
        host,
        port,
        user,
        password: pass,
        database: name,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
        connectTimeout: 10000,
        enableKeepAlive: true
    });

    return {
        pool,

        // ── Sender policies ──
        async listPolicies(email, option) {
            const [rows] = await pool.execute(
                'SELECT `prefid`, `value` AS `sender` FROM `filterconf` WHERE `object` = ? AND `option` = ? ORDER BY `value`',
                [email, option]
            );
            return rows;
        },

        async addPolicy(email, option, sender) {
            if (!isValidSenderPattern(sender)) throw new Error('Invalid sender pattern');
            const [existing] = await pool.execute(
                'SELECT `prefid` FROM `filterconf` WHERE `object` = ? AND `option` = ? AND `value` = ?',
                [email, option, sender]
            );
            if (existing.length > 0) throw new Error('Sender policy already exists');
            const [result] = await pool.execute(
                'INSERT INTO `filterconf` (`object`, `option`, `value`) VALUES (?, ?, ?)',
                [email, option, sender]
            );
            return { prefid: result.insertId, sender };
        },

        async removePolicy(email, option, prefid) {
            const [result] = await pool.execute(
                'DELETE FROM `filterconf` WHERE `object` = ? AND `option` = ? AND `prefid` = ?',
                [email, option, prefid]
            );
            return result.affectedRows > 0;
        },

        // ── Mailbox details ──
        async getMailbox(email) {
            const [rows] = await pool.execute(
                `SELECT
                    m.username, m.name, m.active, m.domain, m.local_part,
                    m.quota, m.created, m.modified, m.authsource, m.attributes,
                    q.bytes, q.messages
                FROM mailbox m
                JOIN quota2 q ON m.username = q.username
                WHERE m.username = ? AND (m.kind = '' OR m.kind IS NULL)`,
                [email]
            );
            if (!rows.length) return null;
            const r = rows[0];
            const quotaUsed = Number(r.bytes) || 0;
            const quota = Number(r.quota) || 0;
            const pct = quota === 0 ? 0 : Math.round((quotaUsed / quota) * 100);
            return {
                username: r.username,
                name: r.name,
                active: !!r.active,
                domain: r.domain,
                localPart: r.local_part,
                quota,
                quotaUsed,
                percentInUse: pct,
                messages: Number(r.messages) || 0,
                created: r.created,
                modified: r.modified,
                authsource: r.authsource || 'mailcow',
                attributes: safeJson(r.attributes)
            };
        },

        // ── SASL logins ──
        async getLogins(email, limit = 20) {
            const [rows] = await pool.execute(
                `SELECT service, real_rip AS ip, datetime AS time
                 FROM sasl_log
                 WHERE username = ?
                 ORDER BY datetime DESC
                 LIMIT ?`,
                [email, limit]
            );
            return rows;
        },

        // ── Time-limited aliases (temp aliases) ──
        async listTempAliases(email) {
            const [rows] = await pool.execute(
                `SELECT address, goto, description, validity, created, modified, permanent
                 FROM spamalias
                 WHERE goto = ? AND (validity >= UNIX_TIMESTAMP() OR permanent != 0)
                 ORDER BY created DESC`,
                [email]
            );
            return rows.map((r) => ({
                address: r.address,
                goto: r.goto,
                description: r.description,
                validity: r.validity,
                expiresAt: r.permanent ? null : new Date(r.validity * 1000).toISOString(),
                permanent: !!r.permanent,
                created: r.created,
                modified: r.modified
            }));
        },

        async createTempAlias(email, { description = '', validityHours = 720, permanent = false }) {
            if (!isValidEmail(email)) throw new Error('Invalid email');
            const hrs = Number(validityHours);
            if (!Number.isFinite(hrs) || hrs < 1 || hrs > 87600) throw new Error('Validity must be 1-87600 hours');
            const domain = email.split('@')[1];
            const local = email.split('@')[0];
            // Generate a random alias like abc123@domain.tld
            const rand = randomAlias(10);
            const address = `${rand}@${domain}`;
            const validity = permanent ? 0 : Math.floor(Date.now() / 1000) + (hrs * 3600);
            await pool.execute(
                'INSERT INTO spamalias (address, goto, description, validity, permanent) VALUES (?, ?, ?, ?, ?)',
                [address, email, description, validity, permanent ? 1 : 0]
            );
            return { address, validity, permanent: !!permanent };
        },

        async deleteTempAlias(email, address) {
            const [result] = await pool.execute(
                'DELETE FROM spamalias WHERE goto = ? AND address = ?',
                [email, address]
            );
            return result.affectedRows > 0;
        },

        // ── Aliases that point to this mailbox ──
        async listAliases(email) {
            const [rows] = await pool.execute(
                `SELECT id, address, domain, goto, active, sogo_visible, internal, sender_allowed, created, modified
                 FROM alias
                 WHERE address != goto AND (goto = ? OR goto LIKE CONCAT('%,', ?, ',%') OR goto LIKE CONCAT(?, ',%') OR goto LIKE CONCAT('%,', ?))`,
                [email, email, email, email]
            );
            return rows.map((r) => ({
                id: r.id,
                address: r.address,
                domain: r.domain,
                goto: r.goto,
                active: !!r.active,
                sogoVisible: !!r.sogo_visible,
                internal: !!r.internal,
                senderAllowed: !!r.sender_allowed,
                created: r.created,
                modified: r.modified
            }));
        },

        // ── Send-from addresses (mailbox + aliases + temp aliases) ──
        // Returns { addresses, wildcardDomains }. wildcardDomains is the
        // list of domains for which this user holds a catch-all alias
        // (`@example.com`); the webmail uses it to allow a free-form
        // FROM input restricted to those domains.
        async getSendFromAddresses(email) {
            const addresses = [email];
            const wildcardDomains = [];
            const [aliasRows] = await pool.execute(
                `SELECT address FROM alias
                 WHERE address != goto AND active = 1 AND sogo_visible = 1
                   AND (goto = ? OR goto LIKE CONCAT('%,', ?, ',%') OR goto LIKE CONCAT(?, ',%') OR goto LIKE CONCAT('%,', ?))`,
                [email, email, email, email]
            );
            for (const r of aliasRows) {
                if (!r.address) continue;
                if (r.address.startsWith('@')) {
                    // Catch-all alias like @delivering.email — not a literal
                    // address but signals wildcard authority over the domain.
                    wildcardDomains.push(r.address.slice(1).toLowerCase());
                } else {
                    addresses.push(r.address);
                }
            }
            const [tempRows] = await pool.execute(
                `SELECT address FROM spamalias
                 WHERE goto = ? AND (validity >= UNIX_TIMESTAMP() OR permanent != 0)`,
                [email]
            );
            for (const r of tempRows) addresses.push(r.address);
            return {
                addresses: [...new Set(addresses)],
                wildcardDomains: [...new Set(wildcardDomains)]
            };
        },

        async close() {
            await pool.end();
        }
    };
}

function safeJson(v) {
    try { return JSON.parse(v); } catch { return {}; }
}

module.exports = { createMailcowDb, isValidSenderPattern };
