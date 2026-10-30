#!/usr/bin/env bash
# F-P2.11 - Archivador WAL remoto con verificacion de integridad (ADR-005).
#
# Contrato archive_command de PostgreSQL:
#   archive_command = '<ruta>/wal-archive.sh "%p" "%f"'
#   %p = ruta del segmento WAL fuente (en pg_wal, dentro del volumen persistente
#        `pgdata`; ver ADR-005/F-P2.10). NUNCA se borra.
#   %f = nombre canonico del segmento (24 hexadecimales en MAYUSCULAS).
#
# Devuelve 0 SOLO tras verificar remotamente tamano y SHA-256 del objeto. Un PUT
# exitoso no demuestra por si solo que el objeto sea correcto. Cualquier otro
# resultado (discrepancia agotada, error permanente, estado remoto indeterminado)
# devuelve EXIT_ARCHIVE_FAILED (78), distinto de cero, para que PostgreSQL
# retenga el segmento y reintente.
#
# El transporte se inyecta via WAL_ARCHIVE_TRANSPORT (mismo patron que
# OFFHOST_S3_CMD en offhost-upload.sh): todo el contrato es exercitable contra un
# doble local SIN red, credenciales, bucket ni aws CLI. Sin esa variable se usa la
# capa aws (clasificacion best-effort, NO probada contra B2 real; F-P7).
#
# Alcance (ADR-005 cond. 4): una escritura local no prueba archivado durable. Este
# script NO declara PITR operativo y NO activa el archivado en produccion
# (archive_mode/archive_command siguen sin configurarse en docker-compose.yml).
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

# Codigos de transporte canonicos. Distintos a 0/75/76 para no confundirse con
# exito ni con los codigos reservados por backup (75=lock) y off-host (76).
WAL_T_OK=0
WAL_T_ABSENT=10     # objeto ausente CONFIRMADO (404/NoSuchKey)
WAL_T_FORBIDDEN=11  # 403 / falta de permiso (NO es ausencia)
WAL_T_TRANSIENT=12  # timeout, 5xx, conexion (reintentable)
WAL_T_PERMANENT=13  # auth / configuracion (no reintentar)

EXIT_ARCHIVE_FAILED=78

# ---------------------------------------------------------------------------
# Configuracion. Variables (unidades / predeterminados / validacion):
#   WAL_ARCHIVE_TRANSPORT            comando inyectable (opcional). Sin ella, aws.
#   WAL_ARCHIVE_BUCKET               bucket S3 (requerido SOLO con capa aws).
#   WAL_ARCHIVE_PREFIX               prefijo de clave; default "wal". Sin "/".
#   WAL_ARCHIVE_S3_ENDPOINT          endpoint (requerido SOLO con capa aws).
#   WAL_ARCHIVE_S3_REGION            region (opcional).
#   WAL_ARCHIVE_RETRIES              T: intentos TOTALES por operacion; default 3.
#   WAL_ARCHIVE_RETRY_DELAY_SECONDS  pausa entre intentos (s); default 5.
#   WAL_ARCHIVE_REPAIR_ROUNDS        R: rondas GLOBALES de reparacion; default 3.
#   WAL_ARCHIVE_PUT_TIMEOUT_SECONDS  timeout PUT (s); default 60 (PROVISIONAL).
#   WAL_ARCHIVE_GET_TIMEOUT_SECONDS  timeout GET (s); default 120 (PROVISIONAL).
#
# Los timeouts PUT/GET son INDEPENDIENTES. Un timeout es error TRANSITORIO
# (reintentable). NO se copian de los healthchecks de Compose (5s no aplica a S3).
# Los valores por defecto son PROVISIONALES para pruebas locales; NO calibrados
# para B2 (calibracion = F-P7). Cualquier T/R/delay/timeout que no sea entero
# positivo produce error de configuracion (exit != 0) INMEDIATO, sin transferir.
# ---------------------------------------------------------------------------
wal_sleep() { sleep "$1"; }
wal_sleep_hook="${WAL_ARCHIVE_SLEEP_HOOK:-wal_sleep}"

T="${WAL_ARCHIVE_RETRIES-3}"
RETRY_DELAY="${WAL_ARCHIVE_RETRY_DELAY_SECONDS-5}"
R="${WAL_ARCHIVE_REPAIR_ROUNDS-3}"
PUT_TIMEOUT="${WAL_ARCHIVE_PUT_TIMEOUT_SECONDS-60}"
GET_TIMEOUT="${WAL_ARCHIVE_GET_TIMEOUT_SECONDS-120}"

