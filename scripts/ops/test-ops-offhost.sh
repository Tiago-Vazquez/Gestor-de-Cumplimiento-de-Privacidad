#!/usr/bin/env bash
# M26.0 - Tests for the off-host upload client.
#
# Exercises the real scripts/ops/offhost-upload.sh against a local double via
# OFFHOST_S3_CMD, so the whole contract is verified with no network, no
# credentials, no bucket and no aws CLI. The B2 account cannot be created until
# the production VPS location is known, and a client that is only testable
# against production infrastructure is a client that ships untested.
#
# RETRY_SLEEP_HOOK replaces the real sleep, so the retry assertions cost zero
# wall-clock time while the delays stay observable: they are recorded, not
# skipped.
#
# Run: bash scripts/ops/test-ops-offhost.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPLOADER="$ROOT_DIR/scripts/ops/offhost-upload.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "M26.0 offhost-upload tests"

# --- fixture: a realistic backup set ---------------------------------------
SET="$WORK/m24-postgres-20260926T001718Z-abc123"
mkdir -p "$SET"
printf 'dump-payload' > "$SET/m24-postgres-20260926T001718Z-abc123.dump"
printf 'roles-payload' > "$SET/m24-postgres-20260926T001718Z-abc123.roles.sql"
printf 'format=pg_dump-custom\ndump_sha256=deadbeef\n' > "$SET/m24-postgres-20260926T001718Z-abc123.manifest"
DUMP="$SET/m24-postgres-20260926T001718Z-abc123.dump"

# A recording transport: appends each key to a log and can be told to fail.
#
# Two failure modes, because the retry contract has to be tested in both
# directions and a single mode proves only one of them:
#   DOUBLE_FAIL_MODE=once     -> fails the first matching call, then succeeds.
#                                Models a transient network fault: the retry must
#                                recover and the run must finish 0.
#   DOUBLE_FAIL_MODE=always   -> fails every matching call. Models a persistent
#                                fault: the run must exhaust its attempts and
#                                finish 76. Without this mode a "persistent
#                                failure" test silently passed on the first
#                                retry and never exercised the give-up path.
# The marker records that a "once" failure already happened, so a second call in
# the same run succeeds.
CALLS="$WORK/calls.log"
cat > "$WORK/double.sh" <<'DOUBLE'
#!/usr/bin/env bash
printf '%s\n' "$2" >> "$CALLS"
if [[ -n "${DOUBLE_FAIL_ON:-}" && "$2" == *"${DOUBLE_FAIL_ON}"* ]]; then
  case "${DOUBLE_FAIL_MODE:-once}" in
    always)
      echo "double: simulated persistent failure for $2" >&2
      exit 1
      ;;
    once)
      if [[ -f "${DOUBLE_FAIL_MARKER:-/nonexistent}" ]]; then exit 0; fi
      : > "${DOUBLE_FAIL_MARKER:-/nonexistent}"
      echo "double: simulated transient failure for $2" >&2
      exit 1
      ;;
  esac
fi
exit 0
DOUBLE
chmod +x "$WORK/double.sh"

# Records sleeps instead of performing them.
cat > "$WORK/sleep.sh" <<'SLEEPER'
#!/usr/bin/env bash
printf 'sleep %s\n' "$1" >> "$SLEEP_LOG"
exit 0
SLEEPER
chmod +x "$WORK/sleep.sh"

export CALLS
export SLEEP_LOG="$WORK/sleeps.log"

# The knobs are plain global variables rather than `VAR=x func` prefixes.
# A prefix assignment to a *function* call is only visible inside the function
# for variables the function actually reads, which made it impossible to set
# several knobs at once without one shadowing another. Globals with explicit
# defaults are unambiguous and let each test change one thing.
TB_VAR_NAME=""; TB_VAR_VALUE=""
TB_FAIL_ON=""; TB_FAIL_MARKER=""; TB_FAIL_MODE=""
TB_RETRIES=3; TB_DELAY=1
TB_BUCKET="b"; TB_ENDPOINT="https://x.invalid"
TB_DUMP="$DUMP"
TB_ALERT_CMD=""

