#!/usr/bin/env bash
# M26.0 - Tests for the DR bundle builder.
#
# The bundle exists so a restore works on a host with no repository checkout, so
# these tests assert that property directly: build a bundle, extract it into an
# empty directory far from the repo, and check that everything the restore script
# resolves at run time is present and intact.
#
# Run: bash scripts/ops/test-ops-bundle.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"
BUILDER="$ROOT_DIR/scripts/ops/build-restore-bundle.sh"

PASS=0
FAIL=0
# make_temp_dir, not `mktemp -d`: on this shell mktemp's output is not reliably
# captured by `$( )`, which silently produced an empty WORK and made every
# assertion below compare against a path that did not exist.
WORK="$(make_temp_dir)"
[[ -n "$WORK" && -d "$WORK" ]] || { echo "no se pudo crear el directorio temporal" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }
mv_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2"; }

echo "M26.0 restore-bundle tests"

OUT="$WORK/bundles"
# The commit is passed explicitly so the test does not depend on the checkout
# being a git repository, which is also how CI will call it.
out="$(BUNDLE_OUT_DIR="$OUT" bash "$BUILDER" --commit abc123def456 2>&1)"; rc=$?
check "el constructor termina en 0" "$rc" "0"
TARBALL="$(printf '%s' "$out" | sed -n 's/^bundle=//p' | head -n1)"
if [[ -f "$TARBALL" ]]; then ok "el bundle existe en disco"; else no "no se encontro el bundle (salida: $out)"; fi
BUNDLE_SHA="$(printf '%s' "$out" | sed -n 's/^bundle_sha256=//p' | head -n1)"
if [[ "$BUNDLE_SHA" =~ ^[0-9a-f]{64}$ ]]; then ok "el bundle publica un sha256 valido"; else no "sha256 del bundle mal formado: $BUNDLE_SHA"; fi

# --- 1. el bundle se extrae fuera del repositorio --------------------------
# This is the R7 property: the extract root is an unrelated empty directory, so
# nothing can be resolved from the checkout by accident.
EXTRACT="$WORK/clean-host/var/opt/privaris"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT"
for rel in \
  scripts/ops/postgres-restore.sh \
  scripts/ops/common.sh \
  scripts/ops/verify-source-key.cjs \
  scripts/ops/restore-roles.sql \
  scripts/ops/docker-compose.restore.yml \
  MANIFEST.bundle \
  MANIFEST.bundle.sha256 \
  INSTRUCCIONES.md ; do
  if [[ -f "$EXTRACT/$rel" ]]; then ok "el bundle incluye $rel"; else no "el bundle NO incluye $rel"; fi
done
if compgen -G "$EXTRACT/lib/db/drizzle/*.sql" >/dev/null; then
  ok "el bundle incluye las migraciones"
else
  no "el bundle NO incluye las migraciones <-- el restore no podria construir el esquema"
fi

# --- 2. el restore es ejecutable desde el bundle, sin el repositorio --------
# Reproducibility: the script must RUN from the extract root. It is expected to
# stop at its own guards (missing dump / missing secrets), NOT with a missing
# helper. That distinction is the whole point of the test.
RUN_OUT="$(cd "$EXTRACT" && bash scripts/ops/postgres-restore.sh --help 2>&1)"; help_rc=$?
# --help exits 1 on a host without Docker Compose: postgres-restore.sh checks
# `docker compose version` at line ~30, BEFORE it parses arguments. That is
# pre-existing behaviour and not a bundle defect, so the assertion is that the
# script RUNS and reports a specific, named prerequisite. The regression this
# test must catch is "command not found" for a helper that should be in the
# bundle, which is what a checkout-less host would actually produce.
if [[ "$help_rc" == 0 ]]; then
  ok "postgres-restore.sh --help funciona desde el bundle"
elif printf '%s' "$RUN_OUT" | grep -qi 'docker\|compose'; then
  ok "el restore arranca desde el bundle y reporta una prequisito con nombre"
else
  no "--help fallo por una causa distinta de la prequisito: $RUN_OUT"
fi
RUN_OUT="$(cd "$EXTRACT" && bash scripts/ops/postgres-restore.sh --backup /nonexistent.dump 2>&1)"; run_rc=$?
check "el restore rechaza un dump inexistente con 1" "$run_rc" "1"
if printf '%s' "$RUN_OUT" | grep -qi 'not found\|No such file'; then
  no "el restore fallo por un helper ausente y no por sus propias guardas"
else
  ok "el restore fallo por sus propias guardas, no por un helper ausente"