BUCKET="${WAL_ARCHIVE_BUCKET:-}"
PREFIX="${WAL_ARCHIVE_PREFIX-wal}"
ENDPOINT="${WAL_ARCHIVE_S3_ENDPOINT-}"
REGION="${WAL_ARCHIVE_S3_REGION-}"

fail() { echo "wal-archive: $*" >&2; exit "$EXIT_ARCHIVE_FAILED"; }
config_fail() { echo "wal-archive: CONFIG: $*" >&2; exit "$EXIT_ARCHIVE_FAILED"; }

is_positive_int "$T"           || config_fail "WAL_ARCHIVE_RETRIES debe ser entero positivo (got: $T)"
is_positive_int "$RETRY_DELAY" || config_fail "WAL_ARCHIVE_RETRY_DELAY_SECONDS debe ser entero positivo (got: $RETRY_DELAY)"
is_positive_int "$R"           || config_fail "WAL_ARCHIVE_REPAIR_ROUNDS debe ser entero positivo (got: $R)"
is_positive_int "$PUT_TIMEOUT" || config_fail "WAL_ARCHIVE_PUT_TIMEOUT_SECONDS debe ser entero positivo (got: $PUT_TIMEOUT)"
is_positive_int "$GET_TIMEOUT" || config_fail "WAL_ARCHIVE_GET_TIMEOUT_SECONDS debe ser entero positivo (got: $GET_TIMEOUT)"
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] || config_fail "WAL_ARCHIVE_PREFIX invalido (got: $PREFIX)"

if [[ $# -ne 2 ]]; then config_fail "se esperaban 2 argumentos (%p %f), got $#"; fi
SRC="$1"   # %p
WAL_F="$2" # %f

# Validacion estricta del nombre entregado a archive_command. PostgreSQL archiva
# TRES formas canonicas, y las tres deben aceptarse: rechazar las dos ultimas
# bloquea la cola de archivado (defecto M31.3: pg_basebackup deja
# <seg>.<tli>.backup en pg_wal y, al devolver CONFIG/78, PostgreSQL reintenta ese
# fichero indefinidamente y los segmentos siguientes nunca se archivan -> la
# cadena WAL se corta y PITR resulta imposible). Todas las formas aceptadas usan
# solo hex MAYUSCULAS y ".", por lo que siguen sin permitir "/", ".." ni rutas.
#   - segmento WAL:        24 hex mayusculas
#   - fichero de backup:   <24 hex>.<8 hex>.backup
#   - historia de timeline: <8 hex>.history
WAL_F_OK=0
if [[ "$WAL_F" =~ ^[0-9A-F]{24}$ ]] \
  || [[ "$WAL_F" =~ ^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$ ]] \
  || [[ "$WAL_F" =~ ^[0-9A-F]{8}\.history$ ]]; then
  WAL_F_OK=1
fi
(( WAL_F_OK == 1 )) || config_fail "nombre de archivado invalido (se requiere segmento de 24 hex mayusculas, <seg>.<tli>.backup o <tli>.history): got '$WAL_F'"

[[ -f "$SRC" ]] || fail "la fuente %p no es fichero regular: '$SRC'"
[[ -r "$SRC" ]] || fail "la fuente %p no es legible: '$SRC'"

LOCAL_SIZE="$(wc -c < "$SRC" | tr -d ' \r\n')"
[[ "$LOCAL_SIZE" =~ ^[0-9]+$ ]] || fail "no se pudo determinar el tamano local de %p"
LOCAL_SHA="$(sha256_of "$SRC")"
is_sha256 "$LOCAL_SHA" || fail "el SHA-256 local no es un digesto valido"

key_for() { printf '%s/%s' "$PREFIX" "$WAL_F"; }
KEY="$(key_for)"
# ---------------------------------------------------------------------------
# Transporte
# ---------------------------------------------------------------------------
build_aws_common() {
  aws_common=()
  [[ -n "$ENDPOINT" ]] && aws_common+=(--endpoint-url "$ENDPOINT")
  [[ -n "$REGION" ]]   && aws_common+=(--region "$REGION")
}

# Clasificacion best-effort de la salida de aws. La interfaz S3 NO distingue de
# forma fiable ausencia, falta de permiso y error transitorio solo por codigo de
# salida del CLI, asi que se inspecciona el texto. Ante cualquier patron NO
# reconocido se devuelve PERMANENT (fail-safe): NO se asume ausencia (no se sube
# a ciegas) ni transitorio (no se reintenta ciegas). NO PROBADA CONTRA B2 REAL.
classify_aws() {
  local text="$1"
  if grep -qE '404|Not Found|NoSuchKey' <<<"$text"; then return "$WAL_T_ABSENT"; fi
  if grep -qE '403|AccessDenied|Forbidden' <<<"$text"; then return "$WAL_T_FORBIDDEN"; fi
  if grep -qE '401|SignatureDoesNotMatch|InvalidAccessKeyId|InvalidToken|ExpiredToken|UnrecognizedClientException|MissingSecurityHeader|AccessKey' <<<"$text"; then return "$WAL_T_PERMANENT"; fi
  if grep -qE 'timeout|timed out|Connection|503|SlowDown|InternalError|ServiceUnavailable|RequestTimeout|500|Reset' <<<"$text"; then return "$WAL_T_TRANSIENT"; fi
  return "$WAL_T_PERMANENT"
}

# Capa aws: traduce head/get/put a los codigos canonicos. NO probada contra B2.
aws_transport() {
  local op="$1"; shift
  local key="$1"; shift
  local text rc=0
  case "$op" in
    head)
      text="$(aws s3api head-object --bucket "$BUCKET" --key "$key" "${aws_common[@]}" 2>&1)" || rc=$?
      ((rc == 0)) || { classify_aws "$text"; return $?; }
      local size
      size="$(printf '%s' "$text" | tr -d ' \n' | sed -n 's/.*"ContentLength":\([0-9]*\).*/\1/p')"
      [[ "$size" =~ ^[0-9]+$ ]] || return "$WAL_T_TRANSIENT"
      printf '%s\n' "$size"; return 0
      ;;
    get)
      local out_file="$1"
      text="$(aws s3api get-object --bucket "$BUCKET" --key "$key" "$out_file" "${aws_common[@]}" 2>&1)" || rc=$?
      ((rc == 0)) && return 0
      classify_aws "$text"; return $?
      ;;
    put)
      local in_file="$1"
      text="$(aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$in_file" "${aws_common[@]}" 2>&1)" || rc=$?
      ((rc == 0)) && return 0
      classify_aws "$text"; return $?
      ;;
    *) return "$WAL_T_PERMANENT" ;;
  esac
}

