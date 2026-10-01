#!/usr/bin/env bash
# M29.2 A1 - Tests del CONTRATO del disparador de backup.
#
# Offline y determinista: nunca ejecuta un backup real ni toca ninguna base.
# El binario invocado se sustituye por un doble via BACKUP_CMD (mismo patron que
# OFFHOST_S3_CMD en test-ops-offhost.sh), de modo que se verifica el TRATAMIENTO
# de los codigos de salida, no una ejecucion de produccion.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEDULER="$ROOT_DIR/scripts/ops/backup-schedule.sh"
BACKUP="$ROOT_DIR/scripts/ops/postgres-backup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "M29.2 A1 backup-schedule contract tests (offline, sin base de datos)"

# --- T1: el disparador invoca el script existente, no una reimplementacion ----
if grep -q 'postgres-backup.sh' "$SCHEDULER" && grep -q 'BACKUP_CMD:-' "$SCHEDULER"; then
  ok "T1 el disparador delega en postgres-backup.sh (no lo reimplementa)"
else
  no "T1 el disparador no referencia postgres-backup.sh"
fi
# El disparador NO debe contener logica de backup (pg_dump, manifest, retencion).
leak="$(grep -nE 'pg_dump|pg_dumpall|manifest=|find .*mtime' "$SCHEDULER" | grep -v '^ *#' || true)"
if [[ -z "$leak" ]]; then
  ok "T1b el disparador no duplica logica de backup (pg_dump/manifest/retencion)"
else
  no "T1b el disparador duplica logica: $leak"
fi

# --- doble que devuelve un codigo dado --------------------------------------
make_double() {
  local code="$1" path="$WORK/double-$code.sh"
  printf '#!/usr/bin/env bash\nexit %s\n' "$code" > "$path"
  chmod +x "$path"
  printf '%s' "$path"
}

run_with() {
  local code="$1" double
  double="$(make_double "$code")"
  local out rc
  out="$(BACKUP_CMD="$double" bash "$SCHEDULER" 2>&1)"
  rc=$?
  LAST_OUT="$out"
  LAST_RC="$rc"
}

# --- T2: exit 0 es exito ----------------------------------------------------
run_with 0
check "T2 exit 0 se propaga como 0" "$LAST_RC" "0"
if grep -q 'result=ok' <<<"$LAST_OUT"; then ok "T2b exit 0 se reporta result=ok"; else no "T2b exit 0 no se reporta como ok"; fi

# --- T3: exit 75 se conserva y se identifica como EXIT_LOCKED ----------------
run_with 75
check "T3 exit 75 se conserva (no se enmascara como 0)" "$LAST_RC" "75"
if grep -q 'EXIT_LOCKED' <<<"$LAST_OUT" && grep -q 'skipped_locked' <<<"$LAST_OUT"; then
  ok "T3b exit 75 se identifica como EXIT_LOCKED"
else
  no "T3b exit 75 no se identifica como EXIT_LOCKED"
fi

# --- T4: exit 76 se conserva y se identifica como EXIT_UPLOAD_FAILED ---------
run_with 76
check "T4 exit 76 se conserva (no se enmascara como 0)" "$LAST_RC" "76"
if grep -q 'EXIT_UPLOAD_FAILED' <<<"$LAST_OUT" && grep -q 'partial_upload_failed' <<<"$LAST_OUT"; then
  ok "T4b exit 76 se identifica como EXIT_UPLOAD_FAILED"
else
  no "T4b exit 76 no se identifica como EXIT_UPLOAD_FAILED"
fi

# --- T5: cualquier otro codigo es fallo ------------------------------------
for code in 1 2 130; do
  run_with "$code"
  check "T5 exit $code se propaga intacto" "$LAST_RC" "$code"
  if grep -q "result=failed" <<<"$LAST_OUT"; then
    ok "T5b exit $code se reporta result=failed"
  else
    no "T5b exit $code no se reporta como fallo"
  fi
done

# --- T6: sin credenciales hardcodeadas --------------------------------------
creds="$(grep -nEi '(password|secret|api[_-]?key|token)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"']+' "$SCHEDULER" || true)"
if [[ -z "$creds" ]]; then
  ok "T6 el disparador no contiene credenciales hardcodeadas"
else
  no "T6 credenciales hardcodeadas: $creds"
