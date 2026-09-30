'use strict';

const crypto = require('node:crypto');
const { withClient: pooledWithClient, withMailbox, walkStructure, downloadPartText } = require('./imap');
const { htmlToText } = require('./webhook-payload');
const { chat: defaultChat, resolveProvider: defaultResolveProvider } = require('./llm');

// The takeover worker.
//
// Every poll it looks at unread INBOX mail for each user who has switched the
// feature on, decides which messages a real person is actually waiting on,
// and drafts a reply in the owner's voice.
//
// THERE ARE EXACTLY TWO EXITS TO A MESSAGE, both injected as dependencies:
//
//   * `deliver` — the approval gate. In production it self-POSTs to
//     http://127.0.0.1:<port>/v1/messages/send with
//     `Authorization: Basic base64(user:pass)`, and that route's Basic-auth
//     branch (src/routes/send.js, `if (isBasicAuth(req))`) creates a pending
//     approval record and mails the owner an approve/deny link instead of
//     sending. The owner's click is what sends the mail.
//   * `send` — the direct path (src/server.js createTakeoverSendNow): the
//     same in-process sendMessage the send route uses, plus the Sent-folder
//     copy. It runs ONLY for a draft the model marked REPLY: (confident)
//     while the owner has autoSend switched on, and ONLY when the wiring
//     injected it. A draft the model marked UNSURE: never takes this exit,
//     and neither does anything at all when `send` is absent — that is what
//     keeps old deployments and tests on the approval gate.
//
// The rate limit and the delay below are enforced here, in code, before any
// model is asked to write anything — never as a request in a prompt. The
// hourly limit counts both exits: markReplySent runs on a direct send and on
// a draft handed to the approval gate alike.
//
// Order of work per candidate, and why:
//
//   1. already processed? already waiting on the owner? → skip (idempotent
//      across restarts and repeat polls)
//   2. deterministic automated-sender check → skip (no model needed, and it
//      must hold even if the model is wrong)
//   3. outside the lookback window → skip, terminally
//   4. minimum delay → defer (nothing has been drafted yet, so deferring is
//      free and the message is picked up by a later poll)
//   5. hourly rate limit → defer
//   6. model classification: does a human await a reply? → skip if not
//   7. model draft → REPLY: (confident), UNSURE: (right-shaped but would not
//      bet on it), or an explicit NEEDS INPUT listing what the assistant
//      refuses to guess at — NEEDS INPUT always wins
//   8. confident + autoSend + send wired → send directly; anything else →
//      deliver → the approval gate
//
// Steps 4 and 5 deliberately run before the model is called: a message
// waiting out its delay or the hourly slot costs zero model calls, and a
// message that gets skipped as automated never costs one at all.

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// The whole disclosure, and all of it. The owner asked for the sign-off and
// explicitly not for a banner: a real person reading the reply should learn
// it came from the assistant and then get on with their day.
const DISCLOSURE = '-- \nThis reply came from my AI assistant.';

const TAKEOVER_CLASSIFY_SYSTEM = [
    'You decide whether an email needs a reply from the mailbox owner.',
    'The mailbox owner is a real person with a real job and limited time. Be objective: do not flatter him, do not call something important when it is not.',
    '',
    'Reply with ONLY a JSON object: {"needsReply": true|false, "reason": "<short>"}.',
    '',
    'needsReply is true ONLY when a real person is plausibly sitting there waiting for an answer — they asked a question, or asked the owner to do or confirm something.',
    'needsReply is false for every message nobody is waiting on: newsletters and mailing lists, marketing and promotions, receipts, order and shipping notifications, account and security notifications, calendar invites and reminders, automated alerts and monitoring mail, CI and build reports, bounce and delivery-failure reports, auto-replies and out-of-office notices, anything from a no-reply address, and anything where the answer would not change what the sender does next.',
    'If you cannot tell, answer false. A reply nobody is waiting for is worse than no reply.'
].join('\n');

const TAKEOVER_REPLY_SYSTEM = [
    'You draft an email reply on behalf of the mailbox owner. A REPLY answer is sent to the recipient immediately, with no human reading it first — so a mistake goes out the door, not into a queue.',
    '',
    'The recipient is a real person. An over-polite, generic or padded reply is a failure. So is a fabricated fact. Write like a competent human being writing a short, direct email — not like an assistant performing helpfulness.',
    '',
    'HARD RULES',
    '1. NEVER invent facts. Do not state a date, time, price, amount, order number, address, telephone number, policy, deadline, availability, or any commitment that is not literally present in the message thread or in the owner\'s instructions. That includes questions about whether the owner is free, whether something has shipped, what something costs, or what the policy is. If the thread does not establish it, you do not know it.',
    '2. If the reply cannot be written without a fact you do not have, STOP and answer with exactly:',
    'NEEDS INPUT:',
    '- <the specific fact or decision you need>',
    'One line per missing fact, naming it precisely enough that the owner can answer in a single line. Do not draft a reply around a hole.',
    '3. Otherwise answer with EXACTLY ONE of:',
    'REPLY:',
    '<the reply body>',
    'or',
    'UNSURE:',
    '<the reply body>',
    'Why unsure: <one line>',
    '',
    'REPLY: is the default, and it means you would bet on this reply: the request is clear, every fact in it comes from the thread or the owner\'s instructions, and nothing in the wording commits the owner to anything he has not already agreed to. A REPLY IS SENT IMMEDIATELY.',
    'UNSURE: is for a reply that is right-shaped but that you would not bet on — the ask is ambiguous, the tone is a judgement call, or sending it could commit the owner to something. The draft is held for the owner to approve, and your one-line "Why unsure:" reason is shown to him. UNSURE is never a soft NEEDS INPUT: if a fact is missing, rule 2 applies.',
    '',
    '4. The reply body carries NO signature and NO disclosure: never write "This reply came from my AI assistant", never mention being an AI, no apology for being an assistant, no disclaimer paragraph, no hedging preamble. The assistant adds a one-line sign-off to the outgoing mail itself when the owner has that enabled. That system-added line is the entire disclosure.',
    '5. No tells. Never open with "I hope this email finds you well", "Thank you for reaching out", "As an AI", "Certainly!", "Great question", "Thanks for your patience". Do not summarise the sender\'s message back to them. Do not apologise more than once, and only when an apology is owed. No bullet points unless the message itself is a list. Under 200 words unless the message demands more.',
    '6. Match the register of the message. If they write plainly, write plainly. Contractions are fine. No exclamation marks unless the sender used them first.',
    '7. Never say you have done something, will do something, or will send something. You cannot act. A promise is a fabricated fact. Where the owner must act, say it is being looked into.',
    '8. Answer the question that was actually asked. If the message asks three things and the thread answers two, answer those two and say the third is being looked into.',
    '9. The owner\'s instructions below override tone and the REPLY-vs-UNSURE judgement. They never override rule 1.'
].join('\n');