# Llamada cruda al transporte, envuelta en GNU `timeout` con el limite propio de
# la operacion. `timeout` devuelve 124 si mata el proceso -> TRANSIENT.
wal_transport() {
  local op="$1" tmo="$2"; shift 2
  local rc=0
  if [[ -n "${WAL_ARCHIVE_TRANSPORT:-}" ]]; then
    timeout "$tmo" "$WAL_ARCHIVE_TRANSPORT" "$op" "$@" || rc=$?
  else
    build_aws_common
    timeout "$tmo" aws_transport "$op" "$@" || rc=$?
  fi
  ((rc == 124)) && rc="$WAL_T_TRANSIENT"
  return "$rc"
}
# ---------------------------------------------------------------------------
# Operaciones. Cada una fija LAST_CLASS; head/verify fijan ademas LAST_SIZE /
# VERIFY_RESULT. La clasificacion ocurre ANTES de decidir reintentos.
# ---------------------------------------------------------------------------
LAST_CLASS=""
LAST_SIZE=""
VERIFY_RESULT=""

# H-2: tracking de directorios temporales propios para limpieza segura.
# Solo se borran rutas dentro de ${TMPDIR:-/tmp}/privaris-ops.* creadas por
# esta invocacion y registradas aqui. Nunca %p, pg_wal, origen ni remotos.
WAL_TMPDIRS=()
wal_tmp_base() { printf '%s' "${TMPDIR:-/tmp}"; }
register_tmpdir() { WAL_TMPDIRS+=("$1"); }
cleanup_tmpdirs() {
  local d base
  base="$(wal_tmp_base)"
  for d in ${WAL_TMPDIRS[@]+"${WAL_TMPDIRS[@]}"}; do
    case "$d" in
      "$base"/privaris-ops.*) [[ -d "$d" ]] && rm -rf "$d" 2>/dev/null || true ;;
    esac
  done
  WAL_TMPDIRS=()
  return 0
}
# Limpieza en salidas anticipadas (fail/success via exit) y senales capturables
# (INT/TERM). El handler de EXIT NO llama a `exit` (lo re-dispararia); se limita
# a limpiar y devolver 0 para que el codigo original (0/78) se preserve. Una
# limpieza fallida nunca convierte un fallo en exito ni viceversa. SIGKILL y la
# terminacion abrupta no son interceptables: queda documentado, no manejado.
trap_cleanup() {
  cleanup_tmpdirs
  return 0
}
trap trap_cleanup EXIT
trap 'cleanup_tmpdirs; exit 130' INT
trap 'cleanup_tmpdirs; exit 143' TERM

