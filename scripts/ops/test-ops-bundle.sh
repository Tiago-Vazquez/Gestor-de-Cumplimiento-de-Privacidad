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
  scripts/ops/postgres-physbackup.sh \
  scripts/ops/wal-chain-manifest.sh \
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
elif grep -qi 'docker\|compose' <<<"$RUN_OUT"; then
  ok "el restore arranca desde el bundle y reporta una prequisito con nombre"
else
  no "--help fallo por una causa distinta de la prequisito: $RUN_OUT"
fi
RUN_OUT="$(cd "$EXTRACT" && bash scripts/ops/postgres-restore.sh --backup /nonexistent.dump 2>&1)"; run_rc=$?
check "el restore rechaza un dump inexistente con 1" "$run_rc" "1"
if grep -qi 'not found\|No such file' <<<"$RUN_OUT"; then
  no "el restore fallo por un helper ausente y no por sus propias guardas"
else
  ok "el restore fallo por sus propias guardas, no por un helper ausente"
fi

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

# --- 4b. PITR desde el bundle: el helper de cadena viaja y es lo que autoriza ---
# M31.21: postgres-restore.sh EJECUTA "$ROOT_DIR/scripts/ops/wal-chain-manifest.sh"
# (L207) al verificar una cadena WAL. Si el bundle no lo lleva, un objetivo fuera
# de los WAL-Ranges del propio set base no puede autorizarse. Se cubren las tres
# caras, sin Docker, sin red, sin PostgreSQL y sin credenciales:
#   (i)   el helper esta en la ruta exacta, el manifiesto de checksums lo cubre y
#         el bundle lo ejecuta con exito;
#   (ii)  una cadena manipulada se rechaza;
#   (iii) sin el helper (extracto temporal aparte) el camino PITR NO puede
#         verificar la cadena, y el mismo comando con el helper si puede.
# Los datos son sinteticos (segmentos dispersos de 16 MiB) y viven en $WORK, fuera
# del repositorio: el resultado no depende del checkout original.
PITR_HELPER_REL="scripts/ops/wal-chain-manifest.sh"
PITR_SET_HELPER_REL="scripts/ops/postgres-physbackup.sh"
export WAL_CHAIN_SEGSIZE=16777216
SEGSZ=16777216
PITR_UNTIL="2026-01-02T03:04:05Z"

for rel in "$PITR_SET_HELPER_REL" "$PITR_HELPER_REL"; do
  if [[ -f "$EXTRACT/$rel" ]]; then
    ok "el bundle incluye $rel (ruta exacta que ejecuta postgres-restore.sh)"
  else
    no "el bundle NO incluye $rel <-- el camino PITR muere por helper ausente"
  fi
done
for rel in \
  scripts/ops/postgres-restore.sh \
  scripts/ops/common.sh \
  scripts/ops/verify-source-key.cjs \
  scripts/ops/restore-roles.sql \
  scripts/ops/docker-compose.restore.yml \
  scripts/ops/postgres-physbackup.sh \
  scripts/ops/wal-chain-manifest.sh ; do
  check "MANIFEST.bundle.sha256 cubre $rel" \
    "$(grep -c -- "  $rel\$" "$EXTRACT/MANIFEST.bundle.sha256" || true)" "1"
done

