'use strict';

// Downloads hand Fastify a stream from a pooled IMAP connection. If that
// connection went back to the pool before the FETCH literal finished, a
// concurrent request could acquire it mid-literal and corrupt both.
//
// Fastify does not resolve the handler chain until a streamed body has
// been written, so the current code is already safe — measured over a real
// socket, pool release lands a few ms *after* the stream ends. These tests
// exist to keep it that way: detaching the stream from the returned
// promise (writing to reply.raw, or sending without awaiting) would
// reintroduce the hazard silently.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const messageRoutes = require('../../src/routes/messages');

// A stream that emits its chunks slowly, so "released before finished"
// is observable rather than a race we'd usually win by luck.
function slowStream(chunks, delayMs = 15) {
    let i = 0;
    return new Readable({
        read() {
            setTimeout(() => {
                if (i >= chunks.length) this.push(null);
                else this.push(chunks[i++]);
            }, delayMs);
        }
    });
}

// Records *whether the source stream had ended* at the moment the
// connection went back to the pool. That's the actual guarantee, and it
// doesn't depend on how inject() interleaves with the response lifecycle.
function makeTrackingPool({ download }) {
    const state = { streamEnded: false, releasedWhileStreaming: null, released: false };
    const client = {
        authenticated: true,
        usable: true,
        download,
        async getMailboxLock() {
            return { release() {} };
        }
    };
    const note = () => {
        state.released = true;
        if (state.releasedWhileStreaming === null) {
            state.releasedWhileStreaming = !state.streamEnded;
        }
    };
    return {
        state,
        pool: {
            async acquire() { return client; },
            release: note,
            discard: note
        }
    };
}

// Give the release callback a turn to run.
const settle = () => new Promise((r) => setTimeout(r, 50));

// These must run over a real socket. app.inject() buffers the whole body
// before resolving, so the stream has always ended by the time the pool is
// touched and the ordering bug is invisible — a test built on inject()
// passes with or without the fix.
async function listen(app) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address();
    return `http://127.0.0.1:${port}`;
}

async function buildApp(pool) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        reply.code(status).send(err.problem || { title: err.message, status });
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(messageRoutes, { pool });
    return app;
}

test('raw download: connection is not released until the body is fully written', async () => {
    const chunks = [Buffer.from('From: a@b.c\r\n'), Buffer.from('Subject: hi\r\n'), Buffer.from('\r\nbody')];
    let tracker;
    tracker = makeTrackingPool({
        async download() {
            const st = slowStream(chunks);
            st.on('end', () => { tracker.state.streamEnded = true; });
            return { content: st, meta: {} };
        }
    });
    const app = await buildApp(tracker.pool);
    try {
        const base = await listen(app);
        const res = await fetch(`${base}/v1/mailboxes/INBOX/messages/5/raw`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'From: a@b.c\r\nSubject: hi\r\n\r\nbody');
        await settle();
        assert.equal(tracker.state.released, true, 'connection must be returned to the pool');
        assert.equal(tracker.state.releasedWhileStreaming, false,
            'connection was released before the FETCH literal finished');
    } finally { await app.close(); }
});

test('attachment download: full payload survives a slow stream', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x41);
    const chunks = [payload.subarray(0, 20000), payload.subarray(20000, 50000), payload.subarray(50000)];
    let tracker;
    tracker = makeTrackingPool({
        async download() {
            const st = slowStream(chunks);
            st.on('end', () => { tracker.state.streamEnded = true; });
            return { content: st, meta: { contentType: 'application/pdf', filename: 'a.pdf' } };
        }
    });
    const app = await buildApp(tracker.pool);
    try {
        const base = await listen(app);
        const res = await fetch(`${base}/v1/mailboxes/INBOX/messages/5/attachments/2`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/pdf');
        // A connection recycled mid-literal is how downloads get truncated;
        // assert we got every byte.
        const got = Buffer.from(await res.arrayBuffer());
        assert.equal(got.length, payload.length);
        await settle();
        assert.equal(tracker.state.releasedWhileStreaming, false,
            'connection was released before the FETCH literal finished');
    } finally { await app.close(); }
});

test('raw download: a missing message still releases the connection', async () => {
    const tracker = makeTrackingPool({
        async download() { return null; }
    });
    const app = await buildApp(tracker.pool);
    try {
        const base = await listen(app);
        const res = await fetch(`${base}/v1/mailboxes/INBOX/messages/9/raw`);
        assert.equal(res.status, 404);
        await settle();
        assert.equal(tracker.state.released, true,
            'connection must go back to the pool even on the error path');
    } finally { await app.close(); }
});
