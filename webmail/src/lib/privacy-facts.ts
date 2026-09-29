// Plain-language "what the AI can see" for Settings → Images & privacy.
//
// WHY A MODULE AND NOT A BLOCK OF COPY IN THE .svelte FILE:
//   Every string in here is a claim about code that lives somewhere else in
//   the tree, and the failure mode when that code changes is a Settings page
//   that confidently lies to the user about their own mail. A privacy
//   summary that overstates its protection is worse than no summary at all,
//   because the user's trust in the one control that DOES work (blocking
//   remote images) is borrowed to vouch for the ones that don't.
//
//   So each claim carries the `source` it was verified against, and the UI
//   renders that citation. When a future change invalidates a claim, the
//   citation is right there next to the prose and greppable from the other
//   end of the codebase — `PrivacyFact.source` is the audit hook.
//
// TWO RENDERING MODES, BECAUSE THE TRUTH DEPENDS ON THE ROUTE:
//   Which path a request takes decides what scrubs it, and the path is
//   chosen at call time from `capabilities.aiConfig` (see resolveBaseUrl in
//   inbox-summary.ts:45, email-actions.svelte.ts:33, chat.svelte.ts:1012).
//   * Server configured → /v1/ai/config hands back a *relative* baseUrl of
//     `/v1/ai/llm` (routes/ai.js:410) with `proxied: true` (:412), so the
//     browser posts to our own proxy and the server-side scrubber runs.
//   * No server AI (or the user typed their own base URL) → the browser
//     posts straight to the provider and the server never sees the text, so
//     it also cannot scrub it. Only the browser-side redaction applies.
//
//   We resolve the mode the same way those resolvers do rather than
//   assuming, and the summary says which one you are in. Claiming server
//   scrubbing to a user who is actually calling OpenAI directly would be
//   the exact lie this module exists to prevent.

import { settings, capabilities } from './settings.svelte';

/** One verifiable claim about what does (or does not) leave the browser. */
export interface PrivacyFact {
    /** Stable id, for tests and for future per-fact conditionals. */
    id: string;
    /** The plain-language claim, shown to the user. */
    claim: string;
    /** file:line this claim was verified against. Rendered in the UI and
     *  greppable from the other end, so a stale claim is findable. */
    source: string;
}

export interface PrivacySummary {
    /** True when the browser routes AI calls through our own server proxy
     *  (routes/ai.js:410 returns baseUrl `/v1/ai/llm`, proxied: true). */
    viaServerProxy: boolean;
    /** Where the provider actually is, in words the user can act on. */
    destination: string;
    facts: PrivacyFact[];
}

// Is this browser talking to our server, or straight to a provider?
//
// Mirrors the `capabilities.aiConfig?.configured` branch every resolver in
// the codebase uses as its FIRST choice (inbox-summary.ts:45-46,
// email-actions.svelte.ts:34, chat.svelte.ts:1013-1014,
// calendar-suggest.ts:41, folder-prefs.svelte.ts:164). The fallback branches
// all end at a preset host (e.g. https://api.mistral.ai/v1,
// inbox-summary.ts:50-57) or the user's own base URL.
export function isViaServerProxy(): boolean {
    return !!capabilities.aiConfig?.configured;
}

export function providerDestination(): string {
    if (capabilities.aiConfig?.configured) {
        // routes/ai.js:460-467 — the model is resolved server-side and the
        // baseUrl is the relative prefix `/v1/ai/llm` (:465, :248), so the
        // provider is the server's own env config and the browser never
        // learns its host.
        return 'your server’s configured model';
    }
    const llm = settings.llm;
    if (llm.baseUrl) {
        try {
            return new URL(llm.baseUrl).hostname;
        } catch {
            return 'your own provider';
        }
    }
    return 'the provider you picked in Settings → AI';
}

