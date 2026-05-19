# mailcow-rest-api

Mailcow add-on REST API for mailbox, message, send, calendar, drive, push, and account workflows. It includes OpenAPI documentation at `/docs` and an optional MCP stdio adapter for local tool use.

## Docker

The public image is published to GitHub Container Registry:

```sh
docker pull ghcr.io/jr551/mailcow-rest-api:master
```

Run it near a mailcow deployment and point it at the mailcow service names:

```sh
docker run --rm -p 3001:3001 \
  -e IMAP_HOST=dovecot-mailcow \
  -e SMTP_HOST=postfix-mailcow \
  ghcr.io/jr551/mailcow-rest-api:master
```

Authenticated routes accept mailcow mailbox credentials via HTTP Basic auth, or a bearer session token created by `/v1/auth/session`.

## Development

```sh
npm install
npm test
npm start
```

OpenAPI is available at `http://localhost:3001/docs`.
