# ADR-005 — Recuperación a un punto en el tiempo (PITR) mediante backup físico y archivado de WAL

- **Estado**: **Aprobado con condiciones** (F-P1.7). **Implementación parcial y solo
  offline**: los scripts de archivado WAL (F-P2.11), de backup físico (F-P3.2) y la rama
  PITR offline (F-P4) están implementados y publicados, con pruebas offline en `test:ops`;
  **la configuración WAL no está activada en el Compose**, **ninguna restauración real a un
  instante T se ha ejecutado** y **PITR no está desplegado ni puede declararse operativo**.
  Detalle y evidencia: §"Estado posterior a la publicación (2026-10-28)".
- **Fecha**: sin aprobar (F-P1, formalización del diseño previo a implementación)
- **Alcance**: solo decisiones de arquitectura. **No implementa código**, no modifica
  `docker-compose.yml`, ni los scripts de backup/restore, ni la configuración de
  PostgreSQL, ni crea infraestructura. La implementación queda en F-P2…F-P8.
- **Relación**: ejecuta y concreta **ADR-002 D5** (PITR aislado, no declarar operativo
  sin ensayo real). No modifica ADR-002 ni ADR-003.

## Aprobación formal condicionada (F-P1.7)

Se aprueba la **dirección arquitectónica, Alternativa B**:

- Backup físico consistente como base de recuperación.
- Archivado continuo de WAL para recuperación a un punto en el tiempo (PITR).
- Conservación del backup lógico actual como mecanismo complementario.
- Separación explícita entre recuperación funcional validada en F-P5 y durabilidad
  off-host validada en F-P7 (ver §"Alcance de operativo").

Las **decisiones de diseño inicial 1–9** quedan aprobadas con sus límites en
§"Decisiones de diseño aprobadas (F-P1.10)"; las magnitudes cuantitativas (duración,
coste, umbrales) siguen pendientes de evidencia y aprobación específica.

**Condiciones** (ninguna resuelta por esta aprobación):

1. **N-02** se mantiene como **limitación documental explícita** hasta verificar su
   semántica exacta en PostgreSQL 16 (ver §Mecanismo de recuperación); debe
   resolverse **antes de implementar la configuración de recuperación de F-P4**.
2. Las **nueve decisiones pendientes** (§Decisiones cuantitativas aún pendientes) se mantienen
   **abiertas en sus magnitudes**; esta aprobación **solo fija las políticas de diseño**
  registradas en §"Decisiones de diseño aprobadas (F-P1.10)".
3. **No declarar** PITR implementado, validado, operativo ni durable hasta superar los
   gates correspondientes (F-P5 para funcional, F-P7 para durable) con evidencia
   verificable.
4. Una escritura en staging local, **por sí sola, no prueba** archivado duradero
   (ver §Disponibilidad, contrato de `archive_command`).
5. El backup lógico existente se conserva **sin modificarlo** como parte de esta
   decisión.

**Alcance de esta aprobación**: únicamente la arquitectura propuesta. **No autoriza**
F-P2 ni fases posteriores; **no autoriza** cambios en scripts, Compose, PostgreSQL,
backups, B2 ni VPS.

> **Nota de estado (2026-10-28)**: la frase anterior describe el alcance de la aprobación
> F-P1.7 y se conserva como registro histórico. Con posterioridad se autorizaron y
> publicaron cambios en scripts de operaciones (F-P2.11, F-P3.2 y la rama PITR offline de
> F-P4) y en `test:ops`; **nada de eso activa WAL en el Compose, despliega PITR ni valida
> una recuperación real** (ver §"Estado posterior a la publicación (2026-10-28)").

> **Este ADR no declara PITR operativo.** PITR **no está desplegado ni validado**: existe
> código offline (F-P2.11, F-P3.2 y la rama PITR de F-P4) sin configuración WAL activa, y
> no podrá presentarse como implementado hasta completar una restauración real a un
> instante T (requisito heredado de ADR-002 D5).

## Contexto

El mecanismo de backup actual es **lógico**:

- `scripts/ops/postgres-backup.sh:167` ejecuta `pg_dump --format=custom` y `:168`
  `pg_dumpall --roles-only`.
- `scripts/ops/postgres-restore.sh:466` restaura con
  `pg_restore --exit-on-error --single-transaction`.
- El manifiesto (`postgres-backup.sh:226-241`) registra `format=pg_dump-custom`,
  `dump_sha256`, `roles_sha256`, `migration_journal_sha256` y
  `source_key_fingerprint`. **No registra LSN, timeline ni referencia a WAL.**

**El archivado de WAL no está activo y PITR no está desplegado.** Conviene distinguir
cuatro planos que **no** son equivalentes:

1. **Configuración que un script puede generar en una ruta offline**: **existe** desde
   F-P2.11/F-P3.2/F-P4 (archivador WAL, backup físico y emisión de `recovery.signal` /
   `recovery_target*` por la rama `--pitr` de `postgres-restore.sh`), con pruebas offline
   en `scripts/ops/test-ops-*.sh` (integradas en `test:ops`). **No** es configuración
   desplegada.
2. **Parámetros activos en una instancia PostgreSQL**: **ninguno**.
   `docker-compose.yml` (servicio `db`, líneas 4-20) usa `postgres:16-alpine` **sin
   `command:`**, por lo que no se fija `wal_level`, `archive_mode` ni `archive_command`,
   y no hay `archive_timeout`.
3. **Ejecución real de la recuperación**: **ninguna**. No se ha ejecutado una restauración
   real a un instante T ni un `pg_basebackup` real (la ruta real está tras
   `PHYS_ALLOW_REAL=1` y no se alcanza en las pruebas offline).
4. **Durabilidad y recuperación frente a pérdida del host**: **no validada** (F-P7).

(En PostgreSQL 16 **`recovery.conf` ya no existe**: se sustituyó por `recovery.signal`
y las opciones `recovery_target_*`, de modo que **su ausencia no prueba nada**. La
evidencia real de ausencia de PITR desplegado sigue siendo la falta de `archive_mode` /
`archive_command` **activos** y de cualquier configuración de archivado.)
Evidencia adicional del estado **desplegado**:

- `offhost-upload.sh:69` sube únicamente `("dump" "roles.sql" "manifest")`.
- `DEPLOY.md:33-34`, `docs/security-overview.md:227` y
  `docs/operations-runbook.md:927` lo declaran explícitamente: **"no existe"**,
  **"sin implementar"**, **"Compose no configura PITR, WAL archiving ni réplicas"**.
  *(Anclas verificadas el 2026-10-28; la cita previa `:873` era obsoleta. Estas frases
  describen el estado **desplegado**, que sigue siendo el mismo; desde F-P2.11/F-P3.2/F-P4
  existen además scripts offline **no desplegados**, por lo que la redacción "no existe"
  debería precisarse en esos documentos en una fase documental posterior — fuera del
  alcance de este ADR.)*

