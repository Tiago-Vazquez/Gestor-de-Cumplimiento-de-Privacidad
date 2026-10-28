#!/usr/bin/env bash
# F-P2.11 - Tests del archivador WAL remoto (scripts/ops/wal-archive.sh).
#
# Ejercita el archivador REAL contra un doble de "almacen de objetos" local via
# WAL_ARCHIVE_TRANSPORT: todo el contrato se verifica SIN red, SIN credenciales,
# SIN bucket y SIN aws CLI (mismo patron que test-ops-offhost.sh). El doble
# implementa la interfaz de transporte con los codigos canonicos del archivador
# (0 ok / 10 absent / 11 forbidden / 12 transient / 13 permanent) y expone
# modos de fallo por operacion para controlar cada escenario.
#
# RETRY_SLEEP_HOOK / WAL_ARCHIVE_SLEEP_HOOK registran las pausas sin esperar.
#
# Run: bash scripts/ops/test-ops-wal-archive.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCHIVER="$ROOT_DIR/scripts/ops/wal-archive.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "F-P2.11 wal-archive tests"

# --- fixture: un segmento WAL canonico ---------------------------------------
F_OK="000000010000000000000001"                 # 24 hex mayusculas, valido
SRC="$WORK/$F_OK"
printf 'wal-segment-payload-para-archivar' > "$SRC"
# El archivador construye la clave "wal/<F_OK>"; el doble la aplana a "wal_<F_OK>".
OBJNAME="wal_$F_OK"

# --- doble: almacen de objetos local -----------------------------------------
# El doble recibe: <op> <key> [args]. op en {head,get,put}. Lee STORE_DIR como
# "bucket" (clave -> fichero) y CTL_DIR/<op>_mode como modo de fallo.
# Modos: ok | absent | transient | transient-once | forbidden | permanent
#        | put-ambiguous (sube bien pero devuelve transient) | put-corrupt
#        (devuelve ok pero escribe bytes incorrectos).
export STORE_DIR="$WORK/store"
export CTL_DIR="$WORK/ctl"
export CALLS="$WORK/calls.log"
cat > "$WORK/double.sh" <<'DOUBLE'
#!/usr/bin/env bash
op="$1"; key="$2"; shift 2
# Clave plana: S3 trata "wal/<f>" como un nombre, no como ruta. Se sustituye
# "/" por "_" para modelar el objeto como un fichero sin subdirectorios.
obj="$STORE_DIR/${key//\//_}"
ctl="$CTL_DIR/${op}_mode"
mode="$(cat "$ctl" 2>/dev/null || echo ok)"
printf '%s %s\n' "$op" "$key" >> "$CALLS"
# transitorio la PRIMERA vez; despues sigue el comportamiento normal.
if [[ "$mode" == "transient-once" ]]; then
  m="$CTL_DIR/${op}_once_marker"
  if [[ -f "$m" ]]; then mode=ok; else : > "$m"; mode=transient; fi
fi
case "$mode" in
  forbidden) exit 11 ;;
  permanent) exit 13 ;;
  transient) exit 12 ;;
