#!/usr/bin/env bash
# M24: logical PostgreSQL backup for the current Docker Compose deployment.
# The script reads the existing db container; it never stops or mutates it.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

fail() { echo "backup: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# M25.2 concurrency guard
#
# A logical backup is a multi-step operation against one database. Two
# overlapping runs would race on artefact names and could publish a partially
# written dump. A lock directory is used rather than flock(1) so the guard also
# works on the minimal shells this repository is developed against, where flock
# is not present. The lock is released by the EXIT trap on success, on error
# and on SIGINT/SIGTERM; a process killed with SIGKILL cannot run any trap, so
# the PID liveness check reclaims the lock it leaves behind.
# ---------------------------------------------------------------------------
# 75 is EX_TEMPFAIL: another instance holds the lock, retry later.
EXIT_LOCKED=75
# Resolved after BACKUP_DIR_ABS is known; an override may still be supplied.
LOCK_DIR="${BACKUP_LOCK_DIR:-}"
LOCK_GRACE_SECONDS="${BACKUP_LOCK_GRACE_SECONDS:-120}"
LOCK_HELD=""

lock_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

lock_holder_pid() {
  [[ -f "$LOCK_DIR/pid" ]] || return 0
  tr -dc '0-9' < "$LOCK_DIR/pid" 2>/dev/null || true
}

write_lock_files() {
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_DIR/acquired_at"
}

release_lock() {
  [[ "$LOCK_HELD" == "1" ]] || return 0
  rm -rf "$LOCK_DIR"
  LOCK_HELD=""
  return 0
}

acquire_lock() {
  local holder dir_age
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    write_lock_files
    LOCK_HELD=1
    return 0
  fi

  holder="$(lock_holder_pid)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    return 1
  fi

  # Without a readable holder, only reclaim once the directory is older than the
  # grace period: a just-created lock may simply not have written its pid yet.
  if [[ -z "$holder" ]]; then
    dir_age=$(( $(date +%s) - $(lock_mtime "$LOCK_DIR") ))
    [[ "$dir_age" -ge "$LOCK_GRACE_SECONDS" ]] || return 1
  fi

  echo "backup: reclaiming stale lock (holder pid=${holder:-unknown}, age=${dir_age:-0}s)" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  write_lock_files
  LOCK_HELD=1
  return 0
}

# Git Bash/MSYS rewrites POSIX-looking arguments passed to native Windows
# executables. Keep paths that belong inside the container untouched.
docker_exec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[[ -n "$BACKUP_DIR" ]] || fail "set BACKUP_DIR to an external/protected directory"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a non-negative integer"
# M25.5: the lock grace period used to be consumed unvalidated. A non-numeric
# value made the arithmetic comparison fail, so acquire_lock reported "busy"
# forever even with no backup running: a configuration typo disguised as
# concurrency. Reject it explicitly instead of degrading silently. 0 stays
# valid (immediate reclaim); negatives are rejected because they would make every
# lock look expired the moment it appears.
[[ "$LOCK_GRACE_SECONDS" =~ ^[0-9]+$ ]] || fail "BACKUP_LOCK_GRACE_SECONDS must be a non-negative integer (got: $LOCK_GRACE_SECONDS)"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd -P)"
ROOT_ABS="$(cd "$ROOT_DIR" && pwd -P)"
if [[ "${ALLOW_LOCAL_BACKUP:-0}" != "1" && ( "$BACKUP_DIR_ABS" == "$ROOT_ABS" || "$BACKUP_DIR_ABS" == "$ROOT_ABS/"* ) ]]; then
  fail "BACKUP_DIR must be outside the repository (or explicitly opt in for a drill)"
fi

[[ -n "$LOCK_DIR" ]] || LOCK_DIR="$BACKUP_DIR_ABS/.m24-backup.lock"

if ! acquire_lock; then
  echo "backup: another backup already holds $LOCK_DIR (pid $(lock_holder_pid || true)); not starting" >&2
  echo "backup: if no backup is actually running, remove $LOCK_DIR and retry" >&2
  exit "$EXIT_LOCKED"
fi

# M25.5: a backup killed with SIGKILL cannot run its trap, so its temporary
# directory survives forever. Retention only deletes regular files named
# m24-postgres-*, so those directories were never collected: a daily failing
# backup leaked one directory per run with no alarm. Only directories that are
# demonstrably not in use are reclaimed. The lock is already held here, so no
# other backup can own a temporary directory in this BACKUP_DIR.
reclaim_orphan_temp_dirs() {
  local dir age
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    age=$(( $(date +%s) - $(lock_mtime "$dir") ))
    if [[ "$age" -ge 86400 ]]; then
      echo "backup: removing orphaned temporary directory $(basename "$dir") (age ${age}s)" >&2
      rm -rf "$dir"
    fi
  done < <(find "$BACKUP_DIR_ABS" -maxdepth 1 -type d -name '.m24-tmp.*' 2>/dev/null || true)
}
reclaim_orphan_temp_dirs

