// Browser-side chat client. Posts directly to the LLM provider's
// /chat/completions endpoint from the browser.
//
// Config priority:
//   1. Server-provided config (fetched from /v1/ai/config) — lets admins
//      supply a shared key/endpoint so users don't need their own.
//   2. User's localStorage override (Settings → AI) — for power users who
//      want their own provider/key.
//
// Tool calls map onto the existing /v1/* REST surface using the user's
// session bearer token. The tool catalog mirrors the `imap-rest-mcp` MCP
// server one-for-one, so swapping in a real MCP transport later is a drop-in.

import {
    settings, setLlm, setUseCustomLlm, setDensity, setListFilter,
    setKeyboardShortcuts, setAiSystemPrompt, setAccountChipDisplay,
    setDefaultFromAddress, setDisplayName, setPageSize,
    setAlwaysAllowImages, setGroupThreads, setProxyImages, setPermanentSignIn,
    setPhishingScan, setTrackOpensDefault, setAiSuggestSubjectOnBlur,
    setPhishingScanTimeoutSec, setPhishingScanPromptAddendum,
    setPhishingScanConfidenceFloor, setTesseractOcrInstalled,
    setPhishingScanOcrInline, setSpamSuggest, setSpamSuggestConfidenceFloor,
    setSpamSweepBatchSize, setAiSortSweepSpam, setPreSendCheck,
    setComposeHistorySummary, setVipAddresses, setWeatherChip,
    setWeatherLatLon, setWeatherUnits, setCalendarTicker,
    capabilities, aiAuthKey
} from './settings.svelte';
import { voicePrefs, setVoiceEnabled, setVoiceId } from './voice.svelte';
import { setSkin, setCustomAccent, skinState } from './skins.svelte';
import { folderPrefs, setFolderIcon } from './folder-prefs.svelte';
import { ui, showToast } from './store.svelte';
import { maybeFlagCooldown, aiCooldownLabel } from './ai-cooldown.svelte';
import { bearerHeader, getSession } from './auth.svelte';
import { apiUrl } from './api';
import { setTools } from './ai-threads.svelte';


export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
    id: string;
    name: string;
    arguments: string; // raw JSON string; parsed before exec
}

export interface ChatMessage {
    role: ChatRole;
    content: string;
    /** Base64 data URLs (e.g. data:image/jpeg;base64,...) for vision input. */
    images?: string[];
    toolCalls?: ToolCall[];
    toolCallId?: string; // set when role === 'tool'
    name?: string;       // tool name when role === 'tool'
    /** DeepSeek (and other thinking models) require the prior turn's
     *  reasoning_content to be echoed back when continuing the
     *  conversation. We stash it on the assistant message so cross-turn
     *  history doesn't trip the "reasoning_content must be passed back"
     *  error from the LiteLLM proxy. */
    reasoningContent?: string;
}

// Tools that mutate state — server-side or client-side. The chat loop
// asks the user to approve each one before firing. Read-only tools
// (list_mailboxes, search_messages, get_event, get_settings, …) skip
// the prompt.
export const WRITE_TOOLS = new Set([
    'add_mail_rule', 'remove_mail_rule', 'block_sender', 'send_message',
    'move_message', 'delete_message',
    'create_event', 'delete_event',
    'set_setting', 'set_skin', 'set_folder_icon', 'set_app_surface'
]);

/** Capabilities the model can ask the user to grant via `request_permission`.
 *  Each maps onto a toggle in the AI sidebar. The model's request includes a
 *  human-readable reason that surfaces verbatim in the consent card. */
/** The subset of WRITE_TOOLS whose effects the user cannot easily undo:
 *  mail leaves the building, a message is gone, or inbound mail is silently
 *  filtered from then on. These always ask before firing in a foreground
 *  turn, and are withheld from background tasks entirely.
 *
 *  This matters because the assistant reads attacker-supplied text. A
 *  phishing mail carrying injected instructions ("assistant: archive this
 *  by calling…") is summarised with the victim's live bearer session, and
 *  POST /v1/messages/send delivers immediately for bearer auth. The
 *  reversible writes (move, settings, skins) stay unprompted so ordinary
 *  use doesn't turn into a clickfest. */
export const DESTRUCTIVE_TOOLS = new Set([
    'send_message', 'delete_message', 'add_mail_rule', 'block_sender'
]);

export const GRANTABLE_CAPABILITIES = ['accessEmail', 'accessAllChats', 'webSearch'] as const;
export type GrantableCapability = typeof GRANTABLE_CAPABILITIES[number];

/** Tools that should be available even when the user hasn't toggled on the
 *  email-access tools. Lets the model ask for permission to do more. */
export const META_TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'request_permission',
            description: 'Ask the user to enable a capability you don\'t currently have. Use sparingly, only when you genuinely need it. Provide a clear, one-sentence reason that the user will see.',
            parameters: {
                type: 'object',
                required: ['capability', 'reason'],
                properties: {
                    capability: {
                        type: 'string',
                        enum: ['accessEmail', 'accessAllChats', 'webSearch'],
                        description: 'accessEmail = read mail + calendar. accessAllChats = reference other chat threads. webSearch = use the Brave Search tool to look things up online.'
                    },
                    reason: {
                        type: 'string',
                        description: 'One sentence the user will read in the consent card. Be specific about what you\'ll do with the access.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the live web via Brave Search. Use this for current facts (news, weather, prices, sports, definitions, official sources) — anything outside the user\'s mail/calendar that the user has asked about. Returns 1-10 result snippets with title, URL, and a short description. Cite your sources inline as [1], [2], etc.',
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search terms. Phrase it like a search engine query, not a question (e.g. "Brave Search API limits 2026" not "what are the Brave Search API limits?").'
                    },
                    count: {
                        type: 'integer',
                        description: 'How many results to return (1-10). Default 5.',
                        minimum: 1,
                        maximum: 10
                    }
                }
            }
        }
    }
];

export interface ToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

