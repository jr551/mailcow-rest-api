'use strict';

const net = require('node:net');
const tls = require('node:tls');

const SCRIPT_NAME = 'imap-rest-rules';
const PRESERVED_MARKER = '# --- preserved rules ---';
const RULES_HEADER = '# mailcow-rest-api rules';

function isOk(response) {
    return /(^|\r\n)OK(\s|$)/m.test(response);
}

function isNo(response) {
    return /(^|\r\n)NO(\s|$)/m.test(response);
}

function readResponse(socket, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('ManageSieve read timeout'));
        }, timeoutMs);
        function onData(chunk) {
            buf += chunk;
            const lines = buf.split('\r\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (line.startsWith('OK ') || line.startsWith('NO ') || line.startsWith('BYE ') ||
                    line === 'OK' || line === 'NO' || line === 'BYE') {
                    cleanup();
                    resolve(buf);
                    return;
                }
            }
        }
        function cleanup() {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onErr);
            socket.off('close', onClose);
        }
        function onErr(err) { cleanup(); reject(err); }
        function onClose() { cleanup(); reject(new Error('ManageSieve socket closed')); }
        socket.on('data', onData);
        socket.on('error', onErr);
        socket.on('close', onClose);
    });
}

function parseCapabilities(response) {
    const caps = { sasl: [], starttls: false };
    for (const line of response.split('\r\n')) {
        const saslMatch = line.match(/^"SASL" "([^"]*)"/);
        if (saslMatch) caps.sasl = saslMatch[1].split(/\s+/).filter(Boolean);
        if (line.includes('"STARTTLS"')) caps.starttls = true;
    }
    return caps;
}

function parseScripts(response) {
    const scripts = [];
    for (const line of response.split('\r\n')) {
        const m = line.match(/^"([^"]+)"\s*(ACTIVE)?/);
        if (m) scripts.push({ name: m[1], active: !!m[2] });
    }
    return scripts;
}

function extractScriptContent(response) {
    const m = response.match(/\{(\d+)\+?\}\r\n([\s\S]*?)\r\nOK/m);
    if (!m) return '';
    const len = parseInt(m[1], 10);
    return m[2].substring(0, len);
}

