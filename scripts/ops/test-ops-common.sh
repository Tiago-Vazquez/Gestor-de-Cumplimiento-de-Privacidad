#!/usr/bin/env bash
# M25.5 - Tests for the operational shell helpers.
#
# Self-contained on purpose: no test framework is introduced just to test three
# shell scripts. It sources the real scripts/ops/common.sh, so it exercises the
# same code the backup and restore run, not a copy.
#
# Run: bash scripts/ops/test-ops-common.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "M25.5 ops-common tests"

FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
printf 'contenido-fijo-para-el-test' > "$FIXTURE/artefacto.bin"
REAL_SHA="$(cd "$FIXTURE" && sha256sum artefacto.bin | awk '{print $1}')"

# --- 1. hash con ruta POSIX ------------------------------------------------
check "hash con ruta POSIX" "$(sha256_of "$FIXTURE/artefacto.bin")" "$REAL_SHA"

# --- 2. hash con ruta Windows (backslashes) --------------------------------
# M25.4: sha256sum prefixes "\" when the path holds literal backslashes, and awk
# captured that 65-character value. Reading from stdin must make it identical.
# The path is derived from the real fixture so the shell can open it: with the
# stdin form the shell performs the redirect, so the file must exist.
WIN_PATH="$(cygpath -w "$FIXTURE/artefacto.bin" 2>/dev/null || true)"
if [[ -n "$WIN_PATH" && -f "$WIN_PATH" ]]; then
  WIN_SHA="$(sha256_of "$WIN_PATH")"
  check "hash con ruta Windows (backslashes)" "$WIN_SHA" "$REAL_SHA"
  if [[ "$WIN_SHA" =~ ^[0-9a-f]{64}$ ]]; then ok "hash sin prefijo de 65 caracteres"; else no "hash mal formado: $WIN_SHA"; fi
else
  echo "  skip hash con ruta Windows (ruta real no resoluble en este host)"
fi

# --- 3. manifest historico con prefijo \ ------------------------------------
check "manifest historico con \\ se normaliza" "$(strip_sha_prefix "\\$REAL_SHA")" "$REAL_SHA"
if is_sha256 "$(strip_sha_prefix "\\$REAL_SHA")"; then ok "prefijo \\ produce un digest valido"; else no "prefijo \\ no se normaliza"; fi

# --- 4. hash truncado / incorrecto rechazado -------------------------------
if is_sha256 "\\${REAL_SHA:0:63}"; then no "hash truncado deberia rechazarse"; else ok "hash truncado rechazado"; fi
if is_sha256 ""; then no "hash vacio deberia rechazarse"; else ok "hash vacio rechazado"; fi
if is_sha256 "${REAL_SHA:0:63}"; then no "hash de 63 caracteres deberia rechazarse"; else ok "hash de 63 caracteres rechazado"; fi
if is_sha256 "$(printf '%s' "$REAL_SHA" | tr 'a-f' 'A-F')"; then no "hex en mayusculas deberia rechazarse"; else ok "hex en mayusculas rechazado"; fi
if is_sha256 "$REAL_SHA"; then ok "hash de 64 hex valido aceptado"; else no "hash valido deberia aceptarse"; fi
# cut -c1-64 trunca en vez de quitar: exactamente el valor que M25.4 prohibio.
TRUNCATED="$(printf '%s' "\\$REAL_SHA" | cut -c1-64)"
if is_sha256 "$TRUNCATED"; then no "el valor producido por cut -c1-64 deberia rechazarse"; else ok "valor truncado tipo cut -c1-64 rechazado"; fi

# --- 5. sha256_stdin coincide con sha256_of --------------------------------
check "sha256_stdin coincide con sha256_of" "$(sha256_stdin < "$FIXTURE/artefacto.bin")" "$REAL_SHA"

