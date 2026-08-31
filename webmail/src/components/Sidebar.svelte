<script lang="ts">
    import { onDestroy } from 'svelte';
    import { ui, showToast } from '../lib/store.svelte';
    import { shortcutsItems, embeddedShortcut } from '../lib/shortcuts-store';
    import { folderIcon, isGmailFolder, isGmailContainer } from '../lib/format';
    import {
        folderPrefs, setFolderIcon, setFolderExpanded, isFolderExpanded,
        buildFolderTree, flattenTree, getFolderIcon, defaultFolderOpen, collapseAllFolders,
        suggestFolderEmoji, suggestFolderEmojiBatch, isAiSuggestAvailable,
        ICON_STYLES, type IconStyle, type FolderNode
    } from '../lib/folder-prefs.svelte';
    import { ApiError } from '../lib/api';
    import Icon from './Icon.svelte';
    import type { Mailbox, Shortcut } from '../lib/api';
    import type { IconName } from '../lib/icons';

    interface Props {
        onSelect: (path: string) => void;
        onCompose: () => void;
        onRefresh?: () => void | Promise<void>;
        onShortcut: (sc: Shortcut) => void;
        onCreate?: (parentPath: string | null) => Promise<void> | void;
        onRename?: (oldPath: string, newPath: string) => Promise<void> | void;
        onDelete?: (path: string) => Promise<void> | void;
        onDropMessages?: (uids: number[], destPath: string) => void;
    }
    let { onSelect, onCompose, onRefresh, onShortcut, onCreate, onRename, onDelete, onDropMessages }: Props = $props();

    // Spin the refresh icon for the duration of the refresh round-trip, with
    // a minimum spin so quick refreshes still register visually.
    let refreshSpinning = $state(false);
    async function handleRefresh() {
        if (!onRefresh || refreshSpinning) return;
        refreshSpinning = true;
        const startedAt = performance.now();
        try {
            await Promise.resolve(onRefresh());
        } finally {
            const elapsed = performance.now() - startedAt;
            const remaining = Math.max(0, 600 - elapsed);
            setTimeout(() => { refreshSpinning = false; }, remaining);
        }
    }

    // Folder being hovered while dragging messages — used to highlight the
    // drop target without triggering a click.
    let dropTargetPath = $state<string | null>(null);

    let scList = $state<Shortcut[]>([]);
    let embedUrl = $state<string | null>(null);
    const u1 = shortcutsItems.subscribe((v) => { scList = v; });
    const u2 = embeddedShortcut.subscribe((v) => { embedUrl = v?.url || null; });
    onDestroy(() => { u1(); u2(); });

    // Sort INBOX + special folders first at the top level. Hierarchy
    // ordering (within each subtree) uses the alphabetical sort baked
    // into buildFolderTree.
    const SPECIAL_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive'];
    function sortRoots(nodes: FolderNode<Mailbox>[]): FolderNode<Mailbox>[] {
        const score = (n: FolderNode<Mailbox>) => {
            if (n.path.toUpperCase() === 'INBOX') return -1;
            const i = SPECIAL_ORDER.indexOf(n.mailbox.specialUse || '');
            return i >= 0 ? i : 100 + n.label.charCodeAt(0);
        };
        return [...nodes].sort((a, b) => score(a) - score(b));
    }

    let tree = $derived(sortRoots(buildFolderTree(ui.mailboxes)));
    // Touch folderPrefs.expanded so the flatten re-runs when the user
    // toggles a row.
    let visibleNodes = $derived.by(() => {
        // Read the expanded map so Svelte tracks it.
        void folderPrefs.expanded; // eslint-disable-line @typescript-eslint/no-unused-expressions
        // Hide internal storage folders (settings sync, future caches).
        // The leading `.storage_` prefix is reserved for webmail's own
        // bookkeeping; users should never see those rows.
        return flattenTree(tree, ui.selectedPath).filter((n) => !n.path.startsWith('.storage_'));
    });

    function prettyFolder(label: string): string {
        if (label.toUpperCase() === 'INBOX') return 'Inbox';
        // Drop the leading "." from hidden folders we manage (e.g.
        // ".AI Conversations" → "AI Conversations") so the sidebar reads
        // as a normal first-class folder. The on-disk path keeps the dot.
        if (label.startsWith('.') && label.length > 1) return label.slice(1);
        return label;
    }

    function isAiFolder(label: string): boolean {
        return label === '.AI Conversations';
    }

    function toggle(path: string) {
        const node = visibleNodes.find((n) => n.path === path);
        const current = isFolderExpanded(
            path,
            node ? defaultFolderOpen(path, node.depth, ui.selectedPath, node.mailbox.delimiter || '/') : true
        );
        setFolderExpanded(path, !current);
    }

    function collapseAll() {
        collapseAllFolders(visibleNodes.filter((n) => n.children.length && n.depth > 0).map((n) => n.path));
    }

    // --- Context menu ----------------------------------------------------
    let menu = $state<{ path: string; x: number; y: number } | null>(null);
    function openMenu(e: MouseEvent, path: string) {
        e.preventDefault();
        e.stopPropagation();
        menu = { path, x: e.clientX, y: e.clientY };
    }
    function closeMenu() { menu = null; }

    async function doCreate(parent: string | null) {
        closeMenu();
        if (!onCreate) return;
        try {
            await onCreate(parent);
        } catch (err) {
            showToast('error', err instanceof ApiError ? (err.detail || err.title) : (err as Error).message);
        }
    }
    async function doRename(path: string) {
        closeMenu();
        if (!onRename) return;
        const next = prompt('Rename folder to:', path);
        if (!next || next === path) return;
        try {
            await onRename(path, next);
        } catch (err) {
            showToast('error', err instanceof ApiError ? (err.detail || err.title) : (err as Error).message);
        }
    }
    async function doDelete(path: string) {
        closeMenu();
        if (!onDelete) return;
        if (!confirm(`Delete folder "${path}"? This is permanent.`)) return;
        try {
            await onDelete(path);
        } catch (err) {
            showToast('error', err instanceof ApiError ? (err.detail || err.title) : (err as Error).message);
        }
    }
    function setEmoji(path: string) {
        closeMenu();
        const cur = getFolderIcon(path) || '';
        const next = prompt(
            `Custom icon for "${path}". Paste any single emoji (📥, 💼, 🛫, …) or leave blank to clear.`,
            cur
        );
        if (next === null) return;
        setFolderIcon(path, next.trim() || null);
    }

    let aiSuggesting = $state<string | null>(null); // path being processed, for spinner state
    async function aiSuggestIcon(node: FolderNode<Mailbox>) {
        closeMenu();
        if (!isAiSuggestAvailable()) {
            showToast('error', 'Set up your AI provider in Settings → AI first.');
            return;
        }
        aiSuggesting = node.path;
        try {
            const emoji = await suggestFolderEmoji(node.label);
            setFolderIcon(node.path, emoji);
            showToast('success', `${emoji}  set on ${node.label}`);
        } catch (err) {
            showToast('error', (err as Error).message || 'Couldn\'t suggest an icon');
        } finally {
            aiSuggesting = null;
        }
    }

    // Footer secondary actions (New folder / Auto-icon all / Shortcuts)
    // hide by default; the strip slides up when the cursor enters its
    // hover zone — keeps the sidebar focused on folders.
    let footerHover = $state(false);
    let bulkRunning = $state(false);
    let bulkProgress = $state<{ done: number; total: number } | null>(null);
    let stylePickerOpen = $state(false);
    let bulkAbort: AbortController | null = null;

    function toggleStylePicker() {
        if (!isAiSuggestAvailable()) {
            showToast('error', 'Set up your AI provider in Settings → AI first.');
            return;
        }
        if (bulkRunning) {
            // Second click cancels.
            bulkAbort?.abort();
            return;
        }
        stylePickerOpen = !stylePickerOpen;
    }

    async function aiSuggestAll(style: IconStyle) {
        stylePickerOpen = false;
        if (!isAiSuggestAvailable()) {
            showToast('error', 'Set up your AI provider in Settings → AI first.');
            return;
        }
        if (bulkRunning) return;
        // Skip rows that already have an icon — don't clobber user choices.
        const targets = visibleNodes.filter((n) => !folderPrefs.icons[n.path]);
        if (!targets.length) {
            showToast('info', 'All visible folders already have icons.');
            return;
        }
        bulkRunning = true;
        bulkProgress = { done: 0, total: targets.length };
        bulkAbort = new AbortController();
        try {
            await suggestFolderEmojiBatch(
                targets.map((n) => ({ path: n.path, name: n.label })),
                {
                    style,
                    concurrency: 5,
                    signal: bulkAbort.signal,
                    onPicked: (path, emoji) => {
                        setFolderIcon(path, emoji);
                        if (bulkProgress) bulkProgress = { ...bulkProgress, done: bulkProgress.done + 1 };
                    }
                }
            );
            const done = bulkProgress?.done ?? 0;
            showToast('success', `Picked icons for ${done} of ${targets.length} folders.`);
        } catch (err) {
            showToast('error', (err as Error).message || 'Bulk suggest failed.');
        } finally {
            bulkAbort = null;
            bulkProgress = null;
            bulkRunning = false;
            aiSuggesting = null;
        }
    }

    function renderIcon(node: FolderNode<Mailbox>): { kind: 'lucide'; name: IconName } | { kind: 'emoji'; ch: string } {
        const custom = folderPrefs.icons[node.path];
        if (custom) return { kind: 'emoji', ch: custom };
        if (isAiFolder(node.label)) return { kind: 'lucide', name: 'sparkles' };
        return { kind: 'lucide', name: folderIcon(node.mailbox.specialUse, node.label) as IconName };
    }
