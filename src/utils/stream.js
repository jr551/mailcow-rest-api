'use strict';

// Drain a ReadableStream reader into a single Buffer, bailing out as soon
// as the accumulated byte count exceeds `maxBytes`. Returns the buffer of
// bytes read so far plus an `exceeded` flag so callers can surface their
// own 413 / problem response.
async function streamWithLimit(reader, maxBytes) {
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Keep the bytes we're allowed to keep. Returning before pushing
        // silently dropped the chunk that crossed the line, so `buf` was
        // short by up to one chunk even for callers that tolerate a partial
        // read.
        const remaining = maxBytes - total;
        total += value.byteLength;
        if (total > maxBytes) {
            if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
            // Tell the producer to stop. Without this, undici kept pulling
            // the rest of the body into memory we were about to discard —
            // so a mailbox owner embedding <img src="https://evil/huge">
            // drove an unbounded server-side download on every render.
            try { await reader.cancel(); } catch { /* already gone */ }
            return { buf: Buffer.concat(chunks), exceeded: true };
        }
        chunks.push(Buffer.from(value));
    }
    return { buf: Buffer.concat(chunks), exceeded: false };
}

module.exports = { streamWithLimit };
