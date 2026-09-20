# Deploying Keypad (v2 — PostgreSQL / Argon2)

Keypad is a Next.js 16 app with an optional standalone Node server that also
hosts an authenticated WebSocket endpoint at `/api/v1/ws`. For single-server
VPS deployments the simplest configuration is:

- Ubuntu 22.04 or newer
- PostgreSQL 15+ (bound to `127.0.0.1`, not public)
- Node.js 20.11+
- Nginx terminating TLS and proxying HTTP + WebSocket
- PM2 or systemd to keep the server alive
- Local-disk object storage for media (STORAGE_PROVIDER=local) backed by daily
  `pg_dump` + rsync to another host (or S3 if you prefer).

PostgreSQL must **not** be exposed publicly. Bind `listen_addresses` to
`127.0.0.1`, and only allow peer/password authentication from localhost.

## 1. Build and prepare

```bash
git clone <repo> /srv/keypad
cd /srv/keypad
npm ci --legacy-peer-deps
cp .env.example .env.production
# Edit .env.production (see below)
npx prisma generate
DATABASE_URL=postgres://keypad:CHANGE_ME@127.0.0.1:5432/keypad npx prisma migrate deploy
npm run build
```

Before going further, run the environment pre-flight check — it names the exact
file each value came from, flags placeholder/short secrets, and validates the
Prisma and S3 credentials:

```bash
npm run doctor
```

## 2. Required environment variables

See `.env.example`. Minimum viable production set:

```
NODE_ENV=production
APP_ENV=production
APP_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgres://keypad:<password>@127.0.0.1:5432/keypad
DATA_PROVIDER=prisma
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=/var/lib/keypad/media
ADMIN_EMAIL=you@example.com
SESSION_DURATION_HOURS=336   # two weeks
SEED_SECRET_CODE=<choose a 1-15 char code — the typing-game gate>
NEXT_PUBLIC_APP_URL=https://keypad.example.com
```

Generate values:

```bash
openssl rand -hex 32   # APP_SECRET (must be >= 32 characters in production)
```

## 3. Run the server

The `serve` script (`tsx server.ts`) boots Next.js AND the WebSocket server and
the outbox worker in one process. For a single-node VPS this is sufficient.

### With systemd

`/etc/systemd/system/keypad.service`:

```ini
[Unit]
Description=Keypad (Next.js + WebSocket)
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/keypad
EnvironmentFile=/srv/keypad/.env.production
ExecStart=/usr/bin/env npm run serve
Restart=always
RestartSec=3
# Allow binding to port 3000; we proxy through Nginx.
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now keypad
sudo systemctl status keypad
```

### With PM2

```bash
npm install -g pm2
pm2 start npm --name keypad -- run serve
pm2 save
pm2 startup systemd   # follow the printed command
```

### Standalone outbox worker (optional)

`npm run serve` already runs the outbox worker in-process. If you prefer it as
its own unit (so it can be restarted independently), add a second service:

```ini
[Unit]
Description=Keypad outbox worker
After=network.target postgresql.service keypad.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/keypad
EnvironmentFile=/srv/keypad/.env.production
ExecStart=/usr/bin/env npm run worker
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Poll interval and batch size come from `OUTBOX_POLL_INTERVAL_MS` (default 500)
and `OUTBOX_BATCH_SIZE` (default 100). Do not run two workers against the same
database unless the poller is shared (see decision #10 in `decisions.md`).

## 4. Nginx reverse proxy (HTTPS + WSS)

Generate a certificate with `certbot --nginx -d keypad.example.com` after
creating this config at `/etc/nginx/sites-available/keypad`:

```nginx
server {
  listen 80;
  server_name keypad.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name keypad.example.com;

  ssl_certificate     /etc/letsencrypt/live/keypad.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/keypad.example.com/privkey.pem;

  client_max_body_size 25m;   # voice/image uploads

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_read_timeout 300s;             # long-polling / WS
  }
}
```

Note that `Upgrade`/`Connection` are set for **all** locations. That is what
makes the `/api/v1/ws` path answer WSS handshakes through Nginx.

```bash
sudo ln -s /etc/nginx/sites-available/keypad /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Firewall

Only expose 80/443 and SSH. PostgreSQL stays bound to localhost.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 6. Media storage

- For `STORAGE_PROVIDER=local`, make sure `STORAGE_LOCAL_DIR` is writable by the
  `www-data` (or pm2) user:
  ```bash
  sudo mkdir -p /var/lib/keypad/media
  sudo chown www-data:www-data /var/lib/keypad/media
  ```