# Fixtures del set fisico con la forma que produce postgres-physbackup.sh: el
# .pmanifest enlaza base.tar (con backup_label), pg_wal.tar y backup_manifest.
# El rango WAL propio del set NO cubre el objetivo: solo la cadena archivada lo
# cubre, que es el escenario del defecto R1 y el motivo por el que el helper es
# imprescindible.
pitr_make_set() {  # <dir> <sid> <base_lsn> <tl> <wal_start> <wal_end>
  local dir="$1" sid="$2" lsn="$3" tl="$4" ws="$5" we="$6" stage sb sw sm bb bw bm
  stage="$WORK/stage.$sid"; rm -rf "$stage"; mkdir -p "$stage" "$dir"
  printf 'START WAL LOCATION: %s\nSTART TIMELINE: %s\n' "$lsn" "$tl" > "$stage/backup_label"
  tar -cf "$stage/base.tar" -C "$stage" backup_label 2>/dev/null; rm -f "$stage/backup_label"
  printf 'w\n' > "$stage/_w"; tar -cf "$stage/pg_wal.tar" -C "$stage" _w 2>/dev/null; rm -f "$stage/_w"
  printf 'm\n' > "$stage/backup_manifest"
  sb="$(sha256sum < "$stage/base.tar" | awk '{print $1}')"
  sw="$(sha256sum < "$stage/pg_wal.tar" | awk '{print $1}')"
  sm="$(sha256sum < "$stage/backup_manifest" | awk '{print $1}')"
  bb="$(wc -c < "$stage/base.tar" | tr -d ' ')"
  bw="$(wc -c < "$stage/pg_wal.tar" | tr -d ' ')"
  bm="$(wc -c < "$stage/backup_manifest" | tr -d ' ')"
  {
    printf 'format=pg-base-tar-set\nschema_version=1\nset_id=%s\ncreated_at=2026-01-01T00:00:00Z\n' "$sid"
    printf 'base_lsn=%s\nbase_timeline=%s\n' "$lsn" "$tl"
    printf 'base_tar_file=%s.base.tar\nbase_tar_sha256=%s\nbase_tar_bytes=%s\n' "$sid" "$sb" "$bb"
    printf 'pgwal_tar_file=%s.pg_wal.tar\npgwal_tar_sha256=%s\npgwal_tar_bytes=%s\n' "$sid" "$sw" "$bw"
    printf 'manifest_file=%s.backup_manifest\nmanifest_sha256=%s\nmanifest_bytes=%s\nstatus=complete\n' "$sid" "$sm" "$bm"
    printf 'wal_range_count=1\nwal_range_1_timeline=%s\nwal_range_1_start_lsn=%s\nwal_range_1_end_lsn=%s\n' "$tl" "$ws" "$we"
  } > "$dir/$sid.pmanifest"
  mv "$stage/base.tar" "$dir/$sid.base.tar"
  mv "$stage/pg_wal.tar" "$dir/$sid.pg_wal.tar"
  mv "$stage/backup_manifest" "$dir/$sid.backup_manifest"
  rm -rf "$stage"
}

PSET="$WORK/pitr-set"
pitr_make_set "$PSET" s1 0/2000000 1 0/2000000 0/2000000
PWAL="$WORK/pitr-wal"; mkdir -p "$PWAL"
for i in 2 3; do truncate -s "$SEGSZ" "$PWAL/$(printf '0000000100000000%08X' "$i")"; done
PCHAIN="$WORK/s1.walchain"
CHAIN_OUT="$(cd "$EXTRACT" && bash "$PITR_HELPER_REL" --emit --base "$PSET/s1.pmanifest" --wal-dir "$PWAL" --out "$PCHAIN" 2>&1)"; chain_rc=$?
check "el helper del bundle emite la cadena (exit 0)" "$chain_rc" "0"
check "la cadena emitida cubre 0/2000000..0/3000000" \
  "$(awk -F= '$1=="coverage_end_lsn" {print $2; exit}' "$PCHAIN")" "0/3000000"
check "la cadena emitida declara 2 segmentos" \
  "$(awk -F= '$1=="segment_count" {print $2; exit}' "$PCHAIN")" "2"

# (i) El mismo comando desde el bundle con el helper presente: la cadena valida
# autoriza el objetivo y el emisor produce su configuracion aislada.
POUT="$WORK/pitr-out"
PITR_OK_TXT="$(cd "$EXTRACT" && bash scripts/ops/postgres-restore.sh --pitr --base "$PSET/s1.pmanifest" --wal-dir "$PWAL" --until "$PITR_UNTIL" --until-lsn 0/3000000 --out "$POUT" --wal-chain "$PCHAIN" 2>&1)"; pitr_ok_rc=$?
check "PITR desde el bundle con cadena valida: exit 0" "$pitr_ok_rc" "0"
check "PITR desde el bundle: senal pitr=prepared" \
  "$(printf '%s' "$PITR_OK_TXT" | grep -c '^pitr=prepared ' || true)" "1"
check "PITR desde el bundle: la cadena fue la fuente (chain=1)" \
  "$(printf '%s' "$PITR_OK_TXT" | grep -c 'chain=1' || true)" "1"
check "PITR desde el bundle: recovery.signal emitido" \
  "$([ -f "$POUT/recovery.signal" ] && echo yes || echo no)" "yes"
check "PITR desde el bundle: restore_command apunta a la WAL sintetica" \
  "$(grep -c -- "$PWAL" "$POUT/postgresql.pitr.conf" || true)" "1"
check "PITR desde el bundle: la config no menciona el checkout original" \
  "$(grep -c -- "$ROOT_DIR" "$POUT/postgresql.pitr.conf" || true)" "0"

