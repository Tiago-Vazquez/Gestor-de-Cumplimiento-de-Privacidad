# Demo / Presentacion

Recorrido reproducible para una demostracion comercial. **Todo lo que aparece
aqui existe en el codigo**: ninguna pantalla, endpoint ni flujo es inventado.

## 0. Preparacion (una vez)

```bash
pnpm install
cp .env.example .env          # completar POSTGRES_PASSWORD, JWT_SECRET, SOURCE_ENCRYPTION_KEY
docker compose up -d db       # o tu PostgreSQL 16 local
pnpm --filter @workspace/db run db:migrate
```

Primer administrador (idempotente):

```bash
PROVISION_ADMIN_EMAIL=admin@demo.example \
PROVISION_ADMIN_PASSWORD='<>=32 caracteres>' \
pnpm --filter @workspace/db run db:provision-admin
```

Datos de demostracion (sinteticos, opt-in). Crea un dataset empresarial con 5
organizaciones, fuentes, escaneos, hallazgos, informes y usuarios:

```bash
DEMO_SEED_CONFIRM=demo \
DEMO_USER_PASSWORD='demo-password-123456' \
pnpm run demo:seed
```

- `DEMO_SEED_CONFIRM=demo` es OBLIGATORIO (confirmacion explicita).
- `DEMO_USER_PASSWORD` (opcional): crea los usuarios demo con esa contrasena
  (sintetica; si se omite, no se crean usuarios).
- `DEMO_INCLUDE_RUNNING_SCAN=true` (opcional): anade un scan `running` para
  mostrar el estado "escaneando" del dashboard.

El seed **aborta** (antes de tocar la base) si `NODE_ENV=production`, si la URL
no es local (localhost/127.0.0.1) o si falta `DEMO_SEED_CONFIRM=demo`. Es
**idempotente** (IDs deterministas + `ON CONFLICT DO NOTHING`) y **no borra**
nada. Escribe en la MISMA base local de la aplicacion (no en una BD demo
separada). Ver `scripts/demo/seed-demo-data.mjs`.

Smoke test automatizado (valida las invariantes; requiere PostgreSQL local ya
migrado):

```bash
SMOKE_DATABASE_URL='postgresql://privacy:...@localhost:5432/privacy' \
node scripts/ci/demo-seed-smoke.mjs
```

## 1. Iniciar la aplicacion

```bash
docker compose up -d
curl -s http://localhost:5000/api/readyz     # debe responder 200
```

Web en `http://localhost:8080` (o `http://localhost:5173` en dev con Vite).

## 2. Entrar

Pantalla `/login`. Use las credenciales del `provision-admin`. Tenga en cuenta el
rate limiter: 5 intentos por email cada 15 minutos.

## 3. Organizacion

La sesion queda fijada a una organizacion (`org-context`). El dataset demo crea
5 organizaciones; el usuario **presentador** (`demo-presenter@demo.example.invalid`)
pertenece a las 5 y puede recorrerlas con el selector de la cabecera. Los
usuarios operativos (`*-ops@` y `*-auditor@`) pertenecen a UNA sola y demuestran
el aislamiento. **Todo lo que ve a continuacion esta acotado a la organizacion
activa por RLS.**

## 4. Dashboard (`/`)

Metricas agregadas: fuentes monitorizadas, hallazgos por severidad, cobertura de
escaneo, y la tarjeta "Puntuacion".

> **Importante para la demo**: la puntuacion de cumplimiento usa la politica
> **ponderada por severidad** de `ADR-004` (`low`=1, `medium`=3, `high`=7,
> `critical`=15): un score entero de `0` a `100`, no un porcentaje legal ni una
> certificacion; la UI lo muestra como `score / 100`. Ver `docs/adr/ADR-004`.

## 5. Fuentes (`/sources`)