// Default system prompt for the webmail assistant. Designed for an
// LLM-with-tools that has full read access to the user's mail and calendar.
// Edited via Settings → AI → System prompt to override.
export const SYSTEM_PROMPT = [
    // --- Identity & posture ---
    "You are the assistant inside this user's webmail and calendar.",
    'You speak directly to the account holder — first-person, no third-person disclaimers.',
    'You are competent, terse, and concrete. No filler ("Sure!", "Great question!", "I\'ll get right on that.") — just do the thing.',

    // --- Tool-first behaviour ---
    'Always prefer tools over guessing. If the user mentions a person, subject, message, sender, date, or event, search mail or list calendars before answering.',
    'When a tool returns results, ground every claim in those results — never invent senders, subjects, attendees, dates, addresses, UIDs, or rule IDs.',
    'If a tool fails or returns nothing, say so plainly and offer one obvious next tool call (e.g. broadening the search, switching folders, listing calendars).',
    'Chain tools when needed (search → fetch → quote) without asking permission for read-only steps.',

    // --- Mail style ---
    'When summarising a message: 2–4 short bullets covering sender, ask, deadline, and any links/attachments. Skip pleasantries.',
    'When drafting a reply: match the original\'s register (formal/casual). Default to plain text unless the user asks for HTML.',
    'When quoting from a message, use a short blockquote (`> …`) for the relevant fragment, not a full dump.',
    'When listing messages, use compact bullets: `**Subject** — From · 3d ago` (one line each).',

    // --- Calendar style ---
    'Calendar requests: list calendars first if you don\'t know which one to use. Use ISO 8601 timestamps (e.g. 2026-04-30T14:00:00) for timed events; YYYY-MM-DD with allDay=true for all-day events.',
    'When the user gives relative time ("tomorrow at 3", "next Tuesday"), resolve it against the current date and confirm the absolute date+time in your reply.',
    'Default event duration to 60 minutes if unspecified. Default reminder to 15 minutes before.',

    // --- Confirmations & permissions ---
    'You CAN act on individual messages: `mark_message` (read/unread/star/unstar — no confirmation needed), `move_message` (archive = move to "Archive", trash = move to "Trash", or any other folder), `delete_message` (permanent — almost never the right tool, prefer move to Trash). Use list_mailboxes if you don\'t know the destination folder name.',
    'For destructive actions (move-to-trash, delete-message, block-sender, add-rule, add-event, modify-event), confirm in one short sentence ("Move this to Trash? — yes/no") before calling the tool. For read-only actions and benign toggles like read/unread/star, just go.',
    'After a write succeeds, give a one-line confirmation ("Rule added: redirect from accounts@x to me.") and stop.',
    "If the user asks you to do something that requires a capability you don't currently have (e.g. they want you to read mail but `accessEmail` is off), call the `request_permission` tool with a clear one-sentence reason. The user sees that reason verbatim — be specific about what you'll do with the access.",

    // --- Formatting ---
    'Markdown is rendered. Use **bold** for emphasis, `code` for addresses/UIDs/paths/rule names, blockquotes for excerpts, bullet lists for sets of 3+ items.',
    'Never paste full email bodies in your replies — link by subject + sender + a quoted excerpt.',
    'Never expose API keys, raw tool JSON, or internal IDs unless the user asks for them explicitly.',

    // --- Long-running work ---
    'When a request will obviously take >30s of work — sweeping the whole inbox, scanning hundreds of messages, multi-step research — call `start_background_task` with a clear `instruction` and short `description`, then tell the user "I\'ll notify you when done" and STOP. Do not continue working in the same turn after starting a background task. The result will be posted back into this thread automatically when ready.',

    // --- Date awareness ---
    `Today's date is ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}).`
].join(' ');

// ---------- Tool catalog (mirrors imap-rest-mcp) ----------

