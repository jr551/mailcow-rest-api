# Deployment hardening

The API surface is deployed publicly behind a reverse proxy (nginx). Scanners
probe it nightly — `/.env`, `/phpinfo.php`, wildcard paths — the same patterns
that hit the mailcow admin UI. Three cheap layers sit in front of the app;
each is independent, and each catches what the others miss:

1. **Edge rate limiting** — a per-IP brake at the proxy that works regardless
   of app-side `TRUST_PROXY` configuration.
2. **Security headers** — CSP, `nosniff`, frame denial, referrer policy for
   the webmail and API origins.
3. **Ban coverage** — an external bouncer (CrowdSec or fail2ban) that turns
   repeated 401 floods into a firewall drop.

The app has its own rate limiter (`RATE_LIMIT_*`, default 300 req/min per IP)
and resolves the real client from `X-Forwarded-For` only when the peer is a
trusted proxy (`TRUST_PROXY`, default `loopback, linklocal, uniquelocal`).
The edge limiter is the first brake, the app limiter the second, the bouncer
the third.

## 1. Edge rate limiting

`limit_req` needs a zone in the `http` context and a `limit_req` directive in
the location. On mailcow hosts the `http` context is the main
`nginx.conf`, so put the zone in a file nginx includes there — e.g.
`/etc/nginx/conf.d/zzz-mailcow-rest-api-limit.conf` on the host, or
`data/conf/nginx/` inside the mailcow tree if the container serves the vhost.

```nginx
# http context — one 10 MB zone tracks ~160k IPs.
limit_req_zone $binary_remote_addr zone=mailcow_rest_api:10m rate=10r/s;
```

```nginx
# server/location context — the vhost that proxies to the container.
location /v1/ {
    # Burst of 30 absorbs a webmail client opening a mailbox (it fires a
    # dozen requests at once legitimately); nodelay rejects instead of
    # queueing once the burst is spent.
    limit_req zone=mailcow_rest_api burst=30 nodelay;
    limit_req_status 429;

    proxy_pass http://mailcow-rest-api:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    client_max_body_size 100m;
}
```

If the same vhost also serves `/webmail/` and `/`, apply the same
`limit_req` there — static assets are cheap, but the login page is the
credential-stuffing target.

## 2. Security headers

One origin serves the API, Swagger UI, and the webmail SPA, so the CSP has to
cover the SPA too. The SPA loads no third-party scripts or fonts at runtime —
everything is bundled — so the policy can stay tight. The exceptions: the
photo skins (cat-photos, hamster) fetch images and fonts from third-party
origins, and message bodies render remote images through the app's own image
proxy, so `img-src` can stay `self` + `data:` + `blob:`.

```nginx
# Apply on the vhost that serves /, /webmail/ and /v1/.
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(self), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
```

Notes on the compromises:

- `style-src 'unsafe-inline'` is required — Svelte injects component styles
  and the skin system writes inline custom properties.
- `img-src https:` is required only if you enable the photo skins; tighten to
  `'self' data: blob:` if you don't.
- `font-src https://fonts.gstatic.com` likewise only for the photo skins.
- `frame-ancestors 'none'` duplicates `X-Frame-Options: DENY` for modern
  browsers; keep both — XFO still matters for older clients.
- The API returns JSON; these headers are harmless on `/v1/` responses and
  keep the policy uniform across the vhost.

`always` matters: without it nginx only adds headers to 2xx/3xx responses,
and the 401s and 429s are exactly the responses a scanner sees.

## 3. X-Forwarded-For and TRUST_PROXY

The app resolves `req.ip` from the forwarded chain only when the immediate
peer is trusted. The default (`loopback, linklocal, uniquelocal`) matches the
Docker topology: nginx on the host or in the mailcow network reaches the
container over a private address, so the real client IP comes through.

Two rules keep this honest:

