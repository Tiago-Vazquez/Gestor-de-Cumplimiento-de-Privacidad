#!/usr/bin/env bash
# M28.0: DR drill — prove the backup/restore cycle preserves real data.
#
# WHAT THIS IS: a real end-to-end exercise. It creates a source database with
# deterministic rows (including one ENCRYPTED source credential), runs the real
# postgres-backup.sh, builds the real M26.0 bundle, extracts it into a clean
# directory outside the repository, and runs the real postgres-restore.sh from
# there. Nothing is stubbed.
#
# WHAT THIS IS NOT: it does not touch Backblaze B2, an off-host bucket, or a
# second physical host. Object Lock, lifecycle and a genuine host-loss recovery
# remain BLOCKED pending a VPS, and nothing here is evidence about them. This
# drill covers the data-preservation half of R7 only.
#
# WHY IT IS NOT IN test:ops: it needs Docker and builds images, so it belongs in
# its own CI job (`dr-drill`), exactly like connectors-integration. test:ops
# stays fast, offline and credential-free.
#
# SECRET HANDLING: the encryption key is generated at runtime into a shell
# variable. It is never written to disk, never printed, never placed in the
# bundle, and never passed to a container that persists state. `set -x` is never
# enabled here, which is the other half of keeping it out of the logs.
#
# Run: bash scripts/ci/run-dr-drill.sh
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/scripts/ci/docker-compose.dr-drill.yml"
ASSERTS="$ROOT_DIR/scripts/ci/dr-asserts.sh"
PROJECT_NAME="${M28_DR_PROJECT:-m28-dr-drill}"

# Absolute repository root, needed for the SCRATCH compose's build context.
#
# The committed compose says `context: ../..`, which resolves correctly against
# scripts/ci/. The drill does not use that file: it copies it into $WORK, and
# compose resolves relative paths against the directory of the compose file, not
# the working directory. From $WORK, `../..` points outside the checkout and the
# build fails with "failed to read dockerfile: open Dockerfile.api: no such file
# or directory". The scratch therefore carries the absolute root instead.
#
# `git rev-parse --show-toplevel` is preferred because it answers identically on
# the Actions runner and on a local checkout. ROOT_DIR is the fallback for a tree
# that is not a git checkout. Git Bash reports /c/... , which Docker Desktop does
# not resolve as a build context, so cygpath normalises it to C:/... when present.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$REPO_ROOT" ]] || REPO_ROOT="$ROOT_DIR"
if command -v cygpath >/dev/null 2>&1; then
  REPO_ROOT="$(cygpath -m "$REPO_ROOT" 2>/dev/null || printf '%s' "$REPO_ROOT")"
fi

# A project distinct from the default one is mandatory: the drill tears down
# volumes, and it must never be able to reach the developer's own database.
if [[ "$PROJECT_NAME" == "gestor-de-cumplimiento-de-privacidad" ]]; then
  echo "dr-drill: refusing to reuse the default compose project" >&2
  exit 1
fi

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
note() { printf '  --   %s\n' "$1"; }
die()  { printf 'dr-drill: %s\n' "$*" >&2; exit 1; }

WORK="$(mktemp -d)"
BACKUP_DIR="$WORK/backups"
BUNDLE_DIR="$WORK/bundles"
RESTORE_DIR="$WORK/clean-host/var/opt/privaris"
RESTORE_PROJECT="${PROJECT_NAME}-restore"
SCRATCH_COMPOSE=""