Por tanto, hoy el RPO real es la frecuencia del backup completo (ver §RPO/RTO), no
un instante.

## Decisión propuesta

**Backup físico consistente como base de PITR + archivado continuo de WAL, conservando
el backup lógico actual como mecanismo complementario.**

1. **Base PITR física**: `pg_basebackup` (o backup de nivel de ficheros) sobre
   PostgreSQL 16, que sí contiene la información necesaria para reproducir WAL.
2. **Archivado continuo de WAL**: `archive_mode=on` y un `archive_command` delegado en
   un script propio, con `archive_timeout` para forzar segmentos frecuentes. Se fija
   `wal_level=replica` de forma explícita, pero aclaración: `replica` es el valor por
   defecto desde PostgreSQL 10 y **no sustituye** la configuración que realmente
   habilita el PITR — eso es `archive_mode=on` + `archive_command` (y `archive_timeout`
   para la frecuencia). Con `wal_level` solo no se archiva nada.
3. **El backup lógico se conserva sin cambios** como complemento: portabilidad entre
   versiones, restauración de subconjuntos y defensa en profundidad. **No se elimina
   ni se reemplaza** la ruta `pg_restore` ya verificada por `run-dr-drill.sh`.

El artefacto primario de DR y PITR es la **base física + cadena WAL**; el manifiesto
físico enlaza ambos mediante `base_lsn` y `timeline`.

## Alternativas evaluadas

| Opción | Descripción | Resultado |
| --- | --- | --- |
| **A. Lógico primario + física añadida** | Mantener `pg_dump` como backup principal y añadir una estrategia física paralela para PITR | **Descartada.** Deja como artefacto *primario* un dump que por definición no sirve para PITR; crea dos "verdades" de backup con dos manifiestos y dos retenciones, y multiplica el coste de almacenamiento sin que el lógico aporte PITR. Riesgo de que un operador confíe en el artefacto equivocado (la falsa confianza que ADR-002 D5 advierte). |
| **B. Físico primario (base PITR) + lógico complementario** | Backup físico como base de PITR con archivado WAL; conservar el lógico como complemento | **Elegida.** Único modelo soportado por PostgreSQL 16 para PITR; un solo artefacto primario sirve a DR y PITR; un solo manifiesto/retención/canal off-host. No elimina nada. |

## Compatibilidad: por qué los dumps lógicos no permiten PITR

Esto no es una preferencia de diseño, sino una restricción del motor. La documentación
oficial de **PostgreSQL 16, §26.3 Continuous Archiving and Point-in-Time Recovery**
establece textualmente:

> *"`pg_dump` and `pg_dumpall` do not produce file-system-level backups and **cannot
> be used as part of a continuous-archiving solution**. Such dumps are logical and
> **do not contain enough information to be used by WAL replay**."*

> *"we can combine a file-system-level backup with backup of the WAL files. If
> recovery is needed, we restore the file system backup and then replay from the
> backed-up WAL files."*

La razón no es meramente "otra línea de tiempo": `pg_dump` **no conserva posiciones
de recuperación**. No registra LSN de origen, ni System ID, ni el estado de página
que el WAL de origen describe; `pg_restore` reconstruye las páginas en un clúster con
un espacio de LSN y un System ID **nuevos**. El WAL archivado del clúster de origen
describe páginas en posiciones que **no existen** en la base restaurada, por lo que no
es aplicable a ella. Por tanto, "dump lógico + WAL" no produce PITR: cualquier
alternativa que lo afirme es técnicamente inviable. La base debe ser **física**, porque
solo un backup de nivel de ficheros conserva el espacio de direccionamiento que el
WAL espera reanudar.

Derivada directa (§26.3): hay que **configurar y probar el archivado de WAL antes de
tomar la primera base**, de modo que la secuencia de WAL cubra desde el inicio de la
base.

## Consistencia: base física, LSN, timeline y secuencia WAL

Para que un conjunto sea recuperable deben mantenerse tres invariantes:

1. **Continuidad**: existe una secuencia de segmentos WAL **continua** (sin huecos)
   que se remonta **al menos hasta el LSN de inicio de la base física**.
2. **Timeline**: la base y los segmentos pertenecen a la misma línea de tiempo; un
   cambio de timeline (p. ej. tras un promote) exige los segmentos de la línea
   anterior y de la nueva. El manifiesto físico registra `timeline` y `base_lsn`.
3. **Enlace base↔WAL**: el manifiesto físico asocia cada base a su `base_lsn` y
   `timeline`; la restauración **verifica la continuidad desde ese LSN antes de
   reproducir**. Una base sin WAL continuo desde su LSN es un conjunto
   **irrecuperable** y debe detectarse como fallo, no como éxito parcial.

Cada segmento se individúa con `sha256`. La verificación de la cadena es **previa** a
la restauración: WAL ausente, cortado o corrupto ⇒ **fallo explícito temprano**,
nunca un recovery silencioso a un estado intermedio.

## Mecanismo de recuperación en PostgreSQL 16 (requisitos de diseño)

Ninguno de los siguientes mecanismos está **activo en una instancia** ni **ejecutado de
verdad** en el repositorio; se documentan como **requisitos de diseño** para que F-P4 y el
gate F-P5 tengan un vocabulario preciso. Desde F-P4, la rama `--pitr` **emite** estos
parámetros como configuración offline (contrato probado en
`scripts/ops/test-ops-pitr-branch.sh`), lo que **no** equivale a tenerlos activos ni a
haber ejecutado una recuperación. En PostgreSQL 16 la recuperación a un instante T se
compone de:

- **`restore_command`** (obligatorio para PITR con archivado): recupera cada segmento
  WAL archivado desde el destino (`%f` de origen a `%p` local) mientras dura la
  reproducción. Es la contraparte de `archive_command` en el lado de la recuperación.
  Sin él no hay reproducción de WAL archivado.
- **`recovery.signal`** (obligatorio para iniciar la recuperación en PG12+): marca que
  pone al clúster en modo de recuperación. Sustituyó a `recovery.conf`, que PG16 ya no
  lee.