# Defined before the first use on purpose: bash resolves a function at call time,
# so a definition placed after the first call site silently becomes "command not
# found" (127) and every later assertion fails for the wrong reason.
#
# The exit status is captured from an `if` rather than from `$?` after an
# assignment: in this shell an assignment followed by `status=$?` yields an empty
# value, which made a genuinely failing upload report success. The `if` form is
# unambiguous. `env` is used for the variables under test so an explicit EMPTY
# value survives: `NAME=value cmd` cannot express "set to empty", because the
# client would silently fall back to its default instead of being tested.
# The variable under test must WIN over the defaults above. When TB_VAR_NAME is
# set it is appended LAST, because `env` resolves a name given twice as
# last-wins. Passing it first let the default OFFHOST_UPLOAD_RETRIES=3 override
# an explicit "0", so the guard under test never actually ran and the case
# reported the default behaviour instead.
run_capture() {
  local __out
  if __out="$(env ${TB_FAIL_ON:+DOUBLE_FAIL_ON="$TB_FAIL_ON"} \
      ${TB_FAIL_MARKER:+DOUBLE_FAIL_MARKER="$TB_FAIL_MARKER"} \
      ${TB_FAIL_MODE:+DOUBLE_FAIL_MODE="$TB_FAIL_MODE"} \
      OFFHOST_S3_CMD="$WORK/double.sh" \
      RETRY_SLEEP_HOOK="$WORK/sleep.sh" \
      OFFHOST_UPLOAD_RETRIES="$TB_RETRIES" \
      OFFHOST_UPLOAD_RETRY_DELAY_SECONDS="$TB_DELAY" \
      BACKUP_BUCKET="$TB_BUCKET" \
      B2_S3_ENDPOINT="$TB_ENDPOINT" \
      ${TB_VAR_NAME:+"$TB_VAR_NAME=$TB_VAR_VALUE"} \
      ${TB_ALERT_CMD:+ALERT_CMD="$TB_ALERT_CMD"} \
      bash "$UPLOADER" --backup "$TB_DUMP" "$@" 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  OUT="$__out"
  # Reset the per-test knobs so the next case starts from a known state.
  TB_VAR_NAME=""; TB_VAR_VALUE=""
  TB_FAIL_ON=""; TB_FAIL_MARKER=""; TB_FAIL_MODE=""
  TB_RETRIES=3; TB_DELAY=1
  TB_BUCKET="b"; TB_ENDPOINT="https://x.invalid"
  TB_DUMP="$DUMP"
  TB_ALERT_CMD=""
}

# Convenience wrapper for the happy path with the real bucket name.
run_upload() {
  : > "$CALLS"
  : > "$SLEEP_LOG"
  TB_BUCKET="privaris-postgres-backups" run_capture "$@"
}

# --- 1. orden obligatorio dump -> roles -> manifest -------------------------
run_upload
check "upload exitoso devuelve 0" "$RC" "0"
check "sube exactamente 3 objetos" "$(wc -l < "$CALLS" | tr -d ' ')" "3"
check "orden dump -> roles -> manifest" "$(sed 's/.*\.\(dump\|roles\.sql\|manifest\)$/\1/' "$CALLS" | tr '\n' ',')" "dump,roles.sql,manifest,"
# El manifest debe ser el ULTIMO objeto en existir: es el commit logico del set.
check "el manifest se sube el ultimo" "$(tail -n1 "$CALLS" | grep -c '\.manifest$')" "1"
check "el dump NO es el ultimo" "$(tail -n1 "$CALLS" | grep -c '\.dump$')" "0"
check "la clave usa el layout backups/<env>/<base>" \
  "$(head -n1 "$CALLS")" "backups/prod/m24-postgres-20260926T001718Z-abc123.dump"

