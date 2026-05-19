'use strict';

// Helpers for the open-tracking notification email: turn a raw IP + UA
// into a normie-readable summary (country flag emoji, ISP, browser, OS,
// device kind). Geolocation hits ip-api.com (free, no token, 45 r/min)
// and falls back gracefully when offline / rate-limited so the
// notification email always sends, just with less detail.

const { request } = require('undici');

const GEO_TIMEOUT_MS = 3000;

/** Country code ('GB') → flag emoji ('🇬🇧'). Returns '' for non-letter
 *  inputs so the formatter can omit the flag cleanly. */
function flagEmoji(cc) {
    if (typeof cc !== 'string' || !/^[A-Za-z]{2}$/.test(cc)) return '';
    const A = 0x1F1E6 - 0x41;
    const c1 = cc.toUpperCase().charCodeAt(0) + A;
    const c2 = cc.toUpperCase().charCodeAt(1) + A;
    return String.fromCodePoint(c1) + String.fromCodePoint(c2);
}

async function lookupGeo(ip) {
    if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip.startsWith('::1') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return null;
    }
    try {
        const res = await request(
            `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,isp,org,as,mobile,proxy,hosting`,
            { method: 'GET', headersTimeout: GEO_TIMEOUT_MS, bodyTimeout: GEO_TIMEOUT_MS }
        );
        if (res.statusCode !== 200) return null;
        const data = await res.body.json();
        if (data.status !== 'success') return null;
        return data;
    } catch {
        return null;
    }
}

/** Tiny UA parser — covers the common cases without dragging ua-parser-js
 *  in. Returns { browser, os, device } strings (each may be ''). */
function parseUa(ua) {
    if (!ua) return { browser: '', os: '', device: '' };
    const out = { browser: '', os: '', device: '' };

    // Browser
    let m;
    if ((m = ua.match(/Edg\/([\d.]+)/))) out.browser = `Edge ${m[1].split('.')[0]}`;
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) out.browser = `Firefox ${m[1].split('.')[0]}`;
    else if ((m = ua.match(/OPR\/([\d.]+)/))) out.browser = `Opera ${m[1].split('.')[0]}`;
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) out.browser = `Chrome ${m[1].split('.')[0]}`;
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) out.browser = `Safari ${m[1].split('.')[0]}`;
    else if (/AppleWebKit/.test(ua)) out.browser = 'Safari (older)';
    else out.browser = 'Unknown browser';

    // OS
    if ((m = ua.match(/Windows NT (\d+\.\d+)/))) {
        const winMap = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
        out.os = `Windows ${winMap[m[1]] || m[1]}`;
    } else if ((m = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/))) {
        out.os = `macOS ${m[1].replace(/_/g, '.')}`;
    } else if ((m = ua.match(/iPhone OS (\d+_\d+(?:_\d+)?)/))) {
        out.os = `iOS ${m[1].replace(/_/g, '.')}`;
    } else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) {
        out.os = `Android ${m[1]}`;
    } else if (/X11.*Linux/.test(ua)) {
        out.os = 'Linux';
    } else if (/CrOS/.test(ua)) {
        out.os = 'ChromeOS';
    } else {
        out.os = 'Unknown OS';
    }

    // Device hint
    if (/iPhone/.test(ua)) out.device = 'iPhone';
    else if (/iPad/.test(ua)) out.device = 'iPad';
    else if (/Android.*Mobile/.test(ua)) out.device = 'Android phone';
    else if (/Android/.test(ua)) out.device = 'Android tablet';
    else if (/Macintosh/.test(ua)) out.device = 'Mac';
    else if (/Windows/.test(ua)) out.device = 'PC';
    else if (/Linux/.test(ua)) out.device = 'Linux machine';
    else out.device = '';

    return out;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/** Build both plain-text and HTML bodies for the open-tracking email.
 *  Always returns something usable even if geo/UA lookups fail. */
async function buildOpenNotice({ subject, recipient, openedAt, ip, ua }) {
    const geo = await lookupGeo(ip);
    const uaInfo = parseUa(ua || '');
    const openTime = new Date(openedAt).toUTCString();

    const flag = geo ? flagEmoji(geo.countryCode) : '';
    const where = geo
        ? [geo.city, geo.regionName, geo.country].filter(Boolean).join(', ')
        : '';
    const isp = geo?.isp || geo?.org || '';
    const tags = [];
    if (geo?.mobile) tags.push('📱 mobile network');
    if (geo?.proxy) tags.push('🔒 VPN/proxy');
    if (geo?.hosting) tags.push('🏢 datacenter / VPS');

    // Plain-text body — what most mail clients show in the preview.
    const lines = [
        `📬 Your email was opened.`,
        ``,
        `Subject: ${subject}`,
        `Sent to: ${recipient}`,
        `Opened: ${openTime}`,
        ``,
        `Where: ${flag ? flag + ' ' : ''}${where || 'Unknown location'}`
    ];
    if (isp) lines.push(`Network: ${isp}`);
    if (tags.length) lines.push(`Connection: ${tags.join(' · ')}`);
    lines.push('');
    lines.push(`Device: ${uaInfo.device || 'Unknown device'}`);
    lines.push(`OS: ${uaInfo.os}`);
    lines.push(`Browser: ${uaInfo.browser}`);
    lines.push('');
    lines.push(`IP: ${ip}`);
    lines.push(`User-Agent: ${ua || 'unknown'}`);

    // Inline-styled HTML body — most webmail clients (incl. ours) render
    // <style> sparingly, so all styling is per-element. No JS, no remote
    // assets, no link tags.
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7fb;color:#222;padding:24px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:22px 24px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <span style="font-size:24px;">📬</span>
      <h2 style="margin:0;font-size:18px;font-weight:700;letter-spacing:-0.01em;">Your email was opened</h2>
    </div>
    <div style="color:#666;font-size:13px;margin-bottom:18px;">${escapeHtml(openTime)}</div>

    <div style="background:#f4f4fa;border-radius:10px;padding:12px 14px;margin-bottom:14px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:4px;">Subject</div>
      <div style="font-size:15px;font-weight:600;color:#111;">${escapeHtml(subject || '(no subject)')}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">to ${escapeHtml(recipient)}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div style="background:#f4f4fa;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:4px;">Where</div>
        <div style="font-size:15px;font-weight:600;color:#111;">${flag ? flag + '&nbsp;' : ''}${escapeHtml(where || 'Unknown')}</div>
        ${isp ? `<div style="font-size:12px;color:#666;margin-top:4px;">${escapeHtml(isp)}</div>` : ''}
        ${tags.length ? `<div style="font-size:12px;color:#666;margin-top:4px;">${escapeHtml(tags.join(' · '))}</div>` : ''}
      </div>
      <div style="background:#f4f4fa;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:4px;">Device</div>
        <div style="font-size:15px;font-weight:600;color:#111;">${escapeHtml(uaInfo.device || 'Unknown')}</div>
        <div style="font-size:12px;color:#666;margin-top:4px;">${escapeHtml(uaInfo.os)} · ${escapeHtml(uaInfo.browser)}</div>
      </div>
    </div>

    <details style="margin-top:8px;">
      <summary style="cursor:pointer;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;">Raw details</summary>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#666;margin-top:8px;line-height:1.55;word-break:break-all;">
        IP: ${escapeHtml(ip)}<br>
        UA: ${escapeHtml(ua || 'unknown')}
      </div>
    </details>
  </div>
</body></html>`;

    return { text: lines.join('\n'), html };
}

module.exports = { buildOpenNotice, flagEmoji, parseUa, lookupGeo };