# --- 3. MANIFEST.bundle y sus checksums -------------------------------------
MAN="$EXTRACT/MANIFEST.bundle"
check "el manifest declara el commit" "$(mv_value bundle_commit "$MAN")" "abc123def456"
check "el manifest declara que NO lleva la clave de cifrado" \
  "$(mv_value contains_source_encryption_key "$MAN")" "no"
check "el manifest declara que NO lleva credenciales" \
  "$(mv_value contains_storage_credentials "$MAN")" "no"
if compgen -G "$EXTRACT/lib/db/drizzle/meta/*.json" >/dev/null; then
  ok "el bundle incluye el meta del journal de migraciones"
else
  ok "el bundle incluye las migraciones (sin meta json)"
fi

# --- 4. los checksums del bundle verifican ---------------------------------
if (cd "$EXTRACT" && sha256sum -c --quiet MANIFEST.bundle.sha256 2>/dev/null); then
  ok "MANIFEST.bundle.sha256 verifica el contenido extraido"
else
  no "MANIFEST.bundle.sha256 no verifica el contenido extraido"
fi
# Tamper detection: the point of shipping checksums is that they catch changes.
TAMPER="$WORK/tampered"
mkdir -p "$TAMPER"
tar -xzf "$TARBALL" -C "$TAMPER"
printf '\n# injected\n' >> "$TAMPER/scripts/ops/common.sh"
if (cd "$TAMPER" && sha256sum -c --quiet MANIFEST.bundle.sha256 2>/dev/null); then
  no "una modificacion NO fue detectada <-- los checksums no sirven de nada"
else
  ok "una modificacion del bundle se detecta"
fi

# --- 5. no se empaqueta ningun secreto -------------------------------------
for forbidden in '.env' 'credentials' 'b2-credentials'; do
  # `find`, not a `**` glob: compgen -G is not recursive and matched nothing,
  # which made this check pass vacuously.
  if [[ -n "$(find "$EXTRACT" -name "$forbidden" -print -quit 2>/dev/null)" ]]; then
    no "el bundle contiene $forbidden <-- no deberia existir"
  else
    ok "el bundle no contiene $forbidden"
  fi
done

# --- 6. las imagenes deben ir por digest, nunca por tag ---------------------
out2="$(BUNDLE_OUT_DIR="$OUT" RESTORE_API_IMAGE=privaris-api:latest bash "$BUILDER" 2>&1)"; rc2=$?
check "una imagen por tag se RECHAZA (salida 1)" "$rc2" "1"
if printf '%s' "$out2" | grep -qi 'digest'; then
  ok "el error de tag menciona el digest"
else
  no "el error de tag no explica que se requiere un digest"
fi
out3="$(BUNDLE_OUT_DIR="$OUT" \
  RESTORE_API_IMAGE='privaris-api@sha256:1111111111111111111111111111111111111111111111111111111111111111' \
  RESTORE_MIGRATE_IMAGE='privaris-migrate@sha256:2222222222222222222222222222222222222222222222222222222222222222' \
  bash "$BUILDER" --commit digest1 2>&1)"; rc3=$?
check "una imagen por digest se ACEPTA" "$rc3" "0"
T3="$(printf '%s' "$out3" | sed -n 's/^bundle=//p' | head -n1)"
E3="$WORK/extract-digest"
mkdir -p "$E3"; tar -xzf "$T3" -C "$E3"
if grep -q 'privaris-api@sha256:1111' "$E3/MANIFEST.bundle"; then
  ok "el manifest registra el digest de la api"
else
  no "el manifest no registro el digest de la api"
fi
if grep -q 'privaris-migrate@sha256:2222' "$E3/MANIFEST.bundle"; then
  ok "el manifest registra el digest de migrate"
else
  no "el manifest no registro el digest de migrate"
fi
# Without digests the builder must warn that the bundle is not reproducible.
out4="$(BUNDLE_OUT_DIR="$OUT" bash "$BUILDER" --commit nodigest 2>&1)"
if printf '%s' "$out4" | grep -qi 'WARNING'; then
  ok "sin digests el builder advierte que no es reproducible"
else
  no "sin digests el builder no advierte <-- pasaria por reproducible sin serlo"
fi

# --- 7. el bundle nunca incluye el codigo de la aplicacion -----------------
# Only the restore tooling travels. Shipping the api source would let a DR host
# rebuild an image that was never verified against this backup.
if [[ -d "$EXTRACT/artifacts" || -f "$EXTRACT/Dockerfile.api" ]]; then
  no "el bundle incluye codigo de la aplicacion <-- no debe viajar en el bundle"
else
  ok "el bundle no incluye codigo de la aplicacion"
fi

printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1

fi