# --- 2. prefijo de entorno --------------------------------------------------
: > "$CALLS"
TB_VAR_NAME=BACKUP_PREFIX; TB_VAR_VALUE=drill
run_capture
check "BACKUP_PREFIX=drill usa backups/drill/" "$(head -n1 "$CALLS")" "backups/drill/m24-postgres-20260926T001718Z-abc123.dump"

# --- 3. codigo 76 y conservacion del backup local ---------------------------
# Persistent failure: EVERY attempt of the manifest must fail, so the run has to
# give up and report 76. The "once" mode would be recovered by the retry and
# would exit 0, so it cannot be used to test the give-up path.
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".manifest"; TB_FAIL_MODE=always; TB_RETRIES=2; TB_DELAY=0
run_capture
check "upload fallido devuelve 76 (no 1)" "$RC" "76"
check "el backup local se conserva tras el fallo" "$([[ -f "$DUMP" ]] && echo yes)" "yes"
check "el cliente explica que el backup local sigue intacto" \
  "$(printf '%s' "$OUT" | grep -c 'local backup is intact')" "1"
# The double records ATTEMPTS, including the ones that failed, so the manifest
# key appears RETRIES times even though the object was never published. What
# makes the set unusable is that no manifest object exists at the end; the log
# cannot show that, and the client does not attempt a compensating delete of the
# half-published dump/roles, which is deliberate (see the ADR-003 note).
check "el manifest se intentó RETRIES veces y ninguna tuvo exito" \
  "$(grep -c '\.manifest$' "$CALLS")" "2"
check "el fallo no borra los objetos ya publicados" \
  "$(grep -c '\.dump$' "$CALLS")" "1"

# --- 4. reintentos ----------------------------------------------------------
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".manifest"; TB_FAIL_MODE=always; TB_RETRIES=3; TB_DELAY=7
run_capture
check "fallo persistente tras 3 intentos devuelve 76" "$RC" "76"
# dump + roles = 2 llamadas, manifest = 3 intentos -> 5 llamadas en total.
check "reintenta el objeto fallido (2+3 llamadas)" "$(wc -l < "$CALLS" | tr -d ' ')" "5"
check "respeta el retardo configurado" "$(sort -u "$SLEEP_LOG" | tr -d ' ')" "sleep7"
# retry_with_backoff sleeps BETWEEN ATTEMPTS OF THE SAME OBJECT, not between
# different objects. With RETRIES=3 on the manifest that is exactly 2 sleeps, and
# none before its first attempt. The successful dump and roles do not sleep at
# all: they succeeded on the first try. A loop that also slept between objects
# would add latency to every healthy run for no reason.
check "duerme solo entre reintentos del mismo objeto" "$(wc -l < "$SLEEP_LOG" | tr -d ' ')" "2"
check "no duerme tras un objeto que tuvo exito" "$(sort -u "$SLEEP_LOG" | tr -d ' ')" "sleep7"
# The bound is real: a run that kept retrying would hang the scheduler forever.
check "no intenta un cuarto intento" "$(grep -c '\.manifest$' "$CALLS")" "3"

# --- 5. recuperacion tras un fallo transitorio ------------------------------
rm -f "$WORK/never.fail"
: > "$CALLS"; : > "$SLEEP_LOG"
TB_FAIL_ON=".roles.sql"; TB_FAIL_MARKER="$WORK/never.fail"; TB_RETRIES=3; TB_DELAY=1
run_capture
check "un fallo transitorio no aborta: devuelve 0" "$RC" "0"
check "sube los 3 objetos pese al fallo transitorio" "$(wc -l < "$CALLS" | tr -d ' ')" "4"
# El manifest sigue siendo el ultimo objeto aunque roles se haya reintentado.
check "el manifest sigue siendo el ultimo tras un reintento" "$(tail -n1 "$CALLS" | grep -c '\.manifest$')" "1"

