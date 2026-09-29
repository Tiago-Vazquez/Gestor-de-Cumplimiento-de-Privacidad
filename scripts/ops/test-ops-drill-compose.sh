#!/usr/bin/env bash
# M28.0 - Contrato ESTATICO del stack de compose del DR drill.
#
# ESTO NO ES UN TEST DE INTEGRACION. No arranca Docker, no accede a la red, no
# lee credenciales y no depende de ningun servicio externo. Solo lee dos ficheros
# del repositorio y decide si su contenido cumple el contrato.
#
# POR QUE ES ESTATICO Y NO UNA EJECUCION: el fallo que este test atrapa (un
# servicio `postgres` que ya no existe, o un `api` que nadie levanta antes del
# backup) se manifesta como un fallo LENTO y opaco dentro de un job de CI que
# levanta imagenes, construye el bundle y tarda minutos. Fallar en el primer
# `compose up` de un runner real cuesta una iteracion completa; fallar aqui cuesta
# un segundo y no necesita ni el runner ni Docker.
#
# QUE PROTEGE, en una frase: que el drill de M28.0 no pueda volver a "pasar"
# backup y restore mientras se salta pasos que solo se verifican en tiempo de
# ejecucion (el orden db -> migrate -> seed -> api y la presencia del fingerprint
# de clave). El resto de tests de ops usan dobles; este usa el fichero real.
#
# Run: bash scripts/ops/test-ops-drill-compose.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/scripts/ci/docker-compose.dr-drill.yml"
HARNESS="$ROOT_DIR/scripts/ci/run-dr-drill.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }
check_nonempty() { if [[ -n "$2" ]]; then ok "$1"; else no "$1 (valor vacio)"; fi; }
check_empty() { if [[ -z "$2" ]]; then ok "$1"; else no "$1 (se esperaba vacio, obtenido '$2')"; fi; }

echo "M28.0 DR drill: contrato estatico de compose y del harness (offline, sin Docker)"

# --- 0. los ficheros que hay que leer existen -------------------------------
# Sin esto, un fichero ausente haria que grep no encontrase nada y todos los
# negativos pasarian de forma vacua: el test verde sin haber leido nada.
for f in "$COMPOSE_FILE" "$HARNESS"; do
  if [[ ! -f "$f" ]]; then
    printf 'dr-drill-compose: falta %s; no se puede verificar el contrato\n' "$f" >&2
    exit 1
  fi
done

# Numero de linea de la primera coincidencia, o cadena vacia.
line_of() { grep -n -- "$1" "$2" 2>/dev/null | head -n1 | cut -d: -f1; }
line_of_fixed() { grep -nF -- "$1" "$2" 2>/dev/null | head -n1 | cut -d: -f1; }

# Solo las lineas de codigo: descarta las que son enteramente comentario.
#
# Hace falta porque el compose DOCUMENTA en un comentario el montaje por initdb
# que el mismo fichero ya no usa. Un grep sobre el fichero entero daria un falso
# positivo sobre la explicacion de un fallo ya corregido, no sobre una
# configuracion activa. Se cuentan coincidencias con `grep -c` (y no con
# `grep -q`) a proposito: `grep -q` sale al primer acierto y deja al `grep -v` de
# upstream con SIGPIPE, que con `pipefail` convertiria el pipeline en fallo.
code_hits() {
  grep -vE '^[[:space:]]*#' "$1" 2>/dev/null | grep -c -- "$2" || true
}

# Bloque de un servicio del compose: desde su clave de nivel 2 hasta la siguiente
# clave de nivel 2 (o el fin de la seccion `services`). awk puro, sin yq ni python.
service_block() {
  awk -v svc="$1" '
    /^[^[:space:]]/ && !/^services:/ { in_services = 0 }
    /^services:[[:space:]]*$/ { in_services = 1 }
    in_services && $0 ~ "^  " svc ":[[:space:]]*$" { inside = 1; next }
    inside && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { inside = 0 }
    inside { print }
  ' "$COMPOSE_FILE"
}

