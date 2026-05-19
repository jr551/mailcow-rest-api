'use strict';

// Map imapflow / node errors to HTTP problem responses.
// Fastify's error hook converts thrown errors into JSON via this map.

function problem(status, title, detail, extra = {}) {
    const err = new Error(detail || title);
    err.statusCode = status;
    err.problem = { type: `about:blank`, title, status, detail, ...extra };
    return err;
}

const unauthorized = (detail = 'Invalid credentials') => problem(401, 'Unauthorized', detail);
const forbidden = (detail = 'Forbidden') => problem(403, 'Forbidden', detail);
const notFound = (detail = 'Resource not found') => problem(404, 'Not Found', detail);
const badRequest = (detail) => problem(400, 'Bad Request', detail);
const conflict = (detail) => problem(409, 'Conflict', detail);
const badGateway = (detail) => problem(502, 'Bad Gateway', detail);

// Translate an imapflow ImapError into an HTTP problem.
// If the error is already an HTTP problem (thrown by route handlers via
// notFound/badRequest/etc.), pass it through unchanged.
function fromImapError(err) {
    if (!err) return badGateway('Unknown IMAP error');
    if (err.statusCode && err.problem) return err;
    const code = err.serverResponseCode || err.code || '';
    const text = err.responseText || err.message || String(err);

    if (code === 'AUTHENTICATIONFAILED' || /authentication\s*fail/i.test(text)) {
        return unauthorized('IMAP authentication failed');
    }
    if (code === 'NONEXISTENT' || code === 'TRYCREATE' || /nonexistent|does not exist/i.test(text)) {
        return notFound('Mailbox or message not found');
    }
    if (code === 'ALREADYEXISTS' || /already exists/i.test(text)) {
        return conflict(text);
    }
    if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(text)) {
        return badGateway(`IMAP backend unavailable: ${text}`);
    }
    return badGateway(text);
}

module.exports = {
    problem,
    unauthorized,
    forbidden,
    notFound,
    badRequest,
    conflict,
    badGateway,
    fromImapError
};