# --- 6. idempotencia --------------------------------------------------------
run_upload
first_keys="$(cat "$CALLS")"
run_upload
check "re-ejecutar produce las mismas claves (idempotente)" "$(cat "$CALLS")" "$first_keys"

# --- 7. validacion de configuracion (fail-fast, sin llamadas) ---------------
# Each case asserts two things: the client exits 1, and it never reached the
# transport. A guard that validated AFTER uploading would still exit 1 while
# having already published objects under a key the credential does not allow.
cfg_case() {
  local desc="$1" name="$2" value="$3"
  : > "$CALLS"
  TB_VAR_NAME="$name"; TB_VAR_VALUE="$value"
  run_capture
  if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then
    ok "$desc"
  else
    no "$desc (salida $RC, llamadas $(wc -l < "$CALLS" | tr -d ' '))"
  fi
}
# A single helper has to express both "set to a value" and "set to empty".
# `NAME=value cmd` cannot do that: the empty assignment never reaches the child,
# so the client would fall back to its default and the test would assert the
# wrong thing. `env` inside run_capture is what makes the empty case real.
cfg_case "BACKUP_PREFIX con traversal rechazado"  BACKUP_PREFIX '../escape'
cfg_case "BACKUP_PREFIX con barra inicial rechazado" BACKUP_PREFIX '/prod'
cfg_case "BACKUP_PREFIX vacio rechazado"            BACKUP_PREFIX ''
cfg_case "OFFHOST_UPLOAD_RETRIES=0 rechazado"       OFFHOST_UPLOAD_RETRIES '0'
cfg_case "OFFHOST_UPLOAD_RETRIES no numerico rechazado" OFFHOST_UPLOAD_RETRIES 'abc'
cfg_case "OFFHOST_UPLOAD_RETRIES negativo rechazado" OFFHOST_UPLOAD_RETRIES '-1'
cfg_case "OFFHOST_UPLOAD_RETRY_DELAY no numerico rechazado" OFFHOST_UPLOAD_RETRY_DELAY_SECONDS 'xx'

# --- 7b. variables obligatorias ausentes ------------------------------------
: > "$CALLS"; TB_BUCKET=""
run_capture
if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then ok "BACKUP_BUCKET vacio rechazado antes de cualquier llamada"; else no "BACKUP_BUCKET vacio no rechazado (salida $RC)"; fi
: > "$CALLS"; TB_ENDPOINT=""
run_capture
if [[ "$RC" == 1 && ! -s "$CALLS" ]]; then ok "B2_S3_ENDPOINT vacio rechazado antes de cualquier llamada"; else no "B2_S3_ENDPOINT vacio no rechazado (salida $RC)"; fi

# --- 8. --dry-run no toca el almacenamiento ---------------------------------
: > "$CALLS"
run_capture --dry-run
check "--dry-run no invoca al transporte" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
check "--dry-run reporta las 3 claves" "$(printf '%s' "$OUT" | grep -c 'would upload')" "3"

# --- 9. artefactos faltantes ------------------------------------------------
: > "$CALLS"; TB_DUMP="$WORK/no-existe.dump"
run_capture
check "dump inexistente rechazado" "$RC" "1"
NOMAN="$WORK/m24-postgres-20260926T001718Z-zzz999"
mkdir -p "$NOMAN"
printf 'x' > "$NOMAN/m24-postgres-20260926T001718Z-zzz999.dump"
: > "$CALLS"
TB_DUMP="$NOMAN/m24-postgres-20260926T001718Z-zzz999.dump" run_capture
check "manifest ausente rechazado (no se sube un set incompleto)" "$RC" "1"
check "no se sube ningun objeto si falta el manifest" "$(wc -l < "$CALLS" | tr -d ' ')" "0"