Listado de fuentes de datos. Para anadir una real hacen falta credenciales de
una base de prueba propia: la demo usa una fuente **sin conexion**
(`scannable = false`). Los conectores disponibles son **PostgreSQL** y **MySQL**.

Para un scan real necesita una base PostgreSQL o MySQL de prueba a la que la
demo pueda conectarse. Sin ella, muestre el resto del flujo con los datos
sinteticos.

## 6. Escaneos (`/scans`)

Historial de ejecuciones. Filtros por estado (Todos / En cola / En curso /
Completados / Fallidos), refresco, y detalle por escaneo con cancelacion
cooperativa (solo admin y solo si el escaneo esta en curso).

## 7. Findings (`/findings`)

Detalle de cada hallazgo: tipo de dato, ubicacion, severidad, huella estable y
origen. Desde aqui se cambia el estado a `resolved`.

## 8. Reglas (`/rules`)

Reglas de compliance configuradas para la organizacion.

## 9. Masking / anonimizacion (`/masking`)

Job de anonimizacion sobre una fuente. El POST se ejecuta de forma **sincrona**:
al responder, el job ya esta `ready` o `failed`; despues se descarga el dataset.

## 10. Reportes y compliance (`/reports`, `/compliance`)

Informes periodicos y resumen de cumplimiento, con la misma puntuacion ponderada
por severidad (ADR-004).

## 11. Usuarios (`/users`)

Gestion de identidades locales y roles `admin` / `auditor`. Visible solo para
admin. El servidor impide retirar el rol admin al ultimo administrador y a uno
mismo; la UI lo deshabilita.

## 12. Auditoria (`/audit`)

Trail de auditoria: actor, accion, recurso, resultado y requestId. Buen momento
para mostrar la trazabilidad.

## 13. Controles de seguridad a mostrar

| Que mostrar | Donde |
| --- | --- |
| Aislamiento por organizacion | Cambiar de org y comprobar que no hay datos cruzados |
| Sesiones revocables | `/sessions`, revocar y comprobar que el token deja de servir |
| Cabecera CSRF en mutaciones | DevTools, peticiones `POST/PATCH/DELETE` |
| CORS fail-closed | Sin `CORS_ORIGINS` no se emiten headers CORS |
| Credenciales cifradas | `/sources` -> editar: la config no se devuelve en claro |
| Trazabilidad | `/audit` |
| Gates de CI | Badge del workflow: 3 jobs verdes |

## Reiniciar la demo

El seed es idempotente: volver a ejecutarlo repone los datos sinteticos sin
duplicar (verificable con `node scripts/ci/demo-seed-smoke.mjs`). Para empezar
de cero, recree el volumen de PostgreSQL y vuelva a aplicar migraciones y seed.

## Limitaciones que conviene decir en voz alta

- La puntuacion de cumplimiento usa una **politica aprobada** (`ADR-004`),
  ponderada por severidad. Mide hallazgos abiertos, no es una certificacion.
- Los **informes** no filtran por `period` todavia: el `content` (y por tanto el
  PDF) refleja los hallazgos abiertos actuales al generar el informe, sin importar
  el periodo seleccionado (`period` es una etiqueta). Los PDF se descargan desde
  `/reports` con el boton "Descargar PDF" y se generan con el endpoint real de Fase 1.
- No hay MFA ni recuperacion de contrasena.
- El backup tiene **disparador programado y mecanismo de alertas implementados**,
  pero **no estan desplegados**: la cadencia (`backup-schedule.timer`) es una
  plantilla que instalar en el VPS, asi que hoy **ningun entorno proporcionado por
  este repositorio ejecuta el backup de forma programada** y se lanza a mano. Tampoco
  hay canal de alertas: sin un `ALERT_CMD` configurado en un servidor real,
  nadie recibe avisos.
- El DR drill valida preservacion de datos en local, **no** recuperacion ante
  perdida de la maquina.

Ver `docs/security-overview.md` para el detalle.