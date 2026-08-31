// Browser-side OCR via tesseract.js. Lazy-loaded singleton worker so the
// ~3 MB WASM core only downloads when the user opts in. Lang data is
// cached in IndexedDB by tesseract for the life of the origin.
//
// All OCR happens IN-BROWSER — image bytes never leave the user's machine.
// That's the whole point of using tesseract over a hosted OCR API for
// inline phishing-scan augmentation.

type AnyWorker = {
    recognize: (img: Blob | string) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<void>;
};

let workerPromise: Promise<AnyWorker> | null = null;
let warmedUp = false;
// Self-disable after a couple of hard failures so a misconfigured
// production deploy (missing WASM variants etc.) doesn't keep
// throwing in the user's face on every scan.
let failureCount = 0;
const MAX_FAILURES = 2;
function disabledForSession(): boolean { return failureCount >= MAX_FAILURES; }

async function buildWorker(): Promise<AnyWorker> {
    const Tesseract = await import('tesseract.js');
    const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
    // createWorker returns a typed worker object — `any` here keeps the
    // dynamic-import type-graph from leaking generics into call sites.
    const worker = await (Tesseract as unknown as {
        createWorker: (
            lang: string,
            oem: number,
            opts: Record<string, unknown>
        ) => Promise<AnyWorker>;
    }).createWorker('eng', 1, {
        workerPath: `${base}/tesseract/worker.min.js`,
        corePath: `${base}/tesseract/`,
        // Lang data: tesseract downloads it from the default tessdata
        // CDN on first use and caches in IndexedDB. We don't ship the
        // 15-MB eng.traineddata in our build to keep cold-start fast.
        cacheMethod: 'write'
    });
    warmedUp = true;
    return worker;
}

/** Load + initialize the OCR worker (no-op if already loaded). Call this
 *  from the settings toggle so the user pays the download cost up front,
 *  not the first time they open a phishy email. */
export async function warmupTesseract(): Promise<void> {
    if (!workerPromise) workerPromise = buildWorker();
    await workerPromise;
}

export function isTesseractWarm(): boolean {
    return warmedUp;
}

/** Terminate the worker and free its memory. Call this when the user
 *  disables the OCR feature in Settings. */
export async function teardownTesseract(): Promise<void> {
    const p = workerPromise;
    workerPromise = null;
    warmedUp = false;
    if (!p) return;
    try {
        const w = await p;
        await w.terminate();
    } catch { /* noop */ }
}

/** OCR a single image (URL or Blob). Returns trimmed text, or '' on
 *  failure. Honours an optional AbortSignal — cancellation surfaces as
 *  '' rather than throw, so the caller can keep scanning the rest.
 *
 *  Errors from tesseract.js (worker importScripts failures, decoder
 *  errors) are caught + counted. After MAX_FAILURES we self-disable
 *  for the rest of the session so we don't repeatedly throw the same
 *  error into the page's global handler. */
export async function ocrImage(
    img: Blob | string,
    opts: { signal?: AbortSignal } = {}
): Promise<string> {
    if (opts.signal?.aborted) return '';
    if (disabledForSession()) return '';
    if (!workerPromise) {
        try {
            workerPromise = buildWorker();
        } catch {
            failureCount++;
            return '';
        }
    }
    let worker: AnyWorker;
    try {
        worker = await workerPromise;
    } catch {
        failureCount++;
        // Reset so a future call gets a fresh worker attempt rather
        // than reusing a permanently-rejected promise.
        workerPromise = null;
        return '';
    }
    if (opts.signal?.aborted) return '';
    try {
        const { data } = await worker.recognize(img);
        return (data?.text || '').trim();
    } catch {
        failureCount++;
        return '';
    }
}
