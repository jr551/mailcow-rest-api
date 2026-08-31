# mailcow-rest-api

**Swagger/OpenAPI first:** after starting the API, open `/` for Swagger UI or `/openapi.json` for the raw OpenAPI 3.1 document.

`mailcow-rest-api` is a public mailcow add-on API that turns a mailcow mailbox into a REST, OpenAPI, and optional MCP surface for webmail clients, automation, and local tools.

One container gives you all four surfaces:

| Path | What it serves |
|---|---|
| `/v1/*` | REST API over IMAP, SMTP, Sieve, CalDAV, and mailcow's own database |
| `/` | Swagger UI, with `/openapi.json` for the raw OpenAPI 3.1 document |
| `/webmail/` | The bundled Svelte webmail (`/webmail/mobile/` for the mobile PWA) |
| `/v1/admin/*` | Operator-only runtime settings, when `ADMIN_TOKEN` is set |

There is no second container and no separate frontend deployment to keep in step — the SPA is built from `webmail/` into the image, so the API always serves the frontend it was built with.

## Backend Features

- IMAP mailbox tree, message search/list/read, attachments, raw source, flags, move, delete, and append.
- SMTP send with draft/reply metadata and pending approval links.
- Mailcow account data for mailbox profile, aliases, temporary aliases, sender allow/block lists, and send-from identities.
- Sieve-backed mail rules and blocked-recipient management.
- SOGo CalDAV calendar list, event CRUD, iCal token publishing, and public event edit links.
- Web Push subscription storage and notification polling.
- Image/icon proxying, OCR cache, tracking pixels, and tracking event reads.
- Optional S3/Backblaze B2 drive provisioning for browser-side file storage.
- Optional AI routes for capabilities, configuration, summarise, draft reply, actions, translation, inbox sorting, phishing scan, TTS config, and web search.
- Optional MCP stdio adapter through `bin/imap-rest-mcp`.
- IP allowlisting and per-IP rate limiting in front of the IMAP auth path.

## Full API Surface

The Swagger UI is the source of truth for schemas and response examples. This route list is included so the public README shows the whole surface at a glance.

### Public And Docs

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Swagger UI |
| `GET` | `/openapi.json` | OpenAPI JSON |
| `GET` | `/health` | Health check |
| `GET` | `/v1/app/android/version.json` | Android app version metadata |
| `GET` | `/v1/app/android.apk` | Android APK download when configured |
| `GET` | `/v1/track/:ref.gif` | Tracking pixel |
| `GET` | `/v1/public/ical/:token.ics` | Public calendar feed |
| `GET` | `/v1/public/event/:token/:uid/edit` | Public event edit form |
| `POST` | `/v1/public/event/:token/:uid/edit` | Public event edit submit |
| `GET` | `/webmail/` | Bundled webmail SPA (`/webmail/mobile/` for the mobile PWA) |

### Admin

Registered only when `ADMIN_TOKEN` is set. Authenticated with `Authorization: Bearer <ADMIN_TOKEN>`, not a mailbox login.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/admin/settings` | Read runtime operator settings |
| `PUT` | `/v1/admin/settings` | Toggle the webmail on/off without a restart |
| `GET` | `/v1/admin/status` | Version, uptime, and active subsystems |

### Auth And Session

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/session` | Create bearer session from mailbox credentials |
| `GET` | `/v1/auth/session` | Inspect current session |

Authenticated routes accept either HTTP Basic auth using the mailbox credentials or `Authorization: Bearer <token>` from `/v1/auth/session`.

