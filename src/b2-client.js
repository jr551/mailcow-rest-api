'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

class B2Client {
    constructor({ keyId, applicationKey, logger }) {
        this.keyId = keyId;
        this.applicationKey = applicationKey;
        this.logger = logger || { info: () => {}, warn: () => {}, error: () => {} };
        this.auth = null;
        this.authExpiresAt = 0;
    }

    async _request(url, opts = {}) {
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const body = opts.body ? JSON.stringify(opts.body) : undefined;
        const headers = {
            ...(opts.headers || {}),
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {})
        };

        return new Promise((resolve, reject) => {
            const req = client.request(
                parsed,
                { method: opts.method || 'GET', headers },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const parsedData = JSON.parse(data);
                            if (res.statusCode >= 400) {
                                const err = new Error(parsedData.message || `B2 API error ${res.statusCode}`);
                                (err).statusCode = res.statusCode;
                                (err).code = parsedData.code;
                                reject(err);
                            } else {
                                resolve(parsedData);
                            }
                        } catch {
                            resolve(data);
                        }
                    });
                }
            );
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    async authorize() {
        // Reuse existing auth if not expired (with 5 min buffer)
        if (this.auth && this.authExpiresAt > Date.now() + 5 * 60 * 1000) {
            return this.auth;
        }
        const credentials = Buffer.from(`${this.keyId}:${this.applicationKey}`).toString('base64');
        const res = await this._request('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
            headers: { authorization: `Basic ${credentials}` }
        });
        // B2 v3 nests apiUrl inside apiInfo.storageApi
        res.apiUrl = res.apiUrl || res.apiInfo?.storageApi?.apiUrl;
        res.s3ApiUrl = res.s3ApiUrl || res.apiInfo?.storageApi?.s3ApiUrl;
        this.auth = res;
        // Auth tokens are valid for 24h; back off a bit.
        this.authExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
        this.logger.info({ accountId: res.accountId }, 'B2 authorized');
        return res;
    }

    async listBuckets() {
        const auth = await this.authorize();
        return this._request(`${auth.apiUrl}/b2api/v3/b2_list_buckets`, {
            method: 'POST',
            headers: { authorization: auth.authorizationToken },
            body: { accountId: auth.accountId }
        });
    }

    async createBucket(bucketName) {
        const auth = await this.authorize();
        const res = await this._request(`${auth.apiUrl}/b2api/v3/b2_create_bucket`, {
            method: 'POST',
            headers: { authorization: auth.authorizationToken },
            body: {
                accountId: auth.accountId,
                bucketName,
                bucketType: 'allPrivate'
            }
        });
        this.logger.info({ bucketName, bucketId: res.bucketId }, 'B2 bucket created');
        return res;
    }

    async createKey({ keyName, capabilities, bucketId }) {
        const auth = await this.authorize();
        const body = {
            accountId: auth.accountId,
            keyName,
            capabilities: capabilities || ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles']
        };
        if (bucketId) body.bucketId = bucketId;
        const res = await this._request(`${auth.apiUrl}/b2api/v3/b2_create_key`, {
            method: 'POST',
            headers: { authorization: auth.authorizationToken },
            body
        });
        this.logger.info({ keyName, bucketId }, 'B2 key created');
        return res;
    }

    async deleteKey(applicationKeyId) {
        const auth = await this.authorize();
        return this._request(`${auth.apiUrl}/b2api/v3/b2_delete_key`, {
            method: 'POST',
            headers: { authorization: auth.authorizationToken },
            body: { applicationKeyId }
        });
    }

    async listFileNames(bucketId, prefix = '', startFileName = '', maxFileCount = 1000) {
        const auth = await this.authorize();
        return this._request(`${auth.apiUrl}/b2api/v3/b2_list_file_names`, {
            method: 'POST',
            headers: { authorization: auth.authorizationToken },
            body: { bucketId, prefix, startFileName, maxFileCount }
        });
    }

    async getBucketUsage(bucketId) {
        let totalBytes = 0;
        let startFileName = '';
        // Paginate through all files and sum contentLength
        while (true) {
            const res = await this.listFileNames(bucketId, '', startFileName, 1000);
            const files = res.files || [];
            for (const f of files) {
                totalBytes += f.contentLength || 0;
            }
            if (!res.nextFileName || files.length === 0) break;
            startFileName = res.nextFileName;
        }
        return totalBytes;
    }

    async getS3Endpoint() {
        const auth = await this.authorize();
        // B2 auth response includes s3ApiUrl, e.g. https://s3.us-west-002.backblazeb2.com
        const s3Url = auth.s3ApiUrl || auth.apiUrl?.replace(/^https:\/\/api\./, 'https://s3.');
        const regionMatch = s3Url?.match(/s3\.([^.]+)\.backblazeb2\.com/);
        const region = regionMatch ? regionMatch[1] : 'us-west-000';
        return { endpoint: s3Url, region };
    }
}

module.exports = { B2Client };