# --- 10. los guards criticos siguen presentes en el codigo -----------------
if grep -q 'local backup is intact' "$UPLOADER"; then ok "el cliente declara que conserva el backup local"; else no "falta la nota de conservacion del backup local"; fi
if grep -q 'EXIT_UPLOAD_FAILED=76' "$UPLOADER"; then ok "el codigo 76 esta definido en el cliente"; else no "falta EXIT_UPLOAD_FAILED=76"; fi
# El orden NO debe ser configurable: es el invariante que hace del manifest un commit.
if grep -q '^UPLOAD_ORDER=("dump" "roles.sql" "manifest")' "$UPLOADER"; then
  ok "el orden de subida es una constante, no una variable de entorno"
else
  no "el orden de subida es configurable <-- romperia el invariante del manifest"
fi
# The published suffix must be the one postgres-restore.sh looks for. A "roles"
# entry would publish <base>.roles while the restore derives <base>.roles.sql,
# so the set would look complete in the bucket and only fail at restore time.
if grep -q 'roles\.sql) printf' "$UPLOADER"; then
  ok "el sufijo roles.sql coincide con el que deriva el restore"
else
  no "el sufijo publicado no coincide con el que busca postgres-restore.sh"
fi

# =============================================================================
# M29.2 A2 - Alertas en el punto donde nace el 76.
#
# El 76 lo produce ESTE script, asi que aqui se emite la alerta. Estos casos
# son offline y deterministas: el canal es un comando que escribe el JSON
# recibido por stdin en un fichero. Sin red, sin credenciales y sin proveedor.
# =============================================================================
echo ""
echo "M29.2 A2 offhost alert tests (offline, sin red)"

ALERT_OUT="$WORK/alert.json"
ALERT_SINK="cat > $ALERT_OUT"

# --- A1: upload exitoso NO alerta -------------------------------------------
rm -f "$ALERT_OUT"
TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="$ALERT_SINK" run_capture
check "A1 upload exitoso conserva exit 0" "$RC" "0"
if [[ ! -s "$ALERT_OUT" ]]; then
  ok "A2 upload exitoso NO emite alerta"
else
  no "A2 upload exitoso emitio alerta"
fi

# --- A3: fallo definitivo -> partial_upload_failed --------------------------
# DOUBLE_FAIL_MODE=always hace fallar todos los intentos: es el fallo
# definitivo que produce el 76, no el transitorio que se recupera.
rm -f "$ALERT_OUT"
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="$ALERT_SINK" run_capture
check "A3 fallo definitivo conserva exit 76 (no lo degrada)" "$RC" "76"
if [[ -s "$ALERT_OUT" ]]; then
  ok "A4 fallo definitivo emite alerta"
else
  no "A4 fallo definitivo NO emitio alerta"
fi
if grep -q '"result":"partial_upload_failed"' "$ALERT_OUT" 2>/dev/null; then
  ok "A5 la alerta identifica partial_upload_failed"
else
  no "A5 la alerta no dice partial_upload_failed"
fi
if grep -q '"exit_code":76' "$ALERT_OUT" 2>/dev/null; then
  ok "A6 el JSON lleva exit_code 76 como numero"
else
  no "A6 el JSON no lleva exit_code 76"
fi
if grep -qE '"timestamp":"[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$ALERT_OUT" 2>/dev/null; then
  ok "A7 el JSON lleva timestamp ISO-8601"
else
  no "A7 el JSON no lleva timestamp ISO-8601"
fi

# --- A8: sin ALERT_CMD no ocurre nada y el 76 sigue intacto -----------------
rm -f "$ALERT_OUT"
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" run_capture
check "A8 sin ALERT_CMD el 76 se conserva" "$RC" "76"
if [[ ! -s "$ALERT_OUT" ]]; then
  ok "A9 sin ALERT_CMD no se invoca ningun canal"
else
  no "A9 se invoco un canal sin ALERT_CMD"
fi
if grep -q 'alert' <<<"$OUT"; then
  no "A10 sin ALERT_CMD la salida no debe hablar de alertas"
