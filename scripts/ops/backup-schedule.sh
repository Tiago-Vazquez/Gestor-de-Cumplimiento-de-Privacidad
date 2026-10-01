#!/usr/bin/env bash
# M29.2 A1 - Disparador periodico del backup (CONTRATO PORTATIL).
#
# Este script NO es el backup: delega sin reimplementar nada en
# `postgres-backup.sh`, que sigue siendo la unica fuente de verdad del lock,
# los checksums, el manifest y la retencion. Aqui solo se traduce su codigo
# de salida a un estado legible y se devuelve intacto.
#
# POR QUE NO HAY UN "schedule" DE GITHUB ACTIONS
# El PostgreSQL de produccion vive en un VPS privado. Un runner de GitHub no
# llega a el, su disco es efimero (BACKUP_DIR se perderia) y no tiene las
# credenciales de B2. Un workflow programado fallaria todas las noches y daria
# una sensacion falsa de cierre. El disparador real es EXTERNO al repositorio
# (systemd timer o cron en el VPS); aqui queda el contrato que ambos ejecutan.
# Ver DEPLOY.md y docs/operations-runbook.md.
#
# CODIGOS (heredados de postgres-backup.sh, no redefinidos aqui):
#    0  -> ok
#   75  -> EXIT_LOCKED        otro backup en curso; no es un fallo
#   76  -> EXIT_UPLOAD_FAILED backup local correcto, subida remota fallida
#   *   -> fallo real del backup
#
# El codigo original se propaga tal cual: 75 y 76 NO se convierten en 0.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_SCRIPT="$ROOT_DIR/scripts/ops/postgres-backup.sh"

# Seam de test: permite sustituir el binario invocado (mismo patron que
# OFFHOST_S3_CMD en offhost-upload.sh). Vacio = usar el script real.
BACKUP_CMD="${BACKUP_CMD:-$BACKUP_SCRIPT}"

# El backup exige BACKUP_DIR; no duplicamos su validacion ni sus mensajes:
# si falta, el propio script falla con su mensaje y su codigo.
LOG_FILE="${BACKUP_SCHEDULE_LOG:-/dev/stdout}"

emit() {
  if [[ "$LOG_FILE" == "/dev/stdout" ]]; then
    printf '%s\n' "$*"
  else
    printf '%s\n' "$*" >> "$LOG_FILE" 2>/dev/null || printf '%s\n' "$*"
  fi
}

# --- M29.2 A2: seam de alerta (opcional y desacoplada) -----------------------
# ALERT_CMD es un comando al que se entrega el evento en JSON por stdin. Es el
# mismo patron que OFFHOST_S3_CMD en offhost-upload.sh: aqui no vive ningun
# proveedor (ni Slack, ni SMTP, ni Discord, ni webhook). Si NO se define, no hay
# alerta y el backup se comporta EXACTAMENTE igual que sin este bloque.
#
# POLITICA INICIAL (fijada por requisito, no deducida del codigo):
#   ok                    -> NO alerta
#   skipped_locked        -> alerta
#   partial_upload_failed -> alerta
#   failed                -> alerta
#
# GARANTIA CRITICA: el canal de alerta NUNCA cambia el codigo de salida. Un 0
# sigue siendo 0 aunque el canal este caido, y un 75/76 no se degrada a 0. Un
# backup correcto jamas puede convertirse en fallo por un problema de
# notificacion (ni al reves).

# El emisor vive en lib/alert.sh: una sola definicion del contrato JSON y de la
# garantia "una alerta jamas cambia el codigo de salida". offhost-upload.sh
# comparte exactamente el mismo contrato. alert_log se redirige a emit() para
# que este script conserve su LOG_FILE.
# shellcheck source=scripts/ops/lib/alert.sh
source "$ROOT_DIR/scripts/ops/lib/alert.sh"

alert_log() { emit "$*"; }

emit "backup-schedule: invoking $(basename "$BACKUP_CMD")"
started_at="$(date -u +%FT%TZ)"

# Sin retries: un reintento podria solaparse con el backup en curso. El lock de
# postgres-backup.sh es la autoridad y ya devuelve 75 si otro esta activo.
bash "$BACKUP_CMD"
rc=$?

case "$rc" in
  0)
    result="ok"
    emit "backup-schedule: result=ok exit_code=0 started_at=$started_at"
    ;;
  75)
    result="skipped_locked"
    emit "backup-schedule: result=skipped_locked exit_code=75 (EXIT_LOCKED: another backup is in progress) started_at=$started_at"
    ;;
  76)
    result="partial_upload_failed"
    emit "backup-schedule: result=partial_upload_failed exit_code=76 (EXIT_UPLOAD_FAILED: local backup ok, off-host upload failed) started_at=$started_at"
    ;;
  *)
    result="failed"
    emit "backup-schedule: result=failed exit_code=$rc started_at=$started_at"
    ;;
esac

# --- M29.2 A2: la alerta se emite DESPUES de clasificar ---
# Solo "ok" queda en silencio; cualquier otro resultado avisa.
# Esta llamada NO puede alterar $rc: emit_alert devuelve 0 y nunca ejecuta exit.
if [[ "$result" != "ok" ]]; then
  emit_alert "$result" "$rc" "$started_at"
fi

# Se propaga el codigo ORIGINAL. Un 75 o 76 nunca se reporta como 0.
exit "$rc"