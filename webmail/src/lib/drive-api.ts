// Lightweight S3 REST client using aws4fetch.
// The server provides credentials; we sign requests directly to S3.

import { AwsClient } from 'aws4fetch';
import type { DriveConfig } from './api';

export interface DriveItem {
    name: string;
    path: string;
    size: number;
    lastModified: string;
    etag: string;
    isFolder: boolean;
    contentType?: string;
}

let aws: AwsClient | null = null;
let cfg: DriveConfig | null = null;

export function setDriveConfig(config: DriveConfig | null) {
    cfg = config;
    if (config) {
        aws = new AwsClient({
            accessKeyId: config.credentials.accessKeyId,
            secretAccessKey: config.credentials.secretAccessKey,
            region: config.region,
            service: 's3'
        });
    } else {
        aws = null;
    }
}

function getBaseUrl(config: DriveConfig | null = cfg): string {
    if (!config) throw new Error('Drive not configured');
    const ep = config.endpoint.replace(/\/$/, '');
    return `${ep}/${config.bucket}`;
}

function prefixKey(key: string, config: DriveConfig | null = cfg): string {
    if (!config) throw new Error('Drive not configured');
    const p = config.prefix.replace(/\/$/, '');
    if (!p) return key;
    return p + '/' + key;
}

// Object keys are built from user- and sender-controlled names. fetch()
// collapses `.` and `..` path segments, which would move the request out of
// the folder (or the configured prefix) the caller meant to stay in.
function encodeKey(key: string): string {
    return key.split('/').map((seg) => {
        if (seg === '.' || seg === '..') throw new Error('Invalid path segment');
        return encodeURIComponent(seg);
    }).join('/');
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_NAME_LENGTH = 255;

/** Validate a single file or folder name typed by the user. Returns the
 *  trimmed name or throws a message fit for a toast. */
export function validateDriveName(name: string): string {
    const n = name.trim();
    if (!n) throw new Error('Name cannot be empty');
    if (n === '.' || n === '..') throw new Error('Name cannot be "." or ".."');
    if (n.includes('/') || n.includes('\\')) throw new Error('Name cannot contain "/" or "\\"');
    if (CONTROL_CHARS.test(n)) throw new Error('Name cannot contain control characters');
    if (n.length > MAX_NAME_LENGTH) throw new Error(`Name is longer than ${MAX_NAME_LENGTH} characters`);
    return n;
}

/** Reduce a sender-supplied attachment filename to something safe to use as
 *  one object name: drop any directory part, control characters and dot
 *  segments. */
export function attachmentFileName(name: string): string {
    const base = (name || '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
    if (!base || base === '.' || base === '..') return 'attachment';
    return base.slice(0, MAX_NAME_LENGTH);
}

/** Validate a relative path (folder uploads keep their sub-folders). Each
 *  segment must be a valid name; empty segments are dropped. */
export function validateDriveRelPath(rel: string): string {
    return rel.split('/').filter((seg) => seg !== '').map(validateDriveName).join('/');
}

function signedUrl(key: string): string {
    if (!cfg) throw new Error('Drive not configured');
    if (cfg.publicUrl) {
        const base = cfg.publicUrl.replace(/\/$/, '');
        return `${base}/${encodeKey(key)}`;
    }
    return `${getBaseUrl()}/${encodeKey(key)}`;
}

function parseListXml(xml: string, parentPath: string): DriveItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const contents = doc.querySelectorAll('Contents');
    const prefixes = doc.querySelectorAll('CommonPrefixes');
    const items: DriveItem[] = [];

    prefixes.forEach((p) => {
        const prefix = p.querySelector('Prefix')?.textContent || '';
        const name = prefix.replace(/\/$/, '').split('/').pop() || '';
        const basePrefix = prefixKey(parentPath) + (parentPath ? '/' : '');
        const rel = prefix.startsWith(basePrefix) ? prefix.slice(basePrefix.length) : prefix;
        if (rel === name + '/') {
            items.push({
                name,
                path: parentPath ? `${parentPath}/${name}` : name,
                size: 0,
                lastModified: '',
                etag: '',
                isFolder: true
            });
        }
    });

    contents.forEach((c) => {
        const key = c.querySelector('Key')?.textContent || '';
        const size = parseInt(c.querySelector('Size')?.textContent || '0', 10);
        const lastModified = c.querySelector('LastModified')?.textContent || '';
        const etag = (c.querySelector('ETag')?.textContent || '').replace(/"/g, '');
        const name = key.split('/').pop() || '';
        const basePrefix = prefixKey(parentPath) + (parentPath ? '/' : '');
        const rel = key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
        if (rel.includes('/')) return; // skip nested items beyond current level
        if (size === 0 && name === '') return; // skip empty root placeholders
        // Don't show the folder placeholder object (zero-byte with trailing /) as a file
        if (key.endsWith('/') && size === 0) {
            // Already handled by CommonPrefixes, skip
            return;
        }
        items.push({
            name,
            path: parentPath ? `${parentPath}/${name}` : name,
            size,
            lastModified,
            etag,
            isFolder: false
        });
    });

    // Sort: folders first, then alphabetically
    items.sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        return a.name.localeCompare(b.name);
    });

    return items;
}