- **The proxy must overwrite, not append.** `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;` is correct. If your chain has more than one
  trusted hop (e.g. Cloudflare → host nginx → container), set `TRUST_PROXY`
  to the hop count or an explicit CIDR list so the app walks the chain far
  enough — see `src/config.js`.
- **Never set `TRUST_PROXY=true` meaning "trust everyone".** The app maps the
  literal `true` to the private-hop list for exactly this reason: a forged
  `X-Forwarded-For: 127.0.0.1` would otherwise match the rate limiter's
  loopback exemption and the IP allowlist, disabling the brake on credential
  stuffing.

Verify the app sees real IPs, not the proxy's:

```sh
curl -s -H "X-Forwarded-For: 203.0.113.9" https://<host>/v1/auth/session -o /dev/null -w '%{http_code}\n'
# then check the container log — the logged client IP should be yours,
# not 203.0.113.9 and not the proxy's.
docker logs imap-rest-mailcow --tail 20 | grep -i 401
```

## 4. Ban coverage for /v1/ 401 floods

Community ban rules for the mailcow admin UI match `/api/v1/` (SOGo's API)
only. This API answers 401 on a bad credential at `/v1/auth/session`, every
authenticated `/v1/*` route, and `/v1/admin/*` — a persistent probe is never
blocked at the edge unless a rule watches for it.

### fail2ban

`/etc/fail2ban/filter.d/mailcow-rest-api.conf`:

```ini
[Definition]
# 401s from the API vhost. /v1/ covers /v1/admin/* and app-password auth —
# both answer 401 on a bad credential. (/webmail/ never 401s: the SPA does
# no auth, and a disabled webmail 404s — so no rule for it.)
failregex = ^<HOST> .* "(GET|POST|PUT|DELETE|HEAD) /v1/[^"]*" 401 .*$
ignoreregex =
```

`/etc/fail2ban/jail.d/mailcow-rest-api.conf`:

```ini
[mailcow-rest-api]
enabled  = true
filter   = mailcow-rest-api
logpath  = /var/log/nginx/userapi.access.log   # the API vhost's access log
maxretry = 10
findtime = 600
bantime  = 3600
action   = iptables-multiport[name=mailcow-rest-api, port="http,https"]
```

Give the API vhost its own `access_log` file so the jail doesn't have to
share a log with unrelated traffic.

### CrowdSec

A scenario watching the same log, e.g.
`/etc/crowdsec/scenarios/mailcow-rest-api-401.yaml`:

```yaml
type: leaky
name: local/mailcow-rest-api-401
description: "Ban IPs flooding /v1/ with 401s"
filter: "evt.Meta.log_type == 'http_access-log' && evt.Parsed.request startsWith '/v1/' && evt.Parsed.status == '401'"
leakspeed: 30s
capacity: 10
groupby: "evt.Meta.source_ip"
blackhole: 1m
labels:
  service: http
```

plus an acquisition entry for the vhost's access log in
`/etc/crowdsec/acquis.d/mailcow-rest-api.yaml`:

```yaml
filenames:
  - /var/log/nginx/userapi.access.log
labels:
  type: http_access-log
```

Either way, test it: fire 15 bad `POST /v1/auth/session` requests from a
spare IP and confirm the ban lands (`fail2ban-client status
mailcow-rest-api` or `cscli decisions list`).

## Checklist

- [ ] `limit_req_zone` in http context, `limit_req` on `/v1/` (and the
      webmail location if it shares the vhost)
- [ ] Header block on the vhost, `always` on every `add_header`
- [ ] `X-Forwarded-For` overwritten at the proxy; `TRUST_PROXY` matches the
      real hop count
- [ ] Ban rule covers `/v1/` (which includes `/v1/admin/*` and app-password
      auth — both answer 401 on a bad credential)
- [ ] Verified: `curl -sI https://<host>/webmail/ | grep -i content-security`
      shows the CSP; 15 bad logins produce a ban
