'use strict';

const { request } = require('undici');

const IMAGE_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/avif',
    'image/gif'
]);

function buildDocumentChunk(buffer, mimeType) {
    const mt = (mimeType || 'application/octet-stream').toLowerCase();
    const dataUri = `data:${mt};base64,${buffer.toString('base64')}`;
    if (IMAGE_MIMES.has(mt)) {
        return { type: 'image_url', image_url: dataUri };
    }
    return { type: 'document_url', document_url: dataUri };
}

function mapMistralStatus(status, body) {
    const detail = body && body.message ? String(body.message) : undefined;
    if (status === 401 || status === 403) {
        return { status: 502, title: 'OCR provider rejected our credentials', detail };
    }
    if (status === 413) {
        return { status: 413, title: 'Attachment too large for OCR', detail };
    }
    if (status === 422) {
        return { status: 415, title: 'Attachment type not supported by OCR', detail };
    }
    if (status === 429) {
        return { status: 429, title: 'OCR provider rate limit', detail };
    }
    if (status >= 500) {
        return { status: 502, title: 'OCR provider upstream error', detail };
    }
    return { status: 502, title: `OCR provider returned ${status}`, detail };
}

async function ocrAttachment({ buffer, mimeType, filename, config, logger, cache }) {
    if (!config.apiKey) {
        return { ok: false, status: 501, title: 'OCR not configured', detail: 'MISTRAL_API_KEY env var is not set' };
    }
    if (!buffer || !buffer.length) {
        return { ok: false, status: 422, title: 'Empty attachment', detail: 'No bytes to OCR' };
    }
    if (buffer.length > config.maxBytes) {
        return {
            ok: false,
            status: 413,
            title: 'Attachment too large for OCR',
            detail: `Attachment is ${buffer.length} bytes; OCR limit is ${config.maxBytes}`
        };
    }

    if (cache) {
        const cached = cache.get(buffer, config.model);
        if (cached) {
            if (logger) logger.debug({ model: config.model }, 'ocr cache hit');
            return { ok: true, response: cached, cached: true };
        }
    }

    const document = buildDocumentChunk(buffer, mimeType);
    const reqBody = {
        model: config.model,
        document,
        id: filename || 'attachment'
    };

    const signal = AbortSignal.timeout(config.timeoutMs);
    let res;
    try {
        res = await request(config.endpoint, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${config.apiKey}`,
                'content-type': 'application/json',
                'accept': 'application/json'
            },
            body: JSON.stringify(reqBody),
            signal
        });
    } catch (err) {
        const aborted = err && (err.name === 'AbortError' || err.code === 'UND_ERR_ABORTED' || err.code === 23);
        if (aborted) {
            return { ok: false, status: 504, title: 'OCR provider timed out' };
        }
        if (logger) logger.debug({ err: err.message }, 'ocr request failed');
        return { ok: false, status: 502, title: 'OCR provider unreachable', detail: err.message };
    }

    const status = res.statusCode;
    let body = null;
    try {
        body = await res.body.json();
    } catch {
        try {
            body = { message: await res.body.text() };
        } catch { /* swallow */ }
    }

    if (logger) logger.debug({ status, model: config.model }, 'ocr response');

    if (status >= 200 && status < 300) {
        if (cache && body) {
            try { cache.set(buffer, config.model, body); }
            catch (err) { if (logger) logger.warn({ err: err.message }, 'ocr cache write failed'); }
        }
        return { ok: true, response: body, cached: false };
    }

    const mapped = mapMistralStatus(status, body);
    if (status === 429) {
        const retryAfter = res.headers && (res.headers['retry-after'] || res.headers['Retry-After']);
        if (retryAfter) mapped.retryAfter = String(retryAfter);
    }
    return { ok: false, ...mapped };
}

function pagesToText(response) {
    if (!response || !Array.isArray(response.pages)) return '';
    return response.pages
        .map((p) => (p && typeof p.markdown === 'string') ? p.markdown : '')
        .filter(Boolean)
        .join('\n\n---\n\n');
}

module.exports = { ocrAttachment, pagesToText, buildDocumentChunk, mapMistralStatus };
