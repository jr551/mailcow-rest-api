import type { Mailbox, SendAttachment } from './api';

export type ComposeDraftInput = {
    from: string;
    fromName?: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    html: string;
    text: string;
    inReplyTo?: string;
    attachments?: SendAttachment[];
};

const MAX_SUBJECT_LEN = 998;
const MAX_ADDR_LEN = 320;

function stripCrlf(s: string): string {
    return s.replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeAddrList(list: string[] | undefined): string[] {
    if (!list?.length) return [];
    return list
        .map((a) => stripCrlf(a))
        .filter(Boolean)
        .slice(0, 50)
        .map((a) => (a.length > MAX_ADDR_LEN ? a.slice(0, MAX_ADDR_LEN) : a));
}

export function resolveDraftsMailboxPath(mailboxes: Mailbox[]): string {
    const special = mailboxes.find((m) => m.specialUse === '\\Drafts');
    if (special?.path) return special.path;
    const named = mailboxes.find((m) => /^drafts(\s|$)/i.test(m.name));
    if (named?.path) return named.path;
    return 'Drafts';
}

export function composeDraftHasContent(input: {
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
}): boolean {
    if (input.to?.trim()) return true;
    if (input.subject?.trim()) return true;
    if (input.text?.trim()) return true;
    const plain = (input.html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    return plain.length > 0;
}

function formatFromHeader(from: string, fromName?: string): string {
    const addr = stripCrlf(from);
    if (!addr) return '';
    const name = fromName ? stripCrlf(fromName) : '';
    if (!name) return addr;
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}" <${addr}>`;
}

function formatAddressList(list: string[]): string {
    return list.join(', ');
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
}

function chunkBase64(b64: string, lineLen = 76): string {
    const lines: string[] = [];
    for (let i = 0; i < b64.length; i += lineLen) lines.push(b64.slice(i, i + lineLen));
    return lines.join('\r\n');
}

function buildAttachmentPart(att: SendAttachment, boundary: string): string {
    const filename = stripCrlf(att.filename || 'attachment').replace(/"/g, "'");
    const type = att.contentType || 'application/octet-stream';
    const raw = att.content || '';
    let b64 = raw;
    try {
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
            b64 = encodeBase64(new TextEncoder().encode(raw));
        } else {
            b64 = raw.replace(/\s/g, '');
        }
    } catch {
        b64 = '';
    }
    return [
        `--${boundary}`,
        `Content-Type: ${type}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        chunkBase64(b64),
        ''
    ].join('\r\n');
}

/** Build RFC822 bytes for IMAP APPEND into Drafts (\\Draft flag applied by caller). */
export function buildComposeDraftRfc822(input: ComposeDraftInput, now = Date.now()): Uint8Array {
    const from = stripCrlf(input.from);
    const subject = stripCrlf(input.subject || '(no subject)').slice(0, MAX_SUBJECT_LEN);
    const to = sanitizeAddrList(input.to);
    const cc = sanitizeAddrList(input.cc);
    const bcc = sanitizeAddrList(input.bcc);
    const text = input.text || '';
    const html = input.html || '<p></p>';
    const date = new Date(now).toUTCString();
    const domain = from.includes('@') ? from.split('@')[1]! : 'webmail.local';
    const messageId = `<webmail-draft-${now}-${Math.random().toString(36).slice(2, 10)}@${domain}>`;

    const altBoundary = `alt_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const mixedBoundary = `mix_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const attachments = (input.attachments || []).slice(0, 20);

    const altBody = [
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        text,
        '',
        `--${altBoundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        '',
        `--${altBoundary}--`,
        ''
    ].join('\r\n');

    let bodyPart: string;
    let contentType: string;
    if (attachments.length) {
        const parts = [
            `--${mixedBoundary}`,
            `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
            '',
            altBody,
            ...attachments.map((a) => buildAttachmentPart(a, mixedBoundary)),
            `--${mixedBoundary}--`,
            ''
        ];
        bodyPart = parts.join('\r\n');
        contentType = `multipart/mixed; boundary="${mixedBoundary}"`;
    } else {
        bodyPart = altBody;
        contentType = `multipart/alternative; boundary="${altBoundary}"`;
    }

    const headers = [
        `Date: ${date}`,
        from ? `From: ${formatFromHeader(from, input.fromName)}` : undefined,
        to.length ? `To: ${formatAddressList(to)}` : 'To: undisclosed-recipients:;',
        cc.length ? `Cc: ${formatAddressList(cc)}` : undefined,
        bcc.length ? `Bcc: ${formatAddressList(bcc)}` : undefined,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
        input.inReplyTo ? `In-Reply-To: ${stripCrlf(input.inReplyTo)}` : undefined,
        'MIME-Version: 1.0',
        `Content-Type: ${contentType}`,
        ''
    ].filter(Boolean) as string[];

    const raw = headers.join('\r\n') + '\r\n' + bodyPart;
    return new TextEncoder().encode(raw);
}
