// Per-folder UI prefs — custom icon (emoji or short string) and
// expand/collapse state for hierarchical folders. Lives entirely in
// localStorage; no server round-trip needed.

import { settings, capabilities } from './settings.svelte';

const ICON_KEY = 'webmail.folder-icons.v1';
const EXPAND_KEY = 'webmail.folder-expanded.v1';

interface IconMap { [path: string]: string } // path → emoji or icon-name string
interface ExpandMap { [path: string]: boolean }

function readJSON<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch { return fallback; }
}
function writeJSON(key: string, v: unknown) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ }
}

const _state = $state<{
    icons: IconMap;
    expanded: ExpandMap;
}>({
    icons: readJSON<IconMap>(ICON_KEY, {}),
    expanded: readJSON<ExpandMap>(EXPAND_KEY, {})
});

export const folderPrefs = _state;

export function setFolderIcon(path: string, icon: string | null) {
    if (icon == null || icon === '') {
        delete _state.icons[path];
    } else {
        _state.icons[path] = icon;
    }
    writeJSON(ICON_KEY, _state.icons);
}

export function getFolderIcon(path: string): string | null {
    return _state.icons[path] ?? null;
}

export function setFolderExpanded(path: string, expanded: boolean) {
    _state.expanded[path] = expanded;
    writeJSON(EXPAND_KEY, _state.expanded);
}

export function isFolderExpanded(path: string, defaultOpen = true): boolean {
    return path in _state.expanded ? _state.expanded[path] : defaultOpen;
}

/** Collapse every folder the user hasn't explicitly opened. */
export function collapseAllFolders(paths: string[]) {
    for (const p of paths) _state.expanded[p] = false;
    writeJSON(EXPAND_KEY, _state.expanded);
}

/**
 * Default disclosure for a node the user has never touched.
 *
 * Everything used to default open, so an account with deep nesting
 * unfolded into a wall of rows and pushed the actual mailboxes below the
 * fold. Top-level folders stay open — that's the useful hierarchy — and
 * deeper branches open only when they contain wherever the user currently
 * is, so the active folder is always reachable without scrolling past
 * everything else. An explicit choice still wins, and is remembered.
 */
export function defaultFolderOpen(path: string, depth: number, activePath: string, delimiter = '/'): boolean {
    if (depth === 0) return true;
    if (!activePath) return false;
    if (activePath === path) return true;
    return activePath.startsWith(path + delimiter);
}

// --- Tree building ---------------------------------------------------------

export interface FolderNode<T extends { path: string; delimiter: string }> {
    label: string;     // last segment of the path
    path: string;
    depth: number;
    mailbox: T;        // the original Mailbox object
    children: FolderNode<T>[];
}

/** Build a tree from a flat list of mailboxes. The delimiter from each
 *  mailbox is used to split that mailbox's own path. Children are
 *  grouped under their parent if a sibling Mailbox row exists for that
 *  parent path; otherwise we synthesise a "virtual" parent so the depth
 *  is still correct in the UI. */
export function buildFolderTree<T extends { path: string; delimiter: string; name?: string }>(
    mailboxes: T[]
): FolderNode<T>[] {
    if (!mailboxes.length) return [];
    const byPath = new Map<string, T>();
    for (const m of mailboxes) byPath.set(m.path, m);

    const nodeByPath = new Map<string, FolderNode<T>>();
    function ensure(path: string, mailbox: T): FolderNode<T> {
        let n = nodeByPath.get(path);
        if (n) return n;
        const delim = mailbox.delimiter || '/';
        const segs = path.split(delim);
        const label = segs[segs.length - 1] || path;
        n = {
            label,
            path,
            depth: segs.length - 1,
            mailbox,
            children: []
        };
        nodeByPath.set(path, n);
        return n;
    }

    const roots: FolderNode<T>[] = [];
    for (const m of mailboxes) {
        const node = ensure(m.path, m);
        const delim = m.delimiter || '/';
        if (node.depth === 0 || !m.path.includes(delim)) {
            roots.push(node);
            continue;
        }
        const idx = m.path.lastIndexOf(delim);
        const parentPath = m.path.slice(0, idx);
        const parentMailbox = byPath.get(parentPath) || ({ ...m, path: parentPath, name: parentPath.split(delim).pop() || parentPath } as T);
        const parent = ensure(parentPath, parentMailbox);
        parent.children.push(node);
        if (!byPath.has(parentPath)) {
            // Synthesised parent; make sure it lands somewhere if it isn't
            // already a child of a real grandparent.
            if (parent.depth === 0 && !roots.includes(parent)) roots.push(parent);
        }
    }

    // Stable sort: special-use folders first (INBOX/Sent/Drafts/Trash/Archive
    // often have specialUse flags), then alphabetical. We don't have access
    // to specialUse in this generic builder; the caller can sort outside if
    // needed. For now, alphabetical at every level except keep "INBOX" first.
    const sortFn = (a: FolderNode<T>, b: FolderNode<T>) => {
        if (a.path === 'INBOX') return -1;
        if (b.path === 'INBOX') return 1;
        return a.label.localeCompare(b.label);
    };
    function sortRec(n: FolderNode<T>) {
        n.children.sort(sortFn);
        for (const c of n.children) sortRec(c);
    }
    roots.sort(sortFn);
    for (const r of roots) sortRec(r);
    return roots;
}