# Lista de servicios declarados bajo `services:`, uno por linea.
declared_services() {
  awk '
    /^[^[:space:]]/ && !/^services:/ { in_services = 0 }
    /^services:[[:space:]]*$/ { in_services = 1; next }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
      name = $0; sub(/^  /, "", name); sub(/:.*/, "", name); print name
    }
  ' "$COMPOSE_FILE"
}

# Condicion de dependencia dentro del bloque `depends_on` de un servicio.
# Imprime, por ejemplo, `service_healthy` para (migrate, db). Imprime la cadena
# vacia si ese servicio no declara esa dependencia.
dep_condition() {
  service_block "$1" | awk -v dep="$2" '
    {
      ind = match($0, /[^ ]/) - 1
      if (ind < 0) ind = 0
    }
    $0 ~ /^[[:space:]]*depends_on:[[:space:]]*$/ { in_deps = 1; base = ind; next }
    in_deps && $0 ~ /^[[:space:]]*$/ { next }
    in_deps && ind <= base { in_deps = 0; next }
    in_deps && ind == base + 2 && $1 == dep ":" { found = 1; next }
    found && $1 == "condition:" { print $2; exit }
  '
}

SERVICES="$(declared_services)"
# --- 1. los cuatro servicios del arranque existen ---------------------------
# db -> migrate -> seed -> api es el orden real de produccion. Los cuatro tienen
# que existir: `db` es la base, `migrate` crea el esquema, `seed` inserta las filas
# y `api` es de donde el backup saca la huella de la clave.
for svc in db migrate seed api; do
  if printf '%s\n' "$SERVICES" | grep -qx "$svc"; then
    ok "el compose declara el servicio $svc"
  else
    no "el compose NO declara el servicio $svc"
  fi
done

# --- 2. el servicio `postgres` debe seguir desaparecido ---------------------
# El compose renombro postgres -> db. Un servicio `postgres` resucitado haria que
# `compose up -d --wait seed` levantase una base distinta de la que consulta
# src_psql, y el drill pasaria sobre una base vacia.
check_empty 'no existe ningun servicio `postgres` (el compose usa `db`)' \
  "$(printf '%s\n' "$SERVICES" | grep -x 'postgres')"

# --- 3. y 4. tampoco debe quedar ninguna referencia funcional a `postgres` ----
# Se revisa el compose entero y el harness. `-h postgres` es el fallo silencioso
# por excelencia: psql no avisa de un host equivocado, simplemente no conecta.
check "el compose no referencia '@postgres' en ninguna URL (codigo, no comentarios)" \
  "$(code_hits "$COMPOSE_FILE" '@postgres')" "0"
check "el compose no conecta con '-h postgres' (codigo, no comentarios)" \
  "$(code_hits "$COMPOSE_FILE" '\-h postgres')" "0"
check "el harness no referencia '@postgres' (codigo, no comentarios)" \
  "$(code_hits "$HARNESS" '@postgres')" "0"
check "el harness no conecta con '-h postgres' (codigo, no comentarios)" \
  "$(code_hits "$HARNESS" '\-h postgres')" "0"

# --- 5. migrate depende de db SALUDABLE -------------------------------------
# Con `service_started` el migrate puede correr contra una base que aun no acepta
# conexiones: el fallo aparece como un error de conexion difuso, no como un
# problema de arranque.
check "migrate espera a db con service_healthy" \
  "$(dep_condition migrate db)" "service_healthy"

# --- 6. seed depende de migrate COMPLETADO ----------------------------------
# Este es el invariante que motivo el compose de M28.0: el seed inserta en tablas
# que crea la migracion. Si seed arranca antes, el contenedor db muere y el drill
# se protege en silencio.
check "seed espera a migrate con service_completed_successfully" \
  "$(dep_condition seed migrate)" "service_completed_successfully"