export async function listObjects(path: string, signal?: AbortSignal): Promise<DriveItem[]> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    const prefix = prefixKey(path ? path + '/' : '', config);
    const delimiter = '/';
    const url = `${getBaseUrl(config)}?list-type=2&prefix=${encodeKey(prefix)}&delimiter=${encodeURIComponent(delimiter)}`;
    const res = await client.fetch(url, { signal });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 list failed: ${res.status} ${text}`);
    }
    const xml = await res.text();
    return parseListXml(xml, path);
}

export interface PutProgress {
    loaded: number;
    total: number;
}

export async function putObject(
    path: string,
    file: File,
    onProgress?: (p: PutProgress) => void,
    signal?: AbortSignal
): Promise<void> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    const key = prefixKey(path, config);
    const url = `${getBaseUrl(config)}/${encodeKey(key)}`;

    // We need XMLHttpRequest's `upload.onprogress` events to drive a real
    // % bar + transfer speed. fetch() can't do upload progress in any
    // browser today (request streams aren't shipped). Sign with aws4fetch
    // first (it computes SigV4) then replay the signed request via XHR.
    const signed = await client.sign(url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' }
    });
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');

    return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => xhr.abort();
        xhr.open('PUT', signed.url, true);
        signed.headers.forEach((value, name) => {
            // Some headers (host, content-length) are unsafe to set on XHR;
            // the browser supplies them itself. Skip explicitly.
            const lower = name.toLowerCase();
            if (lower === 'host' || lower === 'content-length') return;
            try { xhr.setRequestHeader(name, value); } catch { /* unsafe */ }
        });
        xhr.upload.onprogress = (e) => {
            if (!onProgress) return;
            const total = e.lengthComputable ? e.total : file.size;
            onProgress({ loaded: e.loaded, total });
        };
        xhr.onload = () => {
            cleanup();
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
            }
        };
        xhr.onerror = () => {
            cleanup();
            reject(new Error('S3 upload network error'));
        };
        xhr.onabort = () => {
            cleanup();
            reject(signal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal?.aborted) {
            reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            xhr.send(file);
        } catch (e) {
            cleanup();
            reject(e);
        }
    });
}

async function deleteFullKey(key: string, client: AwsClient, config: DriveConfig, signal?: AbortSignal): Promise<void> {
    const url = `${getBaseUrl(config)}/${encodeKey(key)}`;
    const res = await client.fetch(url, { method: 'DELETE', signal });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 delete failed: ${res.status} ${text}`);
    }
}

export async function deleteObject(path: string, signal?: AbortSignal): Promise<void> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    await deleteFullKey(prefixKey(path, config), client, config, signal);
}

/** Delete a folder and everything under it. A folder is only a key prefix
 *  (plus an optional zero-byte placeholder), so removing the placeholder
 *  alone would leave every file in the bucket. */
export async function deleteFolder(path: string, signal?: AbortSignal): Promise<void> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (!clean) throw new Error('Refusing to delete the drive root');
    const prefix = prefixKey(clean + '/', config);
    const keys: string[] = [];
    let token = '';
    do {
        const url = `${getBaseUrl(config)}?list-type=2&prefix=${encodeKey(prefix)}` +
            (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
        const res = await client.fetch(url, { signal });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`S3 list failed: ${res.status} ${text}`);
        }
        const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
        doc.querySelectorAll('Contents > Key').forEach((k) => {
            const key = k.textContent || '';
            if (key.startsWith(prefix)) keys.push(key);
        });
        token = doc.querySelector('IsTruncated')?.textContent === 'true'
            ? doc.querySelector('NextContinuationToken')?.textContent || ''
            : '';
    } while (token);
    if (!keys.includes(prefix)) keys.push(prefix);
    for (let i = 0; i < keys.length; i += 8) {
        if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
        await Promise.all(keys.slice(i, i + 8).map((key) => deleteFullKey(key, client, config, signal)));
    }
}

/** Presigned GET URL. Defaults to aws4fetch's 24h; pass a shorter lifetime
 *  for URLs that are only needed to render a preview. */
export async function getObjectUrl(path: string, expiresSec?: number, signal?: AbortSignal): Promise<string> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    const key = prefixKey(path, config);
    const url = `${getBaseUrl(config)}/${encodeKey(key)}${expiresSec ? `?X-Amz-Expires=${Math.floor(expiresSec)}` : ''}`;
    const signed = await client.sign(url, { method: 'GET', aws: { signQuery: true } });
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    return signed.url.toString();
}

export async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    const client = aws;
    const config = cfg;
    if (!client || !config) throw new Error('Drive not configured');
    const key = prefixKey(path, config);
    const url = `${getBaseUrl(config)}/${encodeKey(key)}`;
    const res = await client.fetch(url, { signal });
    if (!res.ok) throw new Error(`S3 fetch failed: ${res.status}`);
    return res.blob();
}

export function getConfig(): DriveConfig | null {
    return cfg;
}
