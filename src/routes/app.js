'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function appRoutes(app, opts) {
    const distDir = opts.distDir || '/app/dist/android';
    const versionFile = path.join(distDir, 'version.json');
    const apkFile = path.join(distDir, 'imap-rest.apk');

    app.get('/v1/app/android/version.json', {
        schema: {
            tags: ['app'],
            summary: 'Android app version metadata',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        version: { type: 'string' },
                        sha: { type: 'string' },
                        builtAt: { type: 'string' },
                        minHostVersion: { type: 'string' }
                    }
                }
            }
        }
    }, async () => {
        if (!fs.existsSync(versionFile)) {
            throw app.httpErrors.notFound('Android app not built into this image');
        }
        const raw = await fs.promises.readFile(versionFile, 'utf8');
        return JSON.parse(raw);
    });

    app.get('/v1/app/android.apk', {
        schema: {
            tags: ['app'],
            summary: 'Download the Android APK'
        }
    }, async (req, reply) => {
        if (!fs.existsSync(apkFile) || !fs.existsSync(versionFile)) {
            throw app.httpErrors.notFound('Android APK not built into this image');
        }
        const meta = JSON.parse(await fs.promises.readFile(versionFile, 'utf8'));
        const stat = await fs.promises.stat(apkFile);
        reply
            .header('Content-Type', 'application/vnd.android.package-archive')
            .header('Content-Disposition', `attachment; filename="imap-rest-${meta.version}.apk"`)
            .header('Content-Length', stat.size)
            .header('Cache-Control', 'public, max-age=3600');
        return fs.createReadStream(apkFile);
    });
}

module.exports = appRoutes;
