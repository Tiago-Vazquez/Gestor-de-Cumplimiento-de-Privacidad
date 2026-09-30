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