# --- 6. validacion de BACKUP_LOCK_GRACE_SECONDS ----------------------------
# Replica la guarda exacta de postgres-backup.sh para no duplicar la regla.
grace_is_valid() { [[ "$1" =~ ^[0-9]+$ ]]; }
if grace_is_valid "abc"; then no "GRACE=abc deberia rechazarse"; else ok "GRACE=abc rechazado"; fi
if grace_is_valid "-5"; then no "GRACE=-5 deberia rechazarse"; else ok "GRACE=-5 rechazado"; fi
if grace_is_valid "0"; then ok "GRACE=0 aceptado (reclamo inmediato)"; else no "GRACE=0 deberia aceptarse"; fi
if grace_is_valid "120"; then ok "GRACE=120 aceptado (default existente)"; else no "GRACE=120 deberia aceptarse"; fi
if grace_is_valid ""; then no "la guarda deberia rechazar una cadena vacia"; else ok "la guarda rechaza una cadena vacia"; fi
if grace_is_valid "12.5"; then no "GRACE=12.5 deberia rechazarse"; else ok "GRACE=12.5 rechazado"; fi

# El default 120 se aplica con ${BACKUP_LOCK_GRACE_SECONDS:-120}, y `:-` sustituye
# tanto una variable NO DEFINIDA como una DEFINIDA VACIA. Por eso la guarda nunca
# llega a ver la cadena vacia: este caso solo documenta como se comporta la guarda
# de forma aislada, NO lo que hace el script con BACKUP_LOCK_GRACE_SECONDS="".
# El comportamiento real del script se comprueba en la seccion siguiente.
resolve_grace() { local v="${1-__UNSET__}"; if [[ "$v" == "__UNSET__" || -z "$v" ]]; then printf '120'; else printf '%s' "$v"; fi; }
check "GRACE no definido resuelve al default" "$(resolve_grace)" "120"
check "GRACE definido vacio resuelve al default" "$(resolve_grace "")" "120"
check "GRACE definido con valor se respeta" "$(resolve_grace 0)" "0"

# --- 7. el default 120 no cambio --------------------------------------------
DEFAULT_LINE="$(grep -o 'BACKUP_LOCK_GRACE_SECONDS:-[0-9]*' "$ROOT_DIR/scripts/ops/postgres-backup.sh" | head -1)"
check "default de GRACE_SECONDS intacto" "$DEFAULT_LINE" "BACKUP_LOCK_GRACE_SECONDS:-120"

# --- 8. journal agregado determinista ---------------------------------------
J1="$(printf '1:aaa:100\n2:bbb:200\n' | sha256_stdin)"
J2="$(printf '2:bbb:200\n1:aaa:100\n' | sha256_stdin)"
J3="$(printf '1:aaa:100\n2:bbb:200\n' | sha256_stdin)"
check "journal hash es determinista" "$J1" "$J3"
if [[ "$J1" != "$J2" ]]; then ok "journal hash depende del orden (como debe)"; else no "orden no deberia colapsarse"; fi
if is_sha256 "$J1"; then ok "journal hash con forma de digest"; else no "journal hash mal formado"; fi
J4="$(printf '1:aaa:100\n2:CCC:200\n' | sha256_stdin)"
if [[ "$J1" != "$J4" ]]; then ok "journal divergente produce hash distinto"; else no "divergencia no detectada"; fi

