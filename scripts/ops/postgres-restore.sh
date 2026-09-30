#!/usr/bin/env bash
# M24: restore a logical backup into a clean, isolated PostgreSQL 16 Compose project.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${RESTORE_COMPOSE_FILE:-$ROOT_DIR/scripts/ops/docker-compose.restore.yml}"
PROJECT_NAME="${RESTORE_PROJECT_NAME:-m24-restore}"
TARGET_USER="${RESTORE_POSTGRES_USER:-restore_admin}"
TARGET_DB="${RESTORE_POSTGRES_DB:-privacy_restore}"
KEEP_TARGET="${RESTORE_KEEP:-0}"
BACKUP_FILE=""
ROLES_FILE=""
MANIFEST_FILE=""

usage() {
  cat <<'EOF'
Usage: bash scripts/ops/postgres-restore.sh --backup FILE [--roles FILE] [--manifest FILE]
Required environment: RESTORE_CONFIRM=RESTORE, RESTORE_POSTGRES_PASSWORD,
RESTORE_APP_ROLE_PASSWORD, RESTORE_BG_ROLE_PASSWORD, RESTORE_JWT_SECRET (>=32),
RESTORE_SOURCE_ENCRYPTION_KEY (>=32).
Optional: RESTORE_PROJECT_NAME, RESTORE_POSTGRES_USER, RESTORE_POSTGRES_DB,
RESTORE_API_PORT, RESTORE_KEEP=1, RESTORE_API_IMAGE, RESTORE_MIGRATE_IMAGE.
EOF
}
fail() { echo "restore: $*" >&2; exit 1; }
# Keep container-local POSIX paths intact when invoked from Git Bash/MSYS.
docker_exec() { MSYS_NO_PATHCONV=1 docker exec "$@"; }
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
while (($#)); do
  case "$1" in
    --backup) [[ $# -ge 2 ]] || fail "--backup needs a file"; BACKUP_FILE="$2"; shift 2 ;;
    --roles) [[ $# -ge 2 ]] || fail "--roles needs a file"; ROLES_FILE="$2"; shift 2 ;;
    --manifest) [[ $# -ge 2 ]] || fail "--manifest needs a file"; MANIFEST_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]] || fail "--backup must point to an existing dump"
[[ "$KEEP_TARGET" == 0 || "$KEEP_TARGET" == 1 ]] || fail "RESTORE_KEEP must be 0 or 1"
[[ "${RESTORE_CONFIRM:-}" == RESTORE ]] || fail "set RESTORE_CONFIRM=RESTORE after reviewing the target project"
for name in RESTORE_POSTGRES_PASSWORD RESTORE_APP_ROLE_PASSWORD RESTORE_BG_ROLE_PASSWORD RESTORE_JWT_SECRET RESTORE_SOURCE_ENCRYPTION_KEY; do
  [[ -n "${!name-}" ]] || fail "$name is required"
done
[[ ${#RESTORE_JWT_SECRET} -ge 32 ]] || fail "RESTORE_JWT_SECRET must be at least 32 characters"
# M25.5: this is the earliest structural check. It cannot tell whether the key
# belongs to this backup, because that comparison needs sha256(sha256(key)) and
# so runs inside the migrate container later, where it aborts before anything is
# declared usable. Failing here instead just avoids wasting an image build.
[[ ${#RESTORE_SOURCE_ENCRYPTION_KEY} -ge 32 ]] || fail "RESTORE_SOURCE_ENCRYPTION_KEY must be at least 32 characters and must be the key that encrypted this backup (M25.3 verifies it before the restore is declared usable)"

BACKUP_FILE="$(cd "$(dirname "$BACKUP_FILE")" && pwd -P)/$(basename "$BACKUP_FILE")"
# M27.0: `base` carries the directory here, unlike in offhost-upload.sh where it
# is an object key component and an absolute path would escape the credential's
# namePrefix. Here the expansion is only used to reach sibling files, so an
# absolute sibling path was always correct. It is normalised anyway so the same
# variable means the same thing in both scripts, and so a caller that later
# reuses `base` for anything other than a local path does not inherit a
# surprise. Deriving the siblings from the captured directory keeps them
# absolute and identical to the previous behaviour.
backup_dir="$(dirname "$BACKUP_FILE")"
base="$(basename "${BACKUP_FILE%.dump}")"
ROLES_FILE="${ROLES_FILE:-$backup_dir/${base}.roles.sql}"
MANIFEST_FILE="${MANIFEST_FILE:-$backup_dir/${base}.manifest}"
[[ -f "$ROLES_FILE" ]] || fail "roles export not found: $ROLES_FILE"
[[ -f "$MANIFEST_FILE" ]] || fail "manifest not found: $MANIFEST_FILE"
ROLES_SQL_FILE="${RESTORE_ROLES_SQL:-$ROOT_DIR/scripts/ops/restore-roles.sql}"
[[ -f "$ROLES_SQL_FILE" ]] || fail "safe role bootstrap not found: $ROLES_SQL_FILE"
cd "$ROOT_DIR"
if [[ "$COMPOSE_FILE" != /* ]]; then COMPOSE_FILE="$ROOT_DIR/$COMPOSE_FILE"; fi
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

sha256() { sha256_of "$1"; }
# M25.5: trailing CR is stripped by strip_cr so a manifest edited on Windows and
# restored on Linux behaves identically. MSYS awk already discards it, but Linux
# awk does not, and the same manifest would otherwise be accepted on one host
# and rejected on the other.
manifest_value() { strip_cr "$(awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST_FILE")"; }
# M25.5: read a manifest hash, drop the historical leading backslash and require a
# well-formed digest. Comparing a malformed value would otherwise be reported as
# a plain "checksum mismatch", hiding the real cause.
read_manifest_sha() {
  local raw normalized
  raw="$(manifest_value "$1")"
  [[ -n "$raw" ]] || fail "manifest lacks $1"
  normalized="$(strip_sha_prefix "$raw")"
  is_sha256 "$normalized" || fail "manifest $1 is not a valid 64-character SHA-256"
  printf '%s' "$normalized"
}
verify_sha() {
  local file="$1" key="$2" expected actual
  expected="$(read_manifest_sha "$key")"
  actual="$(sha256 "$file")"
  is_sha256 "$actual" || fail "computed checksum for $file is not a valid SHA-256"
  [[ "$actual" == "$expected" ]] || fail "checksum mismatch for $file"
}
verify_sha "$BACKUP_FILE" dump_sha256
verify_sha "$ROLES_FILE" roles_sha256
# The roles export is retained as a checksum-protected inventory artifact.
# It is NOT executed: it contains cluster-level role definitions. Runtime
# roles are created by the reviewed, least-privilege bootstrap below.

export RESTORE_POSTGRES_USER="$TARGET_USER" RESTORE_POSTGRES_DB="$TARGET_DB"
COMPOSE_ARGS=(-p "$PROJECT_NAME" -f "$COMPOSE_FILE")
restore_compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atqc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

existing_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME")"
existing_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME")"
if [[ -n "$existing_containers" || -n "$existing_volumes" ]]; then
  [[ "${RESTORE_REPLACE:-0}" == 1 ]] || fail "restore project/volume already exists; use a new project or explicitly set RESTORE_REPLACE=1"
  echo "restore: replacing existing project resources because RESTORE_REPLACE=1" >&2
  restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
fi
db_id=""
cleanup() {
  if [[ -n "$db_id" ]]; then
    docker_exec "$db_id" rm -f "/tmp/$(basename "$BACKUP_FILE")" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TARGET" != 1 ]]; then
    restore_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "restore: starting isolated PostgreSQL project $PROJECT_NAME"
restore_compose up -d db
db_id="$(restore_compose ps -q db)"
[[ -n "$db_id" ]] || fail "restore database container did not start"
wait_for_postgres || fail "restore PostgreSQL did not become ready"
nonempty="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p');")"
[[ "$nonempty" == 0 ]] || fail "target database is not empty; use a new volume/project for a safe restore"

# The exported role file is inventory only; create least-privilege runtime roles.
docker_exec -i "$db_id" psql -v ON_ERROR_STOP=1 -U "$TARGET_USER" -d "$TARGET_DB" < "$ROLES_SQL_FILE" >/dev/null
remote="/tmp/$(basename "$BACKUP_FILE")"
docker cp "$BACKUP_FILE" "$db_id:$remote" >/dev/null
docker_exec "$db_id" pg_restore --list "$remote" >/dev/null
echo "restore: applying database archive"
docker_exec "$db_id" pg_restore --exit-on-error --single-transaction --no-owner --username="$TARGET_USER" --dbname="$TARGET_DB" "$remote"
docker_exec "$db_id" rm -f "$remote"

# --- M25.5: integridad del journal, ANTES de migrar ------------------------
#
# Se compara aqui, y no despues, a proposito. Si el restore migra hacia adelante
# un dump antiguo, el journal crece y la comparacion siempre fallaria, rompiendo
# justamente la recuperacion de backups viejos, que es el proposito del DR.
# Tras migrar se conserva la comprobacion de migration_count como garantia
# adicional de completitud.
verify_migration_journal() {
  local expected actual
  expected="$(strip_sha_prefix "$(manifest_value migration_journal_sha256 || true)")"
  if [[ -z "$expected" ]]; then
    echo "restore: WARNING manifest has no migration_journal_sha256 (backup predates M25.5);" >&2
    echo "restore: WARNING only the migration count will be verified" >&2
    return 0
  fi
  is_sha256 "$expected" || fail "manifest migration_journal_sha256 is not a valid 64-character SHA-256"
  actual="$(journal_sha256_of "$db_id" "$TARGET_USER" "$TARGET_DB")"
  [[ "$actual" == "$expected" ]] \
    || fail "migration journal mismatch: the restored database does not match this backup (expected $expected, got $actual)"
  echo "verified migration journal sha256=$actual"
}

# Deteccion de deriva codigo <-> datos. Solo aviso: restaurar un backup antiguo
# es precisamente lo que debe permitir el DR, asi que una divergencia con los
# .sql actuales informa, pero nunca bloquea la recuperacion. Drizzle decide
# "ya aplicada" por created_at y nunca compara el hash, de modo que una
# migracion editada se omite en silencio: este aviso es la unica señal.
warn_on_migration_drift() {
  local dir="$ROOT_DIR/lib/db/drizzle"
  [[ -d "$dir" ]] || return 0
  local journal_hashes file_hashes missing
  journal_hashes="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc \
    "SELECT DISTINCT hash FROM drizzle.__drizzle_migrations ORDER BY hash;" 2>/dev/null || true)"
  [[ -n "$journal_hashes" ]] || return 0
  file_hashes="$(for f in "$dir"/*.sql; do [[ -f "$f" ]] && sha256_of "$f"; done | sort)"
  missing="$(comm -23 <(printf '%s\n' "$journal_hashes" | sort) <(printf '%s\n' "$file_hashes" | sort) | head -n 5)"
  if [[ -n "$missing" ]]; then
    echo "restore: WARNING the restored migration journal does not match the current .sql files." >&2
    echo "restore: WARNING drizzle skips already-applied migrations by timestamp, so an edited" >&2
    echo "restore: WARNING migration leaves the restored schema divergent from the code. Affected:" >&2
    printf 'restore: WARNING   %s\n' "$missing" >&2
    echo "restore: WARNING this is informational: the restore continues." >&2
  fi
}
verify_migration_journal
warn_on_migration_drift

echo "restore: running migrations and starting API"
# Build sequentially: parallel API/migrate builds can contend on Docker BuildKit's
# shared pnpm store on constrained runners. Operators may provide already-built
# images for a local drill; CI and normal restores leave these unset and build.
if [[ -n "${RESTORE_MIGRATE_IMAGE:-}" ]]; then
  echo "restore: using prebuilt migrate image $RESTORE_MIGRATE_IMAGE"
else
  restore_compose build migrate
fi
if [[ -n "${RESTORE_API_IMAGE:-}" ]]; then
  echo "restore: using prebuilt API image $RESTORE_API_IMAGE"
else
  restore_compose build api
fi
restore_compose up -d --wait --no-build api
api_id="$(restore_compose ps -q api)"
[[ -n "$api_id" ]] || fail "API did not start after restore"
docker_exec "$api_id" node -e "fetch('http://127.0.0.1:5000/api/livez').then(async r=>{if(!r.ok)process.exit(1); console.log(await r.text())}).catch(()=>process.exit(1))"
docker_exec "$api_id" node -e "fetch('http://127.0.0.1:5000/api/readyz').then(async r=>{if(!r.ok)process.exit(1); console.log(await r.text())}).catch(()=>process.exit(1))"

verified=0
while IFS='=' read -r key expected; do
  # Same mechanism as manifest_value: this loop reads the manifest directly with
  # grep, so without strip_cr a CRLF manifest would fail the count comparison on
  # Linux while passing on Git Bash, where read discards the CR by itself.
  expected="$(strip_cr "$expected")"
  case "$key" in
    count_*)
      table="${key#count_}"
      actual="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc "SELECT count(*) FROM \"$table\";")"
      [[ "$actual" == "$expected" ]] || fail "row-count mismatch for $table: expected $expected, got $actual"
      echo "verified $table=$actual"
      verified=1
      ;;
  esac
done < <(grep '^count_' "$MANIFEST_FILE" || true)
[[ "$verified" == 1 ]] || fail "manifest contains no row-count checks"
# RLS coverage must match migration 0018 exactly: every protected table keeps both
# ENABLE and FORCE ROW LEVEL SECURITY. Verifying only one table would let a restore
# finish green with the rest of the tenant tables unprotected.
rls_tables=(sources findings reports activity scans scan_schedules masking_jobs)
rls_report="$(
  docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -At -F '|' -c "
    SELECT t.name, c.relrowsecurity, c.relforcerowsecurity
    FROM unnest(ARRAY['sources','findings','reports','activity','scans','scan_schedules','masking_jobs']) AS t(name)
    LEFT JOIN pg_class c
      ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace
    ORDER BY t.name;"
)"
rls_seen=0
rls_broken=0
while IFS='|' read -r table enabled forced; do
  [[ -n "$table" ]] || continue
  rls_seen=$((rls_seen + 1))
  if [[ "$enabled" == "t" && "$forced" == "t" ]]; then
    echo "verified rls $table enable+force"
  else
    echo "restore: $table missing RLS (enabled=${enabled:-absent} forced=${forced:-absent})" >&2
    rls_broken=$((rls_broken + 1))
  fi
done <<< "$rls_report"
if [[ "$rls_seen" != "${#rls_tables[@]}" ]]; then
  missing="$(comm -23 <(printf '%s\n' "${rls_tables[@]}" | sort) <(printf '%s\n' "$rls_report" | cut -d'|' -f1 | sort) | tr '\n' ' ')"
  fail "RLS verification covered $rls_seen of ${#rls_tables[@]} protected tables; missing: $missing"
fi
[[ "$rls_broken" == 0 ]] || fail "$rls_broken of ${#rls_tables[@]} RLS-protected tables lost ENABLE/FORCE ROW LEVEL SECURITY"

# Runtime roles must keep the attributes restore-roles.sql grants them: app_role is
# the tenant-scoped runtime role and must NOT bypass RLS; bg_role is the background
# worker role and is expected to bypass it. A dump that resurrects app_role as a
# BYPASSRLS role silently voids tenant isolation.
assert_role_bypassrls() {
  local role="$1" expected="$2" actual
  actual="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc \
    "SELECT rolbypassrls FROM pg_roles WHERE rolname = '$role';")"
  [[ -n "$actual" ]] || fail "role $role does not exist after restore"
  [[ "$actual" == "$expected" ]] \
    || fail "role $role has rolbypassrls=$actual but $expected was required"
  echo "verified role $role bypassrls=$actual"
}
assert_role_bypassrls app_role f
assert_role_bypassrls bg_role t


expected_migrations="$(manifest_value migration_count)"
actual_migrations="$(docker_exec "$db_id" psql -U "$TARGET_USER" -d "$TARGET_DB" -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations;')"
[[ "$actual_migrations" == "$expected_migrations" ]] || fail "migration-count mismatch: expected $expected_migrations, got $actual_migrations"

# --- M25.3: verificacion de SOURCE_ENCRYPTION_KEY ----------------------------
#
# M24 validaba checksums, conteos, RLS y roles, pero NUNCA descifraba. Un restore
# hecho con la clave equivocada pasaba todos esos criterios y aun asi dejaba
# todas las fuentes sin conectar. Aqui se comprueba la clave de verdad.
#
# El check corre en el contenedor `migrate` porque es el unico del stack con node
# y `pg` resoluble (`pg` solo resuelve desde /repo/lib/db). La clave se inyecta
# solo en ese `run` one-shot con `-e`, sin tocar docker-compose.restore.yml, y el
# script se pasa por stdin para no dejar ficheros en la imagen.
key_check() {
  local check_file="$ROOT_DIR/scripts/ops/verify-source-key.cjs"
  local expected_fp status=0 output=""
  expected_fp="$(manifest_value source_key_fingerprint)"
  [[ -f "$check_file" ]] || fail "missing $check_file"
  echo "restore: verifying SOURCE_ENCRYPTION_KEY against the restored database"
  output="$(restore_compose run --rm -T \
      -e SOURCE_ENCRYPTION_KEY="$RESTORE_SOURCE_ENCRYPTION_KEY" \
      -e EXPECTED_KEY_FINGERPRINT="$expected_fp" \
      --entrypoint sh migrate \
      -c "cat > /repo/lib/db/m25-key-check.cjs && cd /repo/lib/db && node m25-key-check.cjs" \
      < "$check_file" 2>&1)" || status=$?
  printf '%s\n' "$output" | grep -E '^key_check_' || true
  case "$status" in
    0) return 0 ;;
    3) fail "SOURCE_ENCRYPTION_KEY does not match this backup (fingerprint mismatch); refusing to declare the restore usable" ;;
    4) fail "SOURCE_ENCRYPTION_KEY cannot decrypt the restored source credentials; refusing to declare the restore usable" ;;
    5)
      echo "restore: WARNING no encrypted source configs in this backup, so the key could not be verified"
      return 0
      ;;
    *) fail "source-key verification could not run (exit $status); refusing to declare the restore usable" ;;
  esac
}
key_check

echo "restore=ok project=$PROJECT_NAME database=$TARGET_DB keep=$KEEP_TARGET"
if [[ "$KEEP_TARGET" == 1 ]]; then echo "restore: target left running for operator cutover"; fi