### Mailboxes And Messages

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/mailboxes` | List mailbox folders |
| `POST` | `/v1/mailboxes` | Create mailbox folder |
| `PUT` | `/v1/mailboxes/:path` | Rename mailbox folder |
| `DELETE` | `/v1/mailboxes/:path` | Delete mailbox folder |
| `GET` | `/v1/mailboxes/:path/messages` | List/search messages |
| `POST` | `/v1/mailboxes/:path/messages` | Append a raw message |
| `GET` | `/v1/mailboxes/:path/messages/:uid` | Read message details |
| `GET` | `/v1/mailboxes/:path/messages/:uid/raw` | Read raw RFC 822 source |
| `GET` | `/v1/mailboxes/:path/messages/:uid/attachments/:attachmentId` | Download attachment |
| `GET` | `/v1/mailboxes/:path/messages/:uid/attachments/:attachmentId/text` | Extract attachment text/OCR |
| `PUT` | `/v1/mailboxes/:path/messages/:uid/flags` | Set message flags |
| `PUT` | `/v1/mailboxes/:path/messages/:uid/move` | Move message |
| `DELETE` | `/v1/mailboxes/:path/messages/:uid` | Delete message |
| `POST` | `/v1/messages/send` | Send a message through SMTP |
| `GET` | `/v1/messages/approve/:token` | Approve pending send |
| `GET` | `/v1/messages/deny/:token` | Deny pending send |
| `GET` | `/v1/messages/send/:messageId/status` | Read send status |

### Account, Rules, And Sender Policy

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/me/mailbox` | Mailbox profile and quota |
| `GET` | `/v1/me/logins` | Login aliases |
| `GET` | `/v1/me/aliases` | Mail aliases |
| `GET` | `/v1/me/temp-aliases` | Temporary aliases |
| `POST` | `/v1/me/temp-aliases` | Create temporary alias |
| `DELETE` | `/v1/me/temp-aliases/:address` | Delete temporary alias |
| `GET` | `/v1/me/send-from` | Send-from identities |
| `GET` | `/v1/me/shortcuts` | Admin-defined webmail shortcuts |
| `GET` | `/v1/me/mail-rules` | Sieve mail rules |
| `POST` | `/v1/me/mail-rules` | Create/update mail rule |
| `DELETE` | `/v1/me/mail-rules/:id` | Delete mail rule |
| `GET` | `/v1/me/blocked-recipients` | List blocked recipients |
| `POST` | `/v1/me/blocked-recipients` | Add blocked recipient |
| `DELETE` | `/v1/me/blocked-recipients/:recipient` | Remove blocked recipient |
| `GET` | `/v1/me/blocked-senders` | List blocked senders |
| `POST` | `/v1/me/blocked-senders` | Add blocked sender |
| `DELETE` | `/v1/me/blocked-senders/:prefid` | Remove blocked sender |
| `GET` | `/v1/me/allowed-senders` | List allowed senders |
| `POST` | `/v1/me/allowed-senders` | Add allowed sender |
| `DELETE` | `/v1/me/allowed-senders/:prefid` | Remove allowed sender |

### Calendar

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/me/calendars` | List calendars |
| `GET` | `/v1/me/calendars/:calendar/events` | List calendar events |
| `GET` | `/v1/me/calendars/:calendar/events/:uid` | Read event |
| `POST` | `/v1/me/calendars/:calendar/events` | Create/update event |
| `DELETE` | `/v1/me/calendars/:calendar/events/:uid` | Delete event |
| `GET` | `/v1/me/calendars/:calendar/ical` | Download calendar iCal |
| `POST` | `/v1/me/calendars/:calendar/ical-token` | Create iCal token |
| `GET` | `/v1/me/calendars/:calendar/ical-token` | Read iCal token |
| `DELETE` | `/v1/me/calendars/:calendar/ical-token` | Revoke iCal token |
| `GET` | `/v1/me/calendar-subscriptions` | List subscribed calendars |
| `POST` | `/v1/me/calendar-subscriptions` | Add subscribed calendar |
| `DELETE` | `/v1/me/calendar-subscriptions/:id` | Remove subscribed calendar |
| `GET` | `/v1/me/calendar-subscriptions/:id/events` | List subscribed calendar events |

### Drive, Push, Proxy, Tracking, Telemetry, And AI

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/drive/config` | Browser-side S3/B2 drive config |
| `GET` | `/v1/drive/quota` | Drive quota |
| `GET` | `/v1/push/config` | Web Push public config |
| `POST` | `/v1/push/subscribe` | Add push subscription |
| `DELETE` | `/v1/push/subscribe` | Remove push subscription |
| `POST` | `/v1/push/test` | Send diagnostic push |
| `GET` | `/v1/proxy/image` | Fetch/cache remote image |
| `GET` | `/v1/proxy/icon` | Fetch/cache sender icon |
| `GET` | `/v1/tracking` | List tracking events |
| `DELETE` | `/v1/tracking/:ref` | Delete tracking ref |
| `POST` | `/v1/telemetry/error` | Store client error report |
| `GET` | `/v1/telemetry/recent` | Read recent client errors |
| `GET` | `/v1/ai/capabilities` | AI feature availability |
| `GET` | `/v1/ai/config` | Browser AI provider config |
| `POST` | `/v1/ai/llm/chat/completions` | OpenAI-compatible chat proxy (server holds the provider key) |
| `POST` | `/v1/ai/web-search` | AI web search helper |
| `GET` | `/v1/ai/tts-config` | Text-to-speech config |
| `POST` | `/v1/ai/summarize` | Summarise text/message |
| `POST` | `/v1/ai/draft-reply` | Draft a reply |
| `POST` | `/v1/ai/actions` | Extract action items |
| `POST` | `/v1/ai/translate` | Translate text |
| `POST` | `/v1/ai/sort-inbox` | Sort inbox into AI categories |
| `POST` | `/v1/ai/phishing-scan` | Phishing risk scan |

