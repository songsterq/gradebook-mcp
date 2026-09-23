#!/usr/bin/env bash
#
# Back up gradebook-mcp's SQLite database from the running container.
#
# The database lives on a Docker named volume, so the only supported way to
# read them is through the container. A live SQLite file cannot be copied
# directly: in WAL mode recent commits sit in <db>.sqlite-wal until a checkpoint
# folds them back, so VACUUM INTO is used to emit a single consistent,
# already-checkpointed file.
#
# The staged copy is written to the container's /tmp (a tmpfs) so it never
# enters the data volume. It is then streamed out with `docker exec cat`
# rather than `docker cp`, because `docker cp` cannot read from a tmpfs mount —
# it fails with "Could not find the file" even though the file is plainly there.
#
# Usage: scripts/backup.sh [--verbose]
# Env:   CONTAINER   container name            (default: gradebook-mcp)
#        BACKUP_DIR  destination directory     (default: ./backups)
#        KEEP_DAYS   prune backups older than  (default: 14)

set -euo pipefail

CONTAINER="${CONTAINER:-gradebook-mcp}"
# Relative to where it runs, not where the script lives: it is also used as a
# standalone download next to compose.yaml, outside any checkout.
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DATABASES=(gradebook)

VERBOSE=0
[[ "${1:-}" == "--verbose" ]] && VERBOSE=1

log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
note() { [[ $VERBOSE -eq 1 ]] && log "$*" || true; }
die()  { log "ERROR: $*" >&2; exit 1; }

# `docker exec` on a stopped container fails in ways that are easy to misread,
# so check first and say plainly what is wrong.
state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" \
  || die "container '$CONTAINER' not found"
[[ "$state" == "running" ]] || die "container '$CONTAINER' is '$state', not running"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
failed=0

for db in "${DATABASES[@]}"; do
  staged="/tmp/${db}-backup.sqlite"
  out="$BACKUP_DIR/${db}-${stamp}.sqlite"

  # A stale staged file would make VACUUM INTO refuse: it never overwrites.
  docker exec "$CONTAINER" rm -f "$staged"

  # Verify the file that was just written, not the one it was read from: the
  # point of the check is to refuse to keep a backup that cannot be opened.
  if ! docker exec "$CONTAINER" node --disable-warning=ExperimentalWarning -e "
      const {DatabaseSync} = require('node:sqlite');
      const source = new DatabaseSync('/data/${db}.sqlite', {readOnly: true});
      source.exec(\"VACUUM INTO '${staged}'\");
      source.close();
      const copy = new DatabaseSync('${staged}', {readOnly: true});
      const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
      if (check !== 'ok') { console.error('integrity_check: ' + check); process.exit(1); }
      copy.close();
    "; then
    log "ERROR: $db: VACUUM INTO failed"
    failed=1
    continue
  fi

  # Checksum inside the container, compare after streaming out: a truncated
  # transfer would otherwise land silently as a short, unopenable file.
  want="$(docker exec "$CONTAINER" md5sum "$staged" | cut -d' ' -f1)"

  if ! docker exec "$CONTAINER" cat "$staged" > "$out"; then
    log "ERROR: $db: could not stream backup out of container"
    rm -f "$out"
    docker exec "$CONTAINER" rm -f "$staged"
    failed=1
    continue
  fi
  docker exec "$CONTAINER" rm -f "$staged"

  got="$(md5sum "$out" | cut -d' ' -f1)"
  if [[ "$want" != "$got" ]]; then
    log "ERROR: $db: checksum mismatch (container=$want host=$got); removing $out"
    rm -f "$out"
    failed=1
    continue
  fi

  log "ok $db -> $(basename "$out") ($(du -h "$out" | cut -f1), md5 $got)"
done

# Prune only on a fully clean run. Pruning after a partial failure could retire
# the last good copy of a database that just failed to back up.
if [[ $failed -eq 0 ]]; then
  pruned=0
  while IFS= read -r -d '' old; do
    rm -f "$old"
    note "pruned $(basename "$old")"
    pruned=$((pruned + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*-*.sqlite' \
             -mtime "+$KEEP_DAYS" -print0)
  [[ $pruned -gt 0 ]] && log "pruned $pruned backup(s) older than $KEEP_DAYS days"
else
  log "skipping prune: at least one database failed to back up"
fi

[[ $failed -eq 0 ]] || die "one or more databases failed to back up"
log "backup complete -> $BACKUP_DIR"