esac
# get-absent: GET siempre ausente aunque el objeto exista (carrera head/get).
# No es un error de transporte: es ausencia confirmada por GET.
if [[ "$op" == "get" && "$mode" == "get-absent" ]]; then exit 10; fi
case "$op" in
  head)
    if [[ -f "$obj" ]]; then printf '%s\n' "$(wc -c < "$obj" | tr -d ' ')"; exit 0; else exit 10; fi
    ;;
  get)
    out="$1"
    if [[ -f "$obj" ]]; then cp "$obj" "$out"; exit 0; else exit 10; fi
    ;;
  put)
    in="$1"
    if [[ "$mode" == "put-ambiguous" ]]; then cp "$in" "$obj"; exit 12; fi
    if [[ "$mode" == "put-corrupt" ]]; then printf 'CORRUPTO' > "$obj"; exit 0; fi
    # hang: se bloquea de verdad para ejercitar GNU timeout (A). `exec` reemplaza
    # el proceso del doble por sleep para que `timeout` lo mate directamente sin
    # dejar huerfanos. Se termina por el propio `timeout` del archivador
    # (124->transient); si una asercion falla, el trap del harness y el timeout
    # lo garantizan: ninguna invocacion cuelga mas que el timeout de la prueba.
    if [[ "$mode" == "hang" ]]; then exec sleep 300; fi
    # hang-once: cuelga SOLO la primera invocacion (PUT de la ronda 1); luego ok.
    if [[ "$mode" == "hang-once" ]]; then
      m="$CTL_DIR/${op}_hangonce_marker"
      if [[ ! -f "$m" ]]; then : > "$m"; exec sleep 300; fi
    fi
    # put-ambiguous-corrupt (B): PUT ambiguo que DEJA objeto incorrecto.
    # Devuelve transient pero escribe bytes que no coinciden con %p.
    if [[ "$mode" == "put-ambiguous-corrupt" ]]; then printf 'CORRUPTO' > "$obj"; exit 12; fi
    cp "$in" "$obj"; exit 0
    ;;
  *) exit 13 ;;
esac
DOUBLE
chmod +x "$WORK/double.sh"

# Registrador de pausas (sin espera real).
cat > "$WORK/sleep.sh" <<'SLEEPER'
#!/usr/bin/env bash
printf 'sleep %s\n' "$1" >> "$SLEEP_LOG"
exit 0
SLEEPER
chmod +x "$WORK/sleep.sh"
export SLEEP_LOG="$WORK/sleeps.log"

export WAL_ARCHIVE_TRANSPORT="$WORK/double.sh"
export WAL_ARCHIVE_SLEEP_HOOK="$WORK/sleep.sh"
export TMPDIR="$WORK/tmp"
mkdir -p "$TMPDIR"

# Reinicia el escenario: store/ctl vacios, logs truncados.
reset() {
  rm -rf "$STORE_DIR" "$CTL_DIR"; mkdir -p "$STORE_DIR" "$CTL_DIR"
  : > "$CALLS"; : > "$SLEEP_LOG"
}
set_mode() { printf '%s' "$2" > "$CTL_DIR/$1_mode"; }

RC=0
OUT="$WORK/out.log"
run() {  # %p %f -> fija RC
  RC=0; : > "$OUT"
  bash "$ARCHIVER" "$1" "$2" >>"$OUT" 2>&1 || RC=$?
}
calls_with()   { grep -c "^$1 " "$CALLS" 2>/dev/null || true; }
has_call()     { grep -q "^$1 " "$CALLS" 2>/dev/null; }
src_exists()   { [[ -f "$SRC" ]]; }
# H-2: purga aislada de TMPDIR (no toca el reset compartido de los tests 1-16).
reset_tmp() { rm -rf "${TMPDIR:?}"/privaris-ops.* 2>/dev/null || true; }
# H-2: yes si no quedan dirs privaris-ops.* propios en TMPDIR.
tmpclean() {
  if [ -n "$(find "$TMPDIR" -maxdepth 1 -name 'privaris-ops.*' -print -quit 2>/dev/null)" ]; then echo no; else echo yes; fi
}
# --- 1. Objeto inexistente -> subida verificada -> exit 0 ---------------------
reset
run "$SRC" "$F_OK"
check "1 inexistente: exit" "$RC" "0"
check "1 hubo put" "$(has_call put && echo yes || echo no)" "yes"
check "1 hubo get (verificacion)" "$(has_call get && echo yes || echo no)" "yes"

# --- 2. Objeto existente correcto -> exit 0, sin put --------------------------
reset; cp "$SRC" "$STORE_DIR/$OBJNAME"
run "$SRC" "$F_OK"
check "2 preexistente correcto: exit" "$RC" "0"
check "2 sin put (no re-subio)" "$(has_call put && echo yes || echo no)" "no"

