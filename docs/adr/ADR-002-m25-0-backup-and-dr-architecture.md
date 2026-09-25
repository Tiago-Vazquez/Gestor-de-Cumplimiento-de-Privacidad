# ADR-002 — Arquitectura de backup y recuperación (M25.0)

- **Estado:** Aceptado (M25.0)
- **Fecha:** 2026-09-25
- **Alcance:** **solo decisiones de arquitectura.** No implementa F1–F5, no modifica `docker-compose.yml`, ni los scripts de backup/restore, ni el código criptográfico, ni crea infraestructura. La implementación queda en M25.1+.

## Contexto

M24 entregó una ruta de backup/restore **verificada pero local**: dump lógico con manifest y checksums, y un drill de restore aislado que valida conteos, `RLS`+`FORCE RLS` en las 7 tablas de la migración `0018` y los atributos de `app_role`/`bg_role`. `DEPLOY.md` declara honestamente que M24 no promete PITR ni protege contra pérdida de host.

La auditoría de M25.0 encontró una brecha que la verificación de M24 **no puede detectar**, y que condiciona toda la estrategia de recuperación:

`SOURCE_ENCRYPTION_KEY` se deriva por `sha256` sin KDF con sal ni costo (`secret-manager.ts:57`) y cifra con `aes-256-gcm` la **configuración de conexión completa** de cada fuente, serializada como `JSON.stringify(config)` (`sources.repo.ts:27`) y almacenada en `sources.connection_config` (`schema/sources.ts:27`). El backup **excluye deliberadamente las claves** (`DEPLOY.md:9`). El restore **solo valida longitud ≥ 32** (`postgres-restore.sh:47`) y **no intenta descifrar nada**; el manifest registra `dump_sha256` y `roles_sha256` (`:89-90`) pero **ningún fingerprint de la clave**. No existe versionado ni rotación: la búsqueda de `KEY_VERSION`, `keyVersion`, `rotateKey`, `previousKey`, `ENVELOPE` y `keyRing` no devuelve coincidencias.

De ahí se deriva el fallo central: **un restore con la clave equivocada —o sin ella— pasa todos los criterios de aceptación de M24** (`restore=ok`, probes 200, conteos coincidentes, RLS íntegro, roles correctos) y aun así ninguna fuente conecta, porque `decrypt` rechaza datos que nunca se descifraron. La plataforma reporta salud sobre un sistema inoperable. Agrava el hecho que `connection_config` sea `jsonb` **nullable** (fuentes legacy solo con metadatos), de modo que un restore sin ninguna credencial descifrable es indistinguible de uno sano por conteos.

En paralelo, el repositorio **no declara ninguna topología de producción**: `docker-compose.yml` documenta un stack local con un único volumen nombrado `pgdata` y el servicio `db` sin `command:` (sin `wal_level`, `archive_mode` ni `shared_preload_libraries`); `DEPLOY.md` se titula "Despliegue local"; `replit.md` es una guía de desarrollo. "Almacenamiento off-host" y "PITR" son propiedades de una topología que hoy no existe, por lo que ambas decisiones quedaban bloqueadas.

## Decisiones

### D0. Producción = un único VPS con Docker Compose
Se adopta la topología que el repositorio ya describe, **declarada explícitamente como el modelo de producción soportado** en lugar de dejarlo implícito. Consecuencia aceptada: **no hay alta disponibilidad ni tolerancia a pérdida de host**; el VPS es un punto único de falla y la continuidad depende por completo de que el destino off-host (D1) sea recuperable. Se documentará como limitación conocida, no como capacidad.

### D1. Backups off-host = object storage S3-compatible gestionado
Se elige almacenamiento de objetos gestionado por tres propiedades concretas: **cifrado en reposo gestionado**, **inmutabilidad mediante Object Lock** (una cadena de custodia que un volumen de red no ofrece) y **políticas de lifecycle** para reemplazar el borrado local por `find -mtime` como mecanismo de retención. La misma decisión habilita D5: `archive_command` puede escribir WAL directamente al destino sin instalar un agente adicional.

Restricción derivada de D2 y que se hace explícita aquí: **la `SOURCE_ENCRYPTION_KEY` y la clave de cifrado del dump no deben residir en el bucket ni con las mismas credenciales de acceso**. Quedan pendientes de definir región, clase de almacenamiento y presupuesto de retención de WAL.

### D2. `SOURCE_ENCRYPTION_KEY` con dos copias offline, procedimiento de recuperación y fingerprint en manifiesto
Se adopta custodia **operativa** (dos copias offline, en ubicaciones separadas) más **verificación criptográfica**:

- **Fingerprint de clave en el manifest** — se registrará una huella derivada de la clave usada, para que un restore posterior pueda afirmar **coincidencia** y no mera longitud.
- **Descifrado demostrado en el restore** — contar las fuentes con `connection_config` no nulo, descifrar al menos una y **fallar** si la clave no corresponde. Un restore que no descifra una sola credencial **no es** un restore exitoso, aunque imprima `restore=ok`.
- **Reporte separado de fuentes legacy** con `connection_config` nulo, para que no se contabilicen como sanas.

**Envelope encryption queda explícitamente fuera de M25.** La alternativa de sobre-cifrado con clave envolvente es la única que permitiría rotación sin downtime, pero no es requisito en este milestone (D3). Se acepta el coste: la custodia depende de disciplina operativa, no de infraestructura.

### D3. La rotación de `SOURCE_ENCRYPTION_KEY` no es requisito de M25; la clave actual es inmutable
No se implementará rotación ni versionado de clave. **Debe documentarse de forma explícita que rotar la clave sin migración deja ilegibles todas las configuraciones cifradas ya almacenadas**: al no existir versionado, `decrypt` no puede distinguir "cifrado con la clave anterior" de "cifrado corrupto". Consecuencias asumidas:

- La clave es un **secreto de por vida** del despliegue, con la criticidad que implica.
- Si se filtra, el único camino es **re-cifrar en sitio todas las fuentes**, trabajo que no está incluido en M25.
- Se distingue explícitamente de `JWT_SECRET`, cuya rotación invalida sesiones y es aceptable. **Son dos decisiones distintas y no deben mezclarse.**

### D4. RPO ≤ 24 h y RTO 4 h son objetivos internos, no SLA comercial
Se mantienen los valores ya declarados en `DEPLOY.md` pero **bajan explícitamente a objetivos internos**. No son comunicables como SLA hasta completar automatización, monitoreo y drills.

Distinción que debe documentarse: con la frecuencia diaria y **retención de 14 días**, el peor caso real de pérdida de datos **no es 24 h sino 14 días**, porque un backup puede fallar en silencio sin que nadie lo detecte. El RPO solo será defendible cuando exista programación con monitoreo efectivo.

### D5. PITR entra en M25, aislado, y no se declara operativo sin ensayo real
PITR forma parte del alcance de M25 pero se ejecuta **como frente o milestone propio**, sin acoplarlo a la automatización de backups (F2) ni al destino off-host (F3), y **no se declarará operativo hasta completar un ensayo real** que restaure a un instante T y demuestre coherencia. Declarar PITR sin ese ensayo generaría confianza falsa, que es peor que un backup diario honesto.

Riesgo asumido y a mitigar: un `archive_command` que falla y no se purga acumula WAL hasta agotar el disco. Es un incidente de **disponibilidad**, no de datos, y exige monitoreo de `pg_stat_archiver` y del volumen de WAL.

### D6. Registro mediante ADR
Estas decisiones se documentan como ADR siguiendo la convención de `ADR-001-m21-1-multi-tenant-data-foundation.md`: fichero en `docs/adr/`, numeración correlativa, encabezado con **Estado**, **Fecha** y **Alcance**, y secciones `Contexto`, `Decisiones` y `Consecuencias` citando evidencia concreta del repositorio. Se mantiene la nomenclatura D0–D6 usada en el análisis M25.0 para preservar la trazabilidad entre la especificación y su formalización.

## Consecuencias

- **Brecha de seguridad activa, no resuelta por este ADR:** hasta que D2 se implemente, `scripts/ops/postgres-restore.sh` seguirá aceptando cualquier clave de longitud ≥ 32. Un restore puede pasar **todos** los criterios de M24 y ser inservible. Este ADR no reduce esa brecha; la registra y la convierte en requisito de M25.1+.
- **F1–F5 siguen sin implementar.** El orden de dependencia derivado de estas decisiones es: D0 y D1 habilitan F3 (off-host + custodia); F3 habilita F5 (runbooks de pérdida de host y de drill PITR) y F4 (PITR); F1 (SHA pinning de Actions) es independiente y puede avanzar en paralelo.
- **F5 (runbooks) debe escribirse después** de la topología que describa. El runbook actual cubre siete escenarios y **no incluye pérdida de clave de cifrado**, que es el escenario que esta arquitectura vuelve explícitamente relevante.
- **Ningún cambio de infraestructura en este ADR.** No se crea bucket, ni VM, ni almacén de secretos, ni modificación de `docker-compose.yml`; las decisiones describen el destino, no lo crean.
- **Pendientes de definición antes de F3/F4:** proveedor y región concretos, clase de almacenamiento, presupuesto de retención de WAL, y periodicidad de la verificación de las copias offline de la clave.