- **Opciones de objetivo de recuperación** — determinan *dónde* se detiene la
  reproducción. **Debe configurarse solo un objetivo principal** para evitar
  ambigüedad.

  *Estado de N-02 — **resuelta para el diseño, pendiente de validación operativa**
  (cierre documental F-P3.15/F-P3.16). Semántica de múltiples objetivos
  `recovery_target_*` en PostgreSQL 16. Se distinguen explícitamente tres capas de
  evidencia, que no se confunden entre sí:*

  - ***Capa 1 — Documentación oficial PG16** (verificada en F-P3.15 sobre
    `https://www.postgresql.org/docs/16/runtime-config-wal.html`, §20.5.6 «Recovery
    Target»). Se recuperaron literalmente las definiciones de
    `recovery_target_inclusive` (*«Applies when `recovery_target_lsn`,
    `recovery_target_time`, or `recovery_target_xid` is specified… Default is `on`»*),
    `recovery_target_timeline` (*«…The value `latest` recovers to the latest timeline
    found in the archive… `latest` is the default»*) y `recovery_target_action`
    (*«The default is `pause`… `promote` means the recovery process will finish…
    `shutdown` will stop the server… if a recovery target is configured but the
    archive recovery ends before the target is reached, the server will shut down
    with a fatal error»*). Estas citas sustentan las marcas «verificado en PG16
    §20.5.6» de este ADR.*

  - ***Capa 2 — Evidencia de código fuente PG16** (verificada): los objetivos
    comparten un **único enum global** `RecoveryTargetType recoveryTarget`
    (`xlogrecovery.c`), no cuatro valores independientes; y el commit oficial
    **`4ac4b7a` "Avoid ERROR in recovery target GUC assign hooks"** confirma que la
    ruta de error histórico fue eliminada. De aquí se sigue **con certeza de fuente**
    que especificar varios objetivos **no genera error**.*

  - ***Inferencia de fuente, NO confirmada** (etiquetada como tal): del enum
    compartido y la ausencia de error se **inferiere** que, ante varios objetivos,
    **prevalece el último configurado**. Es coherente con la redacción histórica de
    PG11 §27.2 (*"the last entry will be used"*), pero **no se presenta como hecho
    confirmado ni como cita documental**: la documentación PG16 es **silente** sobre
    la especificación múltiple y esta fase **no re-auditó** el código fuente para
    cerrar el desempate. **No se usa como base de diseño** (véase el criterio F-P4
    más abajo).*

  - ***Limitación de recuperación documental** (F-P3.15): la frase introductoria de
    §20.5.6 sobre objetivos múltiples/exclusividad **no pudo recuperarse** — quedó en
    la zona truncada de la página en los cuatro intentos de consulta. Esto documenta
    **un límite de la consulta**, **no** prueba la ausencia de una regla en toda la
    documentación; no se afirma tal cosa.*

  - ***Capa 3 — Pendiente de validación operativa** (no realizado en esta fase):
    **ninguna** restauración PITR real a un instante T se ejecutó. El desempate ante
    objetivos múltiples y la reproducción efectiva quedan **pendientes del ensayo
    real** de ADR-002 D5 (gate F-P5). **N-02 queda cerrada para el diseño; PITR NO se
    declara implementado, validado ni operativo.***

## Cierre documental de N-02 (F-P3.15 / F-P3.16)

**Estado: cerrado para diseño; pendiente para validación operativa.**

N-02 (semántica de múltiples objetivos `recovery_target_*` en PostgreSQL 16) queda cerrada únicamente para diseño, con base en la evidencia documental y de inspección de código fuente registrada en este ADR. El cierre no autoriza F-P2, F-P4 ni fases posteriores, y no constituye validación operativa de PITR.

### Evidencia de cierre

| Criterio | Tipo | Contenido | Ubicación en este ADR |
|---|---|---|---|
| FP3.15-1 | Documental | `recovery_target_inclusive`: «Applies when `recovery_target_lsn`, `recovery_target_time`, or `recovery_target_xid` is specified… Default is `on`» | Capa 1, §Mecanismo de recuperación |
| FP3.15-2 | Documental | `recovery_target_timeline`: «…The value `latest` recovers to the latest timeline found in the archive… `latest` is the default» | Capa 1, §Mecanismo de recuperación |
| FP3.15-3 | Documental | `recovery_target_action`: «The default is `pause`… `promote` means the recovery process will finish… `shutdown` will stop the server… if a recovery target is configured but the archive recovery ends before the target is reached, the server will shut down with a fatal error» | Capa 1, §Mecanismo de recuperación |
| FP3.15-4 | Documental | Limitación: frase introductoria de §20.5.6 sobre objetivos múltiples/exclusividad no recuperable (página truncada en cuatro intentos de consulta). Documentado como límite de consulta, no como ausencia de regla. | Capa 1, §Mecanismo de recuperación |
| FP3.16-1 | Código fuente | Objetivos comparten un único enum global `RecoveryTargetType recoveryTarget` (`xlogrecovery.c`), no cuatro valores independientes | Capa 2, §Mecanismo de recuperación |
| FP3.16-2 | Código fuente | Commit oficial `4ac4b7a` «Avoid ERROR in recovery target GUC assign hooks» confirma eliminación de la ruta de error histórica; múltiples objetivos no generan error | Capa 2, §Mecanismo de recuperación |
| FP3.16-3 | Código fuente | Inferencia «el último objetivo prevalece»: no confirmada, no presentada como hecho, no citada documentalmente, no usada como base de diseño | Inferencia de fuente, §Mecanismo de recuperación |

### Distinciones mantenidas

1. **N-02 cerrada únicamente para diseño.** La validación operativa (Capa 3) no se ha realizado y permanece pendiente de F-P5.
2. **La inferencia «el último objetivo prevalece» permanece no confirmada.** No puede usarse como base de diseño.
3. **La restauración real a un instante T sigue pendiente de F-P5.** Ninguna restauración PITR real se ha ejecutado en esta fase.
4. **Este cierre documental no autoriza F-P2, F-P4 ni fases posteriores.** La aprobación de F-P1 (ADR-005, §Alcance) declara explícitamente que no autoriza cambios en scripts, Compose, PostgreSQL, backups, B2 ni VPS.

### Queda pendiente

- Validación operativa de N-02 mediante restauración PITR real a instante T (gate F-P5, ADR-002 D5).

  **Criterio derivado para F-P4:** cada ensayo PITR debe configurar **exactamente un
  objetivo principal de recuperación** (`recovery_target_time`, `…_lsn`, `…_xid` o
  `…_name`), de modo que la semántica de especificación múltiple quede **irrelevante**
  y el desempate no confirmado no pueda afectar ningún resultado.*
  - **`recovery_target_time`** — por marca de tiempo (instante T).
  - **`recovery_target_lsn`** — por LSN concreto.
  - **`recovery_target_name`** — por nombre de restore point (creado con
    `pg_create_restore_point()`).
