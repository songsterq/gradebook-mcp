# gradebook-mcp

ParentVUE shows grades one student, term, and course at a time. That makes a
simple question—**“What schoolwork needs attention?”**—surprisingly hard to
answer, especially for families with more than one child.

`gradebook-mcp` solves that problem by syncing ParentVUE into a local,
read-only SQLite snapshot. You can access it through either interface—or both:

- a phone-friendly dashboard for reading grades, assignments, and consolidated
  missing work; and
- an optional [MCP](https://modelcontextprotocol.io) server so AI assistants can
  answer questions about the same data.

Despite the package name, MCP is not required. The dashboard runs on its own
without an MCP endpoint or MCP authentication.

It never writes to ParentVUE. Data stays on your machine, and automatic sync is
off until you explicitly enable it.

## Quick start

Requirements: Docker with Compose and a ParentVUE parent account.

Choose the interfaces you want to run:

- **Dashboard only:** set `UI_PORT` and leave `PORT` blank. No MCP setup or
  authentication is needed.
- **MCP only:** set `PORT` and configure one MCP authentication mode.
- **Both:** set both ports and configure MCP authentication.

```sh
cp .env.example .env
```

To run both interfaces, generate a token with `openssl rand -hex 32`, then edit
`.env` and set:

```ini
GRADEBOOK_PARENTVUE_HOST=<district>.edupoint.com
GRADEBOOK_PARENTVUE_USER=you@example.com
GRADEBOOK_PARENTVUE_PASS=...

# Protect the MCP endpoint with one of the auth modes below.
MCP_BEARER_TOKEN=<random token>

# Enable the dashboard.
UI_PORT=3001
```

Start the service:

```sh
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Dashboard: `http://127.0.0.1:3001/gradebook`

Run the first sync with the dashboard's **Sync now** button or the
`gradebook_sync` MCP tool.

### Dashboard only

If you do not need MCP, leave `PORT` and all MCP authentication settings blank,
set `UI_PORT=3001`, and run (requires Compose v2.24 or newer):

```sh
docker compose -f compose.yaml -f compose.dashboard-only.yaml up -d --build
```

The dashboard is unauthenticated. Keep it on a trusted LAN, VPN, or private
overlay network such as Tailscale; never expose it to the public Internet.

## Optional MCP tools

The MCP server exposes eight tools:

| Tool | What it answers |
|---|---|
| `gradebook_missing` | What is missing, incomplete, or late across courses and students? |
| `gradebook_overview` | What are each student's current grades and missing-work counts? |
| `gradebook_courses` | What courses and grades does a student have for a term? |
| `gradebook_assignments` | What assignments and statuses are recorded for a course? |
| `gradebook_trend` | How has a course grade changed over time? |
| `gradebook_terms` | What school years and reporting periods are available? |
| `gradebook_sync` | Can you refresh the local snapshot now? |
| `gradebook_status` | Is syncing configured and healthy, and how much data is stored? |

Start with `gradebook_missing` for action items or `gradebook_overview` to find
student (`stu_...`) and course (`crs_...`) IDs. All tools read the local
snapshot except `gradebook_sync`, which logs in to ParentVUE and refreshes it.

The dashboard provides the same practical views: student and term selection,
course grades and assignments, consolidated missing work, sync status, and a
manual sync button.

## Configuration

Settings come from environment variables; a local `.env` file is loaded when
present. See [`.env.example`](.env.example) for descriptions and examples.

### Listeners and storage

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | blank | MCP port; blank disables MCP (`.env.example` uses `3000`). |
| `MCP_BIND_ADDR` | `127.0.0.1` | Host address where Compose publishes MCP. |
| `UI_PORT` | blank | Dashboard port; blank disables the dashboard. |
| `UI_BIND_ADDR` | `127.0.0.1` | Host address where Compose publishes the dashboard. |
| `DATA_DIR` | `./data` | SQLite directory (`/data` in Compose). |
| `TZ` | `UTC` | Timezone used to select the current reporting period. |
| `LOG_LEVEL` | `info` | Pino log level. |

At least one of `PORT` or `UI_PORT` must be set.

### ParentVUE and sync

| Variable | Default | Purpose |
|---|---|---|
| `GRADEBOOK_PARENTVUE_HOST` | — | District host without a scheme. |
| `GRADEBOOK_PARENTVUE_USER` | — | ParentVUE username. |
| `GRADEBOOK_PARENTVUE_PASS` | — | ParentVUE password. |
| `GRADEBOOK_STUDENTS` | all | Optional comma-separated student-name allowlist. |
| `GRADEBOOK_SYNC_ENABLED` | `false` | Enables automatic sync. |
| `GRADEBOOK_SYNC_INTERVAL_HOURS` | `24` | Time between automatic syncs; `0` disables them. |

Without all three ParentVUE credentials, the service still starts but cannot
sync. Manual syncs are always available when credentials are configured.

Before enabling automatic sync, check your district's terms: some districts
prohibit automated logins. When enabled, the first sync runs 2–7 minutes after
startup and later runs use the configured interval. Only one sync can run at a
time.

## Authentication and network safety

Authentication protects the MCP endpoint only. When MCP is enabled, configure
exactly one mode:

1. **Bearer token:** set `MCP_BEARER_TOKEN` to a random value of at least 16
   characters. Clients send `Authorization: Bearer <token>`.
2. **Cloudflare Access:** set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and at least
   one identity in `ALLOWED_EMAILS` or `ALLOWED_SERVICE_TOKENS`. The server
   verifies the Access JWT and its allowlist.

The two listeners have different trust boundaries:

- **MCP is authenticated.** For remote access, place it behind TLS using an
  identity-aware proxy, a private overlay such as Tailscale or WireGuard, or a
  TLS reverse proxy such as Caddy or nginx. Never send a bearer token over
  plain HTTP on a public network.
- **The dashboard is not authenticated.** Anyone who can reach it can read all
  stored grades and trigger a ParentVUE login. Restrict it to a trusted private
  network and never route a public hostname or tunnel to it.

Compose publishes both ports on loopback by default. Change the corresponding
`*_BIND_ADDR` only when the selected interface is private or another layer
provides the required protection.

## Data behavior

Syncs merge ParentVUE data into `gradebook.sqlite`. They do not write back to
the district. Assignments that disappear upstream are marked stale instead of
deleted, and course-grade and assignment-score changes are retained as history.
Each student's overview carries a "What's new" summary — new assignments, score
changes, and work that newly went missing — that stays in place until a later
sync brings something newer.

Every MCP call is audit-logged with the resolved identity, tool, arguments,
duration, and outcome. Sync runs also record their trigger and result. The
dashboard limits new sync attempts to one per minute to reduce the risk of a
ParentVUE account lockout.

## Backup and restore

The database uses SQLite WAL mode, so do not back up only the `.sqlite` file
while the service is running. Use the included consistent-backup script:

```sh
BACKUP_DIR=/path/to/backups KEEP_DAYS=14 scripts/backup.sh
```

It creates and verifies a snapshot through the running container and removes
successful backups older than `KEEP_DAYS`. `CONTAINER` defaults to
`gradebook-mcp`; `BACKUP_DIR` defaults to `./backups`.

To restore, stop the service and replace the database plus its WAL files in the
named volume:

```sh
docker compose down
docker run --rm --user 1000:1000 \
  -v gradebook_gradebook-data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c "rm -f /data/gradebook.sqlite /data/gradebook.sqlite-wal /data/gradebook.sqlite-shm && cp /backup/gradebook-<timestamp>.sqlite /data/gradebook.sqlite"
docker compose up -d
```

Adjust the volume prefix if your checkout directory or `COMPOSE_PROJECT_NAME`
differs. Do not run `docker compose down -v` unless you intend to delete all
stored data.

## Local development

Requires Node.js 22.16 or newer and pnpm 12.3.4.

```sh
npx pnpm@12.3.4 install
cp .env.example .env
pnpm dev
```

For dashboard-only development, set:

```ini
PORT=
UI_PORT=3001
UI_HOST=127.0.0.1
```

For local MCP development without authentication, set:

```ini
NODE_ENV=development
HOST=127.0.0.1
DEV_INSECURE_NO_AUTH=true
```

The bypass works only outside production on a loopback address.

```sh
pnpm build
pnpm test
```

The ParentVUE client is a zero-dependency package in
[`src/lib/parentvue`](src/lib/parentvue) with its own documentation and tests.

## License

MIT — see [LICENSE](LICENSE).
