# ADR-003 — Almacenamiento off-host S3-compatible para backups (M26.0)

- **Estado:** Aceptado (diseño cerrado; infraestructura pendiente)
- **Fecha:** 2026-09-27
- **Alcance:** ejecuta D1 de ADR-002: destino off-host, cliente de subida,
  bundle de restore y retención. **No incluye** PITR/WAL, firma criptográfica
  del manifest, rotación o envelope de `SOURCE_ENCRYPTION_KEY`, cifrado
  client-side, monitoring stack, MFA ni cambios de topología.

## Contexto

ADR-002 decidió que D1 es object storage S3-compatible gestionado, con cifrado
en reposo gestionado, inmutabilidad por Object Lock y retención por lifecycle.
Nunca se implementó: no existía SDK, CLI, bucket ni credencial, y la imagen base
`node:22-alpine` no incluye `aws-cli`.

Sin copia off-host, la pérdida del VPS destruye la única copia de los backups: un
`rm` o ransomware en el host equivale a pérdida permanente. ADR-002 D0 ya asume
que la continuidad depende por completo de que D1 sea recuperable.

Los candidatos se evaluaron por **capacidad documentada**, no por preferencia:

- **Cloudflare R2 — descartado.** Su matriz de compatibilidad S3 marca
  `x-amz-object-lock-mode ❌`, `x-amz-object-lock-retain-until-date ❌` y
  `x-amz-object-lock-legal-hold ❌`. Sin Object Lock desaparece la propiedad de
  inmutabilidad que ADR-002 ya decidió, y no hay configuración que lo sustituya.
  El "Bucket locks" de R2 impide borrar el *bucket*, no objetos individuales.
- **Wasabi — descartado.** Habilitar Object Lock **anula la función Compliance**,
  dejando un solo modo efectivo.
- **MinIO self-hosted — descartado.** En el mismo VPS no es off-host, que es
  exactamente la amenaza que D1 existe para cubrir.
- **Backblaze B2 — elegido.** Object Lock en modos Governance y Compliance
  (1–3.000 días), lifecycle por prefijo, app keys restringibles a un bucket y a
  un prefijo con expiración, endpoint S3 estándar, $6.95/TB/mes con 10 GB gratis
  y egress hasta 3× el almacenamiento medio mensual.

## Decisión

Backblaze B2 Cloud Storage mediante su API S3-compatible, con un cliente de
subida independiente (`scripts/ops/offhost-upload.sh`) y un bundle de restore
autoverificable (`scripts/ops/build-restore-bundle.sh`).

## Configuración conceptual

    B2_S3_ENDPOINT   = https://s3.<region>-<NNN>.backblazeb2.com
    B2_S3_REGION     = <región de firma SigV4>
    BACKUP_BUCKET    = privaris-postgres-backups  (propuesto)
    BACKUP_PREFIX    = prod | staging | drill

> **Corrección sobre la documentación del proveedor.** La documentación general
> muestra `https://s3.<region>.backblazeb2.com`, pero **todos los ejemplos
> ejecutables** usan un sufijo numérico de datacenter: `s3.us-west-000`,
> `s3.us-east-004`, `s3.us-east-005`. Ese valor es **por cuenta**, se obtiene en
> el panel y **no se deriva de la región**. Además, el host del endpoint y el
> valor de región usado en la firma SigV4 son **distintos** (los ejemplos de
> presigned URL muestran `/us-east-1/` en el scope de firma con host
> `us-east-004`). El endpoint no puede construirse a partir de la región.

Estructura de objetos, reutilizando el `base` que ya genera
`postgres-backup.sh`:

    backups/<env>/m24-postgres-<timestamp>-<sufijo>.{dump,roles.sql,manifest}

Los nombres de bucket en B2 son **únicos globales** y no se pueden renombrar, y
B2 advierte de no incluir PII/PHI en nombres. `privaris-postgres-backups` cumple
las reglas de caracteres y longitud, pero **su disponibilidad solo puede
comprobarse creando la cuenta**.


## Object Lock

**Governance, 30 días**, como default del bucket.

