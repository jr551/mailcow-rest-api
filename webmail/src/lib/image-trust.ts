// Quick heuristic — does the HTML reference any remote image source? We
// can't load the iframe just to check; doing it on the raw HTML is good
// enough for the gate. False positives just mean we show the badge;
// false negatives mean we skip it for an email that probably doesn't
// need it (no remote refs to phone home).
export function hasRemoteImages(html: string | null | undefined): boolean {
    if (!html) return false;
    // Strip data: + cid: + relative paths so they don't count.
    return /<img\b[^>]*[\s/]src\s*=\s*["']?(?:https?:)?\/\//i.test(html)
        || /\b(?:background|poster)\s*=\s*["']?(?:https?:)?\/\//i.test(html)
        || /\bbackground(?:-image)?\s*:\s*url\(\s*["']?(?:https?:)?\/\//i.test(html);
}