// --- LLM emoji suggestion --------------------------------------------------
//
// Fire a single completion against the user's configured LLM asking for
// one fitting emoji for the folder name (e.g. "Travel" → ✈️, "Receipts"
// → 🧾). Falls back gracefully when AI isn't configured. The picked
// emoji is cached in folderPrefs.icons just like a manual selection.

function resolveBaseUrl(): string {
    if (capabilities.aiConfig?.configured) return capabilities.aiConfig.baseUrl.replace(/\/+$/, '');
    const llm = settings.llm;
    if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
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
function resolveModel(): string {
    if (capabilities.aiConfig?.configured) return capabilities.aiConfig.model;
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
function resolveApiKey(): string {
    if (capabilities.aiConfig?.configured) return capabilities.aiConfig.apiKey;
    return settings.llm.apiKey;
}

export function isAiSuggestAvailable(): boolean {
    if (capabilities.aiConfig?.configured) return true;
    const llm = settings.llm;
    return !!(settings.useCustomLlm && llm.apiKey && (llm.baseUrl || llm.preset));
}

// Style presets the user can pick from when running the bulk auto-icon
// sweep. Each preset is just a hint to the LLM about which "vibe" to
// stay in so a wall of folders looks coherent.
export type IconStyle = 'office' | 'playful' | 'mono' | 'animals' | 'food' | 'mixed';

export const ICON_STYLES: { id: IconStyle; label: string; sample: string; hint: string }[] = [
    { id: 'mixed',   label: 'Mixed',         sample: '✨📥💼',     hint: 'Pick whatever fits best — variety is fine.' },
    { id: 'office',  label: 'Office',        sample: '📥📊🗂️',     hint: 'Stay in the work-and-paperwork register: trays, folders, charts, mail, ledgers.' },
    { id: 'playful', label: 'Playful',       sample: '🎉🍕🚀',     hint: 'Pick bright, fun, expressive emoji — celebration, food, transport, cute creatures.' },
    { id: 'mono',    label: 'Outline / Mono', sample: '✏️📝📭',    hint: 'Prefer line-art / outlined emoji over filled colorful ones.' },
    { id: 'animals', label: 'Animals',       sample: '🐺🦊🐧',     hint: 'Pick a fitting ANIMAL emoji for each folder — even when it stretches the metaphor.' },
    { id: 'food',    label: 'Food',          sample: '🍕☕🥖',     hint: 'Pick a fitting FOOD or DRINK emoji for each folder — even when it stretches the metaphor.' }
];

/**
 * Ask the user's LLM for a single emoji that represents the folder
 * name. Returns the emoji string on success; throws on misconfiguration
 * or provider error.
 */
export async function suggestFolderEmoji(
    name: string,
    opts: { signal?: AbortSignal; style?: IconStyle } = {}
): Promise<string> {
    if (!isAiSuggestAvailable()) {
        throw new Error('Configure an OpenAI-compatible provider + API key in Settings → AI.');
    }
    const baseUrl = resolveBaseUrl();
    const model = resolveModel();
    const apiKey = resolveApiKey();
    const styleHint = ICON_STYLES.find((s) => s.id === (opts.style || 'mixed'))?.hint
        || ICON_STYLES[0].hint;
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Return one emoji that fits the user-supplied mailbox folder name.',
                        'Reply with the emoji ONLY — no quotes, no words, no explanation.',
                        styleHint,
                        'Examples (style: mixed): "Travel" → ✈️, "Receipts" → 🧾, "Family" → 👨‍👩‍👧, "Work" → 💼,',
                        '"Newsletters" → 📰, "GitHub" → 🐙, "Banking" → 🏦, "School" → 🎓, "Spam" → 🚫.'
                    ].join(' ')
                },
                { role: 'user', content: name }
            ],
            temperature: 0.3,
            // 1500 is plenty even for reasoning models — we only need a
            // single grapheme back. 4000 was unnecessarily slow.
            max_tokens: 1500
        }),
        signal: opts.signal
    });
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); detail = j?.error?.message || j?.message || detail; } catch { /* */ }
        throw new Error(`Provider: ${detail}`);
    }
    const r = await res.json();
    const m = r?.choices?.[0]?.message || {};
    const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
    const detailText = Array.isArray(m.reasoning_details)
        ? m.reasoning_details.map((d: { text?: string }) => d?.text || '').join('')
        : '';
    const text = (m.content || reasoning || detailText || '').trim();
    if (!text) throw new Error('Provider returned an empty reply.');
    // Take the first emoji-ish grapheme. Strip surrounding quotes/punctuation.
    const cleaned = text
        .replace(/^["'`(]+|["'`).!?,]+$/g, '')
        .trim();
    // Use Intl.Segmenter when available so multi-codepoint emoji (e.g.
    // family) come back intact.
    let first = cleaned;
    try {
        const seg = new (Intl as unknown as { Segmenter: new (l?: string, o?: { granularity?: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter(undefined, { granularity: 'grapheme' });
        for (const s of seg.segment(cleaned)) { first = s.segment; break; }
    } catch {
        first = [...cleaned][0] || cleaned;
    }
    if (!first) throw new Error("Couldn't extract an emoji from the reply.");
    return first;
}

/**
 * Run suggestFolderEmoji() for many folders at once with a small
 * concurrency cap. Materially faster than the previous serial loop
 * (6 folders × 5–10 s per call → 6 × concurrent = under 10 s total).
 * onProgress fires per folder so the UI can paint icons as they land.
 */
export async function suggestFolderEmojiBatch(
    items: { path: string; name: string }[],
    opts: {
        style?: IconStyle;
        concurrency?: number;
        onPicked?: (path: string, emoji: string) => void;
        signal?: AbortSignal;
    } = {}
): Promise<{ path: string; ok: boolean; emoji?: string; err?: string }[]> {
    const conc = Math.max(1, Math.min(opts.concurrency ?? 5, 8));
    const results: { path: string; ok: boolean; emoji?: string; err?: string }[] = [];
    let next = 0;
    async function worker() {
        while (next < items.length) {
            if (opts.signal?.aborted) return;
            const i = next++;
            const it = items[i];
            try {
                const emoji = await suggestFolderEmoji(it.name, {
                    style: opts.style,
                    signal: opts.signal
                });
                results[i] = { path: it.path, ok: true, emoji };
                opts.onPicked?.(it.path, emoji);
            } catch (err) {
                results[i] = { path: it.path, ok: false, err: (err as Error).message };
            }
        }
    }
    await Promise.all(Array.from({ length: conc }, () => worker()));
    return results;
}

/**
 * Flatten the tree into a render-ready list, honouring expand/collapse.
 *
 * `activePath` decides the default for branches the user has never
 * touched: only the ones containing it open, so a deeply nested account
 * doesn't unfold into a wall of rows on first load.
 */
export function flattenTree<T extends { path: string; delimiter: string }>(
    tree: FolderNode<T>[],
    activePath = ''
): FolderNode<T>[] {
    const out: FolderNode<T>[] = [];
    function walk(n: FolderNode<T>) {
        out.push(n);
        const open = isFolderExpanded(
            n.path,
            defaultFolderOpen(n.path, n.depth, activePath, n.mailbox.delimiter || '/')
        );
        if (n.children.length && open) {
            for (const c of n.children) walk(c);
        }
    }
    for (const r of tree) walk(r);
    return out;
}