- **`recovery_target_inclusive`** (se utiliza **conjuntamente** con el objetivo
  elegido; aplica a `…_lsn`, `…_time` y `…_xid`): decide detenerse **justo después**
  del objetivo (`on`) o **justo antes** (`off`), controlando si las transacciones con
  exactamente ese LSN, hora de commit o XID quedan **incluidas**. **Valor
  predeterminado `on`** (verificado en PG16 §20.5.6). **No se fija aquí ningún valor
  para producción**: F-P4 deberá definirlo **explícitamente** según el escenario de
  prueba, porque determina el límite exacto que comprueban FP5-2 y FP5-3.
- **`recovery_target_timeline`** (se utiliza **conjuntamente** con la opción de
  objetivo elegida; no es alternativa): fija qué línea de tiempo se reproduce. Por
  defecto PG continúa en la más reciente; sin fijarlo explícito en un escenario con
  promotes puede reproducirse una timeline distinta de la deseada, por lo que el diseño
  lo fijará de forma explícita.
- **`recovery_target_action`** — determina **qué ocurre al alcanzar** el objetivo y
  distingue *detener la reproducción* de *promover el clúster recuperado*:
  - **`pause`** — **predeterminado** (verificado en PG16 §20.5.6): la reproducción
    **se pausa** en el objetivo; el servidor **no** queda promovido. Permite consultar
    y decidir, y puede reanudarse con `pg_wal_replay_resume()`.
  - **`promote`** — la reproducción **finaliza** y el servidor **empieza a aceptar
    conexiones** (clúster recuperado activo).
  - **`shutdown`** — el servidor **se detiene** en el objetivo, dejando la instancia
    lista en el punto exacto.

  **El ensayo automatizado F-P5 necesita especificar esta acción de forma
  explícita.** Con el predeterminado `pause`, la recuperación **se detiene y no
  promueve**, de modo que el proceso **no terminaría por sí solo como éxito
  automático** y FP5-1 quedaría sin cumplir. Por eso F-P4 debe fijar
  `recovery_target_action` (muy probablemente `promote` **para el entorno aislado de
  ensayo**) en lugar de heredar el default. **`promote` no se declara aquí como la
  mejor opción universal para producción**: es una opción a evaluar para el ensayo;
  la elección productiva queda **pendiente**.

  **Error fatal (verificado en PG16 §20.5.6):** si un objetivo está configurado pero
  la recuperación archivada **termina antes de alcanzarlo**, el servidor **se apaga
  con un error fatal**. Comportamiento deseable: **no** es un éxito silencioso, y
  refuerza que un WAL que falta debe producir fallo explícito (FP5-5).

El gate F-P5 (instante T) se apoyará probablemente en `recovery_target_time`, pero la
**opción concreta de objetivo, `recovery_target_inclusive` y `recovery_target_action`
se deciden en F-P4**, no aquí. Ninguno de estos parámetros está **desplegado** hoy:
`docker-compose.yml` no tiene `command:` y no hay `recovery.signal` ni `recovery_target*`
activos en ninguna instancia; la rama `--pitr` de F-P4 los **emite** en un directorio de
salida offline y `scripts/ops/test-ops-pitr-branch.sh` verifica ese contrato **sin
ejecutar recuperación** (ver §Contexto).

## Seguridad

- **Integridad**: `sha256` por segmento WAL y por artefacto, reutilizando los helpers
  ya existentes (`sha256_of`, `is_sha256` de `scripts/ops/common.sh`), con el mismo
  criterio que dump/roles en `postgres-restore.sh:407-415`. **Límite explícito**: un
  SHA-256 permite verificar integridad **frente a un digest de confianza**, pero **no
  garantiza autenticidad** ante un atacante capaz de alterar **tanto el objeto como su
  digest** — si el atacante puede escribir en el destino, puede reescribir ambos y el
  cálculo cuadra. **La firma criptográfica seguirá siendo trabajo futuro** (coherente
  con ADR-003, que deja R2 "atenuado, no cerrado").
- **Cifrado**: en reposo gestionado por el destino (objeto S3-compatible, coherente
  con ADR-002 D1). La **estrategia de cifrado de WAL queda aprobada con sus límites** (ver
  §"Decisiones de diseño aprobadas (F-P1.10)", 2); ADR-003 excluye hoy el cifrado client-side.
- **Custodia de claves**: `SOURCE_ENCRYPTION_KEY` sigue siendo secreto de por vida
  (ADR-002 D3) y **no reside en el bucket ni con las credenciales de acceso**
  (ADR-002 D1, restricción derivada de D2). El manifiesto físico registra
  `source_key_fingerprint` con el mismo mecanismo que hoy (`postgres-backup.sh:204-221`),
  calculado dentro del contenedor `api`; la clave cruda nunca llega al host ni al
  manifiesto. Si la clave se pierde, los datos físicos son recuperables pero las
  credenciales quedan ilegibles: debe documentarse como **fallo degradado explícito**,
  no como éxito.
- **Protección del transporte (requisito)**: la transferencia de WAL hacia el destino
  remoto debe ir **cifrada en tránsito**, con **verificación TLS** del endpoint cuando
  el cliente la soporte (el destino diseñado es S3-compatible sobre https, ver
  ADR-003). El **staging local** debe usar **permisos restrictivos** (umask 077, como
  ya hacen `postgres-backup.sh` y `postgres-restore.sh`). **La decisión concreta de
  cifrado queda aprobada con sus límites** (ver §"Decisiones de diseño aprobadas (F-P1.10)",
  2); **pendientes solo sus magnitudes** (ver §"Decisiones cuantitativas aún pendientes").
  Aquí solo se fija el requisito y la política, no los valores.
- **Aislamiento de restauración**: se reutiliza el patrón actual de
  `postgres-restore.sh` y `docker-compose.restore.yml`: proyecto Compose **aislado**,
  distinto del proyecto por defecto, con `RESTORE_CONFIRM=RESTORE` y validación del
  destino **antes** de tocar la base. La instancia PITR **no** se promueve hasta
  verificar probes y descifrado real.
- **Prevención de borrado prematuro**: la retención de WAL debe ser **≥** retención
  de bases + ventana de recovery; la política remota del prefijo de WAL debe ser
  **más laxa** que la de dumps, y **nunca** debe borrarse un WAL aún necesario para
  el LSN mínimo requerido.

## Disponibilidad