else
  ok "A10 sin ALERT_CMD no hay ruido en la salida"
fi

# --- A11: un ALERT_CMD caido NO oculta ni reemplaza el 76 --------------------
TB_FAIL_MODE="always" TB_FAIL_ON="dump" TB_RETRIES=1 TB_DELAY=1 \
  TB_BUCKET="privaris-postgres-backups" TB_ALERT_CMD="exit 42" run_capture
check "A11 canal caido: el proceso sigue devolviendo 76" "$RC" "76"
if grep -q 'alert delivery FAILED' <<<"$OUT"; then
  ok "A12 el fallo del canal queda registrado"
else
  no "A12 el fallo del canal no quedo registrado"
fi

# --- A13: el calendario de A1 NO ejecuta este script -------------------------
# Impide "arreglar" el hueco de R9c encadenando el uploader al timer: el
# calendario debe seguir siendo SOLO backup local.
# Se comprueba una INVOCACION, no una mencion: un comentario que cite el
# uploader es legitimo (el seam comparte contrato con el), mientras que una
# llamada real rompere el calendario de A1. Por eso se filtran las lineas de
# comentario y se busca el nombre del script en codigo ejecutable.
sched="$ROOT_DIR/scripts/ops/backup-schedule.sh"
sched_code="$(grep -vE '^[[:space:]]*#' "$sched")"
if grep -q 'offhost-upload' <<<"$sched_code"; then
  no "A13 backup-schedule.sh NO debe invocar offhost-upload.sh"
else
  ok "A13 backup-schedule.sh no invoca offhost-upload.sh"
fi
if grep -qE 'OFFHOST_S3_CMD|bash .*offhost' <<<"$sched_code"; then
  no "A13b backup-schedule.sh no debe ejecutar transporte off-host"
else
  ok "A13b backup-schedule.sh no ejecuta ningun transporte off-host"
fi
svc="$ROOT_DIR/scripts/ops/backup-schedule.service"
if grep -q 'ExecStart=.*backup-schedule\.sh' "$svc" && ! grep -q 'offhost' "$svc"; then
  ok "A14 la unidad systemd arranca backup-schedule.sh y no el uploader"
else
  no "A14 la unidad systemd no arranca solo backup-schedule.sh"
fi

# --- A15: el emisor es compartido, no duplicado ------------------------------
lib="$ROOT_DIR/scripts/ops/lib/alert.sh"
if [[ -f "$lib" ]]; then
  ok "A15 existe la libreria compartida de alertas"
else
  no "A15 falta scripts/ops/lib/alert.sh"
fi
dupes="$(grep -c 'printf.*timestamp.*result.*exit_code' "$sched" "$ROOT_DIR/scripts/ops/offhost-upload.sh" 2>/dev/null | grep -v ':0$' || true)"
if [[ -z "$dupes" ]]; then
  ok "A16 el payload JSON esta definido una sola vez (en lib/alert.sh)"
else
  no "A16 el payload JSON esta duplicado en: $dupes"
fi
for s in "$sched" "$ROOT_DIR/scripts/ops/offhost-upload.sh"; do
  if grep -q 'lib/alert.sh' "$s"; then
    ok "A17 $(basename "$s") usa el emisor compartido"
  else
    no "A17 $(basename "$s") no usa lib/alert.sh"
  fi
done

# --- A18: el emisor nunca cambia el codigo de salida ------------------------
if bash -c 'set -Eeuo pipefail; source scripts/ops/lib/alert.sh; ALERT_CMD="exit 9"; emit_alert partial_upload_failed 76 2026-10-01T00:00:00Z; exit 76' 2>/dev/null; then
  no "A18 el proceso deberia salir 76 con un canal caido"
else
  rc18=$?
  check "A18 el codigo de salida sobrevive a un canal caido" "$rc18" "76"
fi
printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