# --- 3. Objeto existente con TAMANO incorrecto -> repara -> exit 0 ------------
reset; printf 'x' > "$STORE_DIR/$OBJNAME"   # tamano distinto
run "$SRC" "$F_OK"
check "3 tamano incorrecto: exit 78 (fallo cerrado)" "$RC" "78"
check "3 sin put (no sobrescribe)" "$(has_call put && echo yes || echo no)" "no"
check "3 objeto no modificado" "$(sha256sum < "$STORE_DIR/$OBJNAME" | awk '{print $1}')" "$(printf 'x' | sha256sum | awk '{print $1}')"

# --- 4. Objeto existente con SHA-256 incorrecto (mismo tamano) -> repara ------
reset; head -c "$(wc -c < "$SRC" | tr -d ' ')" /dev/zero | tr '\0' 'A' > "$STORE_DIR/$OBJNAME"
run "$SRC" "$F_OK"
reset; head -c "$(wc -c < "$SRC" | tr -d ' ')" /dev/zero | tr '\0' 'A' > "$STORE_DIR/$OBJNAME"
EXPECTED_SHA_4="$(sha256sum < "$STORE_DIR/$OBJNAME" | awk '{print $1}')"
run "$SRC" "$F_OK"
check "4 sha incorrecto: exit 78 (fallo cerrado)" "$RC" "78"
check "4 sin put (no sobrescribe)" "$(has_call put && echo yes || echo no)" "no"
check "4 objeto no modificado" "$(sha256sum < "$STORE_DIR/$OBJNAME" | awk '{print $1}')" "$EXPECTED_SHA_4"

# --- 5. PUT ambiguo seguido de verificacion correcta -> exit 0 ---------------
reset; set_mode put put-ambiguous
run "$SRC" "$F_OK"
check "5 put ambiguo + verif correcta: exit" "$RC" "0"
check "5 hubo put" "$(has_call put && echo yes || echo no)" "yes"

# --- 6. PUT ambiguo con estado remoto todavia incierto -> exit 78 ------------
reset; set_mode put put-ambiguous; set_mode get transient
run "$SRC" "$F_OK"
check "6 put ambiguo + verif indeterminada: exit" "$RC" "78"

# --- 7. Transitorio que se recupera dentro de T -> exit 0 --------------------
reset; set_mode head transient-once
run "$SRC" "$F_OK"
check "7 head transitorio recupera: exit" "$RC" "0"

# --- 8. Permanente (auth/config) sin reintentos innecesarios -> exit 78 -------
reset; set_mode head permanent
run "$SRC" "$F_OK"
check "8 permanente: exit" "$RC" "78"
check "8 head llamado exactamente 1 vez (sin reintentar)" "$(calls_with head)" "1"
check "8 sin put" "$(has_call put && echo yes || echo no)" "no"
# --- 9. 403 NO se interpreta como ausencia -> exit 78, sin subida ------------
reset; set_mode head forbidden
run "$SRC" "$F_OK"
check "9 forbidden (403): exit" "$RC" "78"
check "9 sin put (no subio a ciegas)" "$(has_call put && echo yes || echo no)" "no"

# --- 10. Agotamiento de R sin exito falso -> exit 78 -------------------------
reset; set_mode put put-corrupt   # put devuelve ok pero deja bytes incorrectos
run "$SRC" "$F_OK"
check "10 R agotado sin exito falso: exit" "$RC" "78"
check "10 un solo intento de PUT (fallo cerrado en mismatch)" "$([ "$(calls_with put)" -eq 1 ] && echo yes || echo no)" "yes"
check "10 objeto NO quedo correcto (nunca acepto el corrupto)" "$(sha256sum < "$STORE_DIR/$OBJNAME" | awk '{print $1}')" "$(printf 'CORRUPTO' | sha256sum | awk '{print $1}')"