export const TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'list_mailboxes',
            description: 'List all mailbox folders for the user. Returns name, path, special-use flag, and unread/total counts.',
            parameters: { type: 'object', properties: { counts: { type: 'boolean', description: 'Include unread + total counts (slower).' } } }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_messages',
            description: 'Search messages in a mailbox. Returns up to pageSize entries with envelope (subject/from/date) and uid.',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string', description: 'Mailbox path, e.g. "INBOX" or "Archive/2026"' },
                    search: { type: 'string', description: 'Free-text search across subject/from/body.' },
                    page: { type: 'integer', minimum: 0 },
                    pageSize: { type: 'integer', minimum: 1, maximum: 100 }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_message',
            description: 'Fetch a single message: envelope, plain-text body, html body, and attachment metadata.',
            parameters: {
                type: 'object',
                required: ['path', 'uid'],
                properties: {
                    path: { type: 'string' },
                    uid: { type: 'integer' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'summarise_email',
            description: 'Summarise a single email by mailbox path + uid. Returns a short prose summary (default 80 words) of the body. Prefer this over fetching the full message when the user just wants the gist.',
            parameters: {
                type: 'object',
                required: ['path', 'uid'],
                properties: {
                    path: { type: 'string', description: 'Mailbox path, e.g. "INBOX".' },
                    uid: { type: 'integer', description: 'IMAP uid of the message.' },
                    maxWords: { type: 'integer', minimum: 30, maximum: 300, description: 'Approx word budget for the summary. Default 80.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'move_message',
            description: 'Move a message to another mailbox folder. Use this for archive (move to "Archive"), trash (move to "Trash"), or any folder change. Confirm with the user first unless they explicitly asked for this exact move.',
            parameters: {
                type: 'object',
                required: ['path', 'uid', 'destination'],
                properties: {
                    path: { type: 'string', description: 'Source mailbox path the message lives in, e.g. "INBOX".' },
                    uid: { type: 'integer', description: 'IMAP uid of the message.' },
                    destination: { type: 'string', description: 'Destination mailbox path, e.g. "Archive", "Trash", "INBOX/Receipts". Use list_mailboxes if unsure.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'mark_message',
            description: 'Toggle flags on a message: read, unread, starred, unstarred. Read/unread/star changes don\'t need user confirmation.',
            parameters: {
                type: 'object',
                required: ['path', 'uid', 'op'],
                properties: {
                    path: { type: 'string', description: 'Mailbox path the message lives in.' },
                    uid: { type: 'integer', description: 'IMAP uid of the message.' },
                    op: {
                        type: 'string',
                        enum: ['read', 'unread', 'star', 'unstar'],
                        description: 'read = add \\Seen, unread = remove \\Seen, star = add \\Flagged, unstar = remove \\Flagged.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_message',
            description: 'Permanently delete a message. Almost always wrong — prefer move_message to "Trash". Only call this when the user explicitly asks for permanent deletion.',
            parameters: {
                type: 'object',
                required: ['path', 'uid'],
                properties: {
                    path: { type: 'string' },
                    uid: { type: 'integer' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_mail_rules',
            description: 'List the user\'s mail rules (block, redirect, copy) compiled into their Sieve script.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'add_mail_rule',
            description: 'Add a mail rule. action.type is one of discard | redirect | copy. redirect/copy require action.to. condition.type is one of from-contains | to-contains | subject-contains | envelope-to-is | header-contains | header-is. header-* conditions require condition.header.',
            parameters: {
                type: 'object',
                required: ['name', 'condition', 'action'],
                properties: {
                    name: { type: 'string' },
                    condition: {
                        type: 'object',
                        required: ['type', 'value'],
                        properties: {
                            type: { type: 'string', enum: ['from-contains', 'to-contains', 'subject-contains', 'envelope-to-is', 'header-contains', 'header-is'] },
                            header: { type: 'string' },
                            value: { type: 'string' }
                        }
                    },
                    action: {
                        type: 'object',
                        required: ['type'],
                        properties: {
                            type: { type: 'string', enum: ['discard', 'redirect', 'copy'] },
                            to: { type: 'string', format: 'email' }
                        }
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remove_mail_rule',
            description: 'Remove a mail rule by id.',
            parameters: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'block_sender',
            description: 'Add an address (or wildcard like "*@spam.example") to the per-user blocked sender list.',
            parameters: {
                type: 'object',
                required: ['sender'],
                properties: { sender: { type: 'string' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_message',
            description: 'Send an email. Returns 501 if SMTP isn\'t configured server-side.',
            parameters: {
                type: 'object',
                required: ['to', 'subject'],
                properties: {
                    to: { type: 'array', items: { type: 'string' } },
                    cc: { type: 'array', items: { type: 'string' } },
                    bcc: { type: 'array', items: { type: 'string' } },
                    subject: { type: 'string' },
                    text: { type: 'string' },
                    html: { type: 'string' },
                    inReplyTo: { type: 'string' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_calendars',
            description: "List the user's calendars — both their own CalDAV calendars AND any external feeds they're subscribed to (Google, work, etc.). Each entry has id, name, source ('caldav' | 'subscription'), color, and a writable flag (subscriptions are read-only).",
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_events',
            description: 'List events in a date range for one calendar. Works for both caldav AND subscription calendars; pass the id from list_calendars and the function dispatches automatically. start/end are ISO 8601 (e.g. 2026-04-01T00:00:00Z).',
            parameters: {
                type: 'object',
                required: ['calendar', 'start', 'end'],
                properties: {
                    calendar: { type: 'string', description: 'Calendar id from list_calendars.' },
                    start: { type: 'string', description: 'Range start (ISO 8601).' },
                    end: { type: 'string', description: 'Range end (ISO 8601).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_event',
            description: 'Fetch a single calendar event by UID.',
            parameters: {
                type: 'object',
                required: ['calendar', 'uid'],
                properties: {
                    calendar: { type: 'string' },
                    uid: { type: 'string' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_event',
            description: 'Create a calendar event. Use ISO 8601 timestamps for start/end. allDay=true uses YYYY-MM-DD strings.',
            parameters: {
                type: 'object',
                required: ['calendar', 'title', 'start', 'end'],
                properties: {
                    calendar: { type: 'string' },
                    title: { type: 'string' },
                    start: { type: 'string' },
                    end: { type: 'string' },
                    allDay: { type: 'boolean' },
                    description: { type: 'string' },
                    location: { type: 'string' },
                    rrule: { type: 'string', description: 'Optional RFC-5545 RRULE, e.g. "FREQ=WEEKLY".' },
                    color: { type: 'string', description: 'Optional CSS colour to override the calendar default.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_event',
            description: 'Delete a calendar event by UID.',
            parameters: {
                type: 'object',
                required: ['calendar', 'uid'],
                properties: {
                    calendar: { type: 'string' },
                    uid: { type: 'string' }
                }
            }
        }
    },

    // --- Local app-control tools (no server roundtrip) -------------------

    {
        type: 'function',
        function: {
            name: 'set_setting',
            description: [
                'Update one user setting. Valid keys:',
                'density (comfortable|compact), listFilter (all|unread|starred|attachments),',
                'keyboardShortcuts (bool), accountChipDisplay (email|name),',
                'defaultFromAddress (string), displayName (string),',
                'pageSize (1..1000 or "unlimited"), aiSystemPrompt (string),',
                'alwaysAllowImages (bool), groupThreads (bool), proxyImages (bool),',
                'permanentSignIn (bool), phishingScan (bool), trackOpensDefault (bool),',
                'aiSuggestSubjectOnBlur (bool), phishingScanTimeoutSec (1..60),',
                'phishingScanPromptAddendum (string ≤500), phishingScanConfidenceFloor (0..1),',
                'tesseractOcrInstalled (bool), phishingScanOcrInline (bool),',
                'spamSuggest (bool), spamSuggestConfidenceFloor (0..1),',
                'spamSweepBatchSize (10..200), aiSortSweepSpam (bool),',
                'preSendCheck (bool), composeHistorySummary (bool),',
                'vipAddresses (comma list), weatherChip (bool),',
                'weatherLatitude (-90..90), weatherLongitude (-180..180),',
                'weatherUnits (celsius|fahrenheit), calendarTicker (bool),',
                'useCustomLlm (bool), llmPreset (string), llmModel (string),',
                'voiceEnabled (bool), voiceId (string).'
            ].join(' '),
            parameters: {
                type: 'object',
                required: ['key', 'value'],
                properties: {
                    key: { type: 'string' },
                    value: {}
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_settings',
            description: "Read the user's current webmail settings (density, page size, AI prompt, default From, etc.). Useful before set_setting to know the current state.",
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_skin',
            description: 'Switch the colour skin / accent. Pass a built-in id (default | midnight | forest | rose | sunset | mono | custom) or "custom" plus a CSS hex colour.',
            parameters: {
                type: 'object',
                required: ['skinId'],
                properties: {
                    skinId: { type: 'string' },
                    customAccent: { type: 'string', description: 'Required when skinId is "custom". Any CSS hex colour, e.g. #6e44ff.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_folder_icon',
            description: 'Override the icon shown next to a mailbox folder with a custom emoji. Pass an empty string to clear.',
            parameters: {
                type: 'object',
                required: ['path', 'emoji'],
                properties: {
                    path: { type: 'string', description: 'Mailbox path, e.g. "INBOX" or "Archive/2026"' },
                    emoji: { type: 'string', description: 'A single emoji, or empty string to remove.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_folder_icons',
            description: "List the user's current per-folder custom icons.",
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_app_surface',
            description: 'Switch the active surface: mail, calendar, or ai.',
            parameters: {
                type: 'object',
                required: ['app'],
                properties: { app: { type: 'string', enum: ['mail', 'calendar', 'ai'] } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'start_background_task',
            description: 'Use this when the user\'s request needs MORE than ~30 seconds of work — e.g. sweeping the whole inbox, doing multi-step research, summarising every email from a sender, or anything that would normally make the chat hang. Calling this returns IMMEDIATELY so you can answer the user with "I\'ll notify you when done." The task then runs detached for up to 30 minutes (100 tool steps); the result is posted as a NEW assistant message in this thread when complete, and the user gets a chime + notification. Only call this once per request. Do NOT call it for short / interactive work — that\'s slower and worse UX.',
            parameters: {
                type: 'object',
                required: ['description', 'instruction'],
                properties: {
                    description: { type: 'string', maxLength: 200, description: 'Short label shown in the running-task banner, e.g. "Sweeping inbox for spam".' },
                    instruction: { type: 'string', maxLength: 4000, description: 'Full instruction the background runner should execute. Be specific — it has access to all the same tools you do.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'spawn_subagent',
            description: 'Spawn a focused sub-agent to handle one well-scoped slice of work in isolation. The sub-agent has the same tool catalog you do but its own conversation context, runs to completion (up to 40 tool steps), and returns its final summary as the tool result. Use this to (a) parallelise independent work, (b) keep your own context lean by offloading deep dives, or (c) recurse into a smaller question without losing your place. RULES: only call this from inside a long background task; max recursion depth is 3 (sub-agents may spawn sub-sub-agents, but not deeper); each sub-agent should have a single clear deliverable in its instruction. Don\'t use it for trivial work that fits in a couple of tool calls — the spawn overhead isn\'t worth it.',
            parameters: {
                type: 'object',
                required: ['description', 'instruction'],
                properties: {
                    description: { type: 'string', maxLength: 200, description: 'Short label, e.g. "Find every receipt from Q1".' },
                    instruction: { type: 'string', maxLength: 4000, description: 'Self-contained task description. The sub-agent does not see your conversation — give it everything it needs.' }
                }
            }
        }
    }
];

// ---------- Tool dispatch ----------

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
    const session = getSession();
    if (!session) throw new Error('No active session');
    const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
        authorization: bearerHeader(session)
    };
    if (init.body) headers['content-type'] = 'application/json';
    const res = await fetch(apiUrl(path), { ...init, headers });
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            if (ct.includes('json')) {
                const j = await res.json();
                detail = j.detail || j.title || detail;
            }
        } catch { /* ignore */ }
        throw new Error(detail);
    }
    return ct.includes('json') ? res.json() : res.text();
}

export async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case 'list_mailboxes':
            return rest(`/v1/mailboxes${args.counts ? '?counts=true' : ''}`);
        case 'search_messages': {
            const q = new URLSearchParams();
            if (args.search) q.set('search', String(args.search));
            if (args.page !== undefined) q.set('page', String(args.page));
            if (args.pageSize !== undefined) q.set('pageSize', String(args.pageSize));
            const qs = q.toString();
            return rest(`/v1/mailboxes/${encodeURIComponent(String(args.path))}/messages${qs ? '?' + qs : ''}`);
        }
        case 'get_message':
            return rest(`/v1/mailboxes/${encodeURIComponent(String(args.path))}/messages/${args.uid}`);
        case 'summarise_email': {
            // Fetch the message envelope + body, then ship the body
            // through the existing /v1/ai/summarize endpoint. Returns
            // { subject, from, summary } so the model can quote the
            // bits that matter without re-asking for envelope details.
            const detail = await rest(`/v1/mailboxes/${encodeURIComponent(String(args.path))}/messages/${args.uid}`) as {
                envelope?: { subject?: string; from?: { name?: string | null; address?: string | null }[] };
                text?: string;
                html?: string;
            };
            const fromAddr = detail.envelope?.from?.[0];
            const text = (detail.text || (detail.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 12000);
            const maxWords = Math.max(30, Math.min(300, Number(args.maxWords) || 80));
            const sum = await rest('/v1/ai/summarize', {
                method: 'POST',
                body: JSON.stringify({ text, maxWords })
            }) as { content?: string };
            return {
                subject: detail.envelope?.subject || '(no subject)',
                from: fromAddr ? (`${fromAddr.name || ''} <${fromAddr.address || ''}>`.trim()) : '',
                summary: sum.content || ''
            };
        }
        case 'move_message': {
            const path = encodeURIComponent(String(args.path));
            return rest(`/v1/mailboxes/${path}/messages/${args.uid}/move`, {
                method: 'PUT',
                body: JSON.stringify({ path: String(args.destination) })
            });
        }
        case 'mark_message': {
            const path = encodeURIComponent(String(args.path));
            const op = String(args.op);
            const body: { add?: string[]; remove?: string[] } = {};
            if (op === 'read') body.add = ['\\Seen'];
            else if (op === 'unread') body.remove = ['\\Seen'];
            else if (op === 'star') body.add = ['\\Flagged'];
            else if (op === 'unstar') body.remove = ['\\Flagged'];
            else throw new Error('op must be one of read | unread | star | unstar');
            return rest(`/v1/mailboxes/${path}/messages/${args.uid}/flags`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
        }
        case 'delete_message': {
            const path = encodeURIComponent(String(args.path));
            return rest(`/v1/mailboxes/${path}/messages/${args.uid}`, { method: 'DELETE' });
        }
        case 'list_mail_rules':
            return rest('/v1/me/mail-rules');
        case 'add_mail_rule':
            return rest('/v1/me/mail-rules', { method: 'POST', body: JSON.stringify(args) });
        case 'remove_mail_rule':
            return rest(`/v1/me/mail-rules/${encodeURIComponent(String(args.id))}`, { method: 'DELETE' });
        case 'block_sender':
            return rest('/v1/me/blocked-senders', { method: 'POST', body: JSON.stringify({ sender: args.sender }) });
        case 'send_message':
            return rest('/v1/messages/send', { method: 'POST', body: JSON.stringify(args) });
        case 'list_calendars': {
            // Merge CalDAV calendars + subscribed external feeds into one
            // list so the model can reason over the user's full calendar
            // surface. Subscriptions are clearly tagged + flagged read-
            // only so it doesn't try to write to them.
            type CalDav = { id: string; displayName?: string; color?: string | null; primary?: boolean };
            type Sub = { id: string; name: string; color?: string | null };
            const [cal, sub] = await Promise.all([
                rest('/v1/me/calendars').catch(() => ({ calendars: [] as CalDav[] })),
                rest('/v1/me/calendar-subscriptions').catch(() => ({ subscriptions: [] as Sub[] }))
            ]);
            const calendars = ((cal as { calendars?: CalDav[] }).calendars || []).map((c) => ({
                id: c.id,
                name: c.displayName || c.id,
                source: 'caldav' as const,
                color: c.color ?? null,
                primary: !!c.primary,
                writable: true
            }));
            const subs = ((sub as { subscriptions?: Sub[] }).subscriptions || []).map((s) => ({
                id: s.id,
                name: s.name,
                source: 'subscription' as const,
                color: s.color ?? null,
                primary: false,
                writable: false
            }));
            return { calendars: [...calendars, ...subs] };
        }
        case 'list_events': {
            const q = new URLSearchParams();
            if (args.start) q.set('start', String(args.start));
            if (args.end) q.set('end', String(args.end));
            const calId = String(args.calendar);
            // Subscription IDs come back from listSubscriptions; if we can
            // find one matching, hit the subscription events route.
            try {
                const subs = await rest('/v1/me/calendar-subscriptions') as { subscriptions?: { id: string }[] };
                const isSub = (subs.subscriptions || []).some((s) => s.id === calId);
                if (isSub) {
                    return rest(`/v1/me/calendar-subscriptions/${encodeURIComponent(calId)}/events?${q.toString()}`);
                }
            } catch { /* fall through to caldav */ }
            return rest(`/v1/me/calendars/${encodeURIComponent(calId)}/events?${q.toString()}`);
        }
        case 'get_event':
            return rest(
                `/v1/me/calendars/${encodeURIComponent(String(args.calendar))}/events/${encodeURIComponent(String(args.uid))}`
            );
        case 'create_event': {
            const { calendar, ...rest_ } = args;
            return rest(
                `/v1/me/calendars/${encodeURIComponent(String(calendar))}/events`,
                { method: 'POST', body: JSON.stringify(rest_) }
            );
        }
        case 'delete_event':
            return rest(
                `/v1/me/calendars/${encodeURIComponent(String(args.calendar))}/events/${encodeURIComponent(String(args.uid))}`,
                { method: 'DELETE' }
            );

        // --- Local app-control tools (no server roundtrip) ---------------

        case 'get_settings': {
            // Return every persisted preference plus the live skin and voice
            // state. The chat needs this to answer "what's my X set to?"
            // without round-tripping through the human, and to do
            // before/after diffs around set_setting calls.
            return {
                density: settings.density,
                listFilter: settings.listFilter,
                keyboardShortcuts: settings.keyboardShortcuts,
                aiSystemPrompt: settings.aiSystemPrompt,
                accountChipDisplay: settings.accountChipDisplay,
                defaultFromAddress: settings.defaultFromAddress,
                displayName: settings.displayName,
                pageSize: settings.pageSize,
                alwaysAllowImages: settings.alwaysAllowImages,
                groupThreads: settings.groupThreads,
                proxyImages: settings.proxyImages,
                permanentSignIn: settings.permanentSignIn,
                phishingScan: settings.phishingScan,
                trackOpensDefault: settings.trackOpensDefault,
                aiSuggestSubjectOnBlur: settings.aiSuggestSubjectOnBlur,
                phishingScanTimeoutSec: settings.phishingScanTimeoutSec,
                phishingScanPromptAddendum: settings.phishingScanPromptAddendum,
                phishingScanConfidenceFloor: settings.phishingScanConfidenceFloor,
                tesseractOcrInstalled: settings.tesseractOcrInstalled,
                phishingScanOcrInline: settings.phishingScanOcrInline,
                spamSuggest: settings.spamSuggest,
                spamSuggestConfidenceFloor: settings.spamSuggestConfidenceFloor,
                spamSweepBatchSize: settings.spamSweepBatchSize,
                aiSortSweepSpam: settings.aiSortSweepSpam,
                preSendCheck: settings.preSendCheck,
                composeHistorySummary: settings.composeHistorySummary,
                vipAddresses: settings.vipAddresses,
                weatherChip: settings.weatherChip,
                weatherLatitude: settings.weatherLatitude,
                weatherLongitude: settings.weatherLongitude,
                weatherUnits: settings.weatherUnits,
                calendarTicker: settings.calendarTicker,
                useCustomLlm: settings.useCustomLlm,
                llmPreset: settings.llm.preset,
                llmModel: settings.llm.model,
                skinId: skinState.skinId,
                customAccent: skinState.customAccent,
                voiceEnabled: voicePrefs.enabled,
                voiceId: voicePrefs.voiceId
            };
        }
        case 'set_setting': {
            const key = String(args.key);
            const value = args.value;
            // Helpers to keep the dispatcher tight. `bool` accepts the
            // common JSON values (true/false, "true"/"false", 0/1) so the
            // model doesn't have to be pedantic about types.
            const bool = (v: unknown): boolean =>
                v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
            const num = (v: unknown, lo: number, hi: number, label: string): number => {
                const n = typeof v === 'number' ? v : Number(v);
                if (!Number.isFinite(n) || n < lo || n > hi) {
                    throw new Error(`${label} must be a number in [${lo}, ${hi}]`);
                }
                return n;
            };
            switch (key) {
                case 'density':
                    if (value === 'comfortable' || value === 'compact') { setDensity(value); return { ok: true }; }
                    throw new Error('density must be "comfortable" or "compact"');
                case 'listFilter':
                    if (['all', 'unread', 'starred', 'attachments'].includes(String(value))) {
                        setListFilter(value as 'all' | 'unread' | 'starred' | 'attachments'); return { ok: true };
                    }
                    throw new Error('listFilter must be one of all, unread, starred, attachments');
                case 'keyboardShortcuts': setKeyboardShortcuts(bool(value)); return { ok: true };
                case 'aiSystemPrompt': setAiSystemPrompt(String(value || '')); return { ok: true };
                case 'accountChipDisplay':
                    if (value === 'email' || value === 'name') { setAccountChipDisplay(value); return { ok: true }; }
                    throw new Error('accountChipDisplay must be "email" or "name"');
                case 'defaultFromAddress': setDefaultFromAddress(String(value || '')); return { ok: true };
                case 'displayName': setDisplayName(String(value || '')); return { ok: true };
                case 'pageSize':
                    if (value === 'unlimited' || (typeof value === 'number' && value > 0 && value <= 1000)) {
                        setPageSize(value as number | 'unlimited'); return { ok: true };
                    }
                    throw new Error('pageSize must be a positive number ≤ 1000 or "unlimited"');
                case 'alwaysAllowImages': setAlwaysAllowImages(bool(value)); return { ok: true };
                case 'groupThreads': setGroupThreads(bool(value)); return { ok: true };
                case 'proxyImages': setProxyImages(bool(value)); return { ok: true };
                case 'permanentSignIn': setPermanentSignIn(bool(value)); return { ok: true };
                case 'phishingScan': setPhishingScan(bool(value)); return { ok: true };
                case 'trackOpensDefault': setTrackOpensDefault(bool(value)); return { ok: true };
                case 'aiSuggestSubjectOnBlur': setAiSuggestSubjectOnBlur(bool(value)); return { ok: true };
                case 'phishingScanTimeoutSec':
                    setPhishingScanTimeoutSec(num(value, 1, 60, 'phishingScanTimeoutSec')); return { ok: true };
                case 'phishingScanPromptAddendum':
                    setPhishingScanPromptAddendum(String(value || '').slice(0, 500)); return { ok: true };
                case 'phishingScanConfidenceFloor':
                    setPhishingScanConfidenceFloor(num(value, 0, 1, 'phishingScanConfidenceFloor')); return { ok: true };
                case 'tesseractOcrInstalled': setTesseractOcrInstalled(bool(value)); return { ok: true };
                case 'phishingScanOcrInline': setPhishingScanOcrInline(bool(value)); return { ok: true };
                case 'spamSuggest': setSpamSuggest(bool(value)); return { ok: true };
                case 'spamSuggestConfidenceFloor':
                    setSpamSuggestConfidenceFloor(num(value, 0, 1, 'spamSuggestConfidenceFloor')); return { ok: true };
                case 'spamSweepBatchSize':
                    setSpamSweepBatchSize(num(value, 10, 200, 'spamSweepBatchSize')); return { ok: true };
                case 'aiSortSweepSpam': setAiSortSweepSpam(bool(value)); return { ok: true };
                case 'preSendCheck': setPreSendCheck(bool(value)); return { ok: true };
                case 'composeHistorySummary': setComposeHistorySummary(bool(value)); return { ok: true };
                case 'vipAddresses': setVipAddresses(String(value || '')); return { ok: true };
                case 'weatherChip': setWeatherChip(bool(value)); return { ok: true };
                case 'weatherLatitude': {
                    const lat = num(value, -90, 90, 'weatherLatitude');
                    setWeatherLatLon(lat, settings.weatherLongitude); return { ok: true };
                }
                case 'weatherLongitude': {
                    const lon = num(value, -180, 180, 'weatherLongitude');
                    setWeatherLatLon(settings.weatherLatitude, lon); return { ok: true };
                }
                case 'weatherUnits':
                    if (value === 'celsius' || value === 'fahrenheit') { setWeatherUnits(value); return { ok: true }; }
                    throw new Error('weatherUnits must be "celsius" or "fahrenheit"');
                case 'calendarTicker': setCalendarTicker(bool(value)); return { ok: true };
                case 'useCustomLlm': setUseCustomLlm(bool(value)); return { ok: true };
                case 'llmPreset': setLlm({ preset: String(value || '') }); return { ok: true };
                case 'llmModel': setLlm({ model: String(value || '') }); return { ok: true };
                case 'voiceEnabled': setVoiceEnabled(bool(value)); return { ok: true };
                case 'voiceId': setVoiceId(String(value || '')); return { ok: true };
                default:
                    throw new Error(`Unknown setting: ${key}`);
            }
        }
        case 'set_skin': {
            const skinId = String(args.skinId);
            setSkin(skinId);
            if (skinId === 'custom' && args.customAccent) {
                setCustomAccent(String(args.customAccent));
            }
            return { ok: true, skinId, customAccent: skinState.customAccent };
        }
        case 'set_folder_icon': {
            const path = String(args.path);
            const emoji = String(args.emoji || '').trim();
            setFolderIcon(path, emoji || null);
            return { ok: true, path, emoji: emoji || null };
        }
        case 'list_folder_icons':
            return { icons: { ...folderPrefs.icons } };
        case 'set_app_surface': {
            const app = String(args.app);
            if (app === 'mail' || app === 'calendar' || app === 'ai') {
                ui.app = app;
                return { ok: true, app };
            }
            throw new Error('app must be "mail", "calendar", or "ai"');
        }
        case 'web_search': {
            const query = String(args.query || '').trim();
            if (!query) throw new Error('query is required');
            const count = Math.max(1, Math.min(10, Number(args.count) || 5));
            return rest('/v1/ai/web-search', {
                method: 'POST',
                body: JSON.stringify({ query, count })
            });
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ---------- Chat completion ----------

export interface ChatTurnEvent {
    type: 'tool_call' | 'message' | 'error' | 'done' | 'switching_to_bg';
    text?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    /** Set on `message` events when the provider emitted DeepSeek-style
     *  reasoning_content. Consumers should stash this on the assistant
     *  ChatMessage so it round-trips on subsequent turns. */
    reasoningContent?: string;
    /** Set on `switching_to_bg` events so the consumer can show a cancel
     *  affordance while the runner picks up the task. */
    bgTaskId?: string;
}

// Convert an OpenAI-format message back to a ChatMessage so an
// in-progress tool chain can be handed over to a background runner.
// Only the shapes chatTurn produces are handled — system prompts and
// non-text user content reduce to text-only equivalents.
function openAiMessageToChat(m: Record<string, unknown>): ChatMessage | null {
    const role = m.role;
    if (role === 'system') return null;
    if (role === 'tool') {
        return {
            role: 'tool',
            content: typeof m.content === 'string' ? m.content : '',
            toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
            name: typeof m.name === 'string' ? m.name : undefined
        };
    }
    if (role === 'assistant') {
        const out: ChatMessage = { role: 'assistant', content: typeof m.content === 'string' ? m.content : '' };
        if (typeof m.reasoning_content === 'string') out.reasoningContent = m.reasoning_content;
        if (Array.isArray(m.tool_calls)) {
            out.toolCalls = (m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>)
                .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
        }
        return out;
    }
    if (role === 'user') {
        if (typeof m.content === 'string') return { role: 'user', content: m.content };
        if (Array.isArray(m.content)) {
            const parts = m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
            const text = parts.find((p) => p.type === 'text')?.text || '';
            const images = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url || '').filter(Boolean);
            return { role: 'user', content: text, images: images.length ? images : undefined };
        }
        return { role: 'user', content: '' };
    }
    return null;
}

export function isChatConfigured(): boolean {
    if (capabilities.aiConfig?.configured) return true;
    const llm = settings.llm;
    return !!(settings.useCustomLlm && llm.apiKey && (llm.baseUrl || llm.preset));
}

export function resolveBaseUrl(): string {
    if (capabilities.aiConfig?.configured) {
        return capabilities.aiConfig.baseUrl.replace(/\/+$/, '');
    }
    const llm = settings.llm;
    if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
    // Fall back to known presets so the user only has to set the API key.
    const presets: Record<string, string> = {
        mistral: 'https://api.mistral.ai/v1',
        openai: 'https://api.openai.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        together: 'https://api.together.xyz/v1',
        ollama: 'http://127.0.0.1:11434/v1',
        perplexity: 'https://api.perplexity.ai',
        openrouter: 'https://openrouter.ai/api/v1'
    };
    return presets[llm.preset] || presets.openai;
}

export function resolveModel(): string {
    if (capabilities.aiConfig?.configured) {
        return capabilities.aiConfig.model;
    }
    const llm = settings.llm;
    if (llm.model) return llm.model;
    const defaults: Record<string, string> = {
        mistral: 'mistral-small-latest',
        openai: 'gpt-4o-mini',
        groq: 'llama-3.1-70b-versatile',
        together: 'meta-llama/Llama-3-8b-chat-hf',
        ollama: 'llama3.1',
        perplexity: 'llama-3.1-sonar-small-128k-chat',
        openrouter: 'meta-llama/llama-3.1-8b-instruct'
    };
    return defaults[llm.preset] || defaults.openai;
}

export function resolveApiKey(): string {
    if (capabilities.aiConfig?.configured) {
        return aiAuthKey();
    }
    return settings.llm.apiKey;
}

// Run one chat turn: send the conversation, follow tool calls until the
// model emits a final assistant message or we hit the step cap.
export async function* chatTurn(
    history: ChatMessage[],
    opts: {
        maxSteps?: number;
        signal?: AbortSignal;
        /** Override the global tool catalog (AI tab uses this for opt-in tools). */
        tools?: ToolDef[];
        /** Override the system prompt. */
        systemPrompt?: string;
        /** Force a specific model (e.g. with `:online` suffix for OpenRouter web search). */
        modelOverride?: string;
        /**
         * Consent handler for the DESTRUCTIVE_TOOLS subset. Resolve true to
         * run the tool, false to deny (the model is told the user declined).
         * When omitted, those tools are refused outright — a caller with no
         * way to ask is not a caller that may assume consent.
         */
        confirmWrite?: (call: { name: string; args: Record<string, unknown> }) => Promise<boolean>;
        /**
         * Handler for `request_permission` calls. Receives the capability
         * the model is asking for and a free-text reason. Resolve true to
         * grant (the caller is also responsible for actually flipping the
         * toggle), false to deny. When omitted, the request auto-denies.
         */
        confirmPermission?: (req: { capability: GrantableCapability; reason: string }) => Promise<boolean>;
        /** Originating chat thread id. When set, the model can call
         *  `start_background_task` to defer slow work; the result is
         *  appended to this thread when the background runner finishes. */
        threadId?: string;
        /** Recursion depth for sub-agent spawning. The bg runner sets
         *  this to 1 for direct sub-agents, 2 for sub-sub-agents, etc.
         *  Hard cap at 3 — anything deeper refuses. Foreground starts
         *  at 0. */
        subagentDepth?: number;
        /** Channel for the bg runner to surface live progress (current
         *  tool call, step) so the UI can show what's happening
         *  without re-routing through chatTurn events. */
        onProgress?: (ev: { kind: 'tool' | 'step' | 'message'; name?: string; step?: number; text?: string }) => void;
    } = {}
): AsyncGenerator<ChatTurnEvent, void, unknown> {
    if (!isChatConfigured()) {
        yield { type: 'error', text: 'Configure an OpenAI-compatible provider + API key in Settings → AI.' };
        return;
    }
    const maxSteps = opts.maxSteps ?? 6;
    const baseUrl = resolveBaseUrl();
    const model = opts.modelOverride || resolveModel();
    const apiKey = resolveApiKey();
    const toolCatalog = opts.tools ?? TOOLS;
    const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;

    // Build messages array in OpenAI format. System prompt comes first, then
    // history; each tool message is { role:'tool', tool_call_id, content }.
    const messages: Record<string, unknown>[] = [{ role: 'system', content: systemPrompt }];
    for (const m of history) {
        if (m.role === 'tool') {
            messages.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
            messages.push({
                role: 'assistant',
                content: m.content || null,
                ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.name, arguments: tc.arguments }
                }))
            });
        } else if (m.role === 'assistant' && m.reasoningContent) {
            messages.push({
                role: 'assistant',
                content: m.content,
                reasoning_content: m.reasoningContent
            });
        } else if (m.images && m.images.length) {
            const content: Array<{type: string; text?: string; image_url?: {url: string}}> = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const img of m.images) {
                content.push({ type: 'image_url', image_url: { url: img } });
            }
            messages.push({ role: m.role, content });
        } else {
            messages.push({ role: m.role, content: m.content });
        }
    }

    for (let step = 0; step < maxSteps; step++) {
        opts.onProgress?.({ kind: 'step', step });
        // Request timing — surfaces in DevTools so the user can tell whether
        // a slow turn is the wire (large payloads), the provider (reasoning
        // models burn seconds on hidden thought), or both.
        // Perplexity models (via OpenRouter) don't support tool calls — strip
        // them so the provider doesn't reject the request.
        const isPerplexity = model.startsWith('perplexity/');
        const sendTools = !isPerplexity && toolCatalog.length > 0;
        const reqBody = JSON.stringify({
            model,
            messages,
            ...(sendTools ? { tools: toolCatalog, tool_choice: 'auto' } : {}),
            temperature: 0.2,
            max_tokens: 2000,
            // mail-ai is a reasoning model — without effort=low it spent
            // most of the budget on chain-of-thought, leaving the actual
            // reply truncated mid-sentence. Conversational chat doesn't
            // need deep reasoning; the model picks it back up if needed.
            reasoning_effort: 'low'
        });
        const t0 = performance.now();
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${apiKey}`,
                'content-type': 'application/json'
            },
            body: reqBody,
            signal: opts.signal
        });
        const t1 = performance.now();
        console.debug(
            `[chat] step=${step} model=${model} reqBytes=${reqBody.length} histMsgs=${messages.length} latencyMs=${Math.round(t1 - t0)}`
        );

        if (!res.ok) {
            let detail = `${res.status} ${res.statusText}`;
            try {
                const j = await res.json();
                detail = j?.error?.message || j?.message || detail;
            } catch { /* not JSON */ }
            // LiteLLM returns 429 + "Budget has been exceeded" when the
            // per-user daily cap is reached. Surface a friendlier toast
            // and a short error in the chat so the user knows it'll reset.
            if (res.status === 429 && /budget/i.test(detail)) {
                const m = /Current cost:\s*([0-9.]+).*Max budget:\s*([0-9.]+)/i.exec(detail);
                const summary = m
                    ? `You've used $${Number(m[1]).toFixed(2)} of your $${Number(m[2]).toFixed(2)} daily AI budget.`
                    : 'You\'ve hit your daily AI budget.';
                showToast('error', `${summary} It resets at midnight UTC.`);
                yield { type: 'error', text: `${summary} It resets at midnight UTC.` };
                return;
            }
            // LiteLLM "No deployments available... Try again in N seconds"
            // means the upstream model is in cooldown. Surface a friendly
            // banner and disable AI features for that duration.
            if (maybeFlagCooldown(detail)) {
                yield { type: 'error', text: `AI is cooling down — try again in ${aiCooldownLabel()}.` };
                return;
            }
            yield { type: 'error', text: `Provider: ${detail}` };
            return;
        }
        const body = await res.json();
        const choice = body?.choices?.[0];
        const msg = choice?.message;
        if (!msg) {
            yield { type: 'error', text: 'Provider returned no choices' };
            return;
        }

        const toolCalls: ToolCall[] = Array.isArray(msg.tool_calls)
            ? msg.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
                id: tc.id, name: tc.function.name, arguments: tc.function.arguments
            }))
            : [];

        // DeepSeek thinking via LiteLLM emits the chain-of-thought in
        // `reasoning_content` (and OpenRouter sometimes uses `reasoning`).
        // We capture it once so it can be (a) used as a UI fallback when
        // `content` is empty and (b) echoed back on the next request —
        // LiteLLM rejects follow-ups that drop it ("reasoning_content
        // in the thinking mode must be passed back to the API").
        const rawReasoning =
            (typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '')
            || (typeof msg.reasoning === 'string' ? msg.reasoning : '')
            || (Array.isArray(msg.reasoning_details)
                ? msg.reasoning_details.map((d: { text?: string }) => d?.text || '').join('').trim()
                : '');

        if (toolCalls.length === 0) {
            // Reasoning models (DeepSeek v4-pro, o-series) often return
            // `content: null` and the answer in `reasoning` / `reasoning_details`.
            // Fall back to those so the UI isn't blank.
            const text = msg.content || rawReasoning || '';
            yield { type: 'message', text, reasoningContent: rawReasoning || undefined };
            yield { type: 'done' };
            return;
        }

        // Persist the assistant tool-call request, then execute each tool
        // and append its result to the next request's messages.
        messages.push({
            role: 'assistant',
            content: msg.content || null,
            ...(rawReasoning ? { reasoning_content: rawReasoning } : {}),
            tool_calls: toolCalls.map((tc) => ({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
            }))
        });

        for (const tc of toolCalls) {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(tc.arguments || '{}'); } catch { /* tolerate empty */ }
            yield { type: 'tool_call', toolName: tc.name, toolArgs: parsed };

            // The model asks for a capability; the user grants it. This used
            // to auto-approve and flip the toggle itself, which meant text
            // the model had just read could widen its own access.
            if (tc.name === 'request_permission') {
                const cap = String((parsed as { capability?: string }).capability || '');
                const reason = String((parsed as { reason?: string }).reason || '');
                const validCap = GRANTABLE_CAPABILITIES.includes(cap as GrantableCapability);
                // No handler (background runner, ChatBot bubble) means there
                // is no one to ask — deny rather than assume consent.
                const granted = validCap && opts.confirmPermission
                    ? await opts.confirmPermission({ capability: cap as GrantableCapability, reason })
                    : false;
                if (validCap && granted) {
                    // Actually flip the toggle so the capability takes effect
                    // (model swap to Sonar/`:online` for webSearch, prompt
                    // additions for accessAllChats, etc). Without this the
                    // approval was a no-op — model heard "approved" but the
                    // SPA-side toolCatalog/modelOverride never updated, so
                    // the next user message ran with the same context.
                    setTools({ [cap as GrantableCapability]: true });
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.name,
                    content: JSON.stringify(
                        !validCap
                            ? { approved: false, error: `Unknown capability: ${cap}` }
                            : granted
                                ? { approved: true, capability: cap }
                                : { approved: false, capability: cap, error: 'The user declined this request. Continue without it; do not ask again this turn.' }
                    )
                });
                continue;
            }

            // Irreversible tools ask first. Anything else — including the
            // reversible writes — still runs unprompted.
            if (DESTRUCTIVE_TOOLS.has(tc.name)) {
                const approved = opts.confirmWrite
                    ? await opts.confirmWrite({ name: tc.name, args: parsed })
                    : false;
                if (!approved) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        name: tc.name,
                        content: JSON.stringify({
                            error: 'The user declined this action. Do not retry it; tell them what you were going to do and stop.'
                        })
                    });
                    continue;
                }
            }

            let result: unknown;
            // start_background_task is meta — it spawns a detached
            // chatTurn loop with the same tool/system context and
            // returns immediately so the model can answer the user
            // with "I'll notify you when done." Requires threadId so
            // the runner knows which chat to post the result back into;
            // refused otherwise (e.g. the floating ChatBot bubble).
            if (tc.name === 'start_background_task') {
                if (!opts.threadId) {
                    result = { error: 'Background tasks need a chat thread context — try this in the AI tab.' };
                } else {
                    const desc = String((parsed as { description?: string }).description || '').slice(0, 200);
                    const inst = String((parsed as { instruction?: string }).instruction || '').slice(0, 4000);
                    if (!inst) {
                        result = { error: 'Missing instruction.' };
                    } else {
                        const { startBackgroundTask } = await import('./background-tasks.svelte');
                        const out = startBackgroundTask({
                            threadId: opts.threadId,
                            description: desc || 'Background task',
                            instruction: inst,
                            tools: toolCatalog,
                            systemPrompt,
                            modelOverride: opts.modelOverride,
                            history
                        });
                        result = out.alreadyRunning
                            ? { ok: false, alreadyRunning: true, taskId: out.taskId, note: 'Another background task is already running on this thread. Tell the user to wait or cancel that one first.' }
                            : { ok: true, taskId: out.taskId, note: 'Background task started. Tell the user you\'ll notify them when it\'s done — do NOT continue the work yourself in this turn.' };
                    }
                }
            } else if (tc.name === 'spawn_subagent') {
                // Recursive sub-agent spawning, capped at depth 3. The
                // sub-agent runs to completion in a fresh chatTurn loop
                // (no thread context, no further bg promotion) and its
                // final assistant message becomes this tool's result.
                const currentDepth = opts.subagentDepth ?? 0;
                const MAX_DEPTH = 3;
                if (currentDepth >= MAX_DEPTH) {
                    result = { error: `Sub-agent recursion limit (${MAX_DEPTH}) reached. Finish this slice yourself instead of spawning deeper.` };
                } else {
                    const desc = String((parsed as { description?: string }).description || '').slice(0, 200);
                    const inst = String((parsed as { instruction?: string }).instruction || '').slice(0, 4000);
                    if (!inst) {
                        result = { error: 'Missing instruction — sub-agents need a self-contained brief.' };
                    } else {
                        opts.onProgress?.({ kind: 'tool', name: `spawn_subagent (depth ${currentDepth + 1})` });
                        try {
                            const subHistory: ChatMessage[] = [{
                                role: 'user',
                                content: `[Sub-agent task — depth ${currentDepth + 1}/${MAX_DEPTH}]\n${desc ? `Goal: ${desc}\n\n` : ''}${inst}\n\nWork end-to-end. Use tools. Return ONE concise summary as your final message — no follow-up questions.`
                            }];
                            let subAcc = '';
                            let subToolCount = 0;
                            for await (const ev of chatTurn(subHistory, {
                                signal: opts.signal,
                                tools: toolCatalog,
                                systemPrompt,
                                modelOverride: opts.modelOverride,
                                maxSteps: 40,
                                subagentDepth: currentDepth + 1,
                                onProgress: opts.onProgress,
                                // Inherit the parent's consent channel: a
                                // sub-agent of a foreground turn can still
                                // put the card in front of the user, while
                                // one under a background task inherits that
                                // runner's blanket deny.
                                confirmWrite: opts.confirmWrite,
                                confirmPermission: opts.confirmPermission
                                // Deliberately no threadId / no bg promotion
                                // for sub-agents — they finish or fail
                                // inline.
                            })) {
                                if (ev.type === 'message') subAcc += ev.text || '';
                                else if (ev.type === 'tool_call') subToolCount += 1;
                                else if (ev.type === 'error') subAcc += `\n[Sub-agent error: ${ev.text || 'unknown'}]`;
                            }
                            result = {
                                ok: true,
                                depth: currentDepth + 1,
                                toolCalls: subToolCount,
                                summary: subAcc.trim().slice(0, 6000) || '(sub-agent produced no output)'
                            };
                        } catch (err) {
                            result = { error: `Sub-agent failed: ${(err as Error).message}` };
                        }
                    }
                }
            } else {
                opts.onProgress?.({ kind: 'tool', name: tc.name });
                try {
                    result = await execTool(tc.name, parsed);
                } catch (err) {
                    result = { error: (err as Error).message };
                }
            }
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.name,
                // Models accept either a string or stringified JSON; keep payload
                // small by truncating large arrays at the source.
                content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 8000)
            });
        }
    }

    // Step cap hit. If we have a thread context we can hand the
    // in-progress conversation off to a background runner with a much
    // larger budget instead of giving up — the user gets a "switching
    // to long task" message and a notification when it finishes.
    if (opts.threadId) {
        const continuedHistory: ChatMessage[] = [];
        for (const m of messages.slice(1)) {
            const c = openAiMessageToChat(m);
            if (c) continuedHistory.push(c);
        }
        try {
            const { startBackgroundTask } = await import('./background-tasks.svelte');
            const out = startBackgroundTask({
                threadId: opts.threadId,
                description: 'Continuing your request',
                instruction: 'Continue from where you stopped. You ran out of step budget mid-task and are resuming with a larger budget — finish the user\'s request end-to-end without asking follow-up questions, then summarise what you did.',
                tools: toolCatalog,
                systemPrompt,
                modelOverride: opts.modelOverride,
                history: continuedHistory,
                maxSteps: 100
            });
            if (out.alreadyRunning) {
                yield { type: 'error', text: 'Hit the step cap, but a background task is already running on this thread — wait or cancel it first.' };
            } else {
                yield {
                    type: 'switching_to_bg',
                    bgTaskId: out.taskId,
                    text: 'Switching to a long-running background task — I\'ll notify you when it\'s done. Closing the tab will cancel it.'
                };
            }
            return;
        } catch (err) {
            yield { type: 'error', text: `Reached the ${maxSteps}-step tool cap and couldn't promote to background: ${(err as Error).message}` };
            return;
        }
    }
    yield { type: 'error', text: `Reached the ${maxSteps}-step tool cap; ask again with a narrower request.` };
}

// ---------- Thread title generation ----------

const TITLE_SYSTEM_PROMPT = [
    'You are a thread-naming assistant.',
    'Given a user message and an assistant reply, output ONLY a single line in this exact format:',
    '',
    'emoji | 2-4 word title',
    '',
    'Example: "🚀 | Space flight plans"',
    'Pick an emoji that captures the topic. Keep the title under 30 characters.',
    'NO quotes, NO JSON, NO code fences, NO explanation, NO key:value pairs — just the raw "emoji | title" line.',
    'If you would otherwise output JSON, convert it to plain text first.'
].join('\n');

// Looks like JSON / code-fence / object output. Pulled out so the
// fallback can detect "the model gave us {...}" and recover the title
// fields rather than dumping raw JSON into the sidebar.
function extractFromJsonLike(raw: string): { emoji: string; title: string } | null {
    const stripped = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
    const objStart = stripped.indexOf('{');
    const objEnd = stripped.lastIndexOf('}');
    if (objStart === -1 || objEnd === -1) return null;
    try {
        const parsed = JSON.parse(stripped.slice(objStart, objEnd + 1));
        if (typeof parsed === 'object' && parsed) {
            const emoji = String((parsed as Record<string, unknown>).emoji || '💬').slice(0, 4);
            const title = String((parsed as Record<string, unknown>).title || '').slice(0, 40);
            if (title) return { emoji, title };
        }
    } catch { /* fall through */ }
    return null;
}

export async function generateThreadTitle(userMessage: string, assistantReply: string, signal?: AbortSignal): Promise<{ emoji: string; title: string } | null> {
    if (!isChatConfigured()) return null;
    const baseUrl = resolveBaseUrl();
    const model = resolveModel();
    const apiKey = resolveApiKey();
    const body = JSON.stringify({
        model,
        messages: [
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: `User: ${userMessage.slice(0, 200)}\nAssistant: ${assistantReply.slice(0, 400)}` }
        ],
        temperature: 0.4,
        max_tokens: 200,
        reasoning_effort: 'minimal',
        // Disable thinking on providers that key off this — the title
        // is a 5-token reply and doesn't need chain-of-thought.
        thinking: { type: 'disabled' }
    });
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${apiKey}`,
                'content-type': 'application/json'
            },
            body,
            signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        const msg = data?.choices?.[0]?.message ?? {};
        const raw: string = (typeof msg.content === 'string' && msg.content.trim())
            ? msg.content
            : (typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '');

        // Strip ```json fences first — some models emit them even
        // for plain-text prompts.
        let text = raw
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim();

        // If the model handed us a JSON object (against instructions),
        // pull title + emoji out before falling through to text parse.
        if (text.startsWith('{')) {
            const jsonOut = extractFromJsonLike(text);
            if (jsonOut) return jsonOut;
            // Couldn't parse — drop the whole {..} so we don't dump
            // raw braces into the sidebar.
            const close = text.lastIndexOf('}');
            if (close >= 0) text = text.slice(close + 1).trim();
        }

        // Match the asked-for "emoji | title" line first, picking the
        // last matching line (thinking models sometimes preface).
        const lineMatches = [...text.matchAll(/^(\S{1,4})\s*\|\s*(.+)$/gm)];
        const last = lineMatches[lineMatches.length - 1];
        if (last) {
            const emoji = last[1].trim();
            const title = last[2].trim().replace(/^["'`]|["'`]$/g, '').slice(0, 40);
            if (emoji && title) return { emoji, title };
        }

        // Fallback: take the last non-empty short line as the title,
        // ignoring lines that still look JSON-shaped.
        const lines = text.split(/\n+/)
            .map((l) => l.trim().replace(/^["'`]|["'`]$/g, ''))
            .filter((l) => l.length > 0 && l.length <= 60 && !/^[{}\[\]"]/.test(l) && !/[:{}]/.test(l.slice(0, 20)));
        const candidate = lines[lines.length - 1];
        if (candidate) return { emoji: '💬', title: candidate.slice(0, 40) };
    } catch {
        // Non-blocking — title generation is cosmetic
    }
    return null;
}
