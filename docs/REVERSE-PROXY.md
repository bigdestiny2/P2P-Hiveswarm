# Reverse Proxy Guide (nginx + TLS)

This guide walks through putting a HiveRelay node behind nginx with HTTPS.
It is aimed at operators who run a single relay on a VPS or home server and
want a clean, copy-pasteable setup.

## Why bother with a reverse proxy?

A bare HiveRelay binds three plaintext ports on the host:

| Port | Surface | Transport |
|---|---|---|
| `8765` | Hypercore-over-WS replication | WebSocket (binary) |
| `8766` | DHT-relay-over-WS for browser clients | WebSocket (binary) |
| `9100` | HTTP API + dashboard + `/catalog.json` + management endpoints | HTTP |

Exposing those directly works, but you lose a lot:

- **No TLS.** API keys, dashboards, and catalog data go in cleartext. Anyone
  on the network path (coffee shop, ISP, transit) can read or tamper.
- **Three ports to firewall.** Every additional port is one more thing to
  remember when an audit happens.
- **No certificate rotation.** Hand-rolling Let's Encrypt against a Node HTTP
  server is more pain than it should be.
- **Internal topology leaks.** External clients see "port 8765 is the
  Hypercore transport." Behind nginx, they see one HTTPS endpoint with
  opaque path routing.

Putting nginx in front buys you:

1. TLS termination (Let's Encrypt automated via certbot)
2. Single port `443` open to the world; everything else loopback-only
3. A defense-in-depth rate-limit layer in front of the per-IP limiter the
   relay already runs
4. Real client IPs forwarded into the application via standard headers
5. Log unification — one access log instead of three

## Lock the relay to loopback

Before you put nginx in front, bind the relay to `127.0.0.1` so the public
internet cannot reach the plaintext ports directly. In your relay config:

```json
{
  "host": "127.0.0.1",
  "apiPort": 9100,
  "websocketPort": 8765,
  "dhtRelayPort": 8766
}
```

Then verify with `ss -tlnp` that `:8765`, `:8766`, and `:9100` are bound to
`127.0.0.1`, not `0.0.0.0`. Only `:443` (and `:80` for cert challenges) should
be world-reachable.

## Set the API key — non-negotiable for public hosts

The relay's management endpoints (`/api/manage/...`, `/seed`, `/unseed`,
config writes) are protected one of two ways:

- **API key** via `HIVERELAY_API_KEY` env var, sent as `Authorization:
  Bearer <key>` or `?api_key=<key>`
- **Localhost-only fallback** — if the API binds to `127.0.0.1`/`::1` and no
  key is set, requests from loopback are allowed

The localhost fallback is **broken once a reverse proxy is in front**: every
request appears to come from `127.0.0.1` (the nginx upstream connection),
so the host check passes for the entire internet. The relay knows this and
prints a startup warning when the API binds to a non-loopback address with
no key set:

```
[SECURITY WARNING] API binding to 0.0.0.0:9100 without an API key.
Management endpoints are protected only by localhost check, which is
ineffective behind a reverse proxy. Set an API key via HIVERELAY_API_KEY
or opts.apiKey.
```

Even when you bind to `127.0.0.1`, set the key. Treat the warning as a
hard error in any public deployment.

```bash
# /etc/systemd/system/hiverelay.service.d/override.conf
[Service]
Environment="HIVERELAY_API_KEY=<paste 32+ random bytes here>"
```

Generate one with:

```bash
openssl rand -hex 32
```

Store it in a password manager. You will need it from every client that
talks to the management API.

## nginx site config

Replace `relay.example.com` with your hostname. Drop this in
`/etc/nginx/sites-available/hiverelay` and symlink into `sites-enabled/`.