## Docker Image

The public image is published to GitHub Container Registry:

```sh
docker pull ghcr.io/jr551/mailcow-rest-api:master
```

Minimal local run near a mailcow deployment:

```sh
docker run --rm -p 3001:3001 \
  -e IMAP_HOST=dovecot-mailcow \
  -e SMTP_HOST=postfix-mailcow \
  ghcr.io/jr551/mailcow-rest-api:master
```

## Webmail

The image serves the bundled Svelte webmail at `/webmail/` and its mobile PWA at `/webmail/mobile/`. Nothing extra is needed: point a browser at the API's own origin and sign in with a mailcow mailbox address and password.

**Self-hosting and development.** Serving the SPA from the API is the out-of-the-box path. Because it is same-origin with `/v1/*`, there is no CORS to configure and no second TLS certificate or vhost to maintain. `window.__IMAP_API_BASE__` defaults to `""`, so API calls resolve against whatever host is serving the page.

**Production and CDN hosting.** For high-traffic or edge deployments, build the SPA separately and host it on Cloudflare Pages, Netlify, or S3/CloudFront, pointing it at a remote API:

```sh
cd webmail && npm ci && npm run build   # output in webmail/dist
```

Set the API origin before the app's own scripts run, by editing the shell's inline script in `dist/index.html` (and `dist/mobile/index.html`):

```html
<script>window.__IMAP_API_BASE__ = "https://userapi.example.com"</script>
```

Then add that CDN origin to `API_CORS_ORIGINS` on the API so its cross-origin calls are answered.

**Turning it off.** `WEBMAIL_ENABLED=false` removes the webmail at startup. With an `ADMIN_TOKEN` configured you can also toggle it at runtime — see below — which takes effect immediately and does not need the container recreated.

## App Passwords

Pointing an MCP client or a script at a mailbox normally means putting the mailbox password in a config file, where it grants IMAP, SMTP, and webmail access indefinitely and can only be withdrawn by changing the password everywhere it is used.

An app password is a per-client credential instead. Users create them in the webmail under **Settings → Security → App passwords**, giving each one a name and the IP addresses or ranges it may be used from. The token is displayed once, at creation.

Use it wherever the mailbox password would go — as the password with the address as username, or as a bearer token on its own:

```sh
curl -u 'user@example.com:map_...' https://api.example.com/v1/mailboxes
curl -H 'Authorization: Bearer map_...' https://api.example.com/v1/mailboxes
```

For MCP, put it in `IMAP_REST_PASS`:

```json
{
  "mcpServers": {
    "mailcow-rest-api": {
      "command": "npx",
      "args": ["--yes", "--package", "mailcow-rest-api", "imap-rest-mcp"],
      "env": {
        "IMAP_REST_BASE_URL": "https://api.example.com",
        "IMAP_REST_USER": "user@example.com",
        "IMAP_REST_PASS": "map_..."
      }
    }
  }
}
```

