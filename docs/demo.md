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

Datos de demostracion (sinteticos, opt-in):

```bash
DEMO_SEED_CONFIRM=demo pnpm run demo:seed
```

> El seed **aborta** salvo que seDEN: `NODE_ENV=production`, la base no sea local
> y falte `DEMO_SEED_CONFIRM=demo`. Ver `scripts/demo/seed-demo-data.mjs`.

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

La sesion queda fijada a una organizacion (`org-context`). Si su usuario
pertenece a varias, elija en el selector de la cabecera. **Todo lo que ve a
continuacion esta acotado a esa organizacion por RLS.**

## 4. Dashboard (`/`)

Metricas agregadas: fuentes monitorizadas, hallazgos por severidad, cobertura de
escaneo, y la tarjeta "Puntuacion".

> **Importante para la demo**: la puntuacion de cumplimiento usa una politica
> **provisional** (100 con cero hallazgos abiertos, 0 en cuanto hay uno). No es un
> porcentaje legal de cumplimiento. Ver `docs/adr/ADR-004`.

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

Informes periodicos y resumen de cumplimiento. Misma puntuacion provisional.

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
duplicar. Para empezar de cero, recree el volumen de PostgreSQL y vuelva a
aplicar migraciones y seed.

## Limitaciones que conviene decir en voz alta

- La puntuacion de cumplimiento usa una **politica aprobada** (`ADR-004`),
  ponderada por severidad. Mide hallazgos abiertos, no es una certificacion.
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