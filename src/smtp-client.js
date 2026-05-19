'use strict';

const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

function createSmtpTransporter({ host, port, secure, user, pass, tlsOptions, connectTimeoutMs }) {
    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        tls: tlsOptions,
        connectionTimeout: connectTimeoutMs
    });
}

function generateMessageId(domain) {
    const uuid = require('crypto').randomUUID();
    const d = domain || 'localhost';
    return `<${uuid}@${d}>`;
}

async function sendMessage({ smtpConfig, user, pass, from, to, cc, bcc, subject, text, html, inReplyTo, attachments }) {
    const domain = from.split('@')[1] || 'localhost';
    const messageId = generateMessageId(domain);

    const tlsOptions = {};
    if (smtpConfig.tlsServername) tlsOptions.servername = smtpConfig.tlsServername;
    if (!smtpConfig.rejectUnauthorized) tlsOptions.rejectUnauthorized = false;

    const transporter = createSmtpTransporter({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        user,
        pass,
        tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined,
        connectTimeoutMs: smtpConfig.connectTimeoutMs
    });

    const mailOptions = {
        from,
        to,
        cc,
        bcc,
        subject,
        text,
        html,
        messageId,
        inReplyTo,
        references: inReplyTo || undefined,
        attachments: attachments
            ? attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType || undefined,
                content: Buffer.from(a.content, 'base64')
            }))
            : undefined
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        // Build the raw RFC822 so we can append a copy to the Sent folder.
        const composer = new MailComposer(mailOptions);
        const raw = await composer.compile().build();
        return { sent: true, messageId: info.messageId || messageId, raw };
    } finally {
        transporter.close();
    }
}

module.exports = { sendMessage, createSmtpTransporter, generateMessageId };