Governance y no Compliance porque en Compliance ninguna retención puede acortarse
por nadie, y la ruta documentada por el proveedor para un error es *cerrar la
cuenta*. Para un despliegue single-tenant con un único operador, el riesgo de
un error de configuración excede el de un atacante con acceso privilegiado al
proveedor. Governance alcanza el mismo resultado frente al atacante real —una
credencial de escritura comprometida en el VPS— porque dicha credencial **no**
lleva `bypassGovernance`.

Legal Hold queda disponible por objeto y nunca se aplica por defecto a nivel de
bucket.

## Lifecycle

El almacenamiento remoto es la **autoridad de retención remota**:

    daysFromUploadingToHiding = 90
    daysFromHidingToDeleting = 1

`find -mtime` deja de expresar una política de retención y pasa a ser **buffer de
staging local** (14 → 3 días). Un fallo de red no debe dejar al backup sin copia
local mientras se reintenta la subida.

**Restricción dura:** con Object Lock activo, cualquier lifecycle que intente
cambiar o borrar un archivo bloqueado falla. Por tanto la retención de Object
Lock debe ser **estrictamente menor** que el día de borrado de lifecycle. Con
`30 < 90` se cumple. Si se invierten los valores, lifecycle falla en silencio y
el bucket crece sin alarma.

## Credenciales

Dos app keys, ambas restringidas a un único bucket y al prefijo del entorno, con
expiración de **180 días**.

| Credencial | Capabilities | Exentas de |
| --- | --- | --- |
| `B2_WRITE_*` | `listFiles`, `readFiles`, `writeFiles` | `deleteFiles`, `bypassGovernance`, `writeFileRetentions` |
| `B2_READ_*` | `listFiles`, `readFiles` | toda capacidad de escritura |

`B2_READ_*` se restringe **solo a `prod/`**. Si más adelante hacen falta accesos
de DR sobre `staging/` o `drill/`, se crean credenciales separadas con mínimo
privilegio, no se amplía la existente.

La **master key nunca se usa**: no tiene restricción de bucket, prefijo,
capacidad ni expiración.

`B2_WRITE_*` reside en el VPS en un archivo con modo 600, fuera del
repositorio y fuera de `.env`. `B2_READ_*` **no reside en el VPS** y se entrega
fuera de banda durante un DR.

**`SOURCE_ENCRYPTION_KEY` no forma parte de estas credenciales ni se almacena
junto a ellas.** Son complementarias, no solapadas: la credencial de lectura sin
la clave no revela datos de fuentes cifrados, y la clave sin el dump no
recupera nada. B2 no soporta IAM Roles en su API S3, de modo que el mecanismo
son app keys; la equivalencia conceptual se consigue por otro camino.

**Rotación (180 días).** Crear la key nueva, desplegarla en el VPS, comprobar un
backup con salida 0, revocar la antigua. La ventana de solape no es necesaria
porque solo hay una credencial de escritura y una de lectura, y cada una puede
reemplazarse de forma independiente. Un backup que devuelva `1` o `76` tras la
rotación es la señal de que la nueva key no tiene los permisos acordados.

## Cifrado

**Sin cifrado client-side en M26.** El proveedor gestiona el cifrado en reposo
(`SSE-B2`).

El dump actual **no está cifrado en reposo en el VPS**, de modo que el cifrado
gestionado no reduce la postura de confidencialidad respecto al estado actual.
ADR-002 ya decidió "cifrado en reposo gestionado".

En consecuencia, y de forma explícita: **el dump no debe considerarse
confidencial frente al operador del storage.** Si el modelo de amenaza incluye a
Backblaze, esta decisión debe revertirse. Client-side encryption queda como
trabajo futuro.

## Backup / restore

El backup se produce en el VPS y se sube **desde el VPS**. **GitHub Actions no
recibe credenciales de producción**: el artefacto nace en el VPS, exfiltrarlo a
CI ampliaría el radio de exposición, y acoplar la copia off-host a la
disponibilidad de un SaaS contradice el propósito de D1.

Orden de subida obligatorio: `dump` → `roles.sql` → `manifest`. **El manifest es
el commit lógico**: su presencia indica juego completo, y un upload interrumpido
deja objetos sin manifest, por tanto inutilizables. El orden es una constante
del cliente, no una variable de entorno, porque hacerlo configurable permitiría
romper ese invariante sin que ninguna prueba lo detectara.