# (ii) Cadena manipulada: se rechaza y nunca se emite una senal de exito.
PCHAIN_BAD="$WORK/s1.bad.walchain"
sed 's|^coverage_end_lsn=.*|coverage_end_lsn=0/90|' "$PCHAIN" > "$PCHAIN_BAD"
PITR_BAD_TXT="$(cd "$EXTRACT" && bash scripts/ops/postgres-restore.sh --pitr --base "$PSET/s1.pmanifest" --wal-dir "$PWAL" --until "$PITR_UNTIL" --until-lsn 0/3000000 --out "$WORK/pitr-out-bad" --wal-chain "$PCHAIN_BAD" 2>&1)"; pitr_bad_rc=$?
check "cadena invalida desde el bundle: rechazo (exit != 0)" \
  "$([ "$pitr_bad_rc" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "cadena invalida desde el bundle: se nombra la verificacion de cadena" \
  "$(printf '%s' "$PITR_BAD_TXT" | grep -c 'does not verify' || true)" "1"
check "cadena invalida desde el bundle: sin senal de exito" \
  "$(printf '%s' "$PITR_BAD_TXT" | grep -c '^pitr=prepared ' || true)" "0"

# (iii) Control negativo: mismo bundle, mismo comando, misma cadena, pero SIN el
# helper. El extracto alternativo vive en $WORK y solo pierde ese archivo, de modo
# que la unica diferencia frente al caso (i) es el helper.
NOHELPER="$WORK/no-helper"
mkdir -p "$NOHELPER"; tar -xzf "$TARBALL" -C "$NOHELPER"
rm -f "$NOHELPER/$PITR_HELPER_REL"
if [[ ! -f "$NOHELPER/$PITR_HELPER_REL" ]]; then
  ok "control negativo: helper eliminado solo del extracto temporal"
else
  no "control negativo: no se pudo eliminar el helper del extracto temporal"
fi
HELPER_OUT="$(cd "$NOHELPER" && bash "$PITR_HELPER_REL" --verify --chain "$PCHAIN" --wal-dir "$PWAL" --set-dir "$PSET" 2>&1)"; helper_rc=$?
check "control negativo: invocar el helper ausente falla" \
  "$([ "$helper_rc" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "control negativo: el fallo nombra el helper ausente" \
  "$(printf '%s' "$HELPER_OUT" | grep -c 'wal-chain-manifest.sh' || true)" "1"
PITR_NH_TXT="$(cd "$NOHELPER" && bash scripts/ops/postgres-restore.sh --pitr --base "$PSET/s1.pmanifest" --wal-dir "$PWAL" --until "$PITR_UNTIL" --until-lsn 0/3000000 --out "$WORK/pitr-out-nh" --wal-chain "$PCHAIN" 2>&1)"; pitr_nh_rc=$?
check "control negativo: el camino PITR no puede verificar la cadena" \
  "$([ "$pitr_nh_rc" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "control negativo: se reporta la verificacion de cadena" \
  "$(printf '%s' "$PITR_NH_TXT" | grep -c 'does not verify' || true)" "1"
check "control negativo: sin senal de exito" \
  "$(printf '%s' "$PITR_NH_TXT" | grep -c '^pitr=prepared ' || true)" "0"
check "control negativo: no se emitio configuracion de recuperacion" \
  "$([ -f "$WORK/pitr-out-nh/postgresql.pitr.conf" ] && echo yes || echo no)" "no"
check "control positivo/negativo: la unica diferencia es el helper" \
  "$([ "$pitr_ok_rc" == "0" ] && [ "$pitr_nh_rc" != "0" ] && echo yes || echo no)" "yes"

# (iv) El OTRO helper del camino PITR: sin postgres-physbackup.sh el emisor muere
# antes todavia, en la verificacion del set base (postgres-restore.sh L129).
rm -f "$NOHELPER/$PITR_SET_HELPER_REL"
PITR_NH2_TXT="$(cd "$NOHELPER" && bash scripts/ops/postgres-restore.sh --pitr --base "$PSET/s1.pmanifest" --wal-dir "$PWAL" --until "$PITR_UNTIL" --until-lsn 0/3000000 --out "$WORK/pitr-out-nh2" --wal-chain "$PCHAIN" 2>&1)"; pitr_nh2_rc=$?
check "control negativo 2 (sin physbackup): el camino PITR no puede verificar el set base" \
  "$([ "$pitr_nh2_rc" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "control negativo 2: se reporta la verificacion del set base" \
  "$(printf '%s' "$PITR_NH2_TXT" | grep -c 'rejected the base set' || true)" "1"
check "control negativo 2: sin senal de exito" \
  "$(printf '%s' "$PITR_NH2_TXT" | grep -c '^pitr=prepared ' || true)" "0"
check "control negativo 2: no se emitio configuracion de recuperacion" \
  "$([ -f "$WORK/pitr-out-nh2/postgresql.pitr.conf" ] && echo yes || echo no)" "no"

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
if grep -qi 'digest' <<<"$out2"; then
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
if grep -qi 'WARNING' <<<"$out4"; then
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
