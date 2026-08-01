'use strict';

const { B2Client } = require('../b2-client');
const { DriveUserStore } = require('../drive-user-store');
const { problem, notFound } = require('../errors');
const config = require('../config');

// Origins the browser will load the webmail from. Without at least one,
// a provisioned bucket is unreachable from the SPA. Operators set
// DRIVE_CORS_ORIGINS (comma-separated); PUBLIC_BASE_URL is used as a
// sensible fallback so a standard deployment works untouched.
function driveCorsOrigins() {
    const raw = config.s3.corsOrigins;
    return raw
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter((o) => /^https?:\/\//i.test(o));
}

function sanitizeBucketName(email) {
    // B2 bucket names: 6-50 chars, alphanumeric and hyphens only, must start with letter/number
    const local = email.split('@')[0].toLowerCase();
    const domain = email.split('@')[1]?.replace(/\./g, '-') || 'user';
    const base = `imr-${domain}-${local}`;
    return base.replace(/[^a-z0-9-]/g, '-').slice(0, 50).replace(/^-+/, 'a');
}

module.exports = async function driveRoutes(app, opts) {
    const s3 = opts.s3;
    const logger = opts.logger || app.log;

    let b2Client = null;
    let userStore = null;
    const quotaCache = new Map(); // email -> { used, total, expiresAt }

    if (s3.enabled && s3.provider === 'b2') {
        if (s3.b2.keyId && s3.b2.applicationKey) {
            b2Client = new B2Client({
                keyId: s3.b2.keyId,
                applicationKey: s3.b2.applicationKey,
                logger
            });
        } else {
            logger.warn('S3_DRIVE_PROVIDER=b2 but B2_KEY_ID or B2_APPLICATION_KEY missing');
        }
        userStore = new DriveUserStore(s3.filePath);
    }

    async function getCachedQuota(email, bucketId) {
        const now = Date.now();
        const cached = quotaCache.get(email);
        if (cached && cached.expiresAt > now) {
            return { used: cached.used, total: cached.total };
        }
        if (!b2Client || !bucketId) {
            return { used: 0, total: s3.defaultQuotaGb * 1024 * 1024 * 1024 };
        }
        try {
            const used = await b2Client.getBucketUsage(bucketId);
            const total = s3.defaultQuotaGb * 1024 * 1024 * 1024;
            quotaCache.set(email, { used, total, expiresAt: now + 2 * 60 * 1000 });
            return { used, total };
        } catch (err) {
            logger.warn({ err: err.message, email }, 'Failed to get bucket usage');
            return { used: 0, total: s3.defaultQuotaGb * 1024 * 1024 * 1024 };
        }
    }

    async function getOrProvisionB2User(email) {
        const existing = userStore.get(email);
        if (existing) return existing;

        if (!b2Client) {
            throw problem(500, 'Server Error', 'B2 drive not configured');
        }

        // Ensure bucket exists, with CORS rules. The browser talks to B2
        // directly, so a bucket without them is one the user can never
        // open — the preflight is refused and Drive shows only "Failed to
        // fetch". Existing buckets get topped up, since anything created
        // before this had no rules at all.
        const bucketName = sanitizeBucketName(email);
        const corsOrigins = driveCorsOrigins();
        let bucketId;
        try {
            const list = await b2Client.listBuckets();
            const found = list.buckets?.find((b) => b.bucketName === bucketName);
            if (found) {
                bucketId = found.bucketId;
                if (corsOrigins.length && !(found.corsRules || []).length) {
                    try {
                        await b2Client.ensureCors(bucketId, corsOrigins);
                        logger.info({ bucketName, corsOrigins }, 'B2 CORS rules added to existing bucket');
                    } catch (err) {
                        logger.warn({ err: err.message, bucketName }, 'B2 CORS update failed');
                    }
                }
            } else {
                const created = await b2Client.createBucket(bucketName, { corsOrigins });
                bucketId = created.bucketId;
            }
        } catch (err) {
            logger.warn({ err: err.message, bucketName }, 'B2 bucket provisioning failed');
            throw err;
        }

        // Create a user-scoped application key
        let key;
        try {
            key = await b2Client.createKey({
                keyName: `imr-${bucketName}`,
                bucketId,
                capabilities: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles']
            });
        } catch (err) {
            logger.warn({ err: err.message, bucketName }, 'B2 key creation failed');
            throw err;
        }

        const s3Info = await b2Client.getS3Endpoint();
        const cfg = {
            endpoint: s3Info.endpoint,
            region: s3Info.region,
            bucket: bucketName,
            bucketId,
            prefix: '',
            publicUrl: `${s3Info.endpoint}/${bucketName}`,
            credentials: {
                accessKeyId: key.applicationKeyId,
                secretAccessKey: key.applicationKey
            }
        };

        userStore.set(email, cfg);
        logger.info({ email, bucketName }, 'B2 drive provisioned');
        return cfg;
    }

    app.get('/v1/drive/config', {
        schema: {
            tags: ['drive'],
            summary: 'S3 drive configuration for the authenticated user',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        endpoint: { type: 'string' },
                        region: { type: 'string' },
                        bucket: { type: 'string' },
                        prefix: { type: 'string' },
                        publicUrl: { type: 'string' },
                        credentials: {
                            type: 'object',
                            properties: {
                                accessKeyId: { type: 'string' },
                                secretAccessKey: { type: 'string' }
                            }
                        }
                    }
                }
            }
        }
    }, async (req) => {
        if (!s3.enabled) {
            throw notFound('S3 drive is not enabled');
        }

        let userCfg;
        if (s3.provider === 'b2') {
            userCfg = await getOrProvisionB2User(req.creds.user);
        } else {
            userCfg = s3.users[req.creds.user.toLowerCase()];
        }

        if (!userCfg) {
            throw notFound('No drive configuration for this user');
        }

        return {
            enabled: true,
            endpoint: userCfg.endpoint,
            region: userCfg.region,
            bucket: userCfg.bucket,
            prefix: userCfg.prefix,
            publicUrl: userCfg.publicUrl,
            credentials: {
                accessKeyId: userCfg.credentials.accessKeyId,
                secretAccessKey: userCfg.credentials.secretAccessKey
            }
        };
    });

    app.get('/v1/drive/quota', {
        schema: {
            tags: ['drive'],
            summary: 'Drive storage quota and usage for the authenticated user',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        used: { type: 'number' },
                        total: { type: 'number' }
                    }
                }
            }
        }
    }, async (req) => {
        if (!s3.enabled) {
            throw notFound('S3 drive is not enabled');
        }

        let userCfg;
        if (s3.provider === 'b2') {
            userCfg = await getOrProvisionB2User(req.creds.user);
        } else {
            userCfg = s3.users[req.creds.user.toLowerCase()];
        }

        if (!userCfg) {
            throw notFound('No drive configuration for this user');
        }

        // For B2 we need the bucketId to calculate usage. JSON provider doesn't track bucketId,
        // so we fall back to zero usage for static config.
        const bucketId = userCfg.bucketId || null;
        const quota = await getCachedQuota(req.creds.user.toLowerCase(), bucketId);
        return quota;
    });
};