How it behaves:

- **IP scoping is mandatory.** At least one address or CIDR is required, and a token presented from anywhere else is rejected exactly like a wrong password. This is what makes a leaked token far less useful than a leaked mailbox password.
- **Only the hash is stored.** A stolen database yields no usable token.
- **They cannot manage themselves.** An app password may not create or revoke app passwords — otherwise a leaked one could issue a replacement scoped to the attacker's own network and survive revocation of the original. Managing them requires signing in with the mailbox password.
- **Revocation is immediate,** and each row records when and from where it was last used.
- **Optional expiry** in days, in addition to revocation.

The API still performs a real IMAP login, so the mailbox password is captured when the token is minted and kept encrypted with `CREDENTIAL_ENCRYPTION_KEY`. The feature therefore requires credential encryption and is disabled without it. It also means **changing the mailbox password invalidates existing app passwords**, since the stored copy no longer matches — recreate them, or sign in to the webmail once to re-key them.

## Admin API

Setting `ADMIN_TOKEN` enables `/v1/admin/*`. Without it the routes are never registered. The token is operator credentials, not a mailbox login, and is sent as `Authorization: Bearer <ADMIN_TOKEN>`.

```sh
# current settings
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.example.com/v1/admin/settings

# take the webmail offline without touching the container
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"webmail":{"enabled":false}}' https://api.example.com/v1/admin/settings
```

`GET /v1/admin/status` reports version, uptime, and which optional subsystems are live. Settings persist in `admin-settings.db` alongside the other state on the data volume.

`WEBMAIL_ENABLED=false` outranks the stored setting: an operator who disabled the webmail at deploy time cannot have it switched back on through the API. The `source` field in the response says which rule is in force (`db`, `default`, or `env-forced-off`).

Generate a real token, and restrict it by source IP when the API is publicly reachable:

```sh
openssl rand -hex 32
```

## Mailcow Setup

The public setup scripts are intentionally conservative. Before they start containers or write nginx config they run `install/mailcow-safety-check.sh`, which verifies Docker, Docker Compose, a mailcow checkout, the mailcow network, the mailcow nginx config directory, and running `nginx-mailcow`, `dovecot-mailcow`, and `postfix-mailcow` containers.

Quick install on a mailcow host:

```sh
curl -fsSL https://raw.githubusercontent.com/jr551/mailcow-rest-api/master/install/quickstart.sh | sudo sh
```

Manual install:

```sh
git clone https://github.com/jr551/mailcow-rest-api.git /opt/mailcow-rest-api
cd /opt/mailcow-rest-api
cp .env.example .env
sudo install/mailcow-safety-check.sh
sudo install/setup.sh
```

The default setup exposes the API through mailcow nginx at:

- `https://<your-mailcow-host>/mailcow-rest-api/`
- `https://<your-mailcow-host>/mailcow-rest-api/openapi.json`
- `https://<your-mailcow-host>/mailcow-rest-api/health`

Set `MAILCOW_PATH` if your mailcow checkout is not `/opt/mailcow-dockerized`, and set `MAILCOW_NETWORK` if your Docker network name differs from `mailcowdockerized_mailcow-network`.

Install this checkout outside of `/opt/mailcow-dockerized` (e.g. as a sibling directory like `/opt/mailcow-rest-api`) so mailcow's own `update.sh` — which resets its working tree — never touches it. The quickstart and manual install commands above already do this.

## Configuration