op_head() {  # $1=key -> si ok, LAST_SIZE = tamano remoto
  local rc=0 out
  out="$(wal_transport head "$GET_TIMEOUT" "$1")" || rc=$?
  if ((rc == WAL_T_OK)); then
    LAST_SIZE="$(printf '%s' "$out" | tr -d ' \r\n')"
    if [[ "$LAST_SIZE" =~ ^[0-9]+$ ]]; then LAST_CLASS=ok; else LAST_CLASS=transient; fi
  elif ((rc == WAL_T_ABSENT));    then LAST_CLASS=absent
  elif ((rc == WAL_T_FORBIDDEN)); then LAST_CLASS=forbidden
  elif ((rc == WAL_T_TRANSIENT)); then LAST_CLASS=transient
  elif ((rc == WAL_T_PERMANENT)); then LAST_CLASS=permanent
  else LAST_CLASS=transient
  fi
}

op_put() {  # $1=key -> sube %p al objeto
  local rc=0
  wal_transport put "$PUT_TIMEOUT" "$1" "$SRC" || rc=$?
  if ((rc == WAL_T_OK)); then LAST_CLASS=ok
  elif ((rc == WAL_T_FORBIDDEN)); then LAST_CLASS=forbidden
  elif ((rc == WAL_T_PERMANENT)); then LAST_CLASS=permanent
  else LAST_CLASS=transient   # incluye PUT ambiguo (timeout/red)
  fi
}

op_verify() {  # $1=key -> descarga y compara tamano+SHA; fija VERIFY_RESULT
  local tmpdir tmp rc=0 rsize rsha
  # H-1: si make_temp_dir falla, terminar con 78 via fail(). Nunca continuar
  # con ruta vacia/invalida y nunca devolver 0. `fail` hace exit 78 (el trap
  # EXIT limpia igualmente los dirs ya registrados).
  if ! tmpdir="$(make_temp_dir)"; then
    fail "no se pudo crear el directorio temporal de verificacion para $1"
  fi
  [[ -n "${tmpdir:-}" && -d "$tmpdir" ]] || fail "directorio temporal de verificacion invalido para $1"
  # H-2: registrar el dir propio para limpieza segura (trap backstop + borrado
  # inmediato abajo). Solo se borran rutas bajo ${TMPDIR:-/tmp}/privaris-ops.*.
  register_tmpdir "$tmpdir"
  tmp="$tmpdir/seg.$$"
  rc=0; wal_transport get "$GET_TIMEOUT" "$1" "$tmp" || rc=$?
  if ((rc == WAL_T_OK)); then
    rsize="$(wc -c < "$tmp" | tr -d ' \r\n')"
    rsha="$(sha256_of "$tmp")"
    if [[ "$rsize" == "$LOCAL_SIZE" && "$rsha" == "$LOCAL_SHA" ]]; then
      VERIFY_RESULT=match
    else
      VERIFY_RESULT=mismatch
    fi
    LAST_CLASS=ok
  elif ((rc == WAL_T_ABSENT));    then VERIFY_RESULT=absent;    LAST_CLASS=absent
  elif ((rc == WAL_T_FORBIDDEN)); then VERIFY_RESULT=forbidden; LAST_CLASS=forbidden
  elif ((rc == WAL_T_PERMANENT)); then VERIFY_RESULT=permanent; LAST_CLASS=permanent
  else VERIFY_RESULT=indeterminate; LAST_CLASS=transient
  fi
  # H-2: limpieza inmediata del par fichero+directorio propio. Solo borra la
  # ruta registrada bajo ${TMPDIR:-/tmp}/privaris-ops.* creados por esta
  # invocacion. Idempotente: si el dir ya no existe, no hace nada. Una limpieza
  # fallida no altera VERIFY_RESULT ni LAST_CLASS (ya fijados arriba), por lo
  # que nunca convierte un fallo en exito ni viceversa. El trap EXIT/INT/TERM
  # es el backstop para salidas anticipadas y senales.
  rm -f "$tmp" 2>/dev/null || true
  case "$tmpdir" in
    "$(wal_tmp_base)"/privaris-ops.*) [[ -d "$tmpdir" ]] && rm -rf "$tmpdir" 2>/dev/null || true ;;
  esac
}

