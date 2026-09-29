// Turns a message's From address into the two sender-block patterns the
// context menu offers alongside "Block sender":
//
//   Block domain       *@sub.example.co.uk   (everything at one host)
//   Block root domain  *@example.co.uk        (everything the registrant owns)
//
// Both are mailcow `filterconf` blacklist_from values, which rspamd matches as
// patterns — `*` is a wildcard, and the server's isValidSenderPattern
// (/^[a-zA-Z0-9@_.*-]+$/) accepts exactly this shape. `*@` + host matches every
// local part at that host, which is the "block this whole sender" gesture.
//
// WHY A HEURISTIC AND NOT THE PUBLIC SUFFIX LIST
//
// The correct root domain is "one label under the public suffix", and the
// public suffix list is ~9,000 entries (github.io, s3.amazonaws.com, the
// whole .co.uk/.com.au/.org.uk set, every ccTLD with an embedded second level
// …). Shipping that list is a dependency or a generated blob; neither is
// worth it for a menu item. Instead this file hard-cases the suffixes that
// actually show up in spam — a small, boring, correct-for-the-common-case
// table — and falls back to "last two labels" for everything else.
//
// The consequences, stated honestly:
//   - A suffix missing from the table gives a root domain one level TOO HIGH.
//     `x.user.foo.jp` (jp is a public suffix) would be reduced to `foo.jp`,
//     blocking every site hosted under foo.jp. Wrong, but only ever wrong in
//     the "blocks more than you asked for" direction, and the confirm dialog
//     names the pattern, so the user sees it before it is applied.
//   - An entry in the table that is NOT a real public suffix narrows the root
//     instead. `s3.amazonaws.com` is listed because it is the one that
//     matters in practice; the hosting platforms (github.io, blogspot.com)
//     have the same shape and the same caveat.
//   - A registrable domain that IS itself a public suffix (`github.io` has no
//     domain registered under it) has no root to strip, so the helper returns
//     null and the caller hides the option rather than offering a pattern
//     that would swallow unrelated people's mail.
//
// Public and private suffixes go in the same table on purpose: keeping them
// apart needs the PSL's ICANN / PRIVATE sections, which is exactly the
// distinction this heuristic gives up.
//
// Not a "block everything" helper: blocking a host the user can't undo from
// this menu is their decision, made with the pattern on screen.

/**
 * Multi-label public suffixes worth special-casing, plus the private
 * suffixes (hosting platforms) a spammer rotates through. Membership test is
 * "does the host end with this key"; the longest match wins, so
 * `a.user.github.io` reduces past `io` to `github.io` and `a.b.co.uk` reduces
 * past `uk` to `co.uk`.
 */
const MULTI_LABEL_SUFFIXES: Record<string, true> = {
    // ccTLDs with a mandatory second level — the ones that make naive
    // "last two labels" wrong most often.
    'co.uk': true, 'org.uk': true, 'me.uk': true, 'ac.uk': true, 'gov.uk': true,
    'net.uk': true, 'sch.uk': true,
    'com.au': true, 'net.au': true, 'org.au': true, 'edu.au': true, 'gov.au': true,
    'co.nz': true, 'net.nz': true, 'org.nz': true, 'govt.nz': true,
    'co.jp': true, 'or.jp': true, 'ne.jp': true, 'ac.jp': true, 'go.jp': true,
    'co.kr': true, 'or.kr': true, 're.kr': true,
    'com.br': true, 'net.br': true, 'org.br': true, 'gov.br': true,
    'com.cn': true, 'net.cn': true, 'org.cn': true, 'gov.cn': true, 'edu.cn': true,
    'com.mx': true, 'org.mx': true, 'gob.mx': true,
    'com.ar': true, 'net.ar': true, 'org.ar': true,
    'co.in': true, 'net.in': true, 'org.in': true, 'gen.in': true, 'firm.in': true,
    'com.sg': true, 'org.sg': true, 'net.sg': true, 'edu.sg': true,
    'com.tr': true, 'net.tr': true, 'org.tr': true, 'gov.tr': true,
    'com.ua': true, 'net.ua': true, 'org.ua': true,
    'com.pl': true, 'net.pl': true, 'org.pl': true,
    'co.za': true, 'org.za': true, 'net.za': true,
    'com.hk': true, 'org.hk': true, 'net.hk': true,
    'com.tw': true, 'org.tw': true, 'net.tw': true,
    'co.id': true, 'or.id': true, 'web.id': true, 'ac.id': true,
    'com.my': true, 'net.my': true, 'org.my': true,
    'co.th': true, 'in.th': true, 'ac.th': true, 'go.th': true,
    'com.vn': true, 'net.vn': true, 'org.vn': true,
    'com.ph': true, 'net.ph': true, 'org.ph': true,
    'com.sa': true, 'com.eg': true, 'com.pk': true, 'com.bd': true,
    'com.ng': true, 'com.gh': true,
    'co.il': true, 'org.il': true, 'net.il': true, 'ac.il': true,
    // Hosting platforms: a user bucket is a full "domain" to its owner, and
    // a spammer who buys one owns the whole platform entry.
    'github.io': true, 'gitlab.io': true, 'pages.dev': true, 'workers.dev': true,
    'netlify.app': true, 'vercel.app': true, 'herokuapp.com': true,
    'web.app': true, 'firebaseapp.com': true,
    'blogspot.com': true, 'wordpress.com': true, 'tumblr.com': true,
    'wixsite.com': true, 'weebly.com': true, 'githubusercontent.com': true,
    // Cloud object stores: `bucket.s3.amazonaws.com` is per-bucket, not per
    // account, and everything under it belongs to whoever made the bucket.
    's3.amazonaws.com': true, 's3.eu-west-1.amazonaws.com': true,
    's3.us-east-1.amazonaws.com': true,
    'blob.core.windows.net': true, 'cloudfront.net': true
};

