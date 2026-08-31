import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const devApiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:3001';

// Stamp a fresh cache version into the service worker on every build.
//
// The version used to be a hand-edited constant, so any deploy that didn't
// happen to touch sw.js produced a byte-identical worker: the browser saw
// no update, `updatefound` never fired, the update prompt never appeared,
// and installed PWAs kept booting the previous build's cached shell
// indefinitely. Deriving it from the built output makes "new build" and
// "new worker" the same event.
function swBuildVersion(): Plugin {
    let outDir = 'dist';
    let assetNames: string[] = [];
    return {
        name: 'sw-build-version',
        apply: 'build',
        configResolved(cfg) {
            outDir = cfg.build.outDir;
        },
        generateBundle(_options, bundle) {
            // public/ files are copied straight to outDir and never enter
            // the bundle, so sw.js has to be patched on disk afterwards.
            // Capture the hashed names here, where we can still see them.
            assetNames = Object.keys(bundle).sort();
        },
        writeBundle() {
            const swPath = resolve(__dirname, outDir, 'sw.js');
            if (!existsSync(swPath)) return;
            const id = createHash('sha256').update(assetNames.join('\n')).digest('hex').slice(0, 12);
            const src = readFileSync(swPath, 'utf8');
            if (!src.includes('__BUILD_VERSION__')) return;
            writeFileSync(swPath, src.replace('__BUILD_VERSION__', id));
        }
    };
}

// Built assets are served as static files under /webmail/ by the API's Fastify
// server (@fastify/static). `base` makes Vite emit asset URLs prefixed with /webmail/.
export default defineConfig({
    plugins: [svelte(), swBuildVersion()],
    base: '/webmail/',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: false,
        cssCodeSplit: false,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                mobile: resolve(__dirname, 'mobile/index.html'),
            },
            output: {
                // Heavy, feature-gated libraries (PDF rendering/editing, the
                // drawing pad, OCR) must never get folded into a chunk that
                // both entry points load eagerly. Naming them explicitly
                // keeps them isolated even if a future static import
                // accidentally makes them "shared" between main and mobile.
                manualChunks: {
                    pdf: ['pdfjs-dist', 'pdf-lib'],
                    tldraw: ['tldraw', '@tiptap/core', '@tiptap/starter-kit'],
                    tesseract: ['tesseract.js'],
                },
            },
        },
    },
    server: {
        port: 5173,
        // Dev mode proxies API calls to a local API server by default.
        proxy: {
            '/v1': { target: devApiTarget, changeOrigin: true, secure: false },
            '/openapi.json': { target: devApiTarget, changeOrigin: true, secure: false },
            '/health': { target: devApiTarget, changeOrigin: true, secure: false },
            '/imap-rest': { target: devApiTarget, changeOrigin: true, secure: false }
        }
    }
});