# --- 7. api depende de db, migrate y seed -----------------------------------
# La api solo es una dependencia fuerte si espera a las tres: levantarla contra
# una base sin esquema levanta un proceso que muere de forma intermitente.
check "api espera a db con service_healthy" \
  "$(dep_condition api db)" "service_healthy"
check "api espera a migrate con service_completed_successfully" \
  "$(dep_condition api migrate)" "service_completed_successfully"
check "api espera a seed con service_completed_successfully" \
  "$(dep_condition api seed)" "service_completed_successfully"

# --- 8. el seed ya no se monta por initdb -----------------------------------
# El montaje en docker-entrypoint-initdb.d ejecutaba el seed durante initdb, antes
# de que existiera ninguna migracion. Es exactamente el fallo que rompio el
# segundo arranque de M28.0, asi que su regreso debe romper el build.
check "el seed NO se monta en docker-entrypoint-initdb.d (codigo, no comentarios)" \
  "$(code_hits "$COMPOSE_FILE" 'docker-entrypoint-initdb')" "0"

# --- 9. el harness usa `db` para las operaciones PostgreSQL ------------------
if grep -q 'compose ps -q db' "$HARNESS" 2>/dev/null; then
  ok 'src_psql localiza el contenedor del servicio `db`'
else
  no "src_psql no usa 'compose ps -q db'"
fi
if grep -q 'compose ps -q postgres' "$HARNESS" 2>/dev/null; then
  no "el harness sigue buscando el contenedor 'postgres' <-- ese servicio ya no existe"
else
  ok "el harness no busca el contenedor 'postgres'"
fi
if grep -q 'compose up -d --wait postgres' "$HARNESS" 2>/dev/null; then
  no "el harness sigue arrancando 'postgres' con --wait"
else
  ok "el harness no arranca 'postgres' con --wait"
fi

# --- 10 y 14. el arranque de seed y de api ocurre ANTES de S2 ----------------
# El orden se comprueba por NUMERO DE LINEA, no por presencia. Un `compose up`
# en algun sitio del fichero no demuestra nada: lo que importa es que la linea de
# S2 (y la llamada al backup) sean posteriores.
SEED_LINE="$(line_of 'compose up -d --wait seed' "$HARNESS")"
API_LINE="$(line_of 'compose up -d --wait api' "$HARNESS")"
S2_LINE="$(line_of '^# --- S2' "$HARNESS")"
BACKUP_LINE="$(line_of 'postgres-backup.sh" 2>&1' "$HARNESS")"

check_nonempty 'el harness arranca `seed` con --wait' "$SEED_LINE"
check_nonempty 'el harness arranca `api` con --wait' "$API_LINE"
check_nonempty "el harness tiene una seccion S2" "$S2_LINE"
check_nonempty "el harness invoca postgres-backup.sh" "$BACKUP_LINE"

if [[ -n "$SEED_LINE" && -n "$S2_LINE" ]]; then
  if ((SEED_LINE < S2_LINE)); then
    ok "seed arranca antes de S2 (linea $SEED_LINE < $S2_LINE): el seed queda aplicado antes del backup"
  else
    no "seed arranca en la linea $SEED_LINE, despues de S2 ($S2_LINE) <-- el backup se haria sobre una base sin seed"
  fi
else
  no "no se pudo comparar el arranque de seed con S2"
fi

# --- 11 y 14. idem para api: S2 no puede empezar antes ----------------------
# Este es el invariante nuevo de M28.0. postgres-backup.sh calcula
# source_key_fingerprint ejecutando node DENTRO del contenedor api, y omite el
# campo en silencio cuando no hay ninguno. Sin este arranque el backup seria
# verde, y assert_manifest de dr-asserts.sh caeria por un campo ausente.
if [[ -n "$API_LINE" && -n "$S2_LINE" ]]; then
  if ((API_LINE < S2_LINE)); then
    ok "api arranca antes de S2 (linea $API_LINE < $S2_LINE): el backup puede leer la huella de la clave"
  else
    no "api arranca en la linea $API_LINE, despues de S2 ($S2_LINE) <-- el manifest saldria sin source_key_fingerprint"
  fi