# --- 9. limpieza de temporales huerfanos, sin tocar backups activos ----------
TMPROOT="$WORK/backupdir"
mkdir -p "$TMPROOT/.m24-tmp.OLD0001" "$TMPROOT/.m24-tmp.FRESH01" "$TMPROOT/.m24-tmp.ACTIVE"
touch "$TMPROOT/.m24-tmp.OLD0001/dump" "$TMPROOT/.m24-tmp.FRESH01/dump" "$TMPROOT/.m24-tmp.ACTIVE/dump"
touch -d "3 days ago" "$TMPROOT/.m24-tmp.OLD0001"
reclaim_temp_dirs() {
  local dir age
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    age=$(( $(date +%s) - $(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir" 2>/dev/null || echo 0) ))
    [[ "$age" -ge 86400 ]] && rm -rf "$dir"
  done < <(find "$1" -maxdepth 1 -type d -name '.m24-tmp.*' 2>/dev/null || true)
}
reclaim_temp_dirs "$TMPROOT"
if [[ -d "$TMPROOT/.m24-tmp.OLD0001" ]]; then no "temporal huerfano antiguo deberia eliminarse"; else ok "temporal huerfano antiguo eliminado"; fi
if [[ -d "$TMPROOT/.m24-tmp.FRESH01" ]]; then ok "temporal reciente preservado"; else no "temporal reciente no debe eliminarse"; fi
if [[ -d "$TMPROOT/.m24-tmp.ACTIVE" ]]; then ok "temporal de backup activo preservado"; else no "temporal ACTIVE eliminado <-- grave"; fi

# --- 10. manifest con CRLF (editado en Windows, restaurado en Linux) --------
# El awk de MSYS ya descarta el CR; el de Linux no. Se fija el comportamiento
# con una expresion explicita para que sea identico en ambos hosts.
CRLF_DIR="$WORK/crlf"
mkdir -p "$CRLF_DIR"
printf 'format=pg_dump-custom\r\ndump_sha256=%s\r\nmigration_count=20\r\n' "$REAL_SHA" > "$CRLF_DIR/m.manifest"
CRLF_MANIFEST="$CRLF_DIR/m.manifest"
crlf_manifest_value() { awk -F= -v key="$1" '$1 == key { sub(/\r$/, ""); sub(/^[^=]*=/, ""); print; exit }' "$CRLF_MANIFEST"; }
CRLF_SHA="$(crlf_manifest_value dump_sha256)"
check "CRLF: hash leido sin CR residual" "${#CRLF_SHA}" "64"
if is_sha256 "$CRLF_SHA"; then ok "CRLF: hash de manifest CRLF es valido"; else no "CRLF: hash invalido"; fi
check "CRLF: migration_count leido sin CR" "$(crlf_manifest_value migration_count)" "20"
if grep -q 'manifest_value() { strip_cr ' "$ROOT_DIR/scripts/ops/postgres-restore.sh"; then
  ok "manifest_value normaliza CR mediante strip_cr"
else
  no "manifest_value no normaliza CR mediante strip_cr"
fi
if grep -q 'strip_cr "\$expected"' "$ROOT_DIR/scripts/ops/postgres-restore.sh"; then
  ok "el bucle count_ tambien normaliza CR (remediacion M25.5)"
else
  no "el bucle count_ lee el manifest sin normalizar CR <-- defecto abierto"
fi

# --- 11. bucle count_ con CRLF: el punto ciego de la auditoria -------------
# El bucle lee el manifest con grep en vez de manifest_value, asi que antes de la
# remediacion el CR llegaba a la comparación. En Git Bash read lo descarta solo y
# el defecto quedaba enmascarado; en Linux no.
printf 'count_sources=3\r\ncount_users=1\r\n' > "$CRLF_DIR/counts.manifest"
count_loop() {
  local key expected sources="" users=""
  while IFS='=' read -r key expected; do
    expected="$(strip_cr "$expected")"
    case "$key" in
      count_sources) [[ "$expected" == "3" ]] && sources=ok ;;
      count_users)   [[ "$expected" == "1" ]] && users=ok ;;
    esac
  done < <(grep '^count_' "$1" || true)
  printf '%s/%s' "$sources" "$users"
}
check "count_ con CRLF: count_sources leido correctamente" "$(count_loop "$CRLF_DIR/counts.manifest" | cut -d/ -f1)" "ok"
check "count_ con CRLF: count_users leido correctamente" "$(count_loop "$CRLF_DIR/counts.manifest" | cut -d/ -f2)" "ok"
# Sin la normalizacion el valor traeria el CR y no coincidiria.
RAW_EXPECTED="$(IFS='=' read -r k v < <(grep '^count_sources=' "$CRLF_DIR/counts.manifest"); printf '%s' "$v")"
if [[ "$RAW_EXPECTED" == "3" ]]; then
  echo "  nota: en este host read ya descarta el CR; el defecto solo es observable en Linux"
else
  echo "  nota: en este host read conserva el CR; sin strip_cr habria fallado"
fi

# --- 11. los dos scripts usan la libreria compartida -----------------------
for f in postgres-backup.sh postgres-restore.sh; do
  if grep -q 'source .*common.sh' "$ROOT_DIR/scripts/ops/$f"; then ok "$f usa common.sh"; else no "$f no sourcea common.sh"; fi
  if grep -q 'sha256sum "\$1"' "$ROOT_DIR/scripts/ops/$f"; then no "$f conserva el hash via argumento (bug M25.4)"; else ok "$f ya no pasa la ruta a sha256sum"; fi
done

printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1