// --------------------------------------------------------------------------
// Deterministic skip: mail a human is not waiting on.
//
// This runs before any model call and must err towards letting a message
// through — a false positive here means a real person gets no reply and no
// one is ever told. Every pattern below is a marker that no human is
// waiting: an address that cannot receive mail, a list or bulk header, an
// automated-submission header, or a subject that is a known machine
// notification.
// --------------------------------------------------------------------------

const AUTOMATED_LOCALPARTS = new Set([
    'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'do_not_reply', 'never-reply',
    'postmaster', 'mailer-daemon', 'mail-daemon', 'daemon', 'bounce', 'bounces',
    'auto-reply', 'autoreply', 'automated', 'autoresponder', 'system', 'daemon',
    'notifications', 'notification', 'newsletter', 'newsletters', 'marketing',
    'announce', 'announcements', 'alerts', 'alert', 'monitoring', 'status',
    'ci', 'builds', 'build', 'jenkins', 'gitlab', 'github', 'sentry', 'noreply-mail'
]);
const AUTOMATED_LOCALPART_SUFFIX = /(?:^|[-_+.])(?:no[-_]?reply|bounces?|notifications?|auto[-_]?reply|do[-_]?not[-_]?reply)$/;
const AUTOMATED_SUBJECTS = [
    /^out of office\b/i,
    /^automatic reply\b/i,
    /^auto[- ]?reply\b/i,
    /^vacation (auto)?reply\b/i,
    /^undelivered? mail returned to sender\b/i,
    /^returned mail\b/i,
    /^mail delivery (subsystem|failure|failed)\b/i,
    /^delivery status notification\b/i,
    /^failure notice\b/i,
    /^postmaster\b/i,
    /^undeliverable\b/i,
    /^your .{0,40}(receipt|invoice|statement|order|subscription|plan|account)\b/i,
    /^(order|payment|shipping|delivery) (confirmation|confirmed|update|shipped)\b/i,
    /^invoice\b[\s#:]*\d/i,
    /^receipt\b/i,
    /^thanks for (your order|subscribing|signing up|your purchase)\b/i,
    /^welcome to\b/i,
    /^verify your (email|account|address)\b/i,
    /^confirm your (subscription|email|account)\b/i,
    /^security alert\b/i,
    /^new sign[- ]?in to\b/i,
    /^your (daily|weekly|monthly) (digest|summary|report|update)\b/i,
    /^newsletter\b/i,
    /^unsubscribe\b/i,
    /^\[[^\]]*(?:ci|build|deploy|alert|notification|jira|confluence|github|gitlab|sentry|grafana|datadog|status|ticket)[^\]]*\]/i
];

function headerMap(headerText) {
    const out = {};
    if (!headerText) return out;
    const text = Buffer.isBuffer(headerText) ? headerText.toString('utf8') : String(headerText);
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        out[key] = out[key] ? `${out[key]}, ${m[2].trim()}` : m[2].trim();
    }
    return out;
}

function firstAddress(list) {
    if (!Array.isArray(list)) return null;
    for (const item of list) {
        if (item && item.address) return { address: item.address, name: item.name || '' };
    }
    return null;
}

// Returns a human-readable reason when no person is waiting on this message,
// otherwise null. The reason is shown verbatim in the audit trail, so it says
// what the marker was.
function automatedReason({ from, subject, headers } = {}) {
    const addr = String((from && from.address) || '').toLowerCase();
    const name = String((from && from.name) || '');
    const subj = String(subject || '');
    const hdr = headers && typeof headers === 'object' ? headers : {};

    if (!addr) return 'there is no sender address';

    const local = addr.split('@')[0] || '';
    if (AUTOMATED_LOCALPARTS.has(local) || AUTOMATED_LOCALPART_SUFFIX.test(local)) {
        return `the sender address (${addr}) is an automated one that cannot answer`;
    }
    if (/^(?:mailer-daemon|postmaster)@/.test(addr)) return `the sender address (${addr}) is a bounce or postmaster address`;
    if (/\bbounce[sd]?\.[^@]*@|[-+]bounces@/.test(addr)) return `the sender address (${addr}) is a bounce handler`;
    if (/(?:no[-_ ]?reply|mailer[-_ ]daemon|auto[-_ ]?reply|do not reply|automated|robot)/i.test(name)) {
        return `the sender name ("${name}") identifies an automated sender`;
    }

    const listId = hdr['list-id'];
    if (listId) return `it carries a List-Id header (${String(listId).slice(0, 80)}) — a mailing list post`;
    const precedence = String(hdr['precedence'] || '').toLowerCase();
    if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) {
        return `its Precedence header is "${precedence}" — bulk or automated mail`;
    }
    const autoSubmitted = String(hdr['auto-submitted'] || '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') {
        return `its Auto-Submitted header is "${autoSubmitted}" — machine-generated mail`;
    }
    if (hdr['x-auto-response-suppress']) {
        return 'it carries X-Auto-Response-Suppress — the sender has asked for no auto responses';
    }
    const contentType = String(hdr['content-type'] || '').toLowerCase();
    if (contentType.startsWith('multipart/report')) {
        return 'it is a delivery status report (multipart/report), not a message to answer';
    }
    if (/^auto[-_ ]?submitted\s*:/i.test(String(hdr['return-path'] || '')) || hdr['return-path'] === '<>') {
        return 'it has an empty Return-Path — a bounce or an auto-generated message';
    }

    for (const re of AUTOMATED_SUBJECTS) {
        if (re.test(subj)) return `the subject "${subj.slice(0, 80)}" is a known automated notification`;
    }
    return null;
}