# Reintenta SOLO mientras LAST_CLASS=transient. Permanentes y forbidden retornan
# de inmediato (no consumen los T intentos genericos). T = intentos totales;
# duerme (T-1) veces.
retry_transient() {
  local fn="$1"; shift
  local attempt
  for ((attempt = 1; attempt <= T; attempt++)); do
    if ((attempt > 1)); then "$wal_sleep_hook" "$RETRY_DELAY"; fi
    "$fn" "$@"
    [[ "$LAST_CLASS" != "transient" ]] && return 0
  done
  return 1  # transitorios agotados -> indeterminado
}

success() { echo "wal-archive: ok key=$KEY $1" >&2; exit 0; }

# ---------------------------------------------------------------------------
# Maquina de estados
# ---------------------------------------------------------------------------
echo "wal-archive: archiving $WAL_F (local sha=$LOCAL_SHA size=$LOCAL_SIZE)" >&2

# Fase A: clasificar el estado remoto.
if ! retry_transient op_head "$KEY"; then
  fail "no se pudo determinar el estado remoto de $KEY (transitorios agotados); no se sube a ciegas"
fi
case "$LAST_CLASS" in
  forbidden) fail "sin permiso de lectura remota (403) para $KEY; no se interpreta como ausencia" ;;
  permanent) fail "error permanente de autenticacion/configuracion al consultar $KEY" ;;
  absent)    need_upload=1 ;;
  ok)
    if ! retry_transient op_verify "$KEY"; then
      fail "no se pudo verificar el objeto preexistente $KEY (indeterminado)"
    fi
    case "$VERIFY_RESULT" in
      match)     success "objeto preexistente ya verificado (tamano+sha coinciden)" ;;
      mismatch)  fail "objeto remoto preexistente diverge para $KEY; no se sobrescribe automaticamente" ;;
      forbidden) fail "sin permiso de lectura remota (403) para verificar $KEY" ;;
      permanent) fail "error permanente al verificar $KEY" ;;
      absent)    need_upload=1 ;;  # desaparecio entre head y get
      *)         fail "verificacion preexistente indeterminada para $KEY" ;;
    esac
    ;;
  *) fail "clase de estado remoto desconocida para $KEY" ;;
esac

# Fase B: subida (+ reparacion), acotada por R rondas GLOBALES.
round=1
while ((round <= R)); do
  if retry_transient op_put "$KEY"; then
    case "$LAST_CLASS" in
      forbidden) fail "sin permiso de subida (403) para $KEY" ;;
      permanent) fail "error permanente de autenticacion/configuracion al subir $KEY" ;;
      ok) : ;;  # subido; se verifica igualmente abajo
    esac
  else
    # PUT ambiguo (transitorios agotados): NO es exito ni fracaso. Se verifica.
    echo "wal-archive: PUT ambiguo para $KEY (transitorios agotados); se verifica el estado remoto" >&2
  fi

  if ! retry_transient op_verify "$KEY"; then
    fail "la verificacion remota de $KEY quedo indeterminada tras el PUT; sin exito falso"
  fi
  case "$VERIFY_RESULT" in
    match)     success "subido y verificado (round=$round)" ;;
    mismatch|absent) fail "discrepancia post-PUT para $KEY; objeto no aceptado como correcto" ;;
    forbidden) fail "sin permiso de lectura remota (403) para verificar $KEY" ;;
    permanent) fail "error permanente al verificar $KEY" ;;
    *)         fail "verificacion indeterminada para $KEY tras el PUT" ;;
  esac
done

fail "agotadas las R=$R rondas de reparacion de $KEY sin verificacion satisfactoria; objeto nunca aceptado como correcto"