Códigos de salida del cliente:

| Código | Significado |
| --- | --- |
| `0` | Los tres objetos publicados |
| `1` | Configuración inválida o artefacto ausente; nada se publica |
| `76` | Backup local correcto, subida fallida |

`76` es deliberadamente distinto de `1`: `1` puede ser un disco lleno, mientras
que `76` significa host sano y sin copia externa. **Ante un `76` el backup local
nunca se borra.** El cliente tampoco ejecuta un borrado compensatorio de los
objetos ya publicados: un set sin manifest es inutilizable por diseño, y borrar
un dump ya subido durante un incidente sería peor que dejarlo.

**Bundle de restore.** `postgres-restore.sh` aún resuelve sus helpers del
repositorio, por lo que un DR sin checkout fallaría antes de llegar a la base de
datos. El bundle empaqueta script, `common.sh`, `verify-source-key.cjs`,
`restore-roles.sql`, compose y migraciones; referencia las imágenes **por digest,
nunca por tag**; y **no contiene** backups, `SOURCE_ENCRYPTION_KEY` ni
credenciales. El constructor extrae lo que acaba de escribir y verifica sus
checksums antes de declararse correcto.

## Dependencia externa: región y cuenta

D1 queda **cerrada en diseño**. Crear la cuenta, el bucket y las app keys
requiere que exista el VPS de producción, porque la **región se elige al crear la
cuenta y no puede cambiarse**, y la disponibilidad del nombre de bucket solo
puede comprobarse entonces.

Hasta que eso ocurra, el cliente se verifica **en contrato** contra un doble
local (`OFFHOST_S3_CMD`), sin red, sin credenciales y sin coste. La verificación
con B2 real es un paso posterior, no un criterio de "hecho" ya cumplido.

## Consecuencias

- Se cierra la pérdida total por destrucción del VPS, en diseño. **La capacidad
  DR real no existe hasta que exista el VPS**, que es consistente con D0.
- El manifest deja de ser editable y pasa a ser un registro fiable de lo que había
  en el momento del sellado. **R2 se atenúa, no se cierra**: sigue sin haber
  autenticidad, y un atacante con acceso de escritura previo al sellado puede
  subir dump y manifest falsos. La firma sigue siendo trabajo futuro.
- El dump pasa a estar en custodia de un tercero: la disponibilidad de los
  backups depende ahora de la API del proveedor.
- Ventana de crecimiento sin vigilancia: entre los 30 días de Object Lock y los
  90 días de lifecycle, el backup ya puede borrarse por quien tenga
  `bypassGovernance`.
- Riesgo operativo asumido: si una subida falla, quedan `dump` y `roles.sql`
  publicados sin manifest. No se limpia automáticamente, porque un borrado
  durante un incidente puede ser más dañino que dejar objetos huérfanos, y el
  lifecycle los reclamará. Un bucket con sets huérfanos es ruido, no pérdida.

## Relación con ADR-002

D1 ya decidió el tipo de destino. Este ADR lo ejecuta y **no lo modifica**, con
una enmienda de una línea: lifecycle es la autoridad de retención *remota* y
`find -mtime` se conserva con rol de buffer de staging local. La redacción
anterior podía leerse como eliminar esa línea, lo que habría dejado al backup
sin copia local ante un fallo de red.

## Relación con R2 / R7 / R8 / R9

- **R2** — atenuado, no cerrado. Ver "Consecuencias".
- **R7** — el restore ya no depende del checkout: el bundle se extrae y ejecuta
  en un host limpio, con referencias a imágenes por digest. La prueba definitiva
  sigue siendo un ensayo completo backup → off-host → restore con B2 real.
- **R8** — sin cambio. PITR sigue aislado en D5 y sin implementar.
- **R9b** — cerrado en diseño.
- **R9a** (scheduler) — **implementado y probado**; no desplegado, porque no
  existe VPS ni entorno de producción.
- **R9c** (alertas) — **implementado y probado**: el seam `ALERT_CMD` notifica
  desde el backup programado y desde el uploader. No hay canal configurado; su
  despliegue depende de la infraestructura que aún no existe.
- **R9d** (retención remota, especificada pero no aplicada) — **abierto**: requiere el
  bucket, que no existe.