</script>

<svelte:window
    onclick={(e) => {
        closeMenu();
        // Close the style picker too on outside click.
        const t = e.target as HTMLElement;
        if (stylePickerOpen && !t?.closest?.('.ai-icons-wrap')) stylePickerOpen = false;
    }}
    oncontextmenu={(e) => {
        if (menu && !(e.target as HTMLElement)?.closest?.('.folder')) closeMenu();
    }}
/>

<aside class="sidebar" aria-label="Mailbox navigation">
    <div class="compose-row">
        <button type="button" class="btn btn-primary compose" onclick={onCompose} data-testid="compose-btn">
            <Icon name="plus" size={16} />
            <span>Compose</span>
        </button>
        {#if onRefresh}
            <button
                type="button"
                class={`btn btn-primary refresh-btn ${refreshSpinning ? 'spinning' : ''}`}
                onclick={handleRefresh}
                title="Refresh inbox"
                aria-label="Refresh inbox"
                disabled={refreshSpinning}
                data-testid="sidebar-refresh-btn"
            >
                <span class="refresh-icon" aria-hidden="true">
                    <Icon name="refresh" size={16} />
                </span>
            </button>
        {/if}
    </div>

    {#if ui.mailboxesLoading && visibleNodes.length === 0}
        <div class="placeholder muted">Loading mailboxes…</div>
    {:else if visibleNodes.length === 0}
        <div class="placeholder muted">No mailboxes</div>
    {:else}
        <nav>
            <ul>
                {#each visibleNodes as node (node.path)}
                    {@const icon = renderIcon(node)}
                    {@const expanded = isFolderExpanded(
                        node.path,
                        defaultFolderOpen(node.path, node.depth, ui.selectedPath, node.mailbox.delimiter || '/')
                    )}
                    {@const hasChildren = node.children.length > 0}
                    <li>
                        <div
                            class="folder-row"
                            style={`padding-left: ${10 + node.depth * 14}px;`}
                        >
                            {#if hasChildren}
                                <button
                                    type="button"
                                    class="caret"
                                    aria-label={expanded ? 'Collapse' : 'Expand'}
                                    onclick={(e) => { e.stopPropagation(); toggle(node.path); }}
                                >
                                    <Icon name={expanded ? 'chevronRight' : 'chevronRight'} size={11} />
                                </button>
                            {:else}
                                <span class="caret-spacer" aria-hidden="true"></span>
                            {/if}
                            <button
                                type="button"
                                class="folder"
                                class:active={ui.selectedPath === node.path}
                                class:expanded
                                class:drop-target={dropTargetPath === node.path}
                                class:ai-folder={isAiFolder(node.label)}
                                draggable={onRename ? true : undefined}
                                onclick={() => onSelect(node.path)}
                                oncontextmenu={(e) => openMenu(e, node.path)}
                                ondragstart={(e) => {
                                    if (!onRename) return;
                                    if (!e.dataTransfer) return;
                                    // Tag the drag with both the path and its
                                    // delimiter so the drop target can compute
                                    // the new full path without a lookup.
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('application/x-webmail-folder', JSON.stringify({
                                        path: node.path,
                                        delimiter: node.mailbox.delimiter || '/',
                                        specialUse: node.mailbox.specialUse || null
                                    }));
                                }}
                                ondragover={(e) => {
                                    const types = e.dataTransfer?.types;
                                    if (!types) return;
                                    if (types.includes('application/x-webmail-uids') && onDropMessages) {
                                        e.preventDefault();
                                        e.dataTransfer!.dropEffect = 'move';
                                        dropTargetPath = node.path;
                                        return;
                                    }
                                    if (types.includes('application/x-webmail-folder') && onRename) {
                                        e.preventDefault();
                                        e.dataTransfer!.dropEffect = 'move';
                                        dropTargetPath = node.path;
                                    }
                                }}
                                ondragleave={() => { if (dropTargetPath === node.path) dropTargetPath = null; }}
                                ondrop={(e) => {
                                    e.preventDefault();
                                    dropTargetPath = null;
                                    const dt = e.dataTransfer;
                                    if (!dt) return;
                                    const folderRaw = dt.getData('application/x-webmail-folder');
                                    if (folderRaw && onRename) {
                                        let info: { path: string; delimiter: string; specialUse: string | null } | null = null;
                                        try { info = JSON.parse(folderRaw); } catch { /* */ }
                                        if (!info || !info.path || info.path === node.path) return;
                                        // Don't allow dropping a parent into its own descendant —
                                        // that would create a loop on the IMAP server.
                                        if (node.path === info.path || node.path.startsWith(info.path + info.delimiter)) return;
                                        const delim = node.mailbox.delimiter || info.delimiter || '/';
                                        const srcName = info.path.split(info.delimiter).pop() || info.path;
                                        const newPath = `${node.path}${delim}${srcName}`;
                                        if (newPath === info.path) return;
                                        Promise.resolve(onRename(info.path, newPath))
                                            .catch((err: unknown) => showToast('error', `Move failed: ${(err as Error).message || 'unknown'}`));
                                        return;
                                    }
                                    const raw = dt.getData('application/x-webmail-uids');
                                    if (!raw || !onDropMessages) return;
                                    let uids: number[] = [];
                                    try { uids = JSON.parse(raw); } catch { /* malformed */ }
                                    if (uids.length && node.path !== ui.selectedPath) {
                                        onDropMessages(uids, node.path);
                                    }
                                }}
                                data-testid={`folder-${node.path}`}
                            >
                                <span class="folder-icon">
                                    {#if isGmailFolder(node.path, node.label)}
                                        <span class="gmail-g" aria-hidden="true" title="Synced from Gmail">G</span>
                                    {:else if icon.kind === 'emoji'}
                                        <span class="emoji" aria-hidden="true">{icon.ch}</span>
                                    {:else}
                                        <Icon name={icon.name} size={15} />
                                    {/if}
                                </span>
                                <span class="name truncate">
                                    {#if isGmailContainer(node.path, node.label)}
                                        Synced Gmail Folder
                                    {:else}
                                        {prettyFolder(node.label)}
                                    {/if}
                                </span>
                                {#if typeof node.mailbox.unseen === 'number' && node.mailbox.unseen > 0}
                                    <span class="count" aria-label={`${node.mailbox.unseen} unread`}>{node.mailbox.unseen}</span>
                                {/if}
                            </button>
                        </div>
                    </li>
                {/each}
            </ul>
        </nav>
    {/if}

    {#if scList.length > 0}
        <nav class="shortcuts-nav" aria-label="Company shortcuts">
            <h4 class="nav-section">Shortcuts</h4>
            <ul>
                {#each scList as sc (sc.title)}
                    <li>
                        <button
                            type="button"
                            class="folder shortcut"
                            class:active={embedUrl === sc.url}
                            onclick={() => onShortcut(sc)}
                            title={sc.description || sc.url}
                            data-testid={`shortcut-${sc.title}`}
                        >
                            <Icon name={(sc.icon as IconName) || 'plus'} size={16} />
                            <span class="name truncate">{sc.title}</span>
                            {#if sc.mode === 'link'}
                                <span class="ext-icon" aria-hidden="true">↗</span>
                            {:else if sc.mode === 'popup'}
                                <span class="ext-icon" aria-hidden="true">⤢</span>
                            {/if}
                        </button>
                    </li>
                {/each}
            </ul>
        </nav>
    {/if}

    <!-- Hover-zone at the bottom 24 px of the sidebar reveals the
         secondary actions (New folder / Auto-icon all / Shortcuts).
         While the bulk picker is running we keep the panel pinned so
         the user sees progress; same when the style picker is open. -->
    <div
        class={`footer-zone ${bulkRunning || stylePickerOpen || footerHover ? 'open' : ''}`}
        onmouseenter={() => (footerHover = true)}
        onmouseleave={() => (footerHover = false)}
        role="presentation"
    >
        <span class="footer-handle" aria-hidden="true">
            <Icon name="chevronRight" size={11} />
        </span>
        <div class="sidebar-footer">
            <button type="button" class="footer-btn new-folder" onclick={() => doCreate(null)} data-testid="sidebar-new-folder">
                <Icon name="plus" size={13} />
                <span>New folder</span>
            </button>
            {#if visibleNodes.some((n) => n.children.length && n.depth > 0)}
                <button
                    type="button"
                    class="footer-btn"
                    onclick={collapseAll}
                    title="Collapse every nested folder"
                    data-testid="sidebar-collapse-all"
                >
                    <Icon name="chevronRight" size={13} />
                    <span>Collapse all</span>
                </button>
            {/if}
            {#if isAiSuggestAvailable()}
                <div class="ai-icons-wrap">
                    <button
                        type="button"
                        class={`footer-btn ${bulkRunning ? 'picking' : ''}`}
                        onclick={toggleStylePicker}
                        title={bulkRunning
                            ? 'Click to cancel'
                            : 'Pick a style — the AI will assign a matching emoji to each folder that has no icon yet'}
                        data-testid="sidebar-ai-icons"
                    >
                        {#if bulkRunning}
                            <span class="picking-mark" aria-hidden="true">
                                <Icon name="sparkles" size={13} />
                            </span>
                        {:else}
                            <Icon name="sparkles" size={13} />
                        {/if}
                        <span class="picking-label">
                            {#if bulkRunning && bulkProgress}
                                Picking {bulkProgress.done} / {bulkProgress.total}
                            {:else if bulkRunning}
                                Picking icons…
                            {:else}
                                Auto-icon all
                            {/if}
                        </span>
                        {#if bulkRunning && bulkProgress}
                            <span
                                class="picking-bar"
                                aria-hidden="true"
                                style={`--pct: ${(bulkProgress.done / Math.max(1, bulkProgress.total)) * 100}%;`}
                            ></span>
                        {/if}
                    </button>
                    {#if stylePickerOpen && !bulkRunning}
                        <ul
                            class="style-picker"
                            role="menu"
                            data-testid="ai-icons-style-picker"
                            onclick={(e) => e.stopPropagation()}
                        >
                            <li class="style-head">Pick a style</li>
                            {#each ICON_STYLES as s (s.id)}
                                <li>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="style-row"
                                        onclick={() => aiSuggestAll(s.id)}
                                        data-testid={`ai-icons-style-${s.id}`}
                                    >
                                        <span class="style-sample">{s.sample}</span>
                                        <span class="style-label">{s.label}</span>
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            {/if}
            <button type="button" class="footer-btn" title="Keyboard shortcuts (?)" onclick={() => (ui.helpOpen = true)} data-testid="sidebar-help">
                <Icon name="info" size={13} />
                <span>Shortcuts</span>
                <kbd>?</kbd>
            </button>
        </div>
    </div>
</aside>

{#if menu}
    <ul
        class="ctx-menu"
        role="menu"
        style={`top: ${menu.y}px; left: ${menu.x}px;`}
        onclick={(e) => e.stopPropagation()}
        oncontextmenu={(e) => e.preventDefault()}
    >
        <li><button type="button" role="menuitem" onclick={() => doCreate(menu!.path)}>
            <Icon name="plus" size={12} /> New subfolder
        </button></li>
        <li><button type="button" role="menuitem" onclick={() => doRename(menu!.path)}>
            <Icon name="reply" size={12} /> Rename
        </button></li>
        <li><button type="button" role="menuitem" onclick={() => setEmoji(menu!.path)}>
            <Icon name="palette" size={12} /> Custom icon (emoji)
        </button></li>
        {#if isAiSuggestAvailable()}
            {@const target = visibleNodes.find((n) => n.path === menu!.path)}
            {#if target}
                <li><button type="button" role="menuitem" onclick={() => aiSuggestIcon(target)}>
                    <Icon name="sparkles" size={12} /> Auto icon (AI)
                </button></li>
            {/if}
        {/if}
        <li class="sep"></li>
        <li><button type="button" role="menuitem" class="danger" onclick={() => doDelete(menu!.path)}>
            <Icon name="trash" size={12} /> Delete folder
        </button></li>
    </ul>
{/if}

<style>
    .sidebar {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 10px 10px;
        background: var(--bg-surface);
        border-right: 1px solid var(--border-subtle);
        overflow: hidden;
        min-width: 0;
    }
    @media (max-width: 720px) {
        .sidebar { padding: 12px 6px; }
        .sidebar .name, .sidebar-footer { display: none; }
        .compose span { display: none; }
        .compose { padding: 10px; aspect-ratio: 1 / 1; justify-content: center; }
    }
    .compose-row {
        display: flex;
        gap: 6px;
        margin: 4px 4px 4px;
        align-items: stretch;
    }
    .compose-row .compose { flex: 1; margin: 0; }
    .compose {
        padding: 10px 14px;
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }
    /* Refresh inherits btn-primary so it tracks the active theme accent —
     * matches compose visually so the two read as a paired action. */
    .refresh-btn {
        flex: 0 0 auto;
        display: inline-grid;
        place-items: center;
        width: 40px;
        padding: 0;
        box-shadow: var(--shadow-sm);
    }
    .refresh-btn:hover { transform: translateY(-1px); }
    .refresh-btn:active { transform: translateY(0); }
    .refresh-btn .refresh-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 200ms ease-out;
    }
    /* Smooth full rotation while a refresh is in flight. The spin keeps going
     * for at least 600ms so cached refreshes still register visually. */
    .refresh-btn.spinning .refresh-icon {
        animation: refresh-spin 700ms linear infinite;
    }
    .refresh-btn.spinning {
        cursor: progress;
        opacity: 0.85;
    }
    @keyframes refresh-spin {
        to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
        .refresh-btn.spinning .refresh-icon { animation: none; }
    }
    @media (max-width: 720px) {
        .refresh-btn { width: 36px; }
    }
    nav {
        flex: 1;
        overflow-y: auto;
    }
    nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .folder-row {
        display: flex;
        align-items: center;
        gap: 0;
        position: relative;
    }
    .caret {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 24px;
        color: var(--text-tertiary);
        transition: transform 160ms ease-out, color var(--transition-fast);
    }
    .caret:hover { color: var(--text-primary); }
    .folder-row:has(.folder.expanded) .caret,
    .folder.expanded ~ .caret { transform: rotate(0deg); }
    /* Rotate caret when the folder's expanded — easier to detect via the
     * .folder.expanded sibling pattern above; if grouping changes we have
     * a fallback that checks isFolderExpanded directly. */
    .folder.expanded > .caret-icon { transform: rotate(90deg); }
    .caret-spacer { flex: 0 0 auto; width: 18px; height: 1px; }
    .folder {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 7px 10px 7px 4px;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 500;
        text-align: left;
        min-width: 0;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .folder-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
    }
    .folder-icon .emoji {
        font-size: 15px;
        line-height: 1;
        font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
    }
    /* Gmail-synced badge: a flat "G" disc that mirrors the Google
       monogram on accounts.google.com without pulling in their actual
       logo asset (we'd need their brand approval). 16-px round, the
       four-colour wedge is approximated via conic-gradient. */
    .folder-icon .gmail-g {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        font-size: 10px;
        font-weight: 700;
        font-family: 'Product Sans', system-ui, sans-serif;
        color: white;
        background: conic-gradient(from 0deg,
            #4285F4 0% 25%,
            #34A853 25% 50%,
            #FBBC05 50% 75%,
            #EA4335 75% 100%);
        text-shadow: 0 0 1px rgba(0,0,0,0.25);
    }
    .folder .name { flex: 1; }

    /* AI Conversations folder — call it out so it's recognisable as a
       different surface from regular mail. Accent text + soft tint on
       hover, sparkle icon already wired in renderIcon(). */
    .folder.ai-folder {
        color: var(--accent-text);
        font-weight: 600;
    }
    .folder.ai-folder .folder-icon { color: var(--accent); }
    .folder.ai-folder:hover {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
    .folder.ai-folder.active {
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        color: var(--accent-text);
    }
    .folder .count {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        padding: 1px 7px;
        border-radius: 10px;
        background: var(--bg-tag);
        color: var(--text-secondary);
        min-width: 22px;
        text-align: center;
    }
    .folder.active .count {
        background: var(--accent);
        color: var(--text-on-accent);
    }
    .folder:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
        transform: translateX(1px);
    }
    .folder { transition: background-color var(--transition-fast), color var(--transition-fast), transform 120ms ease; }
    .folder.active {
        background: var(--bg-selected);
        color: var(--accent-text);
        font-weight: 600;
        box-shadow: inset 2px 0 0 var(--accent);
    }
    /* Drop-target highlight while dragging messages over a folder. Outline
     * + accent wash + a soft pulse so the user can tell where they'd land. */
    .folder.drop-target {
        outline: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent);
        outline-offset: -2px;
        background: color-mix(in srgb, var(--accent) 18%, var(--bg-surface));
        animation: drop-pulse 1s ease-in-out infinite;
    }
    @keyframes drop-pulse {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent); }
        50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
    }
    .placeholder {
        padding: 16px 12px;
        font-size: 13px;
    }
    .shortcuts-nav {
        flex: 0 0 auto;
        border-top: 1px solid var(--border-subtle);
        padding-top: 8px;
        margin-top: 4px;
    }
    .shortcuts-nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .nav-section {
        margin: 0 8px 4px;
        padding: 0 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-tertiary);
    }
    .shortcut .ext-icon {
        font-size: 11px;
        color: var(--text-tertiary);
        margin-left: auto;
    }
    .shortcut:hover .ext-icon { color: var(--text-secondary); }
    /* Hover zone — sits at the bottom edge of the sidebar; the actual
     * strip translates off-screen until the cursor lands here (or a
     * background sweep is mid-flight). */
    .footer-zone {
        position: relative;
        flex: 0 0 auto;
        margin-top: auto;
        height: 22px;
        transition: height 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .footer-zone.open {
        height: auto;
    }
    .footer-zone .footer-handle {
        position: absolute;
        top: 0;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-90deg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: 50%;
        color: var(--text-tertiary);
        font-size: 10px;
        opacity: 0.5;
        transition: opacity 200ms, transform 200ms;
        pointer-events: none;
    }
    .footer-zone:hover .footer-handle { opacity: 0.9; }
    .footer-zone.open .footer-handle {
        opacity: 0;
        transform: translate(-50%, -50%) rotate(90deg);
    }
    .sidebar-footer {
        font-size: 11px;
        padding: 8px 4px 4px;
        border-top: 1px solid var(--border-subtle);
        display: flex;
        flex-direction: column;
        gap: 2px;
        transform: translateY(100%);
        opacity: 0;
        transition: transform 200ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 200ms;
    }
    .footer-zone.open .sidebar-footer {
        transform: translateY(0);
        opacity: 1;
    }
    .footer-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
        font-size: 12px;
        text-align: left;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .footer-btn.new-folder { color: var(--text-secondary); font-weight: 600; }
    .footer-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .footer-btn span { flex: 1; }
    .footer-btn kbd {
        display: inline-block;
        min-width: 18px;
        text-align: center;
        padding: 1px 5px;
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-bottom-width: 2px;
        border-radius: var(--radius-xs);
        color: var(--text-secondary);
    }

    /* Style picker popup */
    .ai-icons-wrap { position: relative; }
    .footer-btn.picking {
        position: relative;
        overflow: hidden;
    }
    /* Filled progress bar that grows as picks land. */
    .picking-bar {
        position: absolute;
        inset: auto 0 0 0;
        height: 2px;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 50%, #d268f4));
        width: var(--pct, 0%);
        transition: width 280ms cubic-bezier(0.2, 0.7, 0.2, 1);
        box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 50%, transparent);
    }
    /* Twinkle the sparkle icon while the sweep runs. */
    .picking-mark {
        display: inline-flex;
        animation: sparkle-twinkle 1.4s ease-in-out infinite;
        color: var(--accent-text);
    }
    @keyframes sparkle-twinkle {
        0%, 100% { transform: scale(1) rotate(0); opacity: 0.85; }
        50%      { transform: scale(1.18) rotate(15deg); opacity: 1; filter: drop-shadow(0 0 4px var(--accent)); }
    }
    .footer-btn.picking .picking-label { font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) {
        .picking-mark { animation: none; }
        .picking-bar { transition: none; }
    }
    .style-picker {
        position: absolute;
        bottom: calc(100% + 4px);
        left: 0;
        right: 0;
        list-style: none;
        margin: 0;
        padding: 4px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        z-index: 200;
        animation: fade-in 120ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .style-head {
        padding: 6px 8px 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
    .style-row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        text-align: left;
        font-size: 12px;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .style-row:hover { background: var(--bg-hover); }
    .style-sample {
        font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
        font-size: 13px;
        line-height: 1;
        flex: 0 0 56px;
    }
    .style-label { font-weight: 500; flex: 1; }

    /* Context menu */
    .ctx-menu {
        position: fixed;
        list-style: none;
        margin: 0;
        padding: 4px;
        min-width: 200px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 200;
        animation: fade-in 120ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .ctx-menu li { list-style: none; }
    .ctx-menu li.sep {
        height: 1px;
        margin: 4px 0;
        background: var(--border-subtle);
    }
    .ctx-menu button {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 10px;
        font-size: 12.5px;
        text-align: left;
        border-radius: var(--radius-xs);
        color: var(--text-primary);
    }
    .ctx-menu button:hover { background: var(--bg-hover); }
    .ctx-menu button.danger { color: var(--danger); }
    .ctx-menu button.danger:hover { background: var(--danger-soft); }
</style>
