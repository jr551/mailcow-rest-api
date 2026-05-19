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
        total += value.byteLength;
        if (total > maxBytes) {
            return { buf: Buffer.concat(chunks), exceeded: true };
        }
        chunks.push(Buffer.from(value));
    }
    return { buf: Buffer.concat(chunks), exceeded: false };
}

module.exports = { streamWithLimit };