# --- 11. Timeouts y configuracion invalida -> exit 78 ------------------------
reset; WAL_ARCHIVE_RETRIES=0 run "$SRC" "$F_OK"
check "11 T=0 invalido: exit" "$RC" "78"
reset; WAL_ARCHIVE_PUT_TIMEOUT_SECONDS=abc run "$SRC" "$F_OK"
check "11 PUT timeout no numerico: exit" "$RC" "78"
reset; WAL_ARCHIVE_GET_TIMEOUT_SECONDS= run "$SRC" "$F_OK"
check "11 GET timeout vacio: exit" "$RC" "78"
reset; WAL_ARCHIVE_REPAIR_ROUNDS=-1 run "$SRC" "$F_OK"
check "11 R=-1 invalido: exit" "$RC" "78"

# --- 12. Nombre WAL malformado / manipulacion de clave -> exit 78 ------------
reset
run "$SRC" "00000001000000000000000A/../evil"
check "12 nombre con '../' y '/': exit" "$RC" "78"
check "12 sin llamada al transporte (no se construyo clave)" "$([ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 0 ] && echo yes || echo no)" "yes"
run "$SRC" "00000001000000000000000a"   # minusculas
check "12 minusculas: exit" "$RC" "78"
run "$SRC" "0000000100000000000001"      # longitud 22
check "12 longitud corta: exit" "$RC" "78"

# --- 13. Conservacion del archivo fuente %p ante cualquier fallo -------------
reset; set_mode head permanent
run "$SRC" "$F_OK"
check "13 %p conservado tras fallo" "$(src_exists && echo yes || echo no)" "yes"

# --- 14. Ausencia de eliminacion de objetos remotos --------------------------
reset
run "$SRC" "$F_OK"   # exito normal
check "14 sin operacion delete remota" "$(grep -q '^delete ' "$CALLS" && echo no || echo yes)" "yes"

# --- 15. Limites maximos de operaciones y pausas -----------------------------
# Peor caso acotado: objeto preexistente incorrecto que obliga a reparar, con
# T=3, R=3. Operaciones remotas <= 3(head) + 3(get verif pre) + R*(3 put + 3 get)
# = 3 + 3 + 18 = 24; pausas por retry <= por cada retry_transient que agota: 2.
reset; printf 'x' > "$STORE_DIR/$OBJNAME"
WAL_ARCHIVE_RETRIES=3 WAL_ARCHIVE_REPAIR_ROUNDS=3 run "$SRC" "$F_OK"
ops=$(( $(calls_with head) + $(calls_with put) + $(calls_with get) ))
check "15 operaciones remotas acotadas (<=24)" "$([ "$ops" -le 24 ] && echo yes || echo no)" "yes"
pausas=$(grep -c '^sleep ' "$SLEEP_LOG" 2>/dev/null || true)
check "15 pausas acotadas (<=16)" "$([ "$pausas" -le 16 ] && echo yes || echo no)" "yes"

# --- 16. exit 0 exclusivamente tras verificacion completa satisfactoria ------
# En todos los exit 0 anteriores debe haber habido al menos un get (verificacion
# de bytes) que caso. Se re-verifica aqui explicitamente para el camino subir.
reset
run "$SRC" "$F_OK"
check "16 exit 0 exige verificacion (get presente)" "$(has_call get && echo yes || echo no)" "yes"
check "16 y ademas hubo put" "$(has_call put && echo yes || echo no)" "yes"

# --- 17. H-1: fallo de make_temp_dir -> exit 78, sin falso exito -------------
# TMPDIR como FICHERO (no dir): mkdir -p falla 100 veces de forma determinista,
# sin permisos ni condiciones ambientales. op_verify debe terminar con 78.
reset; reset_tmp
H1F="$WORK/h1notadir"; rm -f "$H1F"; printf 'x' > "$H1F"
H1TMP="$TMPDIR"; export TMPDIR="$H1F"
run "$SRC" "$F_OK"; H1RC="$RC"
export TMPDIR="$H1TMP"
check "17 H-1 temp indisponible: exit 78" "$H1RC" "78"
check "17 H-1 sin exito declarado" "$(grep -q 'wal-archive: ok' "$OUT" && echo no || echo yes)" "yes"
check "17 H-1 causa en OUT (temp)" "$(grep -q 'no se pudo crear el directorio temporal' "$OUT" && echo yes || echo no)" "yes"