- **Contrato de `archive_command` (invariante de diseño)**: el código de salida **0**
  significa que el segmento **ha alcanzado el umbral de durabilidad acordado** y, solo
  entonces, puede considerarse archivado según el contrato. **Una escritura en staging
  local, por sí sola, NO demuestra durabilidad suficiente ni protección ante la pérdida
  del host** — con solo eso, la destrucción del host eliminaría ese WAL y dejaría la
  cadena PITR incompleta **sin que el código de salida lo revele**. **No se permite que
  una implementación futura devuelva éxito únicamente porque el segmento se escribió
  en una cola local temporal**, salvo que una decisión arquitectónica posterior defina
  expresamente ese umbral y sus límites. Un fallo de archivado **nunca** debe
  comunicarse como éxito: devolver 0 sin haber archivado abriría un **hueco
  silencioso** en la cadena WAL y haría imposible la recuperación hasta el instante
  afectado — pérdida de datos sin aviso. Si el archivado no se puede completar, el
  comando **debe fallar** (salida ≠ 0) para que PostgreSQL reintente el mismo segmento.
  **Todo resultado fallido o ambiguo debe evitar un falso éxito**: ante la duda,
  salida ≠ 0. La **política concreta** —destino, indisponibilidad de B2, reintentos y
  límites operativos— **sigue abierta** (ver §"Decisiones de diseño aprobadas (F-P1.10)", 1) y **a ella queda
  vinculada** la elección de si el éxito exige confirmación remota de B2 u otra
  garantía específica; **aquí no se resuelve**. Este contrato solo fija qué significa
  cada código de salida.

  Precisado en F-P1.11 (**diseño pendiente de implementación, sin fijar parámetros
  cuantitativos no aprobados**):
  - **Reintentos idempotentes**: un reintento que encuentre el staging ya poblado debe
    **verificar la confirmación remota** (identidad, tamaño y/o hash del objeto según
    el contrato definitivo), **no asumirla** por la mera existencia del archivo local.
  - **Un archivo local existente no prueba que la transferencia remota se haya
    confirmado**; solo la verificación del objeto en el destino (nombre canónico PG +
    tamaño y/o hash) permite el éxito.
  - **Un fallo debe producir salida ≠ 0** y conservar la posibilidad de reintento por
    parte de PostgreSQL (el segmento permanece en `pg_wal`).
  - **Máquina de estados propuesta por segmento** (diseño pendiente, sin magnitudes):
    *pendiente* → *transferencia en curso* (staging poblado, permisos restrictivos,
    sin confirmación remota) → *remoto confirmado* (objeto verificado en el destino ⇒
    exit 0) / *fallo recuperable* (destino caído: `pg_wal` retiene el segmento,
    `pg_stat_archiver.failed` incrementa, alerta, reintento) / *fallo terminal*
    (umbral agotado: exit ≠ 0 sostenido + alerta + registro, **nunca** exit 0). Cada
    transición se demuestra con la evidencia indicada; los umbrales cuantitativos
    quedan en §"Decisiones cuantitativas aún pendientes".
- **Fallo del destino remoto**: `archive_command` con reintentos acotados. Si el
  destino remoto cae, se define una **política ante caída de B2** (p. ej. cola local
  temporal) que sigue **pendiente de aprobación**. Un fallo sostenido no debe
  degradarse en silencio.
- **Acumulación de WAL**: riesgo ya anticipado en ADR-002 D5 — un `archive_command`
  que falla y no se purga acumula WAL hasta agotar el disco. Es un incidente de
  **disponibilidad, no de datos**. Exige monitoreo de `pg_stat_archiver`
  (`failed`, `last_archived_time`) y del volumen de `pg_wal`, con alerta de umbral.
- **Alertas**: se reutiliza el seam `ALERT_CMD` existente
  (`scripts/ops/lib/alert.sh`), que **nunca cambia el código de salida** del proceso
  que lo invoca, para eventos nuevos (p. ej. fallo de archivado, fallo de restore
  PITR). **Requisito a verificar en F-P2**: el proceso de archivado lo lanza
  **PostgreSQL dentro del contenedor `db`**, no un script del host, por lo que debe
  comprobarse que `ALERT_CMD` **está disponible en el entorno de ese contenedor**
  antes de dar la alerta por válida. **No se modifica la infraestructura de alertas
  en esta fase.** **No hay canal desplegado**: sin definir `ALERT_CMD` en un entorno
  real, ningún fallo notifica a nadie (externo, fuera de esta fase).

## RPO / RTO

Se distinguen explícitamente niveles y **no se establece ninguna garantía sin ensayo**:

| Nivel | Estado |
| --- | --- |
| **Objetivos internos** | Los ya declarados en `DEPLOY.md:29-30` (RPO 24 h, RTO 4 h) fueron rebajados a **objetivos internos, no SLA**, por ADR-002 D4. |
| **RPO real actual** | La frecuencia del backup completo (no un instante). ADR-002 D4 advierte que el peor caso real no es 24 h sino la **retención completa**, porque un backup puede fallar en silencio. |
| **PITR objetivo** | La granularidad pasaría a ser la del archivado WAL, pero **no se cuantifica aquí**: no hay ensayo, por lo que **no se declara ningún valor**. |
| **Resultados medidos** | **Aún no medidos.** RPO/RTO de PITR solo podrán publicarse tras el ensayo real (F-P5/F-P8) y **deberán presentarse como medidos, nunca como garantía previa**. |

**No se inventan cifras de RPO/RTO.** Cualquier número publicado antes de medirlo
sería una garantía infundada, exactamente lo que ADR-002 D5 prohíbe.

**Discrepancia detectada, sin resolver**: ADR-002 D4 describe el peor caso con una
**retención de 14 días**, mientras `.env.example:37` fija
`BACKUP_RETENTION_DAYS=3`. Este ADR no elige entre ambas cifras: usa "la retención
completa" sin cuantificar. **La reconciliación queda pendiente de aprobación** (no se
resuelve unilateralmente aquí) y debe resolverse antes de basar en ella cualquier
declaración de RPO.

## Retención

La **duración de la retención de WAL y su coste siguen pendientes de aprobación**
(deriva de ADR-002 D1: el "presupuesto de retención de WAL" quedó sin definir).

Consideraciones que la decisión de aprobación debe sopesar, **sin cifras aquí**:

- La retención WAL debe cubrir la ventana de recovery deseada **más** la retención de
  bases, y ser estrictamente mayor que el mínimo necesario para el LSN requerido.
- El lifecycle remoto del prefijo de WAL debe ser **más laxa** que la de dumps.
- El almacenamiento local temporal (staging) entre archivado y subida también define
  una retención propia, pendiente.
- **Prefijo de staging diferenciado**: el WAL pendiente de subida **no debe** convivir
  bajo el patrón `m24-postgres-*` que hoy purga `postgres-backup.sh:244`
  (`find -mtime +$RETENTION_DAYS -delete`). Necesita **prefijo/ruta propio** para que
  su purga sea una política **separada** de la de los dumps.