// --------------------------------------------------------------------------
// Model output parsing.
//
// Both prompts ask for a strict shape. Models still wrap answers in code
// fences or add a sentence, so the parsers are forgiving about surroundings
// and strict about meaning: anything they cannot read is a block, not a
// guess.
// --------------------------------------------------------------------------

function extractJsonBlock(text) {
    const start = String(text || '').indexOf('{');
    const end = String(text || '').lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(String(text).slice(start, end + 1));
    } catch {
        return null;
    }
}

function parseClassify(content) {
    const obj = extractJsonBlock(content);
    if (!obj || typeof obj.needsReply !== 'boolean') return null;
    return { needsReply: obj.needsReply, reason: String(obj.reason || '').slice(0, 500) };
}

function parseMissingList(block) {
    const out = [];
    for (const raw of String(block || '').split(/\r?\n/)) {
        // A reply or unsure marker ends the list: a model that answers with
        // both a question and a draft is being read as asking the question,
        // and the draft must not leak into the list of things we say are
        // missing.
        if (/^\s*(?:\*\*)?\s*(?:reply|unsure)\s*(?:\*\*)?\s*:/i.test(raw)) break;
        const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim();
        if (line && !/^needs input/i.test(line) && !/^why unsure/i.test(line)) out.push(line);
    }
    return out;
}

// Marker lines are structural, never content: a model that echoes REPLY:,
// UNSURE: or "Why unsure:" inside the body would otherwise leak its own
// bookkeeping to a recipient. Standalone marker lines are dropped; a
// "Why unsure:" reason line is dropped with its content.
function stripDraftMarkers(text) {
    return String(text || '')
        .split('\n')
        .filter((line) => !/^\s*(?:\*\*)?\s*(?:reply|unsure)\s*(?:\*\*)?\s*:\s*/i.test(line))
        .filter((line) => !/^\s*(?:\*\*)?\s*why unsure\s*(?:\*\*)?\s*:/i.test(line))
        .join('\n');
}

// An UNSURE answer is "<body>" followed by "Why unsure: <one line>". A
// missing reason is not fatal — the approval email then just says less.
function parseUnsure(chunk) {
    const whyIdx = chunk.search(/(?:^|\n)\s*(?:\*\*)?\s*why unsure\s*(?:\*\*)?\s*:/i);
    let reason = '';
    let body = chunk;
    if (whyIdx !== -1) {
        body = chunk.slice(0, whyIdx);
        const afterColon = chunk.indexOf(':', whyIdx) + 1;
        reason = chunk.slice(afterColon).split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    }
    return { body: stripDraftMarkers(body).trim(), reason: reason.slice(0, 500) };
}

// A draft is one of three shapes:
//   REPLY: <body>                          — confident; sent when autoSend is on
//   UNSURE:\n<body>\nWhy unsure: <reason>  — right-shaped; held for approval
//   NEEDS INPUT: <list>                    — a fact is missing
// A response that carries the NEEDS INPUT marker anywhere is treated as
// needs-input even if it also contains a draft — a reply written around a
// hole is exactly what must not be sent, so NEEDS INPUT always wins. An
// UNSURE marker routes the draft to the approval gate with the model's
// reason. A response with no marker at all is taken as a confident body,
// because some models answer with the bare body despite the prompt.
function parseDraft(content) {
    const text = String(content || '').replace(/\r\n/g, '\n');
    const needsIdx = text.search(/(?:^|\n)\s*(?:\*\*)?\s*needs input\s*(?:\*\*)?\s*:/i);
    if (needsIdx !== -1) {
        return { needsInput: true, missing: parseMissingList(text.slice(needsIdx)) };
    }
    const unsureIdx = text.search(/(?:^|\n)\s*(?:\*\*)?\s*unsure\s*(?:\*\*)?\s*:/i);
    if (unsureIdx !== -1) {
        const { body, reason } = parseUnsure(text.slice(unsureIdx));
        return { needsInput: false, needsApproval: true, body, reason };
    }
    const replyIdx = text.search(/(?:^|\n)\s*(?:\*\*)?\s*reply\s*(?:\*\*)?\s*:/i);
    if (replyIdx !== -1) return { needsInput: false, body: text.slice(text.indexOf(':', replyIdx) + 1).trim() };
    return { needsInput: false, body: text.trim() };
}

// --------------------------------------------------------------------------
// The fabrication guard.
//
// The prompt forbids inventing facts; this checks the numbers a model is most
// likely to invent against the thread and the owner's own instructions.
// Currency, percentages, order/reference-length numbers, clock times and
// dates are exactly the classes the owner named ("dates, prices, order
// numbers, policy details"), so a reply carrying one that appears in neither
// source becomes a NEEDS INPUT instead of a draft. Conservative on purpose:
// asking is cheap, a fabricated price is not.
// --------------------------------------------------------------------------

// A figure is caught when it is money, a percentage, a date, a time, or
// long enough to be a reference. A bare 2-3 digit count is not: "asked 2
// people" is not the class of thing this is about, and flagging it would
// turn harmless replies into questions.
const FIGURE_RE = /(?:[$£€¥]\s?)?\d[\d.,:/-]*\d(?:\s?(?:%|gbp|usd|eur|pounds?|dollars?|euros?))?/gi;