function escapeSieveString(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function compileCondition(condition) {
    switch (condition.type) {
        case 'envelope-to-is':
            return `envelope :is "to" "${escapeSieveString(condition.value)}"`;
        case 'header-contains':
            return `header :contains "${escapeSieveString(condition.header)}" "${escapeSieveString(condition.value)}"`;
        case 'header-is':
            return `header :is "${escapeSieveString(condition.header)}" "${escapeSieveString(condition.value)}"`;
        case 'from-contains':
            return `header :contains "From" "${escapeSieveString(condition.value)}"`;
        case 'to-contains':
            return `header :contains "To" "${escapeSieveString(condition.value)}"`;
        case 'subject-contains':
            return `header :contains "Subject" "${escapeSieveString(condition.value)}"`;
        default:
            throw new Error(`Unknown condition type: ${condition.type}`);
    }
}

function compileAction(action) {
    switch (action.type) {
        case 'discard':
            return '    discard;\n    stop;';
        case 'redirect':
            return `    redirect "${escapeSieveString(action.to)}";\n    stop;`;
        case 'copy':
            return `    redirect :copy "${escapeSieveString(action.to)}";`;
        default:
            throw new Error(`Unknown action type: ${action.type}`);
    }
}

function compileRule(rule) {
    const cond = compileCondition(rule.condition);
    const act = compileAction(rule.action);
    return `# rule: ${rule.id}\n# name: ${escapeSieveString(rule.name)}\nif ${cond} {\n${act}\n}`;
}

function compileRulesScript(rules, preservedContent) {
    if (!rules.length && !preservedContent) return '';

    const needsEnvelope = rules.some((r) => r.condition.type === 'envelope-to-is');
    const needsCopy = rules.some((r) => r.action.type === 'copy');
    const requirements = [];
    if (needsEnvelope) requirements.push('"envelope"');
    if (needsCopy) requirements.push('"copy"');

    let out = '';
    if (requirements.length) {
        out += `require [${requirements.join(', ')}];\n\n`;
    }
    out += `${RULES_HEADER}\n`;
    if (rules.length) {
        out += rules.map(compileRule).join('\n\n') + '\n';
    }
    if (preservedContent) {
        out += `\n${PRESERVED_MARKER}\n${preservedContent.trim()}\n`;
    }
    return out;
}

function parseRules(content) {
    if (!content) return { rules: [], preservedContent: '' };

    const markerIdx = content.indexOf(PRESERVED_MARKER);
    const ourPart = markerIdx >= 0 ? content.substring(0, markerIdx) : content;
    const preservedContent = markerIdx >= 0 ? content.substring(markerIdx + PRESERVED_MARKER.length).trim() : '';

    const rules = [];
    const ruleRe = /# rule: ([^\r\n]+)\r?\n# name: ([^\r\n]+)\r?\nif ([^\{]+)\{\s*([\s\S]*?)\s*\}/g;
    let m;
    while ((m = ruleRe.exec(ourPart)) !== null) {
        const id = m[1].trim();
        const name = m[2].trim().replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const condStr = m[3].trim();
        const actionStr = m[4].trim();

        const condition = parseCondition(condStr);
        const action = parseAction(actionStr);
        if (condition && action) {
            rules.push({ id, name, condition, action });
        }
    }
    return { rules, preservedContent };
}

function parseCondition(condStr) {
    const envMatch = condStr.match(/envelope :is "to" "([^"]+)"/);
    if (envMatch) return { type: 'envelope-to-is', value: unescapeSieveString(envMatch[1]) };

    const headerContainsMatch = condStr.match(/header :contains "([^"]+)" "([^"]+)"/);
    if (headerContainsMatch) {
        const header = unescapeSieveString(headerContainsMatch[1]);
        const value = unescapeSieveString(headerContainsMatch[2]);
        if (header.toLowerCase() === 'from') return { type: 'from-contains', value };
        if (header.toLowerCase() === 'to') return { type: 'to-contains', value };
        if (header.toLowerCase() === 'subject') return { type: 'subject-contains', value };
        return { type: 'header-contains', header, value };
    }

    const headerIsMatch = condStr.match(/header :is "([^"]+)" "([^"]+)"/);
    if (headerIsMatch) {
        return { type: 'header-is', header: unescapeSieveString(headerIsMatch[1]), value: unescapeSieveString(headerIsMatch[2]) };
    }

    return null;
}

function parseAction(actionStr) {
    if (actionStr.includes('discard')) return { type: 'discard' };

    const copyMatch = actionStr.match(/redirect :copy "([^"]+)"/);
    if (copyMatch) return { type: 'copy', to: unescapeSieveString(copyMatch[1]) };

    const redirectMatch = actionStr.match(/redirect "([^"]+)"/);
    if (redirectMatch) return { type: 'redirect', to: unescapeSieveString(redirectMatch[1]) };

    return null;
}