export function privacySummary(): PrivacySummary {
    const proxied = isViaServerProxy();

    // Always true, in both modes. Credentials are attached to the IMAP
    // connection (src/imap.js:9 pool.acquire(creds.hash, creds.user,
    // creds.pass)) and are never placed in a request body by any AI route —
    // the LLM adapters only ever send `model` + `messages`
    // (src/llm/index.js:135-147 for OpenAI-compatible, :195-200 for
    // Anthropic).
    const credentials: PrivacyFact = {
        id: 'credentials',
        claim: 'Your mailbox password, session token and app passwords are never sent to the AI. '
            + 'Only the text of messages you actually open, or ask about, is sent.',
        source: 'src/imap.js:9; src/llm/index.js:135-147,195-200'
    };

    // What the auto-scan sends when you open a message. The body is capped
    // at 4000 chars (phishing-scan.ts:130 MAX_BODY_CHARS, applied :235) and
    // the raw HTML is dropped entirely (:238).
    const scan: PrivacyFact = {
        id: 'scan',
        claim: 'The scam scan sends the subject, sender, recipient, up to 4,000 characters of the '
            + 'message body, and the header block — for that one message, when you open it. '
            + 'Attachments and the raw HTML are not sent.',
        source: 'webmail/src/lib/phishing-scan.ts:130,231-241'
    };

    // Inbox briefing scope. 60 most-recent, subject + a 240-char snippet
    // each — it is a triage pass, not a full mailbox export.
    const briefing: PrivacyFact = {
        id: 'briefing',
        claim: '“Brief me” sends the subject and a short preview of up to 60 recent messages. '
            + 'It does not send the rest of your mailbox.',
        source: 'webmail/src/lib/inbox-summary.ts:133-134,211'
    };

    // The chat assistant's reach is gated behind an explicit per-capability
    // grant, defaulting to OFF (ai-threads.svelte.ts:108 returns all-false
    // with no stored prefs), and the tool catalog is withheld entirely
    // until granted (ai/ChatApp.svelte:207 `aiState.tools.accessEmail ?
    // TOOLS : []`).
    const chat: PrivacyFact = {
        id: 'chat',
        claim: 'The AI assistant can only read your mail if you turn on “Access your emails and '
            + 'calendar” for it. That is off until you grant it, and you can withdraw it at any time.',
        source: 'webmail/src/lib/ai-threads.svelte.ts:108; webmail/src/components/ai/ChatApp.svelte:207'
    };

    // Browser-side redaction, applied before the text is even assembled.
    // redactSecrets covers labelled OTPs, passwords, API keys and Luhn-valid
    // card numbers (redact.ts:9-17,37-54).
    const clientRedaction: PrivacyFact = {
        id: 'client-redaction',
        claim: 'Before anything is sent, one-time codes, passwords, API keys and card numbers are '
            + 'replaced with [REDACTED] in your browser.',
        source: 'webmail/src/lib/phishing-scan.ts:232,235; webmail/src/lib/inbox-summary.ts:133-134; webmail/src/lib/redact.ts:9-17'
    };

    const facts: PrivacyFact[] = [credentials, scan, briefing, chat, clientRedaction];

    if (proxied) {
        // The server scrubber. Gated on LLM_SCRUB_SECRETS (config.js:210,
        // default true) and applied to the proxied chat/completions request
        // (routes/ai.js:566-575). The PII pass (ai.js:580-588) also strips
        // local-parts of email addresses and phone numbers, and is skipped
        // only for a provider on the operator's own network (ai.js:12-22).
        facts.push({
            id: 'server-scrub',
            claim: 'Because your AI calls go through this server, a second pass there strips '
                + 'credentials and personal details before the request leaves the building. '
                + 'Redaction reduces what is exposed; it is pattern-matching, not a guarantee.',
            source: 'src/routes/ai.js:566-575,580-588; src/config.js:210'
        });
    } else {
        // The honest limit. secret-scrub is imported in exactly one file and
        // called from exactly two lines, both inside the proxied
        // chat/completions handler (routes/ai.js:6,567,581). A direct
        // browser→provider call never reaches it. Verified by
        // `grep -rn scrubMessages src/` returning only those lines, and by
        // src/llm/index.js having no import of the scrubber at all.
        facts.push({
            id: 'no-server-scrub',
            claim: 'Note: because you are using your own provider directly, only the redaction '
                + 'above happens — the server never sees the text, so it cannot strip anything '
                + 'further. Anything that does not match a known pattern is sent as-is.',
            source: 'src/routes/ai.js:6,567,581 (proxy route only)'
        });
    }

    // The dedicated per-task routes are the sharpest limit in the whole
    // system and the one most likely to be assumed away. /v1/ai/summarize
    // (routes/ai.js:834), /v1/ai/phishing-scan (:940) and friends call
    // llm.* directly (ai.js:843,857,871,885,919,1037); llm/index.js does not
    // import the scrubber, so these paths get the browser-side redaction
    // only, and for the phishing scan that means subject + body but NOT the
    // header block (phishing-scan.ts:239 passes headers through untouched).
    facts.push({
        id: 'route-scope',
        claim: 'One more thing worth knowing: server-side stripping covers the chat assistant’s '
            + 'calls. The one-shot tools (scam scan, summarise, draft reply) do their own trimming '
            + 'and redaction before sending, and are covered by the in-browser pass above.',
        source: 'src/routes/ai.js:843,857,871,885,919,1037; webmail/src/lib/phishing-scan.ts:239'
    });

    // Web search is a separate egress and is separately gated: it needs its
    // own `webSearch` grant (ai-threads.svelte.ts:108, all-false default) and
    // posts the model's query to our server, which calls Brave.
    facts.push({
        id: 'web-search',
        claim: 'Live web search is off until you grant it separately, and only the search query the '
            + 'model writes is sent to the search provider — not your mail.',
        source: 'webmail/src/lib/ai-threads.svelte.ts:108; webmail/src/lib/chat.svelte.ts:931-938; src/routes/ai.js:684'
    });

    return {
        viaServerProxy: proxied,
        destination: providerDestination(),
        facts
    };
}
