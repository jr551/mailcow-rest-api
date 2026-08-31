<script lang="ts">
    import { mobileState, navigate } from '../lib/store.svelte';
    import { folderIcon } from '../../lib/format';
    import Icon from '../../components/Icon.svelte';
    import type { IconName } from '../../lib/icons';
    import type { Mailbox } from '../../lib/api';

    interface TreeNode {
        mailbox: Mailbox;
        children: TreeNode[];
        depth: number;
    }

    const SPECIAL_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Archive', '\\Trash', '\\Junk'];

    function isHidden(mb: Mailbox): boolean {
        return mb.path.startsWith('.') || mb.name?.startsWith('.');
    }

    function isSpecial(mb: Mailbox): boolean {
        return !!mb.specialUse && SPECIAL_ORDER.includes(mb.specialUse);
    }

    function specialRank(mb: Mailbox): number {
        if (!mb.specialUse) return 999;
        const idx = SPECIAL_ORDER.indexOf(mb.specialUse);
        return idx >= 0 ? idx : 999;
    }

    function hasChildren(mb: Mailbox, all: Mailbox[]): boolean {
        const delim = mb.delimiter || '/';
        return all.some((v) => {
            if (v.path === mb.path) return false;
            const parts = v.path.split(delim);
            parts.pop();
            return parts.join(delim) === mb.path;
        });
    }

    function buildTree(mailboxes: Mailbox[]): TreeNode[] {
        const visible = mailboxes.filter((mb) => !isHidden(mb));
        // Keep special folders in the tree only if they have children,
        // otherwise they already appear in the Favorites section.
        const treeFolders = visible.filter((mb) => !isSpecial(mb) || hasChildren(mb, visible));

        const map = new Map<string, TreeNode>();
        for (const mb of treeFolders) {
            map.set(mb.path, { mailbox: mb, children: [], depth: 0 });
        }

        const roots: TreeNode[] = [];
        for (const mb of treeFolders) {
            const node = map.get(mb.path)!;
            const delim = mb.delimiter || '/';
            const parts = mb.path.split(delim);
            if (parts.length > 1) {
                parts.pop();
                const parentPath = parts.join(delim);
                const parent = map.get(parentPath);
                if (parent) {
                    node.depth = parent.depth + 1;
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            } else {
                roots.push(node);
            }
        }

        // Sort each level alphabetically by name
        function sortLevel(nodes: TreeNode[]) {
            nodes.sort((a, b) => a.mailbox.name.localeCompare(b.mailbox.name));
            for (const n of nodes) sortLevel(n.children);
        }
        sortLevel(roots);

        return roots;
    }

    const favorites = $derived(
        [...mobileState.mailboxes]
            .filter((mb) => !isHidden(mb) && isSpecial(mb))
            .sort((a, b) => specialRank(a) - specialRank(b))
    );

    const tree = $derived(buildTree(mobileState.mailboxes));

    let expanded = $state<Set<string>>(new Set());

    // Auto-expand all parents by default
    $effect(() => {
        const allParents = new Set<string>();
        function collect(nodes: TreeNode[]) {
            for (const n of nodes) {
                if (n.children.length > 0) {
                    allParents.add(n.mailbox.path);
                    collect(n.children);
                }
            }
        }
        collect(tree);
        if (allParents.size > 0 && expanded.size === 0) {
            expanded = allParents;
        }
    });

    function toggleExpand(path: string) {
        const next = new Set(expanded);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        expanded = next;
    }

    function selectFolder(path: string) {
        mobileState.selectedPath = path;
        mobileState.search = '';
        navigate('inbox');
    }

    function renderNodes(nodes: TreeNode[]): TreeNode[] {
        const flat: TreeNode[] = [];
        for (const n of nodes) {
            flat.push(n);
            if (expanded.has(n.mailbox.path) || n.children.length === 0) {
                flat.push(...renderNodes(n.children));
            }
        }
        return flat;
    }

    const flatTree = $derived(renderNodes(tree));
</script>

<div class="folders-view">
    <header class="mheader">
        <h1>Mailboxes</h1>
    </header>
    <div class="list scroll-y">
        {#if favorites.length > 0}
            <div class="ios-section-title">Favorites</div>
            <div class="ios-list">
                {#each favorites as mb, i (mb.path)}
                    <button
                        type="button"
                        class="ios-row"
                        class:active={mobileState.selectedPath === mb.path}
                        class:last={i === favorites.length - 1}
                        onclick={() => selectFolder(mb.path)}
                    >
                        <span class="folder-icon">
                            <Icon name={folderIcon(mb.specialUse, mb.name) as IconName} size={22} />
                        </span>
                        <span class="folder-name">{mb.name || mb.path}</span>
                        {#if typeof mb.unseen === 'number' && mb.unseen > 0}
                            <span class="folder-badge">{mb.unseen}</span>
                        {/if}
                        <span class="chevron">
                            <Icon name="chevronRight" size={14} />
                        </span>
                    </button>
                {/each}
            </div>
        {/if}

        {#if flatTree.length > 0}
            <div class="ios-section-title">All Mailboxes</div>
            <div class="ios-list">
                {#each flatTree as node, i (node.mailbox.path)}
                    {@const mb = node.mailbox}
                    {@const isLast = i === flatTree.length - 1}
                    {@const hasChildren = node.children.length > 0}
                    <button
                        type="button"
                        class="ios-row"
                        class:active={mobileState.selectedPath === mb.path}
                        class:last={isLast}
                        style="padding-left: calc(16px + {node.depth * 20}px)"
                        onclick={() => {
                            if (hasChildren) {
                                toggleExpand(mb.path);
                            }
                            selectFolder(mb.path);
                        }}
                    >
                        {#if hasChildren}
                            <span class="expand-icon" class:expanded={expanded.has(mb.path)}>
                                <Icon name="chevronRight" size={14} />
                            </span>
                        {:else}
                            <span class="spacer"></span>
                        {/if}
                        <span class="folder-icon">
                            <Icon name={folderIcon(mb.specialUse, mb.name) as IconName} size={20} />
                        </span>
                        <span class="folder-name">{mb.name || mb.path}</span>
                        {#if typeof mb.unseen === 'number' && mb.unseen > 0}
                            <span class="folder-badge">{mb.unseen}</span>
                        {/if}
                        <span class="chevron">
                            <Icon name="chevronRight" size={14} />
                        </span>
                    </button>
                {/each}
            </div>
        {/if}

        {#if favorites.length === 0 && flatTree.length === 0}
            <div class="mempty">
                <Icon name="folder" size={32} />
                <p class="muted">No mailboxes found.</p>
            </div>
        {/if}
    </div>
</div>

<style>
    .folders-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
    }
    .list {
        flex: 1;
        padding: 0;
    }
    .ios-section-title {
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--text-tertiary);
        margin: 20px 16px 6px;
        padding: 0;
    }
    .ios-list {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        border-radius: 12px;
        overflow: hidden;
        margin: 0 16px;
    }
    .ios-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 16px;
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
        cursor: pointer;
        font-size: 16px;
        color: var(--text-primary);
        transition: background-color 80ms;
        min-height: 44px;
    }
    .ios-row:not(.last) {
        border-bottom: 0.5px solid var(--border-subtle);
    }
    .ios-row:active { background: var(--bg-hover); }
    .ios-row.active { background: var(--accent-soft); }
    .folder-icon {
        color: var(--accent);
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
    }
    .folder-name {
        flex: 1;
        font-weight: 400;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .folder-badge {
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 10px;
        background: var(--accent);
        color: var(--text-on-accent);
        font-size: 12px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }
    .chevron {
        color: var(--text-tertiary);
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
    }
    .expand-icon {
        color: var(--text-tertiary);
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        width: 16px;
        transition: transform 150ms ease;
    }
    .expand-icon.expanded {
        transform: rotate(90deg);
    }
    .spacer {
        width: 16px;
        flex-shrink: 0;
    }
    .muted { color: var(--text-tertiary); }
</style>
