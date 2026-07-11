# nginx reverse proxy — Hoodgate

Fronts both services behind TLS on a single host. Facilitator and demo-api
bind to `127.0.0.1` only (see systemd units); nginx is the sole public entry.

## Layout

```
Internet
  │
  ├── https://facilitator.hoodgate.example  →  127.0.0.1:3001 (facilitator)
  └── https://demo.hoodgate.example         →  127.0.0.1:3005 (demo-api)
```

## Install

```bash
# 1) Install nginx + certbot
apt-get install -y nginx certbot python3-certbot-nginx

# 2) DNS: point facilitator.hoodgate.example and demo.hoodgate.example
#    at this host's public IP. Wait for propagation.

# 3) Drop the config in place, edit hostnames
cp hoodgate.conf /etc/nginx/sites-available/hoodgate.conf
$EDITOR /etc/nginx/sites-available/hoodgate.conf  # replace .example hostnames
ln -sf /etc/nginx/sites-available/hoodgate.conf /etc/nginx/sites-enabled/hoodgate.conf
rm -f /etc/nginx/sites-enabled/default        # kill the welcome page
nginx -t && systemctl reload nginx

# 4) Issue Let's Encrypt certs (needs port 80 reachable, ACME challenge path)
mkdir -p /var/www/certbot
certbot certonly --webroot -w /var/www/certbot \
    -d facilitator.hoodgate.example \
    -d demo.hoodgate.example \
    --agree-tos -m ops@hoodgate.example --non-interactive

# 5) Reload nginx to pick up the certs
nginx -t && systemctl reload nginx

# 6) certbot installs a systemd timer for renewal automatically:
systemctl status certbot.timer
```

## Notes

- **`TRUST_PROXY_HOPS`** in `facilitator.env` must be `1` for the direct
  nginx → node topology used here. Behind Cloudflare add one more hop.
- **`CORS_ORIGINS`** must list the full origin including scheme, e.g.
  `https://demo.hoodgate.example`. Missing scheme = the CORS check silently
  fails.
- **`/metrics`** is restricted to RFC1918 subnets in the config. If your
  Prometheus server is elsewhere, replace the `allow` lines with its IP,
  or scrape over `127.0.0.1` from a co-located agent (grafana-agent).
- **`limit_req`** here is coarse (30 r/s per IP, burst 60). It's a floor
  under the app-level limits (`60/min /verify`, `20/min /settle`) so a
  volumetric flood dies at nginx before waking the event loop.
- **HTTP/2** is on. HTTP/3 requires nginx built with `--with-http_v3_module`
  and is not enabled here.
- **HSTS preload** — the `max-age=63072000; includeSubDomains; preload`
  header is a two-year commitment. Confirm every subdomain can serve TLS
  before submitting to `hstspreload.org`.

## Verifying

```bash
# TLS + HSTS
curl -sI https://facilitator.hoodgate.example/health | grep -i strict-transport

# Rate-limit bite (should see 429 after ~30 rps)
for i in $(seq 1 100); do curl -s -o /dev/null -w "%{http_code}\n" https://facilitator.hoodgate.example/health & done | sort | uniq -c

# CORS preflight
curl -sI -X OPTIONS https://facilitator.hoodgate.example/verify \
    -H "Origin: https://demo.hoodgate.example" \
    -H "Access-Control-Request-Method: POST"
```
