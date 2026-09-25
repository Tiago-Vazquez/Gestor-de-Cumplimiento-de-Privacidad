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
# Git Bash/MSYS rewrites POSIX-looking arguments passed to native Windows
# executables. Keep paths that belong inside the container untouched.
docker_exec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[[ -n "$BACKUP_DIR" ]] || fail "set BACKUP_DIR to an external/protected directory"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a non-negative integer"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd -P)"
ROOT_ABS="$(cd "$ROOT_DIR" && pwd -P)"
if [[ "${ALLOW_LOCAL_BACKUP:-0}" != "1" && ( "$BACKUP_DIR_ABS" == "$ROOT_ABS" || "$BACKUP_DIR_ABS" == "$ROOT_ABS/"* ) ]]; then
  fail "BACKUP_DIR must be outside the repository (or explicitly opt in for a drill)"
fi

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then COMPOSE_ARGS+=(-p "$COMPOSE_PROJECT_NAME"); fi
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

db_id="$(compose ps -q db)"
[[ -n "$db_id" ]] || fail "the Compose db service is not running"
compose exec -T db true >/dev/null

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="m24-postgres-$timestamp"
tmp_dir="$(mktemp -d "$BACKUP_DIR/.m24-tmp.XXXXXX")"
remote_dump="/tmp/$base.dump"
cleanup() {
  docker_exec "$db_id" rm -f "$remote_dump" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

dump_tmp="$tmp_dir/$base.dump"
roles_tmp="$tmp_dir/$base.roles.sql"
compose exec -T db sh -ceu 'exec pg_dump --format=custom --compress=9 --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' > "$dump_tmp"
compose exec -T db sh -ceu 'exec pg_dumpall --roles-only --no-role-passwords --username="$POSTGRES_USER"' > "$roles_tmp"
[[ -s "$dump_tmp" && -s "$roles_tmp" ]] || fail "dump or role export is empty"

# Validate the custom archive before publishing it.
docker cp "$dump_tmp" "$db_id:$remote_dump" >/dev/null
docker_exec "$db_id" pg_restore --list "$remote_dump" >/dev/null

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
dump_sha="$(sha256 "$dump_tmp")"
roles_sha="$(sha256 "$roles_tmp")"
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
$count_lines
EOF
chmod 600 "$BACKUP_DIR_ABS/$base.dump" "$BACKUP_DIR_ABS/$base.roles.sql" "$BACKUP_DIR_ABS/$base.manifest"

find "$BACKUP_DIR_ABS" -maxdepth 1 -type f -name 'm24-postgres-*' -mtime "+$RETENTION_DAYS" -delete
printf 'backup=%s\nroles=%s\nmanifest=%s\n' \
  "$BACKUP_DIR_ABS/$base.dump" \
  "$BACKUP_DIR_ABS/$base.roles.sql" \
  "$BACKUP_DIR_ABS/$base.manifest"