- **Purga específica y segura** (**diseño pendiente de especificación y validación;
  no se afirma que el algoritmo esté completamente diseñado ni validado**): la purga
  del staging WAL debe regirse por la política de retención WAL (decisión pendiente
  3), **no** por `BACKUP_RETENTION_DAYS`. Requisitos mínimos que deberá cumplir:
  - Considerar **cada backup físico completo y retenido**, relacionando **LSN,
    segmentos y timeline** de su conjunto recuperable.
  - **Verificar la continuidad** de la cadena WAL necesaria para cada conjunto antes
    de purgar por debajo de su LSN de inicio.
  - **Excluir backups incompletos** del cálculo del piso de retención (un backup
    fallido a mitad no puede anclar el piso).
  - **Abortar y alertar** si faltan segmentos necesarios o no puede demostrarse la
    continuidad; nunca purgar "alrededor" de un hueco como si fuera recuperable.
  - **Registrar el avance del piso de retención de forma duradera** (marcador atómico)
    **antes** de permitir purgas que dependan de él; un fallo a mitad de purga no debe
    borrar un segmento aún necesario.
  - **Prohibir expresamente** aplicar la purga `find -mtime` de los dumps
    (`postgres-backup.sh:244`, patrón `m24-postgres-*`) a los segmentos WAL.

  **No se fija ninguna duración nueva aquí** y **no se modifica ningún script
  existente.**
- **Manifiesto físico — campos requeridos en F-P3** (**no inventar formatos**; los
  campos actuales del manifiesto lógico `postgres-backup.sh:226-241` **no** los
  contienen): el manifiesto físico deberá **evaluar y documentar, como mínimo**,
  `base_lsn`, `stop_lsn`, timeline de inicio, checkpoint LSN y estado de completitud
  del backup físico, porque la retención y la purga segura dependen de ellos. **No se
  declara que estos campos existan hoy** ni se define un esquema definitivo en esta
  fase.

## Dependencias externas (fuera de esta fase)

Permanecen **íntegramente fuera** del alcance de F-P1 y de este ADR:

- **Backblaze B2**: cuenta, bucket, Object Lock y lifecycle (ADR-003; región
  irreversible al crear la cuenta).
- **VPS de producción** (ADR-002 D0): prerrequisito de todo lo anterior.
- **Credenciales y endpoint reales**: hoy vacíos en `.env.example`.
- **Canal real de `ALERT_CMD`**.

Este ADR **no crea** bucket, VM, almacén de secretos ni modifica topología.

## Fases posteriores

| Fase | Contenido | Local / Externo | Criterio de aceptación |
| --- | --- | --- | --- |
| **F-P1** | Este ADR (formalización) | Local | ADR aprobado; sin código |
| **F-P2** | `docker-compose.yml` (`wal_level`, `archive_mode`, `archive_command`, `archive_timeout`) + script de archivado. **Estado (2026-10-28): el script de archivado existe y está publicado (F-P2.11); la configuración WAL activa sigue pendiente** | Local | `SHOW archive_mode=on`; segmentos archivados de verdad en local; `pg_stat_archiver` limpio |
| **F-P3** | Base física + manifiesto con `base_lsn`/`timeline`. **Estado (2026-10-28): implementada en `scripts/ops/postgres-physbackup.sh` (publicado y probado offline); la ruta real `pg_basebackup` y sus prerrequisitos (`REPLICATION`, `wal_level=replica`, `max_wal_senders`) siguen sin verificarse** | Local | Base extraíble, digest válido, campos presentes |
| **F-P4** | Verificación de cadena WAL + rama PITR en `postgres-restore.sh` **y en `scripts/ops/docker-compose.restore.yml`** (montaje del WAL, `restore_command`, objetivo de recuperación). **Estado (2026-10-28): la rama PITR offline está publicada y probada como contrato; la compatibilidad de `docker-compose.restore.yml` y el ensayo real siguen pendientes** | Local | Cadena verificada; WAL corrupto ⇒ fallo explícito. **La compatibilidad actual de `docker-compose.restore.yml` con la reproducción de WAL NO está comprobada**: deberá verificarse con la implementación y el ensayo de F-P4 |
| **F-P5** | **Drill PITR automatizado** (`test-ops-pitr.sh`) en CI, a instante T. **Estado (2026-10-28): pendiente. `scripts/ops/test-ops-pitr-branch.sh` prueba el contrato offline de la rama y NO sustituye este gate** | Local | Todos los criterios medibles de §"Gate F-P5" (FP5-1…FP5-10) cumplidos con evidencia |
| **F-P6** | Integración con `offhost-upload.sh` y bundle, y eventos de alerta. **Estado (2026-10-28): pendiente; el archivador no está integrado en `offhost-upload.sh` ni en el bundle** | Local (contrato) | `76` preservado, manifest al final, `test:ops` verde |
| **F-P7** | Destino B2 real, Object Lock/lifecycle del WAL, canal `ALERT_CMD` | **Externo** | Ensayo con B2 real |
| **F-P8** | Medición de RPO/RTO reales + runbook PITR + pérdida total del host | **Externo** | RPO/RTO **medidos**; recuperación de host demostrada |

**Requisito innegociable de "operativo"** (heredado de ADR-002 D5): **PITR no se
declarará implementado ni operativo hasta completar una restauración real a un
instante T previamente controlado y demostrar su coherencia.** El gate es F-P5.
Hasta entonces, el estado documentado es *"diseñado e implementado **offline**; no
desplegado y no validado operativamente"*.

### Gate F-P5 — criterios de aceptación medibles

F-P5 solo se considera superado si **todos** los criterios siguientes quedan
demostrados con evidencia objetiva (salida de comando, registros o aserciones del
propio ensayo), **expresados como condiciones observables y verificables**, sin
depender de inspección subjetiva ni de inferir el éxito de que el proceso terminó.

**Secuencia temporal obligatoria del ensayo**: `base física < t1 < t2`, con el
archivado de `t1` y `t2` **confirmado antes de restaurar** (ver FP5-2 y FP5-3). La
prueba debe demostrar **reproducción de WAL y recuperación hasta un objetivo**, no una
restauración que ya contuviera los datos o que omitiera WAL relevante.