fi
# --- T7: el disparador es invocable manualmente ----------------------------
# No hay workflow de GitHub: el scheduler de produccion es EXTERNO (systemd/cron
# en el VPS). Se verifica que el contrato documenta la ejecucion manual.
if [[ -f "$ROOT_DIR/scripts/ops/backup-schedule.service" ]]; then
  ok "T7a existe la unidad systemd (disparador de produccion)"
else
  no "T7a falta scripts/ops/backup-schedule.service"
fi
if grep -qE 'ops:backup-schedule|backup-schedule\.sh' "$ROOT_DIR/package.json" "$ROOT_DIR/DEPLOY.md" 2>/dev/null; then
  ok "T7b la ejecucion manual esta expuesta (script package.json / documentada)"
else
  no "T7b no hay via documentada para disparar el backup a mano"
fi

# --- T8: el disparador declara una cadencia (schedule) ---------------------
sched="$(grep -nE 'OnCalendar|Persistent|cron' "$ROOT_DIR/scripts/ops/backup-schedule.service" 2>/dev/null || true)"
if [[ -n "$sched" ]]; then
  ok "T8 la unidad systemd declara la cadencia (OnCalendar/Persistent)"
else
  no "T8 la unidad systemd no declara cadencia"
fi

# --- T9: no hay retries automaticos -----------------------------------------
if grep -qiE '\bretry\b|--retry|reintento' "$SCHEDULER" | grep -v '^ *#'; then
  no "T9 el disparador introduce retries"
else
  ok "T9 el disparador NO introduce retries (solo delega)"
fi
# El comentario puede mencionar "sin retries"; lo que no vale es logica de retry.
if grep -qE '^\s*for .*retry|^\s*until ' "$SCHEDULER"; then
  no "T9b hay bucle de reintento en el disparador"
else
  ok "T9b no hay bucles de reintento"
fi

# --- T10: el lock sigue siendo el del backup, no uno nuevo ----------------
newlock="$(grep -nE 'mkdir.*lock|flock' "$SCHEDULER" | grep -v '^ *#' || true)"
if [[ -z "$newlock" ]]; then
  ok "T10 el disparador NO introduce un lock propio"
else
  no "T10 el disparador duplica el lock: $newlock"
fi
if grep -q 'EXIT_LOCKED=75' "$BACKUP"; then
  ok "T10b la autoridad del lock sigue siendo postgres-backup.sh (75)"
else
  no "T10b postgres-backup.sh ya no declara EXIT_LOCKED=75"
fi

printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1

# =============================================================================
# M29.2 A2 - Seam de alerta (ALERT_CMD). Offline y determinista.
# El "canal" es un comando que escribe el JSON recibido por stdin en un
# fichero: no hay red, ni proveedor, ni credenciales.
# =============================================================================
echo ""
echo "M29.2 A2 alert seam tests (offline, sin red)"

ALERT_OUT="$WORK/alert.json"

# Doble de canal: guarda el payload. Si el scheduler no lo invoca, el fichero
# se queda ausente -> eso ES la asercion de "no se invoco".
make_alert_double() {
  printf '#!/usr/bin/env bash\ncat > %q\n' "$ALERT_OUT"
}

run_alert() {
  # $1 = codigo del backup, $2 = valor de ALERT_CMD (vacio = sin canal)
  local code="$1" alert_cmd="$2" double out rc
  double="$(make_double "$code")"
  rm -f "$ALERT_OUT"
  if [[ -z "$alert_cmd" ]]; then
    out="$(env -u ALERT_CMD BACKUP_CMD="$double" bash "$SCHEDULER" 2>&1)"
  else
    out="$(ALERT_CMD="$alert_cmd" BACKUP_CMD="$double" bash "$SCHEDULER" 2>&1)"
  fi
  rc=$?
  LAST_OUT="$out"
  LAST_RC="$rc"
}

ALERT_OK="$(make_alert_double)"
# --- T11: sin ALERT_CMD el comportamiento de R9a queda INTACTO --------------
run_alert 0 ""
check "T11 sin ALERT_CMD y backup ok conserva exit 0" "$LAST_RC" "0"
if [[ ! -s "$ALERT_OUT" ]]; then ok "T11b sin ALERT_CMD no se invoca ningun canal"; else no "T11b se invoco un canal sin ALERT_CMD"; fi
run_alert 76 ""
check "T11d sin ALERT_CMD un 76 sigue propagandose como 76" "$LAST_RC" "76"
if [[ ! -s "$ALERT_OUT" ]]; then ok "T11e sin ALERT_CMD un 76 tampoco notifica"; else no "T11e un 76 notifico sin ALERT_CMD"; fi

