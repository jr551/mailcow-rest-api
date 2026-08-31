// Reactive state for the S3 Drive surface.

import { getDriveConfig, type DriveConfig } from './api';
import { listObjects, putObject, deleteObject, fetchBlob, setDriveConfig, getConfig, type DriveItem } from './drive-api';
import { getObjectUrl } from './drive-api';
export type { DriveItem };
import * as cache from './drive-cache';
import { authState } from './auth.svelte';
import { showToast } from './store.svelte';

export type DriveView = 'grid' | 'list';

export interface DriveUpload {
    name: string;
    progress: number;
    /** Bytes uploaded so far (live). */
    loaded: number;
    /** Total bytes, known up front from File.size. */
    total: number;
    /** Smoothed transfer rate in bytes/sec, EMA over the last few ticks. */
    speedBps: number;
    /** Wall clock when this upload started — used to compute initial speed. */
    startedAt: number;
    done: boolean;
    error: string | null;
}

export interface DrawingEditorState {
    mode: 'create' | 'edit';
    path: string;
    initialSnapshot?: object;
}

export interface TextEditorState {
    item: DriveItem;
    content: string;
}

interface DriveState {
    config: DriveConfig | null;
    configLoading: boolean;
    currentPath: string;
    items: DriveItem[];
    itemsLoading: boolean;
    itemsError: string | null;
    view: DriveView;
    selected: Set<string>;
    uploads: DriveUpload[];
    dragOver: boolean;
    previewItem: DriveItem | null;
    drawingEditor: DrawingEditorState | null;
    textEditor: TextEditorState | null;
}

const LS_VIEW_KEY = 'webmail.drive.v1';

function loadView(): DriveView {
    try {
        const raw = localStorage.getItem(LS_VIEW_KEY);
        if (raw === 'list') return 'list';
    } catch { /* noop */ }
    return 'grid';
}

function saveView(v: DriveView) {
    try {
        localStorage.setItem(LS_VIEW_KEY, v);
    } catch { /* noop */ }
}

const state = $state<DriveState>({
    config: null,
    configLoading: false,
    currentPath: '',
    items: [],
    itemsLoading: false,
    itemsError: null,
    view: loadView(),
    selected: new Set(),
    uploads: [],
    dragOver: false,
    previewItem: null,
    drawingEditor: null,
    textEditor: null
});

export const driveState = state;

export async function loadDriveConfig(): Promise<void> {
    if (state.configLoading) return;
    state.configLoading = true;
    try {
        const cfg = await getDriveConfig();
        state.config = cfg;
        setDriveConfig(cfg);
    } catch (e) {
        showToast('error', 'Failed to load drive config');
    } finally {
        state.configLoading = false;
    }
}

export async function loadPath(path: string): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;

    state.currentPath = path;
    state.itemsLoading = true;
    state.itemsError = null;
    state.selected = new Set();

    // Stale-while-revalidate: render cache first
    const cached = await cache.getTree(user, cfg.prefix, path);
    if (cached) {
        state.items = cached;
    }

    try {
        const items = await listObjects(path);
        state.items = items;
        await cache.putTree(user, cfg.prefix, path, items);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.itemsError = msg;
        if (!cached) state.items = [];
        showToast('error', msg);
    } finally {
        state.itemsLoading = false;
    }
}

export function setView(v: DriveView) {
    state.view = v;
    saveView(v);
}

export function toggleSelect(path: string) {
    const next = new Set(state.selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.selected = next;
}

export function clearSelection() {
    state.selected = new Set();
}

export function selectAll() {
    state.selected = new Set(state.items.map((i) => i.path));
}

export async function createFolder(name: string): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const target = state.currentPath ? `${state.currentPath}/${name}` : name;
    const placeholder = new File([], '');
    try {
        await putObject(target + '/', placeholder);
        await cache.invalidateTree(user, cfg.prefix, state.currentPath);
        await loadPath(state.currentPath);
        showToast('success', `Folder "${name}" created`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', msg);
    }
}

export async function saveAttachmentToDrive(blob: Blob, filename: string, targetPath?: string): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const base = targetPath ?? state.currentPath;
    const path = base ? `${base}/${filename}` : filename;

    const upload: DriveUpload = {
        name: filename,
        progress: 0,
        loaded: 0,
        total: blob.size,
        speedBps: 0,
        startedAt: Date.now(),
        done: false,
        error: null
    };
    state.uploads = [...state.uploads, upload];

    try {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        await putObject(path, file, ({ loaded, total }) => {
            upload.loaded = loaded;
            upload.total = total;
            upload.progress = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
        });
        upload.progress = 100;
        upload.loaded = blob.size;
        upload.done = true;
        showToast('success', `Saved "${filename}" to Drive`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        upload.error = msg;
        upload.done = true;
        showToast('error', `Failed to save "${filename}" to Drive: ${msg}`);
    }

    setTimeout(() => {
        state.uploads = state.uploads.filter((u) => !u.done);
    }, 3000);

    await cache.invalidateTree(user, cfg.prefix, base);
    await loadPath(base);
}

export async function uploadFiles(files: File[], targetPath?: string): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const base = targetPath ?? state.currentPath;

    const now = Date.now();
    const uploads: DriveUpload[] = files.map((f) => ({
        name: f.webkitRelativePath || f.name,
        progress: 0,
        loaded: 0,
        total: f.size,
        speedBps: 0,
        startedAt: now,
        done: false,
        error: null
    }));
    state.uploads = [...state.uploads, ...uploads];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relPath = file.webkitRelativePath || file.name;
        const path = base ? `${base}/${relPath}` : relPath;
        const displayName = file.webkitRelativePath || file.name;
        const idx = state.uploads.findIndex((u) => u.name === displayName && !u.done);
        // EMA over (loaded delta / time delta). α=0.3 smooths jitter from
        // browser progress event bursts without lagging too far behind.
        let lastLoaded = 0;
        let lastTickMs = state.uploads[idx]?.startedAt || Date.now();
        try {
            await putObject(path, file, ({ loaded, total }) => {
                if (idx < 0) return;
                const nowMs = performance.now();
                const dt = (nowMs - lastTickMs) / 1000;
                if (dt > 0.05) {
                    const instant = (loaded - lastLoaded) / dt;
                    const prev = state.uploads[idx].speedBps || instant;
                    state.uploads[idx].speedBps = prev * 0.7 + instant * 0.3;
                    lastTickMs = nowMs;
                    lastLoaded = loaded;
                }
                state.uploads[idx].loaded = loaded;
                state.uploads[idx].total = total;
                state.uploads[idx].progress = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
            });
            if (idx >= 0) {
                state.uploads[idx].progress = 100;
                state.uploads[idx].loaded = file.size;
                state.uploads[idx].done = true;
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (idx >= 0) {
                state.uploads[idx].error = msg;
                state.uploads[idx].done = true;
            }
            showToast('error', `Upload failed: ${displayName}`);
        }
    }

    setTimeout(() => {
        state.uploads = state.uploads.filter((u) => !u.done);
    }, 3000);

    await cache.invalidateTree(user, cfg.prefix, base);
    await loadPath(base);
}

