# gradebook-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server and phone-friendly
dashboard for ParentVUE. It keeps a local, read-only snapshot of every child on
a parent account — students, school years, reporting periods, courses with
grades, and assignments with scores, due dates, and statuses — and exposes it
as MCP tools so an AI assistant can answer "what is missing this week?" without
you clicking through ParentVUE.

ParentVUE has no consolidated missing-work view. `gradebook_missing` is that
view.

- **Read-only upstream.** Nothing ever writes back to the school district.
- **Local data.** One SQLite file on a Docker volume; grades stay on your box.
- **Two listeners.** An authenticated MCP endpoint and a separate,
  unauthenticated dashboard port meant only for private networks.
- **No cloud dependency.** Docker Compose, Node 22, `node:sqlite`. No external
  database, no framework beyond Express.

The ParentVUE client lives in [`src/lib/parentvue`](src/lib/parentvue) as a
zero-dependency package with its own README and tests.

## Quick start (Docker Compose)

```sh
cp .env.example .env
```

Edit `.env` and fill in:

1. `GRADEBOOK_PARENTVUE_HOST`, `GRADEBOOK_PARENTVUE_USER`,
   `GRADEBOOK_PARENTVUE_PASS` — your district's ParentVUE host (no scheme) and
   your parent login.
2. **Exactly one** MCP auth mode: `MCP_BEARER_TOKEN` (generate one with
   `openssl rand -hex 32`), or `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` +
   allowlists for Cloudflare Access. See [Authentication](#authentication).
3. `UI_PORT=3001` if you want the dashboard.

Then:

```sh
docker compose up -d --build
curl http://127.0.0.1:3000/healthz        # {"status":"ok"}
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` and the dashboard, when
enabled, is `http://127.0.0.1:3001/gradebook`. Both are published to loopback
only; how to reach them from elsewhere is covered in
[Exposing it from a home lab](#exposing-it-from-a-home-lab).

The first sync happens when you press **Sync now** on the dashboard or call
`gradebook_sync`. Automatic syncs are off until you opt in (see
[Automatic sync](#automatic-sync-and-district-terms)).

## Configuration

All settings come from the environment; `.env` is read when present.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | MCP listener inside the container. |
| `MCP_BIND_ADDR` | `127.0.0.1` | Host address Compose publishes the MCP port on. |
| `UI_PORT` | blank (off) | Dashboard listener port. Blank disables it. |
| `UI_HOST` | `HOST` | Dashboard listener interface inside the container. |
| `UI_BIND_ADDR` | `127.0.0.1` | Host address Compose publishes the dashboard port on. |
| `DATA_DIR` | `./data` (`/data` in Compose) | Where `gradebook.sqlite` lives. |
| `TZ` | `UTC` | Timezone for "today" when picking the current reporting period. |
| `LOG_LEVEL` | `info` | pino log level. Logs are JSON lines. |
| `MCP_BEARER_TOKEN` | — | Auth mode A: static bearer token (min 16 chars). |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | — | Auth mode B: Cloudflare Access team domain (with scheme) and application AUD tag. |
| `ALLOWED_EMAILS`, `ALLOWED_SERVICE_TOKENS` | — | Mode B allowlists: user emails and service-token Client IDs. |
| `GRADEBOOK_PARENTVUE_HOST` | — | District host, e.g. `<district>.edupoint.com`. |
| `GRADEBOOK_PARENTVUE_USER`, `GRADEBOOK_PARENTVUE_PASS` | — | Parent login. |
| `GRADEBOOK_SYNC_ENABLED` | `false` | Opt-in switch for the automatic scheduler. |
| `GRADEBOOK_SYNC_INTERVAL_HOURS` | `24` | Hours between automatic syncs; `0` disables. |
| `GRADEBOOK_STUDENTS` | all | Optional comma-separated student-name allowlist. |
| `DEV_INSECURE_NO_AUTH` | `false` | Local dev only; see [Local development](#local-development). |

Without the three `GRADEBOOK_PARENTVUE_*` values the server still starts: the
dashboard shows an empty state and syncs record `not_configured`.

## MCP tools

| Tool | Purpose |
|---|---|
| `gradebook_overview` | Every student, their current term, and per-course grades with missing counts. Start here to find `stu_`/`crs_` ids. |
| `gradebook_terms` | School years and reporting periods on file for a student. |
| `gradebook_courses` | Courses for a student's term (defaults to the term in progress) with teacher, grade, and missing count. |
| `gradebook_assignments` | Assignments for a course with due date, category, score, and status; filter by status (default `missing`). |
| `gradebook_missing` | Consolidated missing / incomplete / late work across every course, for one student or all. |
| `gradebook_trend` | Grade history for a course within its term. |
| `gradebook_sync` | Pull ParentVUE now and merge. Idempotent; joins an in-flight run rather than starting a second. |
| `gradebook_status` | Last sync outcome, whether ParentVUE is configured, whether the scheduler is armed and when it last fired, row counts. |

Students are addressed by name (case-insensitive) or `stu_` id, courses by
`crs_` id. All tools except `gradebook_sync` are read-only. Every call is
audit-logged with the resolved identity, tool name, arguments, duration, and
outcome.

The sync is idempotent and never writes back: assignments that disappear
upstream are marked stale rather than deleted, and every course-grade change is
appended to a grade-history table.

### Dashboard

| Method | Path | Input | Result |
|---|---|---|---|
| `GET` | `/gradebook` | `?student=stu_…` or name; `?term=trm_…`; `?view=courses\|missing` | Student tabs, term picker (opens on the period in progress), course cards with every assignment, or the cross-course missing table. |
| `POST` | `/gradebook/sync` | — | `303` back to `/gradebook` with a banner: synced, joined an in-flight run, cooled down, or the failure. |

The Sync button refuses to start a fresh run within 60 seconds of the last one.
It is an unauthenticated button that performs a real district login, so this
keeps anyone who can reach the port from hammering ParentVUE into an account
lockout.

## Authentication

The MCP endpoint requires **exactly one** of these modes; the process refuses
to start with both or neither.

**Bearer token** (`MCP_BEARER_TOKEN`). Clients send
`Authorization: Bearer <token>`. Comparison is constant-time. Use this behind
any TLS reverse proxy or private overlay network.

**Cloudflare Access** (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`,
`ALLOWED_SERVICE_TOKENS`). The origin verifies the `Cf-Access-Jwt-Assertion`
JWT that Access injects (signature against the team's JWKS, issuer, audience)
and then checks the email or service-token Client ID against the allowlists.
Use this when an identity-aware proxy fronts the server and you want per-user
identities in the audit log. `ACCESS_TEAM_DOMAIN` must include the scheme and
no trailing slash; `ALLOWED_SERVICE_TOKENS` takes Client IDs, not display
names.

In both modes the origin's `401` is deliberately bare, with no
`WWW-Authenticate` challenge: this server serves no OAuth discovery document,
so a challenge would point clients at something that does not exist. If you
want OAuth for MCP clients, let the identity-aware proxy provide it at the
edge.

`401` means missing or invalid credentials; `403` means a valid Access JWT
whose identity is not on an allowlist. Both are logged.

## Exposing it from a home lab

Both ports are published to `127.0.0.1` by default, and that is the right
starting point. The two listeners have very different trust levels, so treat
them separately.

### The MCP endpoint (`PORT`, default 3000)

It is authenticated, so it *can* face the Internet — but only behind something
that terminates TLS and, ideally, limits abuse. Three patterns that work:

- **Identity-aware proxy or tunnel.** A product that authenticates the caller
  at its edge and injects a verifiable identity header. Configure the
  Cloudflare Access mode (or adapt `src/auth/` for a similar product), keep
  `MCP_BIND_ADDR` on loopback, and point the tunnel connector at the container.
  Per-user identities show up in the audit log, and the proxy can offer OAuth
  to MCP clients so they need no configured secret.
- **Private overlay network.** Tailscale, WireGuard, ZeroTier, or a VPN. Set
  `MCP_BIND_ADDR` to the host's overlay address (or serve it over the overlay's
  own HTTPS feature), use bearer-token mode, and nothing is reachable from the
  public Internet at all. Hosted MCP clients cannot reach an overlay-only
  address; local clients on the same overlay can.
- **Plain TLS reverse proxy on a public hostname.** Caddy, nginx, Traefik, or
  similar with a real certificate, proxying to `127.0.0.1:3000`. Use
  bearer-token mode, add rate limiting at the proxy, and consider restricting
  source IPs if your clients have stable ones.

Whatever you choose, never publish port 3000 directly (`MCP_BIND_ADDR=0.0.0.0`
on a router-forwarded box) without TLS in front of it: the bearer token would
travel in the clear.

MCP clients (Claude, ChatGPT, and others that support remote MCP servers)
point at `https://<your-hostname>/mcp`. In bearer mode configure the
`Authorization: Bearer …` header on the client; in Access mode leave the client
credential-less and let the proxy run the OAuth flow.

### The dashboard (`UI_PORT`, default off)

It is **unauthenticated by design** — a server-rendered page for a phone on the
couch. Anyone who can reach the port can read every student's grades and
trigger a district login. Reach it only over a network you already trust:

- your LAN, with `UI_BIND_ADDR` left on loopback and a LAN-only reverse proxy,
  or set to the host's LAN address;
- a private overlay network (`UI_BIND_ADDR` set to the overlay address, or the
  overlay's own HTTPS serving feature pointed at `127.0.0.1:3001`);
- a VPN into the home network.

Never route a tunnel or public hostname to `UI_PORT`. The server logs an error
and returns 403 when a dashboard request arrives carrying Cloudflare edge
headers, but that is a misconfiguration alarm, not a security control: the
headers are spoofable. If your tunnel connector runs in Docker on the same
host, keep it off the network that carries `gradebook-mcp` — Docker cannot
bind a listener per network, so a connector that can reach the container can
reach the dashboard port regardless of the host binding.

## Automatic sync and district terms

The in-process scheduler is **off by default**. Some districts' ParentVUE
terms of use prohibit software that logs in automatically; read your
district's terms and decide. Manual syncs from the dashboard button or
`gradebook_sync` are always available.

To opt in, set `GRADEBOOK_SYNC_ENABLED=true`. The first run lands 2–7 minutes
after startup (jittered) and each subsequent one `GRADEBOOK_SYNC_INTERVAL_HOURS`
after the previous finishes. Restarting the container restarts that clock.

At startup the log states whether the scheduler armed, and why not when it did
not:

```
gradebook automatic sync is ON: scheduler armed        firstSyncInSeconds=269 intervalHours=24
gradebook automatic sync is OFF: GRADEBOOK_SYNC_ENABLED is not true
gradebook automatic sync is OFF: ParentVUE is not configured
gradebook automatic sync is OFF: GRADEBOOK_SYNC_INTERVAL_HOURS is 0
```

Each scheduled run logs `gradebook scheduled sync finished` with its outcome.
`gradebook_status` reports the same from the other side, and states the last
*automatic* sync separately from the last sync of any kind, so a manual sync
cannot mask a scheduler that has never fired. Every run records what started
it (`scheduled`, `mcp`, `dashboard`); only one sync runs at a time, and
callers arriving mid-run join it rather than racing its stale-marking.

To read the ledger directly:

```sh
docker compose exec gradebook-mcp node --disable-warning=ExperimentalWarning -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/gradebook.sqlite',{readOnly:true});console.table(db.prepare('SELECT id,started_at,status,triggered_by FROM sync_runs ORDER BY id DESC LIMIT 10').all())"
```

## Backup and restore

The database is on a Docker named volume in WAL mode, so copying the `.sqlite`
file alone yields a stale or unopenable backup. `scripts/backup.sh` takes a
consistent copy through the running container with `VACUUM INTO`, verifies it
with `PRAGMA integrity_check`, checks an MD5 across the transfer, and prunes
old copies:

```sh
BACKUP_DIR=/path/to/backups KEEP_DAYS=14 scripts/backup.sh
```

`CONTAINER` (default `gradebook-mcp`), `BACKUP_DIR` (default `./backups`), and
`KEEP_DAYS` (default 14) are the knobs. It exits non-zero if the backup fails
and skips pruning on failure so it can never retire the last good copy. A
nightly cron entry, timed clear of your sync window:

```
20 3 * * * BACKUP_DIR=/path/to/backups /path/to/gradebook-mcp/scripts/backup.sh >> /path/to/backups/backup.log 2>&1
```

To restore, stop the service, replace the database through a throwaway
container, and start again. Dropping the stale `-wal` and `-shm` files is what
makes the restore correct:

```sh
docker compose down
docker run --rm --user 1000:1000 \
  -v gradebook_gradebook-data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c "rm -f /data/gradebook.sqlite /data/gradebook.sqlite-wal /data/gradebook.sqlite-shm && cp /backup/gradebook-<timestamp>.sqlite /data/gradebook.sqlite"
docker compose up -d
```

`gradebook_gradebook-data` is Compose's default volume name when the checkout
directory is `gradebook`; adjust the prefix to your directory or
`COMPOSE_PROJECT_NAME`. **Do not run `docker compose down -v`** unless you mean
to destroy the volume and all of its data.

## Local development

```sh
npx pnpm@12.3.4 install     # or `pnpm install` with a matching pnpm
cp .env.example .env
```

The pnpm version is pinned via `packageManager` in `package.json`; pnpm 12
enforces a `minimumReleaseAge` supply-chain policy by default, and a mismatched
pnpm can resolve a lockfile the Docker build then rejects.

For local iteration without any auth, set in `.env`:

```sh
NODE_ENV=development
HOST=127.0.0.1
DEV_INSECURE_NO_AUTH=true
UI_PORT=3001
```

`DEV_INSECURE_NO_AUTH` is only honored when `NODE_ENV` is not `production`
**and** the server is bound to `127.0.0.1` or `::1`. It is a no-op otherwise,
and a loud warning is logged whenever it is active. Never set it in Compose.

```sh
pnpm dev        # tsx watch
pnpm build      # tsc → dist/
pnpm test       # vitest
```

Smoke test with curl (stateless Streamable HTTP, no session header needed):

```sh
curl http://127.0.0.1:3000/healthz

curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect the eight `gradebook_*` tools. In bearer mode add
`-H 'Authorization: Bearer <token>'`. Any MCP client or the MCP Inspector can
be pointed at `http://127.0.0.1:3000/mcp` the same way.

## Repo layout

```
src/
  index.ts                 bootstrap: config → MCP app + optional dashboard → listen
  config.ts                zod-validated env config
  server.ts                express app: /healthz, /mcp
  audit.ts                 wraps tool handlers: logs identity, tool, args, duration, outcome
  auth/
    middleware.ts          picks exactly one auth mode at startup
    bearerToken.ts         Authorization: Bearer, constant-time compare
    cloudflareAccess.ts    verify Cf-Access-Jwt-Assertion, allowlists
    identity.ts            Identity type
  storage/sqlite.ts        SQLite open, migrations, transactions (node:sqlite)
  ui/                      dashboard app, document shell, HTML escaping, CSP + cross-origin checks
  modules/
    types.ts               module interface (MCP register + optional dashboard router)
    gradebook/             tools, store, sync, scheduler, migrations, dashboard views
  lib/parentvue/           standalone ParentVUE mobile-API client
scripts/backup.sh          consistent SQLite backup through the container
test/                      auth, config, dashboard, and security middleware tests
```

## Security notes

- The dashboard is unauthenticated and isolated only by its own port. Keep it
  on private networks; never expose it to the Internet.
- Stateless Streamable HTTP: a fresh `McpServer` and transport per request, so
  there is no session state to lose behind a proxy and no SSE affinity
  concern.
- The dashboard sends a strict CSP (nonce-only scripts and styles), refuses
  cross-origin writes using `Sec-Fetch-Site`/`Origin`, and is served with
  `Cache-Control: no-store`.
- Credentials never appear in logs or error messages; the ParentVUE client's
  errors carry a code, not the response body.
- The container runs read-only, with all capabilities dropped and
  `no-new-privileges`, as a non-root user.
- Blast radius of the MCP tools is the local snapshot only. `gradebook_sync`
  performs a district login; everything else reads SQLite.

## License

MIT — see [LICENSE](LICENSE).