- **FP5-1 — Objetivo alcanzado y señal de éxito de la rama PITR**: la restauración
  con objetivo en `t1` **alcanza el objetivo configurado y finaliza conforme a la
  acción elegida** (`recovery_target_action`), con **evidencia verificable** de que el
  replay se detuvo en `t1` — **no** se infiere únicamente de que el proceso terminó ni
  de que emitió una marca. **Aclaración**: `restore=ok` identifica la **ruta lógica**
  (`postgres-restore.sh:705`) y `pitr=ok` identifica el resultado de la **rama offline**
  (`postgres-restore.sh:321`: integridad de la cadena WAL y emisión de configuración);
  **ninguna de las dos señales, por sí sola, acredita una recuperación PITR real a un
  instante T**. **F-P4 deberá definir la señal de éxito del ensayo real** (o especificar
  explícitamente cómo se reutiliza una existente), incluyendo
  comprobaciones **independientes** de (a) que se alcanzó el objetivo y (b) que los
  datos posteriores a T no están presentes.
- **FP5-2 — Base física anterior a `t1` y `t1` añadido vía WAL**: se demuestra que la
  **base física se creó antes de insertar `t1`** (evidencia observable: orden y marcas
  de tiempo del ensayo); después se inserta `t1` y se **confirma su archivado WAL**; tras
  recuperar, `t1` **está presente**. Esto prueba que `t1` llegó **por reproducción de
  WAL**, no porque ya estuviera en la base.
- **FP5-3 — `t2` posterior a T, archivado confirmado y ausencia tras recuperar**:
  `t2` se inserta **después** del punto a recuperar (`t2 > t1`); se **fuerza la
  generación/switch** del segmento cuando corresponda y se **confirma que el WAL
  necesario se archivó antes de comenzar la restauración**. Tras recuperar a `T=t1`:
  **`t1` presente (FP5-2) y `t2` ausente**. Esto descarta el falso positivo de una
  omisión de `t2` debida a que su WAL aún no se hubiera archivado.
- **FP5-4 — Objetivo alcanzado (evidencia de línea de tiempo/LSN)**: la recuperación
  **llega al objetivo configurado y finaliza según la acción elegida**, demostrado con
  evidencia verificable (p. ej. estado de replay, LSN/hora alcanzados, salida de la
  acción), **sin inferirlo** del mero fin del proceso. Complementa a FP5-1.
- **FP5-5 — Integridad y continuidad de la cadena WAL**: `sha256` de **todos** los
  segmentos verificado, **continuidad sin huecos** desde `base_lsn` de la base física
  y **timeline correcta**.
- **FP5-6 — Fallo explícito ante WAL ausente o corrupto**: se selecciona
  **deliberadamente un segmento necesario para alcanzar T** (no un segmento posterior
  a T), se demuestra que **falta o está corrupto**, y se verifica que el procedimiento
  **falla con código ≠ 0** identificando el segmento; **nunca** emite la señal de éxito
  con una cadena incompleta. Coherente con el error fatal de PG16 si la recuperación
  termina antes del objetivo (§Mecanismo).
- **FP5-7 — Credenciales cifradas recuperadas**: `source_key_fingerprint` del
  manifiesto coincide y al menos una `connection_config` **descifra de verdad** con la
  clave suministrada.
- **FP5-8 — RLS y permisos conservados**: 7 tablas con `FORCE RLS`, `app_role`
  NOBYPASSRLS, `bg_role` BYPASSRLS y migraciones Drizzle coherentes
  (`migration_journal_sha256`).
- **FP5-9 — Aislamiento de producción**: la restauración se ejecuta en proyecto
  Compose distinto del default y **no toca ningún volumen ni base de producción**.
- **FP5-10 — RPO/RTO medidos en condiciones de ensayo**: el ensayo registra la
  **duración real** (RTO) y la **ventana máxima de pérdida** demostrada (RPO). Son
  **resultados del ensayo, bajo las condiciones y configuración documentadas del
  ensayo**; **no** son garantía de producción ni un SLO validado, y así deben
  publicarse.

### Alcance de "operativo": funcional frente a durable

Se distinguen dos niveles que **no deben confundirse**:

- **PITR funcional validado (F-P5)**: recuperación a un instante T demostrada en el
  **entorno de ensayo** (Docker local/CI), con WAL en almacenamiento local. Protege
  frente a corrupción lógica, erratas y estados intermedios.
- **PITR con durabilidad fuera del host (F-P7)**: solo cuando los segmentos WAL
  estén **archivados y verificados en el destino remoto** (B2 real) puede el PITR
  considerarse protegido frente a la **pérdida total del host**.

**No se declara protección alguna ante pérdida del host antes de validar F-P7.** En
coherencia con ADR-002 D0 (un único VPS, sin tolerancia a pérdida de host), superar
F-P5 **no** autoriza a afirmar que el PITR sobreviva a la destrucción del VPS.

## Decisiones de diseño aprobadas (F-P1.10)

Registro documental de las nueve políticas aprobadas como decisiones de diseño
inicial. **Esta aprobación es documental: no autoriza implementación ni ejecución de
F-P2.** Las magnitudes cuantitativas (duración numérica, presupuesto, umbrales,
tamaño de cola) siguen **pendientes de evidencia y aprobación específica** y se
mantienen en §"Decisiones cuantitativas aún pendientes".

1. **Indisponibilidad de B2**: cola local acotada, reintentos limitados, alertas y
   fallo explícito al agotarse el margen. **Nunca** informar éxito de archivado sin
   satisfacer el contrato de durabilidad.
2. **Cifrado**: TLS con verificación de certificados, cifrado en reposo del
   proveedor y permisos restrictivos de staging. Riesgo residual documentado por **no
   tener cifrado del lado cliente** (ver decisión 7 y coherencia con ADR-003).
3. **Retención WAL**: conservar el WAL necesario para los backups físicos retenidos
   y sus ventanas de recuperación. La duración numérica, el presupuesto y el
   lifecycle quedan pendientes de evidencia y aprobación específica **antes de
   activarse**.
4. **Manifiesto**: un manifiesto primario por conjunto físico recuperable, con
   referencia al backup lógico complementario.
5. **Staging**: directorio independiente de los dumps y política de purga
   independiente. **No purgar segmentos WAL necesarios.** Los umbrales, el mecanismo
   de cálculo y los límites concretos se definirán **antes de implementar** la purga.
6. **Backup lógico**: tres días como propuesta inicial, diferenciando expresamente
   retención local y remota. **Revisar la cifra con datos de costes antes de F-P3.**
7. **Firma**: aceptar provisionalmente el riesgo documentado de no tener firma
   criptográfica. **No presentar SHA-256 como prueba de autenticidad.** La firma
   queda registrada como **mejora futura**.
8. **Pérdida del host**: **no declarar** protección efectiva ante pérdida total del
   host hasta completar y superar un **ensayo con infraestructura remota real**.