function unescapeSieveString(s) {
    return s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// Backward compat helpers
function buildBlockedRecipientsScript(recipients) {
    const rules = recipients.map((r) => ({
        id: `block-${r}`,
        name: `Block ${r}`,
        condition: { type: 'envelope-to-is', value: r },
        action: { type: 'discard' }
    }));
    return compileRulesScript(rules);
}

function parseBlockedRecipients(content) {
    const { rules } = parseRules(content);
    return rules
        .filter((r) => r.condition.type === 'envelope-to-is' && r.action.type === 'discard')
        .map((r) => r.condition.value);
}

class ManageSieveClient {
    constructor({ host, port = 4190, rejectUnauthorized = true, tlsServername = '' }) {
        this.host = host;
        this.port = port;
        this.rejectUnauthorized = rejectUnauthorized;
        // Public TLS cert hostname — separate from the connect host so
        // we can talk to dovecot-mailcow over the docker network while
        // still validating against the user-facing cert (delivering.email).
        // Without this we got "Hostname/IP does not match certificate's
        // altnames: Host: dovecot-mailcow" on every blocked-recipient /
        // mail-rule call.
        this.tlsServername = tlsServername;
        this.socket = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            socket.once('connect', async () => {
                this.socket = socket;
                try {
                    const greeting = await readResponse(socket, 10000);
                    const caps = parseCapabilities(greeting);

                    // If no SASL mechanisms advertised, try STARTTLS
                    if (caps.sasl.length === 0 && caps.starttls) {
                        socket.write('STARTTLS\r\n');
                        const tlsRes = await readResponse(socket, 10000);
                        if (!isOk(tlsRes)) {
                            throw new Error('STARTTLS failed');
                        }
                        // Upgrade to TLS. servername drives both SNI and
                        // certificate verification — must match a cert
                        // SAN entry, not the internal docker host.
                        const tlsSocket = tls.connect({
                            socket,
                            rejectUnauthorized: this.rejectUnauthorized,
                            ...(this.tlsServername ? { servername: this.tlsServername } : {})
                        });
                        await new Promise((res, rej) => {
                            tlsSocket.once('secureConnect', res);
                            tlsSocket.once('error', rej);
                        });
                        this.socket = tlsSocket;
                        // Read post-TLS capabilities
                        await readResponse(this.socket, 10000);
                    }
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
            socket.once('error', reject);
        });
    }

    async authenticate(user, pass) {
        const creds = Buffer.from(`\x00${user}\x00${pass}`).toString('base64');
        this.socket.write(`AUTHENTICATE "PLAIN" "${creds}"\r\n`);
        const res = await readResponse(this.socket);
        if (!isOk(res)) throw new Error('ManageSieve auth failed');
    }

    async listScripts() {
        this.socket.write(`LISTSCRIPTS\r\n`);
        const res = await readResponse(this.socket);
        if (!isOk(res)) throw new Error('LISTSCRIPTS failed');
        return parseScripts(res);
    }

    async getScript(name) {
        this.socket.write(`GETSCRIPT "${escapeSieveString(name)}"\r\n`);
        const res = await readResponse(this.socket);
        if (isNo(res)) throw new Error('GETSCRIPT failed');
        return extractScriptContent(res);
    }

    async putScript(name, content) {
        const bytes = Buffer.byteLength(content, 'utf8');
        this.socket.write(`PUTSCRIPT "${escapeSieveString(name)}" {${bytes}}\r\n`);
        this.socket.write(content);
        this.socket.write('\r\n');
        const res = await readResponse(this.socket);
        if (!isOk(res)) throw new Error('PUTSCRIPT failed: ' + res.split('\r\n').pop());
    }

    async setActive(name) {
        this.socket.write(`SETACTIVE "${escapeSieveString(name)}"\r\n`);
        const res = await readResponse(this.socket);
        if (!isOk(res)) throw new Error('SETACTIVE failed');
    }

    async deleteScript(name) {
        this.socket.write(`DELETESCRIPT "${escapeSieveString(name)}"\r\n`);
        const res = await readResponse(this.socket);
        if (!isOk(res)) throw new Error('DELETESCRIPT failed');
    }

    async logout() {
        if (!this.socket) return;
        this.socket.write('LOGOUT\r\n');
        this.socket.end();
        this.socket = null;
    }

    async close() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }
}

module.exports = {
    ManageSieveClient,
    SCRIPT_NAME,
    PRESERVED_MARKER,
    RULES_HEADER,
    compileRulesScript,
    parseRules,
    buildBlockedRecipientsScript,
    parseBlockedRecipients
};