# Installed before any work so the lock is released on every exit path,
# including a failure that happens before db_id and remote_dump exist.
cleanup() {
  if [[ -n "${db_id:-}" && -n "${remote_dump:-}" ]]; then
    docker_exec "$db_id" rm -f "$remote_dump" >/dev/null 2>&1 || true
  fi
  if [[ -n "${tmp_dir:-}" ]]; then
    rm -rf "$tmp_dir"
  fi
  release_lock
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then COMPOSE_ARGS+=(-p "$COMPOSE_PROJECT_NAME"); fi
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

db_id="$(compose ps -q db)"
[[ -n "$db_id" ]] || fail "the Compose db service is not running"
compose exec -T db true >/dev/null

# mktemp guarantees an unused name, so its random suffix makes the artefact base
# unique even when two runs land in the same wall-clock second. The lock above
# serialises runs; this suffix removes the remaining same-second collision when a
# backup is repeated immediately.
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_dir="$(mktemp -d "$BACKUP_DIR/.m24-tmp.XXXXXX")"
run_suffix="${tmp_dir##*.}"
[[ -n "$run_suffix" && "$run_suffix" != "$tmp_dir" ]] || fail "could not derive a unique run suffix from $tmp_dir"
base="m24-postgres-$timestamp-$run_suffix"
remote_dump="/tmp/$base.dump"

dump_tmp="$tmp_dir/$base.dump"
roles_tmp="$tmp_dir/$base.roles.sql"
compose exec -T db sh -ceu 'exec pg_dump --format=custom --compress=9 --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' > "$dump_tmp"
compose exec -T db sh -ceu 'exec pg_dumpall --roles-only --no-role-passwords --username="$POSTGRES_USER"' > "$roles_tmp"
[[ -s "$dump_tmp" && -s "$roles_tmp" ]] || fail "dump or role export is empty"

# Validate the custom archive before publishing it.
docker cp "$dump_tmp" "$db_id:$remote_dump" >/dev/null
docker_exec "$db_id" pg_restore --list "$remote_dump" >/dev/null

sha256() { sha256_of "$1"; }
dump_sha="$(sha256 "$dump_tmp")"
roles_sha="$(sha256 "$roles_tmp")"
for pair in "dump:$dump_sha" "roles:$roles_sha"; do
  is_sha256 "${pair#*:}" || fail "computed ${pair%%:*} checksum is not a 64-character hex digest"
done
db_user="$(compose exec -T db printenv POSTGRES_USER | tr -d '\r\n')"
db_name="$(compose exec -T db printenv POSTGRES_DB | tr -d '\r\n')"
pg_version="$(compose exec -T db postgres --version | tr -d '\r' | head -n 1)"
count_lines=""
for table in organizations users sources findings scans audit_events; do
  count="$(compose exec -T db sh -ceu "psql --username=\"\$POSTGRES_USER\" --dbname=\"\$POSTGRES_DB\" --tuples-only --no-align --command=\"SELECT count(*) FROM \\\"$table\\\";\"" | tr -d '\r\n')"
  [[ "$count" =~ ^[0-9]+$ ]] || fail "could not read row count for $table"
  count_lines+="count_${table}=${count}"$'\n'
done
migration_count="$(compose exec -T db sh -ceu 'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="SELECT count(*) FROM drizzle.__drizzle_migrations;"' | tr -d '\r\n')"
[[ "$migration_count" =~ ^[0-9]+$ ]] || fail "could not read migration count"
# M25.5 — fingerprint of the migration journal. Drizzle stores sha256 of each
# migration file, but it decides "already applied" by created_at and never
# compares the hash, so an edited migration is silently skipped and the restored
# schema silently diverges. The aggregate makes that state verifiable.
migration_journal_sha="$(journal_sha256_of "$db_id" "$db_user" "$db_name")"
is_sha256 "$migration_journal_sha" || fail "could not compute a valid migration journal digest"

# M25.3 — fingerprint de SOURCE_ENCRYPTION_KEY (sha256 de la clave derivada).
# El proceso de backup NO tiene la clave: se calcula dentro del contenedor `api`,
# que sí la tiene en su entorno, y solo sale la huella. La clave cruda nunca
# llega al host ni al manifest. Si `api` no está en marcha, el campo se omite y
# el restore lo tratará como desconocido (compatibilidad con backups M24).
source_key_fingerprint=""
api_id="$(compose ps -q api 2>/dev/null || true)"
if [[ -n "$api_id" ]]; then
  source_key_fingerprint="$(docker_exec "$api_id" node -e '
    const c = require("node:crypto");
    const k = process.env.SOURCE_ENCRYPTION_KEY;
    if (!k) process.exit(1);
    process.stdout.write(
      c.createHash("sha256").update(c.createHash("sha256").update(k).digest()).digest("hex"),
    );
  ' 2>/dev/null | tr -d '\r\n' || true)"
  if [[ ! "$source_key_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    source_key_fingerprint=""
  fi
fi
fingerprint_line=""
if [[ -n "$source_key_fingerprint" ]]; then
  fingerprint_line="source_key_fingerprint=${source_key_fingerprint}"$'\n'
fi

mv "$dump_tmp" "$BACKUP_DIR_ABS/$base.dump"
mv "$roles_tmp" "$BACKUP_DIR_ABS/$base.roles.sql"
cat > "$BACKUP_DIR_ABS/$base.manifest" <<EOF
format=pg_dump-custom
created_at=$timestamp
database=$db_name
database_user=$db_user
postgres_version=$pg_version
owner_commands=omitted
role_passwords=omitted
dump_file=$base.dump
roles_file=$base.roles.sql
dump_sha256=$dump_sha
roles_sha256=$roles_sha
migration_count=$migration_count
migration_journal_sha256=$migration_journal_sha
$fingerprint_line$count_lines
EOF
chmod 600 "$BACKUP_DIR_ABS/$base.dump" "$BACKUP_DIR_ABS/$base.roles.sql" "$BACKUP_DIR_ABS/$base.manifest"

find "$BACKUP_DIR_ABS" -maxdepth 1 -type f -name 'm24-postgres-*' -mtime "+$RETENTION_DAYS" -delete
printf 'backup=%s\nroles=%s\nmanifest=%s\n' \
  "$BACKUP_DIR_ABS/$base.dump" \
  "$BACKUP_DIR_ABS/$base.roles.sql" \
  "$BACKUP_DIR_ABS/$base.manifest"