9. **Retención actual**: reconocer **tres días** como valor configurado actualmente.
   **No modificar configuración**, **no declarar RPO de 14 días** y mantener pendiente
   la reconciliación documental de ADR-002 D4.

## Decisiones cuantitativas aún pendientes (magnitudes sin aprobar)

Aprobadas las políticas 1–9 de §"Decisiones de diseño aprobadas (F-P1.10)" (arriba),
queda pendiente **solo** lo cuantitativo que cada una declara expresamente pendiente.
Nada de lo siguiente autoriza implementación (ver §"Aprobación formal condicionada
(F-P1.7)"):

1. **Umbral de durabilidad y límites de la cola local** (decisión 1): tamaño máximo,
   tiempo máximo de retención local, cadencia de reintentos y umbral de fallo
   explícito. **Sin cifras.**
2. **Coste del cifrado** (decisión 2): sin infraestructura client-side hoy; el coste
   del modelo proveedor + TLS es el del despliegue ya aprobado en ADR-003.
3. **Duración numérica, presupuesto y lifecycle de la retención WAL** (decisión 3).
   **Sin cifras.**
4. **Formato exacto del manifiesto** (decisión 4): campos y esquema definitivos en
   F-P3; la política (primario con enlace) ya está aprobada.
5. **Umbrales y mecanismo de cálculo de la purga de staging** (decisión 5): a
   definir **antes de implementar** la purga.
6. **Duración de retención del backup lógico** (decisión 6): propuesta inicial de
   **tres días**, a revisar con datos de costes **antes de F-P3**.
7. **Firma criptográfica** (decisión 7): sin diseño ni calendario; mejora futura.
8. **Ensayo con infraestructura remota real** (decisión 8): pendiente de VPS + B2
   (F-P7).
9. **Reconciliación 14 días vs 3 días** (decisión 9): sin elegir cifra; pendiente de
   aprobación documental.

## Estado posterior a la publicación (2026-10-28)

Registro de hechos verificables posteriores a la aprobación F-P1.7. **Esta sección no
modifica ninguna decisión, gate ni requisito**: documenta qué existe hoy y qué **no**
prueba.

### Código publicado

| Commit | Contenido |
| --- | --- |
| `7a3e607` | Scripts operativos: `scripts/ops/wal-archive.sh` (F-P2.11), `scripts/ops/postgres-physbackup.sh` (F-P3.2) y la rama PITR offline de `scripts/ops/postgres-restore.sh` (F-P4). |
| `43f13d6` | Determinismo de las comprobaciones `grep` bajo `pipefail` en `scripts/ci/dr-asserts.sh` y en tres suites de `scripts/ops/`. |
| `36bcf09` | Integración en `test:ops` de las cuatro suites offline: `test-ops-wal-archive.sh`, `test-ops-physbackup.sh`, `test-ops-restore-key-env.sh` y `test-ops-pitr-branch.sh` (de 6 a 10 suites). |

### Evidencia de pruebas

- `pnpm run test:ops` en local: **457 aserciones `ok` / 0 `fail`** (10 suites).
- Workflow `Product quality`, ejecución **#53**: conclusión **`success`**; el paso
  "Test operational scripts" terminó correctamente con las 10 suites integradas.
- Job **`DR drill (backup -> bundle -> restore)`**: conclusión **`success`**. Su alcance es
  **estrictamente lógico** (`pg_dump` → bundle → `pg_restore` en un proyecto Compose
  aislado); su propio harness declara que **no** toca B2, ni un segundo host, ni Object
  Lock, ni lifecycle, y que la recuperación real ante pérdida del host sigue **bloqueada**.

### Qué NO demuestra esta evidencia

- **No** demuestra PITR operativo ni desplegado.
- **No** demuestra una recuperación real a un instante T: ninguna se ha ejecutado.
- **No** demuestra durabilidad off-host ni protección frente a pérdida del host (F-P7).
- Las suites offline prueban **contratos** y comportamiento simulado (dobles de transporte,
  `PHYS_BASEBACKUP_CMD`, stub de `docker`); **no** reproducen WAL ni arrancan PostgreSQL.

### Limitaciones abiertas a esta fecha

Sin resolver, y **sin cambios** en los objetivos de retención, los requisitos
criptográficos, el diseño de B2, la configuración del VPS ni los criterios de RPO/RTO:

1. **A1** — mensaje de error engañoso cuando falta `python3` en `postgres-physbackup.sh`,
   pese a que el script lo utiliza.
2. **A2** — hipótesis no verificada sobre `docker run --user` en la ruta real.
3. **A4** — `basename(%p) == %f` asumido sin verificación en PostgreSQL 16.
4. **A5** — código muerto `need_upload` en `postgres-physbackup.sh`.
5. **A6** — comentario de las rondas "R" sin actualizar en el archivador.
6. **A7** — `REPLICATION`, `wal_level=replica` y `max_wal_senders>=2` **no verificados**
   (`postgres-physbackup.sh:303`): prerrequisito de la base física real.
7. **A8** — N-02 **Capa 3** (validación operativa) sigue pendiente del ensayo F-P5.
8. **A9** — RPO/RTO **no medidos**; la discrepancia 14 días vs 3 días sigue sin reconciliar.
9. **A10** — sin firma criptográfica y sin cifrado del lado cliente (riesgo aceptado).
10. **A11** — B2, VPS, `ALERT_CMD` y credenciales reales siguen fuera de alcance.
11. **A12** — `scripts/ops/docker-compose.restore.yml` no contiene un servicio de
    restauración activo (solo comentarios): la compatibilidad con la reproducción de WAL
    sigue **sin comprobar**.

## Referencias

- `docs/adr/ADR-002-m25-0-backup-and-dr-architecture.md` (D1, D3, D4, D5 — PITR
  aislado y gate de ensayo real)
- `docs/adr/ADR-003-m26-off-host-backend.md` (destino off-host; excluye PITR/WAL)
- PostgreSQL 16, §26.3 *Continuous Archiving and Point-in-Time Recovery*
- `scripts/ops/postgres-backup.sh` (`:167-168`, `:204-221`, `:226-241`)
- `scripts/ops/postgres-restore.sh` (`:407-415`, `:466`, `:705`; rama PITR offline desde
  `:30` y señal `pitr=ok` en `:321`)
- `scripts/ops/offhost-upload.sh` (`:69`, `:37`)
- `scripts/ops/lib/alert.sh` (`emit_alert`)
- `docker-compose.yml` (servicio `db`, `:4-20` — sin configuración WAL)
- `DEPLOY.md:29-35`, `docs/security-overview.md:227`,
  `docs/operations-runbook.md:481,927`