DRILL_KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64"))')"
[[ ${#DRILL_KEY} -ge 32 ]] || die "generated key is too short"
[[ "$WORK" == /* ]] || die "work dir is not absolute: $WORK"

compose() { docker compose -p "$PROJECT_NAME" -f "$SCRATCH_COMPOSE" "$@"; }

cleanup() {
  if [[ -n "$SCRATCH_COMPOSE" ]]; then
    docker compose -p "$PROJECT_NAME" -f "$SCRATCH_COMPOSE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # The restore creates its own project; tear it down too, or the next run finds
  # a leftover volume and fails with "target project already exists".
  docker compose -p "$RESTORE_PROJECT" -f "$ROOT_DIR/scripts/ops/docker-compose.restore.yml" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  # The work dir holds the expanded seed (with a real ciphertext) and the backup
  # artefacts; remove the whole tree either way.
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "M28.0 DR drill (local; does NOT cover B2/off-host/host-loss)"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
node --version >/dev/null 2>&1 || die "node is required"
[[ -f "$COMPOSE_FILE" ]] || die "missing $COMPOSE_FILE"
[[ -f "$ASSERTS" ]] || die "missing $ASSERTS"
# shellcheck source=scripts/ci/dr-asserts.sh
# All assertions live in dr-asserts.sh; this file only orchestrates.
source "$ASSERTS"
compose() { docker compose -p "$PROJECT_NAME" -f "$SCRATCH_COMPOSE" "$@"; }
mfv() { sed -n "s/^$1=//p" "$MANIFEST" | head -n1; }

# --- S1: source database with a real encrypted credential ------------------
# The committed seed holds only a placeholder. The ciphertext is produced here,
# at runtime, so no key and no ciphertext ever enter the repository.
node -e '
const fs = require("fs");
const c = require("crypto");
const key = c.createHash("sha256").update(process.argv[1]).digest();
const iv = c.randomBytes(12);
const cipher = c.createCipheriv("aes-256-gcm", key, iv);
const plain = Buffer.from(JSON.stringify({ dsn: "postgresql://drill:drill@db/drill" }), "utf8");
const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
const tag = cipher.getAuthTag();
const blob = [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
// replaceAll, not replace: the placeholder appears in a comment AND in the
// INSERT, and replace() would only substitute the first one.
const seed = fs.readFileSync(process.argv[2], "utf8").replaceAll("__DRILL_BLOB_JSON__", JSON.stringify(blob));
if (seed.includes("__DRILL_BLOB_JSON__")) { console.error("placeholder not substituted"); process.exit(1); }
fs.writeFileSync(process.argv[3], seed, "utf8");
' "$DRILL_KEY" "$ROOT_DIR/scripts/ci/m28-dr-seed.sql" "$WORK/seed.expanded.sql" \
  || die "could not expand the seed"
[[ -f "$WORK/seed.expanded.sql" ]] || die "seed expansion produced no file"
ok "seed expanded with a runtime-generated key"
# The committed compose mounts the placeholder seed, so the drill uses a scratch
# copy pointed at the expanded one. The committed seed stays placeholder-only.
#
# The scratch copy also needs its build context absolutised (see REPO_ROOT above):
# the relative `context: ../..` is only meaningful next to scripts/ci/, and it
# silently points at the wrong tree once the file lives in $WORK. The capture group
# keeps each service's original indentation, and the value is quoted because a
# Windows absolute path contains colons.
SCRATCH_COMPOSE="$WORK/docker-compose.dr-drill.yml"
sed -e "s#\./m28-dr-seed\.sql#$WORK/seed.expanded.sql#" \
    -e "s#^\( *\)context: \.\./\.\.\$#\1context: \"$REPO_ROOT\"#" \
    "$COMPOSE_FILE" > "$SCRATCH_COMPOSE"
grep -q 'seed.expanded.sql' "$SCRATCH_COMPOSE" \
  || die "scratch compose does not reference the expanded seed"
# Fail loudly here rather than at the first `compose up`: a build that cannot read
# its Dockerfile aborts the whole drill in seconds, with an error that points at
# the runner instead of at the relative path that caused it.
if grep -q 'context: \.\./\.\.' "$SCRATCH_COMPOSE"; then
  die "scratch compose still carries the relative build context"
fi
grep -qF "context: \"$REPO_ROOT\"" "$SCRATCH_COMPOSE" \
  || die "scratch compose does not carry the absolute repository root"
docker compose -p "$PROJECT_NAME" -f "$SCRATCH_COMPOSE" down --volumes --remove-orphans >/dev/null 2>&1 || true
compose up -d --wait seed || die "source database did not become seeded"
ok "source database is up"

# Prove the seed landed: a silent initdb failure would otherwise look like a
# successful backup of an EMPTY database, which proves nothing.
src_psql() {
  docker exec -i "$(compose ps -q db)" psql -U privacy -d privacy -Atc "$1" 2>/dev/null
}
for pair in "organizations 4" "users 2" "sources 2" "scans 4" "findings 2" "audit_events 1"; do
  set -- $pair
  actual="$(src_psql "SELECT count(*) FROM $1;")"
  if [[ "$actual" == "$2" ]]; then
    ok "source $1 = $2"
  else
    no "source $1 = ${actual:-<none>}, expected $2"
  fi
done
encrypted="$(src_psql 'SELECT count(*) FROM sources WHERE connection_config IS NOT NULL;')"
if [[ "$encrypted" == "1" ]]; then
  ok "exactly one source carries an encrypted connection_config"
else
  no "expected 1 encrypted source, found ${encrypted:-0}"
fi
[[ "$encrypted" == "1" ]] || die "seed did not apply; the drill would prove nothing"
# postgres-backup.sh computes source_key_fingerprint by exec'ing node INSIDE the
# api container, and silently omits the field when no api container is running.
# A backup taken before `api` is up would therefore still succeed while producing a
# manifest that weakens the drill's key check, so api is started and waited for
# here: S2 must not begin before this succeeds.
compose up -d --wait api || die "api did not become healthy"
ok "api is up (needed for the backup key fingerprint)"
# --- S2: the real backup ---------------------------------------------------
mkdir -p "$BACKUP_DIR"
backup_out="$(COMPOSE_FILE="$SCRATCH_COMPOSE" COMPOSE_PROJECT_NAME="$PROJECT_NAME" BACKUP_DIR="$BACKUP_DIR" BACKUP_RETENTION_DAYS=3 \
  bash "$ROOT_DIR/scripts/ops/postgres-backup.sh" 2>&1)" \
  || { printf '%s\n' "$backup_out" >&2; die "postgres-backup.sh failed"; }
DUMP="$(printf '%s\n' "$backup_out" | sed -n 's/^backup=//p' | head -n1)"
ROLES="${DUMP%.dump}.roles.sql"
MANIFEST="${DUMP%.dump}.manifest"
for f in "$DUMP" "$ROLES" "$MANIFEST"; do [[ -s "$f" ]] || die "missing or empty artefact: $f"; done
ok "backup produced dump, roles and manifest"
b="$(basename "${DUMP%.dump}")"
[[ "$(basename "$ROLES")" == "$b.roles.sql" && "$(basename "$MANIFEST")" == "$b.manifest" ]] \
  && ok "artefacts share one base name" || no "artefacts do not share one base name"
[[ "$(mfv dump_sha256)" == "$(sha256sum < "$DUMP" | awk '{print $1}')" ]] \
  && ok "manifest dump_sha256 matches the dump" || no "manifest dump_sha256 does not match the dump"
[[ "$(mfv roles_sha256)" == "$(sha256sum < "$ROLES" | awk '{print $1}')" ]] \
  && ok "manifest roles_sha256 matches the roles export" || no "manifest roles_sha256 does not match the roles export"
assert_manifest
# --- S3: the real bundle ---------------------------------------------------
mkdir -p "$BUNDLE_DIR"
bundle_out="$(BUNDLE_OUT_DIR="$BUNDLE_DIR" BUNDLE_COMMIT=dr-drill \
  bash "$ROOT_DIR/scripts/ops/build-restore-bundle.sh" 2>&1)" \
  || { printf '%s\n' "$bundle_out" >&2; die "build-restore-bundle.sh failed"; }
TARBALL="$(printf '%s\n' "$bundle_out" | sed -n 's/^bundle=//p' | head -n1)"
[[ -f "$TARBALL" ]] || die "no tarball produced"
ok "bundle built"

# --- S4: extract outside the repository ------------------------------------
# The R7 property: the restore must run with no checkout. The extract root is
# a temp dir, so nothing can be resolved from the repo by accident.
mkdir -p "$RESTORE_DIR"
tar -xzf "$TARBALL" -C "$RESTORE_DIR" || die "bundle did not extract"
( cd "$RESTORE_DIR" && sha256sum -c --quiet MANIFEST.bundle.sha256 ) \
  || die "bundle checksums do not verify"
ok "bundle checksums verify after extraction"
assert_bundle_contents "$RESTORE_DIR"
# --- S5: the real restore, run FROM the bundle -----------------------------
RESTORE_OUT="$(cd "$RESTORE_DIR" && \
  RESTORE_CONFIRM=RESTORE \
  RESTORE_PROJECT_NAME="$RESTORE_PROJECT" \
  RESTORE_POSTGRES_USER=restore_admin \
  RESTORE_POSTGRES_DB=privacy_restore \
  RESTORE_POSTGRES_PASSWORD=drill-restore-pass \
  RESTORE_APP_ROLE_PASSWORD=drill-app-pass \
  RESTORE_BG_ROLE_PASSWORD=drill-bg-pass \
  RESTORE_JWT_SECRET=drill-jwt-secret-value-at-least-32-chars \
  RESTORE_SOURCE_ENCRYPTION_KEY="$DRILL_KEY" \
  RESTORE_KEEP=1 \
  bash scripts/ops/postgres-restore.sh --backup "$DUMP" 2>&1)" \
  || { printf '%s\n' "$RESTORE_OUT" >&2; die "postgres-restore.sh failed"; }
ok "postgres-restore.sh completed"
assert_restore_output

# --- S6: read the data back from the restored database --------------------
tgt_id="$(docker compose -p "$RESTORE_PROJECT" -f "$ROOT_DIR/scripts/ops/docker-compose.restore.yml" ps -q db)"
[[ -n "$tgt_id" ]] || die "restored database container not found"
TGT_Q() { docker exec -i "$tgt_id" psql -U restore_admin -d privacy_restore -Atc "$1" 2>/dev/null; }
RESTORED_BLOB="$(TGT_Q 'SELECT connection_config::text FROM sources WHERE connection_config IS NOT NULL LIMIT 1;' | tr -d '"' | sed 's/^"//; s/"$//')"
assert_restored_data
assert_decrypts_after_restore
assert_summary