function isSignificantFigure(token) {
    if (/[$£€¥]/.test(token)) return true;
    if (/%|gbp|usd|eur|pounds?|dollars?|euros?/i.test(token)) return true;
    const digits = token.replace(/\D/g, '');
    if (digits.length >= 4) return true;
    return /[:/.-]/.test(token.replace(/^[$£€¥]\s?/, ''));
}

function unbackedFigures(body, sources) {
    const hay = String(sources || '').replace(/[,\s]/g, '').toLowerCase();
    const seen = new Set();
    const out = [];
    for (const match of String(body || '').matchAll(FIGURE_RE)) {
        const token = match[0].trim();
        if (!isSignificantFigure(token)) continue;
        const norm = token.replace(/[,\s]/g, '').toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (!hay.includes(norm)) out.push(token);
    }
    return out;
}

// Build the outgoing body. The model-authored markers are structural and
// never travel, and the disclosure is appended exactly once — but only when
// the owner has the sign-off switched on. The model is told not to write one
// (rule 4 of the prompt); if it does anyway, its copy is dropped, so a
// disabled sign-off stays disabled and an enabled one is never doubled.
// Nothing else is added or removed.
function finalizeReply(body, signReplies = true) {
    let text = stripDraftMarkers(String(body || '')).replace(/\r\n/g, '\n').trimEnd();
    const sigIdx = text.lastIndexOf('\n-- \n');
    if (sigIdx !== -1 && /ai assistant/i.test(text.slice(sigIdx))) {
        text = text.slice(0, sigIdx).trimEnd();
    }
    text = text.replace(/\s*This reply came from my AI assistant\.?\s*$/i, '').trimEnd();
    if (signReplies === false) return text;
    return `${text}\n\n${DISCLOSURE}`;
}

function clip(text, max) {
    const s = String(text || '');
    return s.length <= max ? s : `${s.slice(0, max)}\n[... clipped ...]`;
}

// The message as the model sees it. Attachment names are only included when
// the user has asked for them; the content of an attachment is never part of
// this at any setting.
function composeThread(message, body, maxChars, attachments) {
    const lines = [
        `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from}`,
        `Date: ${message.date ? new Date(message.date).toISOString() : 'unknown'}`,
        `Subject: ${message.subject || '(no subject)'}`,
        ''
    ];
    if (attachments && attachments.length) {
        lines.push(`Attachments: ${attachments.join(', ')}`, '');
    }
    lines.push(body || '(no message body was readable)');
    return clip(lines.join('\n'), maxChars);
}

