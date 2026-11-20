'use strict';

// web-push 4 is ESM-only, so require() returns a read-only module namespace
// and tests can no longer assign sendNotification on it. Swap the cache entry
// for a mutable copy before src/ modules require web-push: they then capture
// the copy that a test can stub.
//
// Call this before requiring src/push-sender (or anything that requires it).
let mutable = null;

function mutableWebPush() {
    if (mutable) return mutable;
    const real = require('web-push');
    const cached = require.cache[require.resolve('web-push')];
    mutable = { ...real };
    if (cached) cached.exports = mutable;
    return mutable;
}

module.exports = { mutableWebPush };