Copy `.env.example` to `.env`. Common values:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API listen port inside the container |
| `IMAP_HOST` | `dovecot-mailcow` | mailcow Dovecot container/service |
| `SMTP_HOST` | empty | Set to `postfix-mailcow` for send support |
| `MAILCOW_DB_HOST` | `mysql-mailcow` | Used for account, alias, and policy features |
| `SOGO_URL` | empty | Set to `http://nginx-mailcow/SOGo` for CalDAV |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `LLM_BASE_URL` | empty | OpenAI-compatible proxy/provider URL |
| `LLM_API_KEY` | empty | Provider key; stays server-side (chat is proxied via `/v1/ai/llm`) |
| `S3_DRIVE_ENABLED` | `false` | Enables drive config/quota endpoints |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | empty | Enables push delivery |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | Per-IP request cap; `RATE_LIMIT_ENABLED=false` to disable |
| `WEBHOOK_ACCOUNTS` | empty | JSON array of mailboxes whose mail is POSTed to a webhook and then deleted |
| `LLM_REASONING_EFFORT` | `none` | Reasoning budget; `none` keeps short answers from being eaten by thinking tokens |
| `AI_CACHE_TTL_MS` | `43200000` | Per-user completion cache TTL (12h); `AI_CACHE_ENABLED=false` to disable |
| `LLM_SCRUB_SECRETS` | `true` | Strip credentials from prompts before they reach the provider |
| `LLM_DECOY_COUNT` | `0` | Decoy requests per real one; multiplies token spend, see README |
| `TRUST_PROXY` | private hops | Which proxies may set `X-Forwarded-For`; never trusts arbitrary clients |
| `CREDENTIAL_ENCRYPTION_KEY` | generated | Encrypts stored mailbox passwords at rest; set it so backups don't carry the key |
| `DRIVE_CORS_ORIGINS` | `PUBLIC_BASE_URL` | Browser origins allowed to reach Drive buckets (required for Drive to work) |
| `WEBMAIL_ENABLED` | `true` | Serve the bundled SPA at `/webmail/`; `false` is a hard off switch the admin API cannot undo |
| `WEBMAIL_DIST` | `/app/webmail/dist` | Where the built SPA lives; the image sets this for you |
| `ADMIN_TOKEN` | empty | Bearer token for `/v1/admin/*`; unset leaves the admin routes unregistered |
| `ADMIN_IP_ALLOWLIST` | empty | Optional CIDR list restricting `/v1/admin/*` on top of the token |
| `ADMIN_SETTINGS_DB_PATH` | `<data>/admin-settings.db` | Runtime operator settings store |

### Webhook conversion accounts

Set `WEBHOOK_ACCOUNTS` to turn a mailbox into a feed for some other system.
Every message that arrives is POSTed as JSON — envelope, the decoded `text`
and `html` bodies, attachments with their bytes (base64), and the full
RFC822 source for receivers that would rather parse MIME themselves — and is
then deleted from the mailbox.

Each attachment carries `filename`, `contentType`, `size`, `included` and
either `content` (base64) or an `omittedReason`. Attachments over
`WEBHOOK_MAX_ATTACHMENT_BYTES` (10 MB) or past the per-message budget
(`WEBHOOK_MAX_ATTACHMENTS_TOTAL_BYTES`, 20 MB) are still listed and
explained rather than dropped silently.

```json
[
  {
    "address": "forms@example.com",
    "password": "the mailbox's IMAP password",
    "url": "https://hooks.example.com/mail",
    "secret": "optional-hmac-secret",
    "mailbox": "INBOX"
  }
]
```

A message is deleted **only** after the webhook answers 2xx. Anything else
leaves it in the mailbox and schedules a retry — 1m, 5m, 15m, 1h, 3h, 6h,
12h, then daily, up to `WEBHOOK_MAX_ATTEMPTS` (default 14). Attempt state is
kept in `WEBHOOK_DB_PATH` so restarts don't reset the backoff or re-deliver.
After the final attempt the message is left in place rather than dropped.

When `secret` is set, each POST carries

```
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature-V2: <hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

Verify the signature against the raw request body, not a re-serialized copy,
and reject any request whose timestamp is outside your tolerance window (300s
is a reasonable default) — that check is what makes a captured request
unreplayable. No body-only `X-Webhook-Signature` is sent: emitting one
alongside the timestamped signature would let an attacker strip the two
headers above and replay the request anyway.

## Development

```sh
npm install
npm test
npm start
```

Open Swagger at `http://localhost:3001/`.

Run the MCP adapter locally:

```sh
IMAP_REST_BASE_URL=http://127.0.0.1:3001 \
IMAP_REST_USER=user@example.com \
IMAP_REST_PASS='mailbox-password' \
npm run mcp
```