else
  no "no se pudo comparar el arranque de api con S2"
fi
if [[ -n "$API_LINE" && -n "$BACKUP_LINE" ]]; then
  if ((API_LINE < BACKUP_LINE)); then
    ok "api arranca antes de la llamada a postgres-backup.sh (linea $API_LINE < $BACKUP_LINE)"
  else
    no "api arranca en la linea $API_LINE, despues del backup ($BACKUP_LINE)"
  fi
else
  no "no se pudo comparar el arranque de api con la llamada al backup"
fi
# El arranque de api debe fallar de forma ruidosa si no queda sana: sin `--wait` ni
# `|| die`, un `compose up` fallido deja S2 continuar hacia un backup sin api.
API_DIE_LINE="$(line_of 'compose up -d --wait api || die "api did not become healthy"' "$HARNESS")"
check_nonempty "el arranque de api falla de forma ruidosa si no queda saludable" "$API_DIE_LINE"

# --- 12. el backup recibe COMPOSE_PROJECT_NAME explicitamente ----------------
# postgres-backup.sh solo anade `-p` cuando COMPOSE_PROJECT_NAME llega en el
# entorno. Sin el, el compose resolveria el proyecto por el nombre del directorio
# y leeria el despliegue del desarrollador, no el del drill.
if grep -qF 'COMPOSE_PROJECT_NAME="$PROJECT_NAME"' "$HARNESS" 2>/dev/null; then
  ok 'el backup recibe COMPOSE_PROJECT_NAME="$PROJECT_NAME"'
else
  no "el backup NO recibe COMPOSE_PROJECT_NAME <-- leeria el compose equivocado"
fi
# Y tiene que ir en la MISMA invocacion que el COMPOSE_FILE del drill, no en una
# linea suelta en algun otro sitio del fichero.
BACKUP_ENV_LINE="$(line_of_fixed 'COMPOSE_FILE="$SCRATCH_COMPOSE" COMPOSE_PROJECT_NAME="$PROJECT_NAME"' "$HARNESS")"
check_nonempty "COMPOSE_PROJECT_NAME viaja en la misma invocacion que COMPOSE_FILE" "$BACKUP_ENV_LINE"

# --- 13. la cadena de preparacion es db -> migrate -> seed -------------------
# La cadena se deriva de las dependencias reales, no de un comentario. Si alguien
# invierte una condicion, el test ve la cadena nueva y falla; si alguien rompe la
# cadena, ve que falta un eslabon y falla tambien.
CHAIN=""
if [[ "$(dep_condition migrate db)" == "service_healthy" ]]; then CHAIN+="db->"; fi
if [[ "$(dep_condition migrate db)" == "service_healthy" ]] \
   && [[ "$(dep_condition seed migrate)" == "service_completed_successfully" ]]; then
  CHAIN+="migrate->"
fi
if [[ "$(dep_condition seed migrate)" == "service_completed_successfully" ]]; then CHAIN+="seed->"; fi
check "la cadena de preparacion es db -> migrate -> seed" "$CHAIN" "db->migrate->seed->"
# seed no puede depender de db directamente saltandose migrate, porque eso seria
# de nuevo un seed sobre una base cuyo esquema todavia no existe.
check_empty "seed NO depende de db directamente (debe pasar por migrate)" \
  "$(dep_condition seed db)"
# Y db no depende de nada: es la raiz de la cadena.
check_empty "db no depende de si mismo (es la raiz)" "$(dep_condition db db)"

printf '\n  %d ok, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]] || exit 1