# --- 18. H-2: sin temporales propios tras cada ruta relevante -----------------
reset; reset_tmp; run "$SRC" "$F_OK"
check "18a exito: TMPDIR limpio" "$(tmpclean)" "yes"
reset; reset_tmp; printf 'x' > "$STORE_DIR/$OBJNAME"; run "$SRC" "$F_OK"
check "18b reparacion-ok: TMPDIR limpio" "$(tmpclean)" "yes"
reset; reset_tmp; set_mode head permanent; run "$SRC" "$F_OK"
check "18c permanente: TMPDIR limpio" "$(tmpclean)" "yes"
reset; reset_tmp; set_mode put put-ambiguous; set_mode get transient; run "$SRC" "$F_OK"
check "18d transitorio-fallo: TMPDIR limpio" "$(tmpclean)" "yes"
reset; reset_tmp; set_mode put put-corrupt; run "$SRC" "$F_OK"
check "18e R-agotado: TMPDIR limpio" "$(tmpclean)" "yes"

# --- 19. A: timeout REAL (hang -> 124 -> transitorio), acotado ---------------
# hang-once cuelga SOLO el primer PUT; PUT_TIMEOUT=1 lo mata (124). No hay
# esperas largas: 1s de timeout + reintento ok. `exec sleep` evita huerfanos.
reset; reset_tmp
set_mode put hang-once
WAL_ARCHIVE_PUT_TIMEOUT_SECONDS=1 WAL_ARCHIVE_GET_TIMEOUT_SECONDS=5 run "$SRC" "$F_OK"
check "19 timeout real recupera: exit" "$RC" "0"
check "19 reintento tras timeout (put==2)" "$(calls_with put)" "2"
check "19 TMPDIR limpio" "$(tmpclean)" "yes"
leftovers=$(ps -ef 2>/dev/null | grep '[s]leep 300' | wc -l | tr -d ' ')
check "19 sin sleep huerfano" "$leftovers" "0"

# --- 20. B: PUT ambiguo + objeto incorrecto -> R acotado, sin falso exito ----
reset; reset_tmp
set_mode put put-ambiguous-corrupt   # transient pero deja bytes incorrectos
run "$SRC" "$F_OK"
check "20 ambiguo+incorrecto: exit 78" "$RC" "78"
check "20 PUT transitorio agotado (put==T=3)" "$([ "$(calls_with put)" -eq 3 ] && echo yes || echo no)" "yes"
check "20 objeto no quedo correcto" "$(sha256sum < "$STORE_DIR/$OBJNAME" | awk '{print $1}')" "$(printf 'CORRUPTO' | sha256sum | awk '{print $1}')"
check "20 %p intacto" "$(src_exists && echo yes || echo no)" "yes"
check "20 TMPDIR limpio" "$(tmpclean)" "yes"

# --- 21. C: head-ok + get-absent (carrera) -> 78 seguro, sin falso exito -----
# HEAD ve el objeto (sembrado correcto) pero GET siempre ausente. No es
# discrepancia de hash (nunca se leyeron bytes): el codigo distingue `absent`
# de `mismatch`. La reparacion esta acotada por R; como GET nunca sirve, no hay
# verificacion posible y el resultado es 78 (nunca 0).
reset; reset_tmp
cp "$SRC" "$STORE_DIR/$OBJNAME"
set_mode get get-absent
run "$SRC" "$F_OK"
check "21 head-ok/get-absent: exit 78" "$RC" "78"
check "21 sin exito declarado" "$(grep -q 'wal-archive: ok' "$OUT" && echo no || echo yes)" "yes"
check "21 un solo PUT tras verifica ausente (put==1)" "$([ "$(calls_with put)" -eq 1 ] && echo yes || echo no)" "yes"
check "21 TMPDIR limpio" "$(tmpclean)" "yes"

echo
echo "  $PASS ok, $FAIL fail"
[[ "$FAIL" == 0 ]] || exit 1
exit 0