- For S3/R2/MinIO: install `@aws-sdk/client-s3 @aws-sdk/s3-request-presigner`,
  set `STORAGE_PROVIDER=s3` and provide `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`,
  `STORAGE_SECRET_KEY`, `STORAGE_ENDPOINT` (for R2/MinIO), `STORAGE_REGION`.

## 7. TURN (coturn) for audio calls

STUN alone fails for clients behind symmetric NATs — most mobile networks. For
production calls, run [coturn](https://github.com/coturn/coturn) on the same
host (or a second one) and point the app at it:

```bash
sudo apt install coturn
```

`/etc/turnserver.conf` (essentials):

```
listening-port=3478
realm=keypad.example.com
server-name=keypad.example.com
use-auth-secret
static-auth-secret=<openssl rand -hex 32>
total-quota=100
```

```bash
sudo systemctl enable --now coturn
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
# media relay range (also open in coturn config: min-port/max-port)
sudo ufw allow 49160:49200/udp
```

Then in `.env.production`:

```
TURN_SERVER_URL=turn:keypad.example.com:3478
TURN_SERVER_USERNAME=keypad
TURN_SERVER_CREDENTIAL=<static-auth-secret above>
```

The `/api/v1/calls/ice-servers` endpoint serves this configuration only to
authenticated users; verify it returns your TURN entry after restarting.

## 8. Backups

```bash
# Daily database dump to /var/backups/keypad
pg_dump -Fc keypad -U keypad -h 127.0.0.1 -f /var/backups/keypad/$(date +%F).dump
# Sync media
rsync -a --delete /var/lib/keypad/media/ backup-host:/var/backups/keypad/media/
```

## 9. First-run: promote an admin

Register an account using the email you set in `ADMIN_EMAIL` (the gate code is
your `SEED_SECRET_CODE`). Any account matching `ADMIN_UID` or `ADMIN_EMAIL` is
treated as administrator on every request — there is no role to grant. The
`npm run seed` output prints the uid to put in `ADMIN_UID`.

The secret code is set from `SEED_SECRET_CODE` on first boot. Change it from
`/admin/settings` (signed in as the admin) with the `rotate` strategy, which
signs out every active typing-game session.

## 10. Verifying

```bash
curl -s https://keypad.example.com/api/v1/health | jq .
```

Expected:

```json
{
  "ok": true,
  "requestId": "…",
  "data": {
    "ok": true,
    "version": "2.0.0",
    "dataProvider": "prisma",
    "authProvider": "argon2-session",
    "storageProvider": "local",
    "time": "…",
    "access": { "epoch": 1, "maxLength": 15, "caseSensitive": true, "configured": true }
  }
}
```

## 11. Troubleshooting

| Symptom                                       | Cause / fix                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server exits on boot with a provider error    | Production refuses the `memory` providers (`assertFallbackAllowed`). Set `DATA_PROVIDER=prisma` + `DATABASE_URL` and `STORAGE_PROVIDER=local` or `s3`.      |
| `config.issue` lines in the log               | Read the `message` field — it names the exact variables. See `howto.md` §5 for the known reasons.                                                           |
| Health returns 500 / Prisma errors            | `DATABASE_URL` unreachable or migrations not applied: re-run `npx prisma migrate deploy` with the production URL.                                           |
| Register/login fail with 429                  | Expected under brute-force limits (`auth:register` 5/10 min, `auth:login` 8/10 min per email). Counters are in-process — restarting the server resets them. |
| Uploads fail with 413                         | Nginx `client_max_body_size` (25m above) and `STORAGE_MAX_UPLOAD_BYTES` must be sized together.                                                             |
| Admin UI says forbidden                       | `ADMIN_UID`/`ADMIN_EMAIL` does not match the signed-in account. Admin status is derived per request, so fix the env and restart — nothing else to change.   |
| Calls connect on Wi-Fi but not on mobile data | Missing/broken TURN — see the coturn section above. Check `/api/v1/calls/ice-servers` as an authenticated user.                                             |
| Realtime events stop after redeploy           | The outbox worker runs inside `npm start` / `npm run serve` (or the standalone unit). Plain `next start` serves pages but does not poll the outbox.         |

## What still needs to be installed

- `prisma` needs engine binaries; `npm install` fetches them automatically on a
  real host.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` when using
  `STORAGE_PROVIDER=s3`.
- TURN server (coturn) is recommended for production WebRTC audio calls across
  NATs. The `/api/v1/calls/ice-servers` endpoint returns STUN servers; add a
  TURN credential provider (e.g. coturn's REST API) before relying on calls
  across mobile networks.