function replySubject(subject) {
    const s = String(subject || '').trim();
    if (!s) return '(no subject)';
    return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

// --------------------------------------------------------------------------
// The worker.
// --------------------------------------------------------------------------

function createTakeoverWorker(options = {}) {
    const {
        store,
        cache,
        pool,
        logger,
        deliver,
        send = null,
        llm = defaultChat,
        resolveProvider = defaultResolveProvider,
        withClient = pooledWithClient,
        clock = Date.now
    } = options;

    // Accept the full config object (the push-sender shape, which is what
    // server.js passes) or the takeover block on its own.
    const cfg = (options.config && options.config.takeover) || options.config || {};

    const enabled = !!cfg.enabled;
    const pollIntervalMs = cfg.pollIntervalMs || 5 * MINUTE_MS;
    const maxCandidatesPerTick = cfg.maxCandidatesPerTick || 20;
    // Header fetches per tick per user. The scan window is allowed to run
    // ahead of the candidate cap so a backlog of settled messages cannot
    // hide live mail (see collectCandidates), but it is always finite: a
    // tick never fetches unbounded headers.
    const maxHeaderScanPerTick = Math.max(maxCandidatesPerTick, cfg.maxHeaderScanPerTick || 5 * maxCandidatesPerTick);
    const maxThreadChars = cfg.maxThreadChars || 12_000;
    const defaultMaxRepliesPerHour = Number.isFinite(cfg.maxRepliesPerHour) ? cfg.maxRepliesPerHour : 1;
    const defaultMinDelayMinutes = Number.isFinite(cfg.minDelayMinutes) ? cfg.minDelayMinutes : 5;
    const defaultLookbackHours = Number.isFinite(cfg.lookbackHours) ? cfg.lookbackHours : 24;

    if (!store) throw new Error('createTakeoverWorker: store is required');
    // A missing session cache is the documented fail-open state (a broken
    // cache.db must never take the whole service down): there are no
    // sessions to poll, so the worker stays inert. Throwing here instead
    // would reject build() outright and take every feature down with it.
    if (enabled && typeof deliver !== 'function') {
        throw new Error('createTakeoverWorker: deliver is required when takeover is enabled — it is the approval-gate path every unsure draft depends on');
    }

    let timer = null;
    let running = false;
    let stopped = false;

    // Per-user scan rotation position for collectCandidates. In-memory on
    // purpose: it is a scan position, not message state — message state
    // lives in the ledger, keyed by content-derived ids that survive a
    // restart and an expunge.
    const scanOffsets = new Map();

    // Messages mid-consideration, tagged by user + ledger key. wasProcessed
    // only settles AFTER a draft has reached an exit (direct send or the
    // approval gate), so without this a poll tick overlapping a slow
    // consider() could draft the same message twice and put two identical
    // replies in front of the owner — or two copies in a recipient's inbox.
    const considering = new Set();

    function note(user, entry) {
        try {
            store.recordDecision(user, entry);
        } catch (err) {
            logger?.warn({ err: err.message, user }, 'takeover: could not record a decision');
        }
    }

    // Stop and ask the owner. Used both for "I need a fact" (missing is
    // non-empty) and for "I could not continue" (missing is empty). Nothing
    // is sent, the message is left unprocessed, and the worker will not touch
    // it again until the owner answers or dismisses it.
    function stopAndAsk(user, message, { missing, reason, decision }) {
        try {
            store.enqueueNeedsInput(user, {
                messageId: message.key,
                from: message.from,
                subject: message.subject,
                missing,
                reason,
                threadSnippet: message.snippet || ''
            });
        } catch (err) {
            // The queue is bounded; if it is full the decision ledger still
            // records why the assistant stopped, which is the part the owner
            // has to be able to see.
            logger?.warn({ err: err.message, user }, 'takeover: could not queue a needs-input item');
        }
        note(user, { messageId: message.key, decision, reason });
        return { decision, reason };
    }

    // --- IMAP ------------------------------------------------------------

    // Header pass for ONE message — the same fetch collectCandidates does
    // per unread uid. A fetch failure throws (the caller decides whether to
    // drop or report it); a message that is not there returns null.
    async function fetchCandidate(client, uid, now) {
        const msg = await client.fetchOne(String(uid), {
            uid: true,
            envelope: true,
            headers: [
                'list-id', 'precedence', 'auto-submitted', 'list-unsubscribe',
                'x-auto-response-suppress', 'return-path', 'content-type', 'in-reply-to'
            ]
        }, { uid: true });
        if (!msg || !msg.envelope) return null;
        const env = msg.envelope;
        const from = firstAddress(env.from);
        const messageId = String(env.messageId || '').replace(/[<>]/g, '') || null;
        const date = env.date ? new Date(env.date).getTime() : null;
        const key = messageId || `synthetic:${hashKey(from?.address || '', date || 0, env.subject || '')}`;
        return {
            uid: String(uid),
            key,
            messageIdHeader: env.messageId || null,
            from: from?.address || '',
            fromName: from?.name || '',
            replyTo: firstAddress(env.replyTo)?.address || from?.address || '',
            subject: env.subject || '',
            date,
            inReplyTo: env.inReplyTo || null,
            headers: headerMap(msg.headers),
            age: date ? now - date : 0
        };
    }

    // Cheap pass: unread message headers only. No body is downloaded until a
    // message has cleared the deterministic checks, the delay and the rate
    // limit.
    //
    // The pass is bounded twice over, and those bounds are what keep one
    // poll from turning into an unbounded bill:
    //
    //   * at most maxHeaderScanPerTick unseen messages have their headers
    //     fetched (the scan window), and
    //   * at most maxCandidatesPerTick of those become candidates — the only
    //     messages that cost a body fetch and, past the deterministic
    //     checks, up to two model calls each.
    //
    // A message the ledger has settled — processed, or parked in needs-input
    // — is skipped inside the window instead of consuming a candidate slot.
    // Those messages stay UNSEEN in IMAP: read state is the human's, and
    // this worker holds the mailbox read-only, so nothing here may set
    // \Seen. Without the skip, a growing pile of settled messages sits at
    // the head of the oldest-first window forever and stops newer mail from
    // ever being looked at.
    //
    // A window that comes back with no candidates held nothing live — it is
    // all settled — so the scan rotates forward and the next tick looks at
    // the next slice of unseen messages: a backlog of settled mail ahead of
    // a live message delays it by at most one rotation instead of starving
    // it. A window that produced candidates stays put, so a message waiting
    // out its delay or its hourly slot is re-examined on every tick. The
    // rotation is a scan position over the current search result and never
    // message identity: identity is always the ledger key, because the uid
    // is not usable for it (it is reassigned after an expunge).

    async function collectCandidates(client, { now, user, isSettled }) {
        const uids = (await client.search({ unseen: true }, { uid: true })) || [];
        // Oldest first: a message that has been waiting longest gets the
        // first reply slot.
        let start = scanOffsets.get(user) || 0;
        if (start >= uids.length) start = 0;
        const out = [];
        let scanned = 0;
        for (const uid of uids.slice(start, start + maxHeaderScanPerTick)) {
            if (out.length >= maxCandidatesPerTick) break;
            scanned++;
            let candidate;
            try {
                candidate = await fetchCandidate(client, uid, now);
            } catch (err) {
                logger?.warn({ err: err.message, uid }, 'takeover: could not fetch a message header');
                continue;
            }
            if (!candidate) continue;
            // Settled messages free their window slot: see above.
            if (isSettled && isSettled(candidate.key)) continue;
            out.push(candidate);
        }
        if (out.length === 0) {
            // Nothing live in this slice — it is all settled — so rotate
            // past it. A slice that produced candidates stays put, so an
            // unsettled message is re-examined on the very next tick.
            const next = start + scanned;
            scanOffsets.set(user, next >= uids.length ? 0 : next);
        } else {
            scanOffsets.set(user, start);
        }
        return out;
    }

    // Body text for one message. HTML-only mail is converted; an unreadable
    // body is not a reason to skip a real person, so it degrades to the
    // headers we already have. Attachment CONTENT is never read — only the
    // file names come back, and only as context when the user has asked for
    // them.
    async function fetchBody(client, message) {
        let msg = null;
        try {
            msg = await client.fetchOne(message.uid, { uid: true, bodyStructure: true }, { uid: true });
        } catch (err) {
            logger?.warn({ err: err.message, uid: message.uid }, 'takeover: could not fetch body structure');
            return { text: '', attachments: [] };
        }
        if (!msg) return { text: '', attachments: [] };
        const acc = { textPart: null, htmlPart: null, attachments: [] };
        walkStructure(msg.bodyStructure, msg.bodyStructure?.part || '1', acc);
        const attachments = acc.attachments.map((a) => a.filename).filter(Boolean);
        if (!acc.textPart && !acc.htmlPart) return { text: '', attachments };
        const text = await downloadPartText(client, message.uid, acc.textPart);
        if (text && text.trim()) return { text, attachments };
        const html = await downloadPartText(client, message.uid, acc.htmlPart);
        return { text: html ? htmlToText(html) : '', attachments };
    }

    // --- model -----------------------------------------------------------

    async function classify(provider, thread, standingInstructions) {
        // Standing instructions may scope what counts as needing a reply at
        // all ("only client mail is important"), so the classifier sees them
        // as context, not as commands that outrank its own rules.
        const context = standingInstructions && standingInstructions.trim()
            ? `\n\nThe owner's standing instructions for this assistant (context for what counts as needing a reply):\n${standingInstructions.trim()}\n`
            : '';
        const result = await llm({
            provider,
            system: TAKEOVER_CLASSIFY_SYSTEM,
            userPrompt: `Does the mailbox owner need to reply to this email?\n\n--- BEGIN MESSAGE ---\n${thread}\n--- END MESSAGE ---${context}`,
            extra: { max_tokens: 300, response_format: { type: 'json_object' } }
        });
        if (!result || result.ok === false) {
            return { error: describeModelError(result) };
        }
        const parsed = parseClassify(result.content);
        if (!parsed) return { error: 'the assistant could not read the classifier\'s answer' };
        return parsed;
    }

    async function draft(provider, thread, advice, standingInstructions) {
        const standing = standingInstructions && standingInstructions.trim()
            ? `\nOwner's standing instructions (verbatim, from the owner himself — these apply to every reply):\n${standingInstructions.trim()}\n`
            : '';
        const adviceBlock = advice && advice.trim()
            ? `\nOwner's instructions for this thread (verbatim, from the owner himself):\n${advice.trim()}\n`
            : '';
        const result = await llm({
            provider,
            system: TAKEOVER_REPLY_SYSTEM,
            userPrompt: `Draft the reply to this email.\n\n--- BEGIN MESSAGE ---\n${thread}\n--- END MESSAGE ---${standing}${adviceBlock}`,
            extra: { max_tokens: 1200, temperature: 0.3 }
        });
        if (!result || result.ok === false) {
            return { error: describeModelError(result) };
        }
        return parseDraft(result.content);
    }

    function describeModelError(result) {
        if (!result) return 'the AI provider returned nothing';
        return `the AI provider failed (${result.title || 'error'}${result.detail ? `: ${String(result.detail).slice(0, 200)}` : ''})`;
    }

    // --- per message -----------------------------------------------------

    // The one-at-a-time guard for a message under consideration. An
    // "in-flight" outcome means another consider() for the same ledger key
    // is already running — nothing new was decided, so nothing is recorded.
    async function consider(user, message, ctx) {
        const tag = `${user}${message.key}`;
        if (considering.has(tag)) {
            return { decision: 'in-flight', reason: 'This message is already being worked on.' };
        }
        considering.add(tag);
        try {
            return await considerMessage(user, message, ctx);
        } finally {
            considering.delete(tag);
        }
    }

    async function considerMessage(user, message, ctx) {
        const { session, settings, open, now } = ctx;
        const key = message.key;

        if (store.wasProcessed(user, key)) {
            return { decision: 'already-processed', reason: 'The assistant has already handled this message.' };
        }
        if (open.has(key)) {
            return { decision: 'blocked', reason: 'This message is already waiting on your input — it is in the needs-input queue.' };
        }

        const auto = automatedReason({
            from: { address: message.from, name: message.fromName },
            subject: message.subject,
            headers: message.headers
        });
        if (auto) {
            store.recordProcessed(user, key, 'skipped-automated', now);
            note(user, {
                messageId: key,
                decision: 'declined',
                reason: `No reply drafted — ${auto}.`,
                at: now
            });
            return { decision: 'declined', reason: `No reply drafted — ${auto}.` };
        }

        const lookbackMs = (settings.lookbackHours || defaultLookbackHours) * 60 * MINUTE_MS;
        if (message.date && message.age > lookbackMs) {
            store.recordProcessed(user, key, 'out-of-window', now);
            note(user, {
                messageId: key,
                decision: 'declined',
                reason: `No reply drafted — this message arrived ${Math.round(message.age / 60000)} minutes ago, outside the ${settings.lookbackHours || defaultLookbackHours}-hour lookback window.`,
                at: now
            });
            return {
                decision: 'declined',
                reason: `No reply drafted — this message arrived ${Math.round(message.age / 60000)} minutes ago, outside the ${settings.lookbackHours || defaultLookbackHours}-hour lookback window.`
            };
        }

        // The hard delay. Nothing has been drafted, nothing has been sent;
        // the message simply waits for a later poll. 5 minutes is the floor
        // the owner asked for and the store will not accept less.
        const delayMs = (settings.minDelayMinutes || defaultMinDelayMinutes) * MINUTE_MS;
        const ageMs = Number.isFinite(message.date) ? message.age : delayMs;
        if (ageMs < delayMs) {
            const waitMinutes = Math.ceil((delayMs - ageMs) / MINUTE_MS);
            note(user, {
                messageId: key,
                decision: 'delayed',
                reason: `Holding back: the reply cannot be drafted for another ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'} (minimum ${settings.minDelayMinutes || defaultMinDelayMinutes}-minute delay after a message arrives).`,
                at: now
            });
            return {
                decision: 'delayed',
                reason: `Holding back: the reply cannot be drafted for another ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'} (minimum ${settings.minDelayMinutes || defaultMinDelayMinutes}-minute delay after a message arrives).`
            };
        }

        // The hard rate limit. It counts every reply that reached an exit —
        // a direct auto-send and a draft handed to the approval gate alike
        // (both call markReplySent), so auto-send does not double the
        // outbound volume. A draft that stopped for a missing fact does not
        // use a slot: nothing left the server for it.
        const maxPerHour = settings.maxRepliesPerHour ?? defaultMaxRepliesPerHour;
        const sent = store.repliesSince(user, now - HOUR_MS);
        if (sent >= maxPerHour) {
            note(user, {
                messageId: key,
                decision: 'rate-limited',
                reason: `Holding back: ${sent} of the ${maxPerHour} reply per hour is already with you for approval. This one is queued for the next slot.`,
                at: now
            });
            return {
                decision: 'rate-limited',
                reason: `Holding back: ${sent} of the ${maxPerHour} reply per hour is already with you for approval. This one is queued for the next slot.`
            };
        }

        const provider = resolveProvider(options.config?.ai);
        const fetched = await fetchBody(ctx.client, message);
        const body = fetched.text;
        const thread = composeThread(
            message,
            body,
            maxThreadChars,
            settings.considerAttachments ? fetched.attachments : []
        );
        message.snippet = clip(body, 2000);

        const classification = await classify(provider, thread, settings.instructions);
        if (classification.error) {
            return stopAndAsk(user, message, {
                missing: [],
                decision: 'blocked',
                reason: `Couldn't continue: ${classification.error}. Nothing was drafted and nothing was sent. Open this again to retry, or answer it yourself.`
            });
        }
        if (!classification.needsReply) {
            store.recordProcessed(user, key, 'no-reply-needed', now);
            const reason = `No reply drafted — nothing in this message is waiting on the owner${classification.reason ? `: ${classification.reason}` : '.'}`;
            note(user, { messageId: key, decision: 'declined', reason, at: now });
            return { decision: 'declined', reason };
        }

        note(user, {
            messageId: key,
            decision: 'considered',
            reason: `A real person is waiting on this one${classification.reason ? `: ${classification.reason}` : '.'}`,
            at: now
        });

        const advice = store.adviceFor(user, key);
        const instruction = advice ? advice.advice : '';
        const drafted = await draft(provider, thread, instruction, settings.instructions);
        if (drafted.error) {
            return stopAndAsk(user, message, {
                missing: [],
                decision: 'blocked',
                reason: `Couldn't continue: ${drafted.error}. Nothing was drafted and nothing was sent. Open this again to retry, or answer it yourself.`
            });
        }

        if (drafted.needsInput) {
            const missing = drafted.missing.length ? drafted.missing : ['what you want to say in reply'];
            return stopAndAsk(user, message, {
                missing,
                decision: 'needs-input',
                reason: `The reply needs something the message thread does not contain: ${missing.join('; ')}. Nothing was drafted and nothing was sent. Answer this and it will be drafted again with your answer in mind.`
            });
        }

        // The fabrication guard: a figure that appears in neither the thread
        // nor the owner's own instructions becomes a question, not a draft.
        const unbacked = unbackedFigures(drafted.body, `${thread}\n${instruction}`);
        if (unbacked.length) {
            const missing = unbacked.map((f) => `confirmation that "${f}" is right — it does not appear in the message thread`);
            return stopAndAsk(user, message, {
                missing,
                decision: 'needs-input',
                reason: `The draft stated ${unbacked.map((f) => `"${f}"`).join(', ')}, which appears nowhere in the message thread. Rather than invent it, the assistant is asking you. Nothing was sent.`
            });
        }

        if (!drafted.body.trim()) {
            return stopAndAsk(user, message, {
                missing: ['what you want to say in reply'],
                decision: 'needs-input',
                reason: 'The assistant came back with an empty reply. Nothing was drafted and nothing was sent.'
            });
        }

        // The sign-off knob: the owner decides whether outgoing replies
        // carry the one-line AI disclosure.
        const text = finalizeReply(drafted.body, settings.signReplies !== false);
        const outgoing = {
            to: [message.replyTo].filter(Boolean),
            cc: [],
            bcc: [],
            from: user,
            subject: replySubject(message.subject),
            text,
            inReplyTo: message.messageIdHeader || undefined
        };
        if (!outgoing.to.length) {
            return stopAndAsk(user, message, {
                missing: ['who this should be replied to'],
                decision: 'blocked',
                reason: 'Couldn\'t continue: the message has no reply address. Nothing was sent.'
            });
        }

        // Confident draft + auto-send on + a wired send path → the reply
        // leaves directly. Everything else — an UNSURE draft, autoSend off,
        // or a deployment that injected no send function — goes to the
        // approval gate below. A send failure blocks rather than falls back
        // to deliver: the owner must choose between "sent" and "not sent",
        // never get both.
        if (drafted.needsApproval !== true && settings.autoSend !== false && typeof send === 'function') {
            let sent;
            try {
                sent = await send({
                    user,
                    pass: session.pass,
                    hash: session.hash,
                    messageId: key,
                    message: outgoing
                });
            } catch (err) {
                return stopAndAsk(user, message, {
                    missing: [],
                    decision: 'blocked',
                    reason: `Couldn't continue: the reply could not be sent (${String(err && err.message || err).slice(0, 200)}). Nothing was sent.`
                });
            }
            const sendRefusal = deliverRefusal(sent);
            if (sendRefusal) {
                return stopAndAsk(user, message, {
                    missing: [],
                    decision: 'blocked',
                    reason: `Couldn't continue: the direct send was refused (${sendRefusal}). Nothing was sent.`
                });
            }
            store.markReplySent(user, key, now);
            store.recordProcessed(user, key, 'sent', now);
            const sentReason = 'The assistant was confident in this reply and auto-send is on, so it sent it directly.';
            note(user, {
                messageId: key,
                decision: 'sent',
                reason: sentReason,
                at: now
            });
            return { decision: 'sent', reason: sentReason };
        }

        // THE APPROVAL EXIT. deliver() must reject if the approval request
        // was not created; in production it self-POSTs to /v1/messages/send
        // with Basic auth, which is what puts the draft in front of the owner
        // instead of in front of the recipient. An UNSURE draft rides with
        // the model's own reason so the approval email says why it was held;
        // the reason is approval-metadata and never reaches the recipient.
        const approvalMessage = drafted.needsApproval && drafted.reason
            ? { ...outgoing, unsureReason: drafted.reason }
            : outgoing;
        let result;
        try {
            result = await deliver({
                user,
                pass: session.pass,
                hash: session.hash,
                messageId: key,
                message: approvalMessage
            });
        } catch (err) {
            return stopAndAsk(user, message, {
                missing: [],
                decision: 'blocked',
                reason: `Couldn't continue: the approval request could not be created (${String(err && err.message || err).slice(0, 200)}). Nothing was sent.`
            });
        }
        const refusal = deliverRefusal(result);
        if (refusal) {
            return stopAndAsk(user, message, {
                missing: [],
                decision: 'blocked',
                reason: `Couldn't continue: the approval request was refused (${refusal}). Nothing was sent.`
            });
        }

        store.markReplySent(user, key, now);
        store.recordProcessed(user, key, 'drafted', now);
        const draftedReason = drafted.needsApproval
            ? 'The assistant drafted a reply but is unsure of it, so it is waiting for you to approve it. It has not been sent — the approval email says why the assistant held back.'
            : 'A reply was drafted and is waiting for you to approve it. It has not been sent.';
        note(user, {
            messageId: key,
            decision: 'drafted',
            reason: draftedReason,
            at: now
        });
        return { decision: 'drafted', reason: draftedReason };
    }

    // A resolved deliver() is taken to mean "the approval request exists",
    // but a caller that resolves with a problem body (a Fastify problem, or
    // an `{ ok: false }`) did not create one, and claiming it did would be
    // the one bug this design cannot survive: a reply recorded as pending
    // when it is actually nowhere.
    function deliverRefusal(result) {
        if (!result || typeof result !== 'object') return null;
        if (result.ok === false) return result.detail || result.title || 'delivery was refused';
        if (typeof result.status === 'number' && result.status >= 400) {
            return result.detail || result.title || `delivery returned ${result.status}`;
        }
        return null;
    }

    // --- per user --------------------------------------------------------

    async function processUser(user, session, now) {
        const settings = store.get(user);
        if (!settings.enabled) return;
        if (!settings.maxRepliesPerHour) return; // paused: never draft, never deliver

        const creds = { user, pass: session.pass, hash: session.hash };
        const open = new Map(store.listNeedsInput(user).map((item) => [item.messageId, item]));

        try {
            // One pooled connection serves the whole pass: headers are read
            // for every candidate, and a body is only downloaded for a
            // message that cleared the skip checks, the delay and the rate
            // limit. The mailbox is locked like every other IMAP caller.
            await withClient(pool, creds, async (client) =>
                withMailbox(client, 'INBOX', true, async () => {
                    const candidates = await collectCandidates(client, {
                        now,
                        user,
                        // A settled message must not occupy a candidate
                        // slot: processed ones never come back, and a
                        // needs-input one waits there until the owner acts.
                        isSettled: (key) => store.wasProcessed(user, key) || open.has(key)
                    });
                    for (const message of candidates) {
                        try {
                            await consider(user, message, { session, settings, open, now, client });
                        } catch (err) {
                            logger?.warn({ err: err.message, user }, 'takeover: failed to consider a message');
                            stopAndAsk(user, message, {
                                missing: [],
                                decision: 'blocked',
                                reason: `Couldn't continue: ${String((err && err.message) || err).slice(0, 200)}. Nothing was sent.`
                            });
                        }
                    }
                })
            );
        } catch (err) {
            // An IMAP failure is not a message-level problem and must not
            // generate a queue of "couldn't continue" items: the mail is
            // still there and the next poll will read it.
            logger?.warn({ err: err.message, user }, 'takeover: could not read INBOX');
        }
    }

    // The pass currently in flight, so stop() can wait for its bookkeeping
    // before server.js closes the stores underneath it.
    let inFlight = null;

    function tick() {
        const p = runTick();
        inFlight = p;
        void p.finally(() => { if (inFlight === p) inFlight = null; });
        return p;
    }

    async function runTick() {
        if (!enabled || running || stopped) return;
        running = true;
        try {
            const now = clock();
            // A null session cache (the documented fail-open mode) simply
            // means no sessions to poll — not a poll failure.
            const sessions = cache && cache.listActiveSessions ? cache.listActiveSessions(now) : [];
            if (!sessions.length) return;

            // A user can hold several sessions; work on the first credential
            // we have for them, exactly as the push sender does.
            const byUser = new Map();
            for (const session of sessions) {
                if (!byUser.has(session.user)) byUser.set(session.user, session);
            }

            for (const [user, session] of byUser) {
                try {
                    await processUser(user, session, now);
                } catch (err) {
                    logger?.warn({ err: err.message, user }, 'takeover: user pass failed');
                }
            }
        } catch (err) {
            // setInterval does not await this; an escaping rejection would
            // take the process down and 502 every in-flight request.
            logger?.error({ err: err.message }, 'takeover poll failed');
        } finally {
            running = false;
        }
    }

    function start() {
        // stop() is a real stop, not a kill: the wiring starts and stops this
        // worker as the last user switches the feature on and off, so a later
        // start() has to work again.
        stopped = false;
        if (!enabled || timer) return;
        tick();
        timer = setInterval(tick, pollIntervalMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        stopped = true;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        // Resolves once the in-flight pass has finished. Callers that close
        // stores (server.js onClose) MUST await this before closing them.
        return inFlight || Promise.resolve();
    }

    // Fire a poll now — used after the owner answers a question or switches
    // the feature on, so he does not wait for the next interval to see the
    // result. Safe to call while a tick is running: the guard drops it.
    function wake() {
        if (!enabled || stopped) return;
        tick();
    }

    return { start, stop, tick, wake, enabled };
}

// A message with no Message-ID header still has to be tracked, or it would
// be re-drafted on every poll. The uid is not usable for that — it is
// reassigned after an expunge — so identity comes from the content that does
// not change.
function hashKey(from, date, subject) {
    return crypto.createHash('sha1').update(`${from}|${date}|${subject}`).digest('hex');
}

module.exports = {
    createTakeoverWorker,
    automatedReason,
    parseClassify,
    parseDraft,
    finalizeReply,
    unbackedFigures,
    headerMap,
    replySubject,
    composeThread,
    TAKEOVER_CLASSIFY_SYSTEM,
    TAKEOVER_REPLY_SYSTEM,
    DISCLOSURE
};
