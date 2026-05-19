'use strict';

const crypto = require('node:crypto');
const {
    ManageSieveClient,
    SCRIPT_NAME,
    compileRulesScript,
    parseRules,
    parseBlockedRecipients
} = require('./sieve-client');

function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateId() {
    return 'rule-' + crypto.randomBytes(8).toString('hex');
}

function createSieveManager({ db, imapHost, rejectUnauthorized = true, tlsServername = '' }) {
    // Validate that the user can actually receive mail at the given recipient address
    async function canReceiveAt(email, recipient) {
        if (email === recipient) return true;
        const domain = recipient.split('@')[1];
        if (!domain) return false;

        // Check if there's an alias address = recipient that forwards to user
        const [aliasRows] = await db.pool.execute(
            `SELECT 1 FROM alias
             WHERE address = ? AND address != goto
               AND (goto = ? OR goto LIKE CONCAT('%,', ?, ',%') OR goto LIKE CONCAT(?, ',%') OR goto LIKE CONCAT('%,', ?))
             LIMIT 1`,
            [recipient, email, email, email, email]
        );
        if (aliasRows.length > 0) return true;

        // Check if there's a catch-all alias @domain that forwards to user
        const [catchAllRows] = await db.pool.execute(
            `SELECT 1 FROM alias
             WHERE address = ? AND address != goto
               AND (goto = ? OR goto LIKE CONCAT('%,', ?, ',%') OR goto LIKE CONCAT(?, ',%') OR goto LIKE CONCAT('%,', ?))
             LIMIT 1`,
            [`@${domain}`, email, email, email, email]
        );
        if (catchAllRows.length > 0) return true;

        // Check alias_domain: recipient domain might be an alias of a domain the user has access to
        const [aliasDomainRows] = await db.pool.execute(
            `SELECT ad.target_domain FROM alias_domain ad
             WHERE ad.alias_domain = ? LIMIT 1`,
            [domain]
        );
        if (aliasDomainRows.length > 0) {
            const targetDomain = aliasDomainRows[0].target_domain;
            // Check catch-all on the target domain
            const [catchAllTarget] = await db.pool.execute(
                `SELECT 1 FROM alias
                 WHERE address = ? AND address != goto
                   AND (goto = ? OR goto LIKE CONCAT('%,', ?, ',%') OR goto LIKE CONCAT(?, ',%') OR goto LIKE CONCAT('%,', ?))
                 LIMIT 1`,
                [`@${targetDomain}`, email, email, email, email]
            );
            if (catchAllTarget.length > 0) return true;
        }

        return false;
    }

    async function withSieve(email, pass, fn) {
        const client = new ManageSieveClient({ host: imapHost, rejectUnauthorized, tlsServername });
        try {
            await client.connect();
            await client.authenticate(email, pass);
            return await fn(client);
        } finally {
            await client.close();
        }
    }

    async function getCurrentRulesAndPreserved(email, pass) {
        return await withSieve(email, pass, async (client) => {
            const scripts = await client.listScripts();
            const ourScript = scripts.find((s) => s.name === SCRIPT_NAME);
            if (ourScript) {
                const content = await client.getScript(SCRIPT_NAME);
                return parseRules(content);
            }

            // No our script yet — check if another script is active and preserve its content
            const activeScript = scripts.find((s) => s.active);
            if (activeScript && activeScript.name !== SCRIPT_NAME) {
                try {
                    const preservedContent = await client.getScript(activeScript.name);
                    return { rules: [], preservedContent };
                } catch {
                    return { rules: [], preservedContent: '' };
                }
            }

            return { rules: [], preservedContent: '' };
        });
    }

    async function syncRules(email, pass, rules, preservedContent) {
        return await withSieve(email, pass, async (client) => {
            const content = compileRulesScript(rules, preservedContent);
            if (!content) {
                // No rules and no preserved content — delete the script
                const scripts = await client.listScripts();
                if (scripts.find((s) => s.name === SCRIPT_NAME)) {
                    await client.setActive('');
                    await client.deleteScript(SCRIPT_NAME);
                }
                return;
            }
            await client.putScript(SCRIPT_NAME, content);
            await client.setActive(SCRIPT_NAME);
        });
    }

    return {
        // Backward compat — blocked recipients
        async listBlockedRecipients(email, pass) {
            const { rules } = await getCurrentRulesAndPreserved(email, pass);
            return rules
                .filter((r) => r.condition.type === 'envelope-to-is' && r.action.type === 'discard')
                .map((r) => r.condition.value);
        },

        async addBlockedRecipient(email, pass, recipient) {
            if (!isValidEmail(recipient)) throw new Error('Invalid email address');
            const allowed = await canReceiveAt(email, recipient);
            if (!allowed) throw new Error('You cannot block a recipient address you do not receive mail for');

            const { rules, preservedContent } = await getCurrentRulesAndPreserved(email, pass);
            const exists = rules.some(
                (r) => r.condition.type === 'envelope-to-is' && r.condition.value === recipient && r.action.type === 'discard'
            );
            if (exists) throw new Error('Recipient already blocked');

            rules.push({
                id: generateId(),
                name: `Block ${recipient}`,
                condition: { type: 'envelope-to-is', value: recipient },
                action: { type: 'discard' }
            });
            await syncRules(email, pass, rules, preservedContent);
            return { recipient };
        },

        async removeBlockedRecipient(email, pass, recipient) {
            if (!isValidEmail(recipient)) throw new Error('Invalid email address');

            const { rules, preservedContent } = await getCurrentRulesAndPreserved(email, pass);
            const idx = rules.findIndex(
                (r) => r.condition.type === 'envelope-to-is' && r.condition.value === recipient && r.action.type === 'discard'
            );
            if (idx === -1) throw new Error('Not found');
            rules.splice(idx, 1);
            await syncRules(email, pass, rules, preservedContent);
            return { removed: true, recipient };
        },

        // New unified mail rules
        async listRules(email, pass) {
            const { rules } = await getCurrentRulesAndPreserved(email, pass);
            return rules;
        },

        async addRule(email, pass, ruleInput) {
            const { rules, preservedContent } = await getCurrentRulesAndPreserved(email, pass);

            // Validate block rules ownership
            if (ruleInput.action.type === 'discard' && ruleInput.condition.type === 'envelope-to-is') {
                const allowed = await canReceiveAt(email, ruleInput.condition.value);
                if (!allowed) throw new Error('You cannot block a recipient address you do not receive mail for');
            }

            // Validate redirect/copy has a valid 'to'
            if ((ruleInput.action.type === 'redirect' || ruleInput.action.type === 'copy') && !isValidEmail(ruleInput.action.to)) {
                throw new Error('Invalid redirect destination email');
            }

            const rule = {
                id: ruleInput.id || generateId(),
                name: ruleInput.name || 'Unnamed rule',
                condition: ruleInput.condition,
                action: ruleInput.action
            };
            rules.push(rule);
            await syncRules(email, pass, rules, preservedContent);
            return rule;
        },

        async removeRule(email, pass, id) {
            const { rules, preservedContent } = await getCurrentRulesAndPreserved(email, pass);
            const idx = rules.findIndex((r) => r.id === id);
            if (idx === -1) throw new Error('Not found');
            rules.splice(idx, 1);
            await syncRules(email, pass, rules, preservedContent);
            return { removed: true, id };
        }
    };
}

module.exports = { createSieveManager };
