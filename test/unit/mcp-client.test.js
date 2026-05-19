'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const { RestClient } = require('../../src/mcp/client');

function withMockAgent(fn) {
    return async () => {
        const original = getGlobalDispatcher();
        const agent = new MockAgent();
        agent.disableNetConnect();
        setGlobalDispatcher(agent);
        try {
            await fn(agent);
        } finally {
            setGlobalDispatcher(original);
            await agent.close();
        }
    };
}

const baseOpts = { baseUrl: 'http://imap-rest:3001', user: 'u@x.com', pass: 'pw' };

test('constructor rejects missing baseUrl', () => {
    assert.throws(() => new RestClient({ user: 'u', pass: 'p' }), /baseUrl/);
});

test('constructor rejects missing user/pass', () => {
    assert.throws(() => new RestClient({ baseUrl: 'http://x', user: 'u' }), /user and pass/);
});

test('constructor strips trailing slash from baseUrl', () => {
    const c = new RestClient({ baseUrl: 'http://x/', user: 'u', pass: 'p' });
    assert.equal(c.baseUrl, 'http://x');
});

test('listMailboxes sends Basic Auth and returns parsed JSON', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    const expected = [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], specialUse: null, subscribed: true }];
    pool.intercept({
        path: '/v1/mailboxes',
        method: 'GET',
        headers: (h) => h.authorization === 'Basic ' + Buffer.from('u@x.com:pw').toString('base64')
    }).reply(200, expected);

    const c = new RestClient(baseOpts);
    const res = await c.listMailboxes();
    assert.deepEqual(res, expected);
}));

test('listMessages encodes path and forwards query params', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/Archive%2F2026/messages?page=1&pageSize=10&search=invoice',
        method: 'GET'
    }).reply(200, { messages: [] });

    const c = new RestClient(baseOpts);
    const res = await c.listMessages('Archive/2026', { page: 1, pageSize: 10, search: 'invoice' });
    assert.deepEqual(res, { messages: [] });
}));

test('createMailbox sends JSON body', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes',
        method: 'POST',
        body: JSON.stringify({ path: 'Archive' })
    }).reply(201, { path: 'Archive' });

    const c = new RestClient(baseOpts);
    const res = await c.createMailbox('Archive');
    assert.deepEqual(res, { path: 'Archive' });
}));

test('ocrAttachment with format=text uses text/plain accept and returns string', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/INBOX/messages/42/attachments/2/text',
        method: 'GET',
        headers: (h) => h.accept === 'text/plain'
    }).reply(200, '# Hello world', { headers: { 'content-type': 'text/plain; charset=utf-8' } });

    const c = new RestClient(baseOpts);
    const res = await c.ocrAttachment('INBOX', 42, '2', { format: 'text' });
    assert.equal(res, '# Hello world');
}));

test('ocrAttachment with format=json uses application/json and returns object', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/INBOX/messages/42/attachments/2/text?format=json',
        method: 'GET'
    }).reply(200, { model: 'mistral-ocr-latest', pages: [{ markdown: 'x' }] });

    const c = new RestClient(baseOpts);
    const res = await c.ocrAttachment('INBOX', 42, '2', { format: 'json' });
    assert.equal(res.model, 'mistral-ocr-latest');
    assert.equal(res.pages.length, 1);
}));

test('error responses surface status, method, path, and detail', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({ path: '/v1/mailboxes', method: 'GET' })
        .reply(401, { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid credentials' });

    const c = new RestClient(baseOpts);
    await assert.rejects(() => c.listMailboxes(), (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.method, 'GET');
        assert.equal(err.path, '/v1/mailboxes');
        assert.equal(err.message, 'Invalid credentials');
        return true;
    });
}));

test('204 No Content returns null', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({ path: '/v1/mailboxes/INBOX/messages/42', method: 'DELETE' }).reply(204, '');

    const c = new RestClient(baseOpts);
    const res = await c.deleteMessage('INBOX', 42);
    assert.equal(res, null);
}));

test('flagMessage sends ops body', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/INBOX/messages/42/flags',
        method: 'PUT',
        body: JSON.stringify({ add: ['\\Seen'] })
    }).reply(200, { uid: 42, flags: ['\\Seen'] });

    const c = new RestClient(baseOpts);
    const res = await c.flagMessage('INBOX', 42, { add: ['\\Seen'] });
    assert.deepEqual(res, { uid: 42, flags: ['\\Seen'] });
}));

// Nested path encoding coverage

test('getMessage encodes nested path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild/messages/42',
        method: 'GET'
    }).reply(200, { uid: 42 });

    const c = new RestClient(baseOpts);
    const res = await c.getMessage('parent/child', 42);
    assert.deepEqual(res, { uid: 42 });
}));

test('ocrAttachment encodes nested path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild/messages/42/attachments/3/text',
        method: 'GET',
        headers: (h) => h.accept === 'text/plain'
    }).reply(200, 'ocr text', { headers: { 'content-type': 'text/plain' } });

    const c = new RestClient(baseOpts);
    const res = await c.ocrAttachment('parent/child', 42, '3');
    assert.equal(res, 'ocr text');
}));

test('deleteMailbox encodes nested path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild',
        method: 'DELETE'
    }).reply(204, '');

    const c = new RestClient(baseOpts);
    const res = await c.deleteMailbox('parent/child');
    assert.equal(res, null);
}));

test('renameMailbox encodes nested path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild',
        method: 'PUT',
        body: JSON.stringify({ newPath: 'parent/renamed' })
    }).reply(200, { path: 'parent/renamed' });

    const c = new RestClient(baseOpts);
    const res = await c.renameMailbox('parent/child', 'parent/renamed');
    assert.deepEqual(res, { path: 'parent/renamed' });
}));

test('moveMessage encodes nested source path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild/messages/42/move',
        method: 'PUT',
        body: JSON.stringify({ path: 'other/nested' })
    }).reply(200, { uid: 42, path: 'other/nested', destUid: 99 });

    const c = new RestClient(baseOpts);
    const res = await c.moveMessage('parent/child', 42, 'other/nested');
    assert.deepEqual(res, { uid: 42, path: 'other/nested', destUid: 99 });
}));

test('deleteMessage encodes nested path', withMockAgent(async (agent) => {
    const pool = agent.get('http://imap-rest:3001');
    pool.intercept({
        path: '/v1/mailboxes/parent%2Fchild/messages/42',
        method: 'DELETE'
    }).reply(204, '');

    const c = new RestClient(baseOpts);
    const res = await c.deleteMessage('parent/child', 42);
    assert.equal(res, null);
}));