```nginx
# /etc/nginx/sites-available/hiverelay

# Defense-in-depth rate limit — the relay already enforces a per-IP limit;
# this layer sheds load before requests ever reach Node. Tune to taste.
limit_req_zone $binary_remote_addr zone=hiverelay_api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=hiverelay_ws:10m rate=2r/s;

# Map for WebSocket upgrade headers.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

# HTTP -> HTTPS redirect (also serves ACME challenges).
server {
  listen 80;
  listen [::]:80;
  server_name relay.example.com;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name relay.example.com;

  # Filled in by certbot — see "Let's Encrypt" section below.
  ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;

  # The relay is on the same host. Trust loopback as a real-IP source so
  # the application sees the client's actual IP via X-Forwarded-For instead
  # of 127.0.0.1.
  set_real_ip_from 127.0.0.1;
  set_real_ip_from ::1;
  real_ip_header X-Forwarded-For;
  real_ip_recursive on;

  # Reasonable upload cap for catalog/manifest payloads. Raise if you push
  # large manifests through the API.
  client_max_body_size 4m;

  # ---- HTTP API ----
  # Everything under /api/... including /api/manage/*, /seed, /unseed, etc.
  location /api/ {
    limit_req zone=hiverelay_api burst=20 nodelay;

    proxy_pass http://127.0.0.1:9100;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;

    # Management requests can be slow during heavy seeding; give them room.
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
  }

  # ---- Public catalog ----
  # /catalog.json is read-only and meant to be cacheable by clients.
  location = /catalog.json {
    limit_req zone=hiverelay_api burst=40 nodelay;

    proxy_pass http://127.0.0.1:9100/catalog.json;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # ---- WSS: Hypercore-over-WS replication ----
  # Other relays / desktop clients connect here for Hypercore replication.
  location /ws/replicate {
    limit_req zone=hiverelay_ws burst=10 nodelay;

    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;

    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Long-lived replication streams — keep them alive.
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering off;
  }

  # ---- WSS: DHT-relay for browser clients ----
  # Browsers can't talk UDP/DHT directly — they connect here, and the relay
  # bridges them to the Hyperswarm DHT.
  location /ws/dht {
    limit_req zone=hiverelay_ws burst=10 nodelay;

    proxy_pass http://127.0.0.1:8766;
    proxy_http_version 1.1;

    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering off;
  }

  # ---- Dashboard / static (optional) ----
  # Serve the dashboard root through the same vhost. Comment out if you
  # don't want the dashboard publicly exposed — it talks to the API and
  # respects the same auth.
  location / {
    proxy_pass http://127.0.0.1:9100;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Let's Encrypt with certbot

First-time issuance, fully automated, with auto-renewal already wired into
the system timer that certbot installs:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d relay.example.com \
  --agree-tos -m you@example.com --no-eff-email --redirect
```

certbot edits the `ssl_certificate` / `ssl_certificate_key` lines in the
nginx config above and installs a renewal timer
(`systemctl list-timers | grep certbot`). To verify renewal works without
actually renewing:

```bash
sudo certbot renew --dry-run
```

Renewals happen twice daily; the cert is replaced when it has < 30 days
left. nginx is reloaded automatically by the deploy hook certbot installs.

## Talking to the API through the proxy

```bash
# Public, no auth — should work.
curl https://relay.example.com/catalog.json

# Management — must include the API key.
curl https://relay.example.com/api/manage/catalog/pending \
  -H "Authorization: Bearer $HIVERELAY_API_KEY"
```

For browser clients connecting over the DHT relay:

```js
// dht-relay-ws over WSS
const ws = new WebSocket('wss://relay.example.com/ws/dht')
```

For other relays connecting for Hypercore replication:

```js
// hypercore-over-ws over WSS
const ws = new WebSocket('wss://relay.example.com/ws/replicate')
```

## Rate-limit tuning notes

The `limit_req_zone` values above are conservative starting points:

- **`hiverelay_api`** at `10r/s` with `burst=20` — fits an interactive
  dashboard plus a couple of scripted clients without backpressure.
- **`hiverelay_ws`** at `2r/s` with `burst=10` — guards the WebSocket
  upgrade handshake itself, not the in-stream traffic. A legit client
  upgrades once and then stays on a long-lived connection, so even `2r/s`
  is generous.

If you see `limit_req` log lines under normal use, raise the rate. If you
see abuse, lower it or add a `geo` block to whitelist known peer IPs at a
higher rate. The application's own per-IP rate limit is still in force —
this layer just sheds load before requests hit Node.

## Things to double-check before going live

- `ss -tlnp` shows `8765`, `8766`, `9100` bound to `127.0.0.1` only.
- `HIVERELAY_API_KEY` is set in the systemd unit and the startup log shows
  no `[SECURITY WARNING]` line.
- `curl -I https://relay.example.com/catalog.json` returns `200` with a
  valid TLS cert.
- `curl https://relay.example.com/api/manage/catalog/pending` without the
  Authorization header returns `401`.
- Replication and DHT WebSocket endpoints upgrade successfully (browser
  devtools or `websocat wss://relay.example.com/ws/dht`).
- `sudo certbot renew --dry-run` succeeds.
- Application access logs show real client IPs, not `127.0.0.1`.