export async function deleteSelected(): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user || state.selected.size === 0) return;
    const paths = Array.from(state.selected);
    for (const p of paths) {
        try {
            const item = state.items.find(i => i.path === p);
            const key = item?.isFolder ? p + '/' : p;
            await deleteObject(key);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            showToast('error', `Delete failed: ${msg}`);
        }
    }
    state.selected = new Set();
    await cache.invalidateTree(user, cfg.prefix, state.currentPath);
    await loadPath(state.currentPath);
}

export function navigateTo(path: string) {
    loadPath(path);
}

export function openPreview(item: DriveItem) {
    state.previewItem = item;
}

export function closePreview() {
    state.previewItem = null;
}

export async function openDrawingEditor(path: string) {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    try {
        const blob = await fetchBlob(path);
        const text = await blob.text();
        const snapshot = JSON.parse(text);
        state.drawingEditor = { mode: 'edit', path, initialSnapshot: snapshot };
    } catch (e) {
        showToast('error', 'Failed to open drawing');
    }
}

export function closeDrawingEditor() {
    state.drawingEditor = null;
}

export async function openTextEditor(path: string) {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    try {
        const blob = await fetchBlob(path);
        const content = await blob.text();
        const item = state.items.find((i) => i.path === path);
        if (!item) return;
        state.textEditor = { item, content };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', `Failed to open file: ${msg}`);
    }
}

export function closeTextEditor() {
    state.textEditor = null;
}

export async function saveTextFile(blob: Blob, filename: string) {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const base = state.currentPath;
    const path = base ? `${base}/${filename}` : filename;
    try {
        const file = new File([blob], filename, { type: blob.type || 'text/plain' });
        await putObject(path, file);
        showToast('success', `Saved "${filename}"`);
        state.textEditor = null;
        await cache.invalidateTree(user, cfg.prefix, state.currentPath);
        await loadPath(state.currentPath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', `Save failed: ${msg}`);
    }
}

export async function renameItem(oldPath: string, newName: string): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (oldPath === newPath) return;
    try {
        const blob = await fetchBlob(oldPath);
        const file = new File([blob], newName, { type: blob.type || 'application/octet-stream' });
        await putObject(newPath, file);
        await deleteObject(oldPath);
        showToast('success', `Renamed to "${newName}"`);
        await cache.invalidateTree(user, cfg.prefix, state.currentPath);
        await loadPath(state.currentPath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', `Rename failed: ${msg}`);
    }
}

export async function deleteItem(path: string, isFolder: boolean): Promise<void> {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    try {
        const key = isFolder ? path + '/' : path;
        await deleteObject(key);
        showToast('success', 'Deleted');
        await cache.invalidateTree(user, cfg.prefix, state.currentPath);
        await loadPath(state.currentPath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', `Delete failed: ${msg}`);
    }
}

export async function createDrawing(name: string) {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const base = state.currentPath;
    const filename = name.endsWith('.tldr') ? name : `${name}.tldr`;
    const path = base ? `${base}/${filename}` : filename;
    state.drawingEditor = { mode: 'create', path };
}

export async function saveDrawing(blob: Blob, filename: string) {
    const cfg = getConfig();
    const user = authState.activeUser;
    if (!cfg || !user) return;
    const base = state.currentPath;
    const path = base ? `${base}/${filename}` : filename;
    try {
        const file = new File([blob], filename, { type: 'application/json' });
        await putObject(path, file);
        showToast('success', `Saved "${filename}"`);
        state.drawingEditor = null;
        await cache.invalidateTree(user, cfg.prefix, state.currentPath);
        await loadPath(state.currentPath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast('error', `Save failed: ${msg}`);
    }
}

export function breadcrumbParts(path: string): { name: string; path: string }[] {
    if (!path) return [];
    const parts = path.split('/');
    return parts.map((name, i) => ({
        name,
        path: parts.slice(0, i + 1).join('/')
    }));
}

export function isImage(item: DriveItem): boolean {
    const ext = item.name.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext || '');
}
