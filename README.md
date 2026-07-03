# mailcow-rest-api

**Swagger/OpenAPI first:** after starting the API, open `/` for Swagger UI or `/openapi.json` for the raw OpenAPI 3.1 document.

`mailcow-rest-api` is a public mailcow add-on API that turns a mailcow mailbox into a REST, OpenAPI, and optional MCP surface for webmail clients, automation, and local tools.

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
| `GET` | `/v1/ai/key/usage` | LiteLLM scoped key usage |
| `POST` | `/v1/ai/key/rotate` | Rotate LiteLLM scoped key |
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
| `LITELLM_MASTER_KEY` | empty | Enables per-user scoped LiteLLM keys |
| `S3_DRIVE_ENABLED` | `false` | Enables drive config/quota endpoints |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | empty | Enables push delivery |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | Per-IP request cap; `RATE_LIMIT_ENABLED=false` to disable |

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
