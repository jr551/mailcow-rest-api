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

function getBaseUrl(): string {
    if (!cfg) throw new Error('Drive not configured');
    const ep = cfg.endpoint.replace(/\/$/, '');
    return `${ep}/${cfg.bucket}`;
}

function prefixKey(key: string): string {
    if (!cfg) throw new Error('Drive not configured');
    const p = cfg.prefix.replace(/\/$/, '');
    if (!p) return key;
    return p + '/' + key;
}

function encodeKey(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/');
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

export async function listObjects(path: string): Promise<DriveItem[]> {
    if (!aws || !cfg) throw new Error('Drive not configured');
    const prefix = prefixKey(path ? path + '/' : '');
    const delimiter = '/';
    const url = `${getBaseUrl()}?list-type=2&prefix=${encodeKey(prefix)}&delimiter=${encodeURIComponent(delimiter)}`;
    const res = await aws.fetch(url);
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
    onProgress?: (p: PutProgress) => void
): Promise<void> {
    if (!aws || !cfg) throw new Error('Drive not configured');
    const key = prefixKey(path);
    const url = `${getBaseUrl()}/${encodeKey(key)}`;

    // We need XMLHttpRequest's `upload.onprogress` events to drive a real
    // % bar + transfer speed. fetch() can't do upload progress in any
    // browser today (request streams aren't shipped). Sign with aws4fetch
    // first (it computes SigV4) then replay the signed request via XHR.
    const signed = await aws.sign(url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' }
    });

    return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
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
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
            }
        };
        xhr.onerror = () => reject(new Error('S3 upload network error'));
        xhr.onabort = () => reject(new Error('S3 upload aborted'));
        xhr.send(file);
    });
}

export async function deleteObject(path: string): Promise<void> {
    if (!aws || !cfg) throw new Error('Drive not configured');
    const key = prefixKey(path);
    const url = `${getBaseUrl()}/${encodeKey(key)}`;
    const res = await aws.fetch(url, { method: 'DELETE' });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 delete failed: ${res.status} ${text}`);
    }
}

export async function getObjectUrl(path: string): Promise<string> {
    if (!aws || !cfg) throw new Error('Drive not configured');
    const key = prefixKey(path);
    const url = `${getBaseUrl()}/${encodeKey(key)}`;
    const signed = await aws.sign(url, { method: 'GET', aws: { signQuery: true } });
    return signed.url.toString();
}

export async function fetchBlob(path: string): Promise<Blob> {
    if (!aws || !cfg) throw new Error('Drive not configured');
    const key = prefixKey(path);
    const url = `${getBaseUrl()}/${encodeKey(key)}`;
    const res = await aws.fetch(url);
    if (!res.ok) throw new Error(`S3 fetch failed: ${res.status}`);
    return res.blob();
}

export function getConfig(): DriveConfig | null {
    return cfg;
}