/** A bracketed IPv6 host (what a From header would carry) or a dotted-quad
 *  v4 address. Neither has a registrable domain, and "block *@[2001:db8::1]"
 *  is a legal-but-useless pattern, so both are treated as unblockable. */
function isIpLiteral(host: string): boolean {
    if (host.startsWith('[') && host.endsWith(']')) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Normalise the domain part of an address to a lower-case, punycode, fully
 * qualified host with any trailing root dot removed.
 *
 * `new URL('http://' + d)` is the dependency-free way to get all of that: the
 * URL parser does IDNA/ToASCII (so `bücher.example` becomes
 * `xn--bcher-kva.example`, which is what rspamd and the server's pattern
 * charset both expect) and strips a trailing dot. It throws on input it
 * cannot parse, which is exactly the "don't crash, hide the option" case the
 * callers want.
 */
export function normaliseDomain(domain: string): string | null {
    const raw = domain.trim().toLowerCase();
    // Whitespace and the address delimiters mean this was never a bare host
    // (a full address, a display name, an unparseable header) — refuse it
    // rather than letting the URL parser invent something.
    if (!raw || /[\s@,;<>"'\\]/.test(raw)) return null;
    let hostname: string;
    try {
        hostname = new URL(`http://${raw}`).hostname;
    } catch {
        return null;
    }
    // URL keeps a fully-qualified trailing dot; `a@b.com.` and `a@b.com` are
    // the same mail domain and must not become two different patterns.
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    // The URL parser is happy with an empty label (`.com` → `*.com`), but
    // `*@.com` is a pattern rspamd will never match and the server's pattern
    // charset would happily store. Reject an empty label anywhere, which also
    // catches a leading dot.
    if (!host || host.split('.').some((l) => !l)) return null;
    return host;
}

/**
 * The registrable ("root") domain of a host: one label under its public
 * suffix. `sub.example.co.uk` → `example.co.uk`, `user.github.io` →
 * `github.io`, `example.com` → `example.com`.
 *
 * Returns null when there is nothing sensible to return: a bare label with no
 * dot (`localhost`), an IP literal, or a host that is only a public suffix
 * with nothing registered under it.
 */
export function rootDomain(domain: string): string | null {
    const host = normaliseDomain(domain);
    if (!host || isIpLiteral(host) || !host.includes('.')) return null;

    const labels = host.split('.');
    // Longest table suffix that this host ends with, scanning right to left
    // and never consuming the whole host (a 1-label host is not a suffix).
    let suffixLen = 1;
    for (let len = 2; len < labels.length; len++) {
        if (MULTI_LABEL_SUFFIXES[labels.slice(labels.length - len).join('.')]) suffixLen = len;
    }
    // Nothing registered above the suffix (`github.io`, `co.uk`): there is no
    // root to report, and the wider pattern would be the public suffix itself.
    if (labels.length - suffixLen < 1) return null;
    const root = labels.slice(labels.length - suffixLen - 1).join('.');
    // An unlisted suffix degrades to "last two labels", which for a 2-label
    // host (`foo.com`) is the host itself — correct — and for a longer one
    // (`a.b.unknown`) can reduce to a bare TLD. A TLD is not registrable.
    return root.includes('.') ? root : null;
}

/** The full host of an address, or null when it has none worth blocking. */
export function domainOf(address: string | null | undefined): string | null {
    if (!address) return null;
    // Take the LAST @: a local part may legally contain an unquoted @ in
    // mailcow's parser, and the domain is whatever follows the final one.
    const at = address.lastIndexOf('@');
    if (at < 1 || at === address.length - 1) return null;
    const host = normaliseDomain(address.slice(at + 1));
    return host && !isIpLiteral(host) ? host : null;
}

/** `*@` + full host — the "Block domain" pattern. */
export function domainPattern(address: string | null | undefined): string | null {
    const host = domainOf(address);
    return host ? `*@${host}` : null;
}

/**
 * `*@` + registrable domain — the "Block root domain" pattern, for the spam
 * that rotates a new subdomain every time it sends (a.b.example.com today,
 * c.d.example.com tomorrow) where "Block domain" would never catch it.
 *
 * Null when the address has no domain, when it is an IP literal, or when the
 * root is not wider than the host itself (`example.com`, `github.io`): in
 * every one of those cases "Block root domain" would be a duplicate of "Block
 * domain" or a pattern that blocks unrelated people's mail, and the caller
 * should hide the option instead.
 */
export function rootDomainPattern(address: string | null | undefined): string | null {
    const host = domainOf(address);
    if (!host) return null;
    const root = rootDomain(host);
    return root && root !== host ? `*@${root}` : null;
}
