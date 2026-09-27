#!/usr/bin/env bash
# M26.0: build a self-contained DR bundle.
#
# postgres-restore.sh resolves its own helpers from the repository, so a
# disaster recovery on a host with no checkout fails before it ever reaches the
# database: the script, common.sh, verify-source-key.cjs, restore-roles.sql and
# docker-compose.restore.yml are all required and all come from the tree. This
# packages exactly those, plus the migration journal, into one tarball that can
# be unpacked anywhere.
#
# What the bundle deliberately does NOT contain:
#   - images: it references them by digest, never by tag. A tag can be moved
#     after the bundle is built, which would run different code than the one the
#     bundle was verified against.
#   - backup artefacts: those live in the off-host bucket.
#   - SOURCE_ENCRYPTION_KEY: never in the bundle, never in the bucket, never
#     next to the storage credentials. Keeping it out is the D1/D2 separation.
#   - B2 credentials: the read credential is handed over out of band.
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

OUT_DIR="${BUNDLE_OUT_DIR:-$ROOT_DIR/../restore-bundles}"
COMMIT="${BUNDLE_COMMIT:-unknown}"

usage() {
  cat <<'EOF'
Usage: bash scripts/ops/build-restore-bundle.sh [--out-dir DIR] [--commit SHA]

Packages everything postgres-restore.sh needs into a single tarball.

Optional environment:
  BUNDLE_OUT_DIR          destination directory (default: ../restore-bundles)
  BUNDLE_COMMIT           commit the bundle was built from (default: unknown)
  RESTORE_API_IMAGE       image reference, by DIGEST, for the api service
  RESTORE_MIGRATE_IMAGE   image reference, by DIGEST, for the migrate service
EOF
}
fail() { echo "bundle: $*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --out-dir) [[ $# -ge 2 ]] || fail "--out-dir needs a directory"; OUT_DIR="$2"; shift 2 ;;
    --commit)  [[ $# -ge 2 ]] || fail "--commit needs a value"; COMMIT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

# --- required files ---------------------------------------------------------
# postgres-restore.sh resolves each of these at run time. A missing file here
# would only surface during a real restore, which is the worst possible moment
# to discover the bundle is incomplete.
required=(
  "scripts/ops/postgres-restore.sh"
  "scripts/ops/common.sh"
  "scripts/ops/verify-source-key.cjs"
  "scripts/ops/restore-roles.sql"
  "scripts/ops/docker-compose.restore.yml"
)
for rel in "${required[@]}"; do
  [[ -f "$ROOT_DIR/$rel" ]] || fail "required file missing: $rel"
done
MIGRATIONS_DIR="$ROOT_DIR/lib/db/drizzle"
[[ -d "$MIGRATIONS_DIR" ]] || fail "migrations directory missing: lib/db/drizzle"

# --- images must be referenced by digest ------------------------------------
# A tag is mutable, so a bundle recording one can end up running an image that
# was never verified against it. A digest cannot move. This is enforced, not
# merely documented.
API_IMAGE="${RESTORE_API_IMAGE:-}"
MIGRATE_IMAGE="${RESTORE_MIGRATE_IMAGE:-}"
is_digest_ref() { [[ "$1" == *@sha256:* ]]; }
if [[ -n "$API_IMAGE" ]] && ! is_digest_ref "$API_IMAGE"; then
  fail "RESTORE_API_IMAGE must be pinned by digest (name@sha256:...), got: $API_IMAGE"
fi
if [[ -n "$MIGRATE_IMAGE" ]] && ! is_digest_ref "$MIGRATE_IMAGE"; then
  fail "RESTORE_MIGRATE_IMAGE must be pinned by digest (name@sha256:...), got: $MIGRATE_IMAGE"
fi
if [[ -z "$API_IMAGE" || -z "$MIGRATE_IMAGE" ]]; then
  # Not an error: the bundle is still useful, but the operator must know that
  # without digests it is not reproducible.
  echo "bundle: WARNING no image digests supplied; the bundle is complete but" >&2
  echo "bundle:          not reproducible until RESTORE_API_IMAGE and" >&2
  echo "bundle:          RESTORE_MIGRATE_IMAGE are set to digest references" >&2
fi

STAGE="$(make_temp_dir)"
[[ -n "$STAGE" && -d "$STAGE" ]] || fail "could not create a staging directory"
VERIFY_DIR=""
cleanup() {
  [[ -n "$VERIFY_DIR" ]] && rm -rf "$VERIFY_DIR"
  [[ -n "$STAGE" ]] && rm -rf "$STAGE"
  return 0
}
trap cleanup EXIT

# scripts/ops/* keeps the relative position postgres-restore.sh expects: it
# sources "$ROOT_DIR/scripts/ops/common.sh" and resolves the compose file and the
# role bootstrap the same way. lib/db/drizzle keeps the migrations where the
# migrate service expects them.
mkdir -p "$STAGE/scripts/ops" "$STAGE/lib/db"
cp "$ROOT_DIR/scripts/ops/postgres-restore.sh" \
   "$ROOT_DIR/scripts/ops/common.sh" \
   "$ROOT_DIR/scripts/ops/verify-source-key.cjs" \
   "$ROOT_DIR/scripts/ops/restore-roles.sql" \
   "$ROOT_DIR/scripts/ops/docker-compose.restore.yml" \
   "$STAGE/scripts/ops/"
cp -R "$MIGRATIONS_DIR" "$STAGE/lib/db/drizzle"

# --- MANIFEST.bundle --------------------------------------------------------
# A checksum of every bundled file, checked on the DR host before anything is
# restored. It is deliberately separate from the backup manifest: this one
# proves the TOOLS are intact, not the data.
{
  printf 'bundle_commit=%s\n' "$COMMIT"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'restore_script=%s\n' "scripts/ops/postgres-restore.sh"
  printf 'api_image=%s\n' "${API_IMAGE:-unpinned}"
  printf 'migrate_image=%s\n' "${MIGRATE_IMAGE:-unpinned}"
  printf 'contains_source_encryption_key=no\n'
  printf 'contains_storage_credentials=no\n'
} > "$STAGE/MANIFEST.bundle"

# sha256_of, not sha256sum: M25.5 fixed the Windows/MSYS path-escaping that made
# the latter produce a 65-character value baked into a checksum file.
(
  cd "$STAGE"
  while IFS= read -r f; do
    printf '%s  %s\n' "$(sha256_of "$f")" "${f#./}"
  done < <(find . -type f ! -name 'MANIFEST.bundle' ! -name 'MANIFEST.bundle.sha256' | sort)
) > "$STAGE/MANIFEST.bundle.sha256"

cat > "$STAGE/INSTRUCCIONES.md" <<'DOC'
# Bundle de restauracion (M26.0)

Contiene las herramientas de `postgres-restore.sh` y las migraciones.
NO contiene: imagenes (referenciadas por digest en `MANIFEST.bundle`), backups
(estan en el almacenamiento off-host), `SOURCE_ENCRYPTION_KEY` ni credenciales.

## Orden de una restauracion

1. Verificar la integridad del bundle:

       sha256sum -c MANIFEST.bundle.sha256

2. Descargar del almacenamiento off-host los tres artefactos del mismo `base`
   (`.dump`, `.roles.sql`, `.manifest`). Los tres deben compartir nombre base:
   un `.dump` sin su `.manifest` significa un set incompleto y no se restaura.

3. Disponer de `SOURCE_ENCRYPTION_KEY` por el canal de custodia. Sin ella el
   restore NO se declara utilizable aunque todos los demas criterios pasen.

4. Ejecutar:

       RESTORE_CONFIRM=RESTORE \
       RESTORE_POSTGRES_PASSWORD=... \
       RESTORE_APP_ROLE_PASSWORD=... \
       RESTORE_BG_ROLE_PASSWORD=... \
       RESTORE_JWT_SECRET=... \
       RESTORE_SOURCE_ENCRYPTION_KEY=... \
       bash scripts/ops/postgres-restore.sh \
         --backup /ruta/m24-postgres-<ts>-<sfx>.dump

`restore=ok` solo aparece si checksums, conteos, RLS, roles, migraciones y la
verificacion de la clave han pasado.
DOC

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
name="restore-bundle-$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:12}.tar.gz"
tarball="$OUT_DIR/$name"

# No absolute paths and no owner data, so the archive is identical wherever it
# is built and unpacks predictably on a DR host.
tar -czf "$tarball" -C "$STAGE" \
  MANIFEST.bundle MANIFEST.bundle.sha256 INSTRUCCIONES.md scripts lib

chmod 600 "$tarball"
bundle_sha="$(sha256_of "$tarball")"
is_sha256 "$bundle_sha" || fail "could not compute a valid bundle checksum"

# --- self-verification ------------------------------------------------------
# Extract what was just written and re-verify it. A bundle that is corrupt on
# disk, or that silently lost a file, must fail HERE rather than during a
# restore on a host that has nothing else.
verify_dir="$(make_temp_dir)"
[[ -n "$verify_dir" && -d "$verify_dir" ]] || fail "could not create a verification directory"
VERIFY_DIR="$verify_dir"

if ! tar -xzf "$tarball" -C "$verify_dir" 2>/dev/null; then
  fail "the produced bundle does not extract cleanly"
fi
if ! (cd "$verify_dir" && sha256sum -c --quiet MANIFEST.bundle.sha256 2>/dev/null); then
  fail "the extracted bundle does not match MANIFEST.bundle.sha256"
fi
for rel in "${required[@]}"; do
  if [[ ! -f "$verify_dir/$rel" ]]; then
    fail "extracted bundle is missing $rel"
  fi
done
# The migrations must survive, not just the scripts: without them the migrate
# service cannot build the schema and the restore cannot complete.
if ! compgen -G "$verify_dir/lib/db/drizzle/*.sql" >/dev/null; then
  fail "extracted bundle has no migrations under lib/db/drizzle"
fi
# Defence in depth: the bundle must never carry a secret, whatever the tree
# happens to contain today. `find` is used instead of a `**` glob because
# `compgen -G` is not recursive and silently matched nothing.
for forbidden in '.env' 'SOURCE_ENCRYPTION_KEY' '.b2-credentials' 'credentials'; do
  if [[ -n "$(find "$verify_dir" -name "$forbidden" -print -quit 2>/dev/null)" ]]; then
    fail "the bundle must not contain $forbidden"
  fi
done

echo "bundle=$tarball"
echo "bundle_sha256=$bundle_sha"
echo "bundle_commit=$COMMIT"
echo "bundle_files=$(tar -tzf "$tarball" | grep -c . || true)"
echo "bundle=ok"