# --- T12: result=ok NO alerta -------------------------------------------------
run_alert 0 "$ALERT_OK"
check "T12 ok conserva exit 0" "$LAST_RC" "0"
if [[ ! -s "$ALERT_OUT" ]]; then ok "T12b ok NO invoca el canal de alerta"; else no "T12b ok SI invoco el canal"; fi

# --- T13: skipped_locked (75) alerta -----------------------------------------
run_alert 75 "$ALERT_OK"
check "T13 skipped_locked conserva exit 75" "$LAST_RC" "75"
if [[ -s "$ALERT_OUT" ]]; then ok "T13b skipped_locked SI invoca el canal"; else no "T13b skipped_locked NO notifico"; fi

# --- T14: partial_upload_failed (76) alerta ---------------------------------
run_alert 76 "$ALERT_OK"
check "T14 partial_upload_failed conserva exit 76" "$LAST_RC" "76"
if [[ -s "$ALERT_OUT" ]]; then ok "T14b partial_upload_failed SI invoca el canal"; else no "T14b partial_upload_failed NO notifico"; fi

# --- T15: failed (otros codigos) alerta --------------------------------------
run_alert 1 "$ALERT_OK"
check "T15 failed conserva exit 1" "$LAST_RC" "1"
if [[ -s "$ALERT_OUT" ]]; then ok "T15b failed SI invoca el canal"; else no "T15b failed NO notifico"; fi

# --- T16: un canal caido NO altera el codigo del backup ----------------------
# Garantia central de A2: el exit code es el del BACKUP, jamas el del canal.
# Con result=ok el canal ni se invoca (politica), asi que el caso interesante
# es un backup NO exitoso al que se le rompe el canal de aviso.
run_alert 76 "exit 3"
check "T16 backup 76 + canal caido => exit 76 (no se degrada a 3)" "$LAST_RC" "76"
if grep -q "alert delivery FAILED" <<<"$LAST_OUT"; then
  ok "T16b el fallo del canal queda registrado"
else
  no "T16b el fallo del canal no quedo registrado"
fi
run_alert 1 "exit 9"
check "T16c backup 1 + canal caido => exit 1 (no enmascarado)" "$LAST_RC" "1"

# --- T17: el JSON minimo lleva timestamp, result y exit_code ----------------
run_alert 76 "$ALERT_OK"
payload="$(cat "$ALERT_OUT" 2>/dev/null || true)"
for field in timestamp result exit_code; do
  if grep -q "\"$field\"" <<<"$payload"; then
    ok "T17 el evento JSON incluye $field"
  else
    no "T17 el evento JSON NO incluye $field"
  fi
done
if grep -q "\"result\":\"partial_upload_failed\"" <<<"$payload"; then
  ok "T17b el campo result viaja con el valor correcto"
else
  no "T17b result no viaja con el valor correcto"
fi
if grep -q "\"exit_code\":76" <<<"$payload"; then
  ok "T17c exit_code viaja como numero, no como cadena"
else
  no "T17c exit_code no viaja como numero"
fi
if grep -qE "\"timestamp\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T" <<<"$payload"; then
  ok "T17d el timestamp tiene formato ISO-8601 UTC"
else
  no "T17d el timestamp no tiene formato ISO-8601"
fi
if [[ "$(wc -l < "$ALERT_OUT")" -le 1 ]]; then
  ok "T17e el evento es un unico objeto JSON"
else
  no "T17e el evento ocupa mas de una linea"
fi

# --- T18: no se presupone ningun proveedor ----------------------------------
prov="$(grep -nEi "slack|discord|telegram|smtp|sendgrid|mailgun|alertmanager|nodemailer|https?://" "$SCHEDULER" | grep -vE "^[0-9]+:[[:space:]]*#" || true)"
if [[ -z "$prov" ]]; then
  ok "T18 el disparador no presupone ningun proveedor concreto"
else
  no "T18 el disparador acopla un proveedor: $prov"
fi

printf "\n  %d ok, %d fail\n" "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1