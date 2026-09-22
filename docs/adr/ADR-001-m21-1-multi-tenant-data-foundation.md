# ADR-001 — Fundación de datos multi-tenant (M21.1)

- **Estado:** Aceptado (M21.1)
- **Fecha:** 2026-09-21 (migración `0014`)
- **Alcance:** solo fundación de datos. Sin autorización multi-tenant, sin scoping en repos, sin cambios de API ni frontend (eso es M21.2/M21.3/M21.6).

## Contexto

La auditoría M21 confirmó que el sistema es single-tenant de facto: autenticación sólida y roles **globales** (`admin|auditor` en `user_roles`, embebidos en el JWT), pero **ninguna entidad de negocio tiene owner ni tenant**. La raíz de propiedad natural es `sources` (de la que derivan `scans`, `findings`, `masking_jobs`, `scan_schedules` por FK). `reports`, `rules`, `activity` y `audit_events` son raíces propias sin FK.

## Decisiones

### D1. Organizations es el boundary de tenant
`organizations` (id, name, slug, status, created_at). El `slug` es el identificador de URLs con **índice único** en BD (`organizations_slug_key`, segunda línea de defensa tras la validación de la API, mismo criterio que `users.email`). `status` se restringe con CHECK (`active | suspended`), mismo espíritu que el CHECK de `user_roles`. No se añadió `updated_at`: no existe aún ninguna operación de actualización definida (llega con la administración de M21.2).

### D2. Membership es la relación user ↔ organization
`memberships` con **PK compuesta `(organization_id, user_sub)`** — misma estrategia que `user_roles` — que garantiza a nivel BD que no exista membership duplicado por par. **El rol pertenece al membership, no al usuario**: `owner | admin | auditor | member` con CHECK. FKs reales: organización (CASCADE), usuario (CASCADE), `invited_by` (SET NULL). Índice `memberships_user_sub_idx` para listar las organizaciones de un usuario (selector M21.2/M21.6); el caso inverso queda cubierto por la PK.

### D3. Invitations incluidas como SOLO modelo de persistencia
Se incorpora `invitations` (id, organization_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at) para mantener M21.1 atómico como "foundation de datos" y dejar M21.2 centrado en la autorización. **Sin endpoints, sin envío, sin aceptación, sin UI** (eso es M21.2). `token_hash` único (lookup por hash; nunca el token en claro). El CHECK del rol del INVITE excluye `owner`: la propiedad se transfiere explícitamente, nunca se concede por invitación.

### D4. `tenant_id` asignado por relación, no indiscriminadamente
- **`sources`** — raíz de propiedad → `tenant_id` propio (FK RESTRICT a organizations: borrar una org no arrastra datos de negocio).
- **`findings`** — **denormalizado**: `source_id` es nullable con SET NULL (la evidencia histórica sobrevive a la fuente, precedido por `source_name` denormalizado), así que debe ser aislable sin join.
- **`reports`** — raíz independiente (sin FK a sources) → `tenant_id` propio.
- **`activity`** — raíz independiente (feed del dashboard) → `tenant_id` propio, derivado del recurso en el punto de inserción (M21.3).
- **`audit_events`** — `tenant_id` **sin FK** a organizations, como `actor_user_id` no tiene FK a users: la auditoría es evidencia de retención y debe sobrevivir a la entidad referenciada. Resolución en el punto de registro (actor→membership activo; sistema→tenant del recurso; plataforma→NULL reservado a platform-admin).
- **`scans`, `masking_jobs`, `scan_schedules`** — **NO reciben `tenant_id`**: derivan inequívocamente de `source` por FK CASCADE; una columna redundante sería una segunda fuente de verdad que puede divergir. El aislamiento se resuelve con join por `source_id` en M21.3.
- **`rules`** — **NO se convierte en tenant-owned**: es catálogo global de reglas de detección (GDPR/CCPA); por-org duplicaría mantenimiento sin valor MVP. Mutaciones: solo plataforma. Revisión futura si aparece demanda de reglas custom por org.
- **`sessions`** — **sin `active_org_id`**: la organización activa pertenece a M21.2 (depende del modelo de autorización). No se adelanta trabajo.
- **`rate_limit_hits`** — sin cambios (claves anti-abuso globales por diseño).

### D5. Nullable transitorio + backfill en M21.4
Todas las `tenant_id` añadidas son **NULLABLE** deliberadamente: existen filas ya persistidas y la regla de esta fase prohíbe `NOT NULL` sin backfill real. M21.4 ejecutará el backfill (users → organización inicial → memberships → recursos) y una migración posterior aplicará `SET NOT NULL`. Las tres tablas nuevas se crean completas; su población es M21.2 (bootstrap crea org + Owner).

### D6. Índices justificados, no especulativos
- `sources_tenant_id_idx (tenant_id)` — listado por org + agregaciones COUNT/SUM del dashboard.
- `findings_tenant_id_idx (tenant_id)` — listado/PATCH/countOpen por org.
- `reports_tenant_created_idx (tenant_id, created_at)` — el listado existente ya ordena `created_at DESC`.
- `activity_tenant_created_idx (tenant_id, created_at)` — feed por org, mismo orden existente.
- `audit_events_tenant_created_idx (tenant_id, created_at)` — listado por org, mismo orden existente.
- `memberships_user_sub_idx (user_sub)` — organizaciones del usuario (PK compuesta ya cubre miembros-de-org).
- `invitations_org_email_idx (organization_id, email)` + único `invitations_token_hash_key` — gestión y flujo de aceptación.
- Ninguno para scans/masking/schedules (los `source_id` existentes ya cubren los joins).

### D7. Estrategia de aislamiento prevista (no implementada en M21.1)
**Application-layer scoping como contrato primario** (M21.3: todas las queries de negocio llevan `tenant_id`; la capa `repositories` es el único punto de acceso a datos, confirmado por el mock central de tests) **+ RLS de PostgreSQL como defensa en profundidad posterior** (M21.8) sobre las tablas críticas (`sources`, `findings`, `masking_jobs`, `reports`, `audit_events`).

**Por qué RLS no entra en M21.1:** el pool de `@workspace/db` es compartido y exigiría `SET LOCAL app.tenant_id` por transacción/wrapper; además el proyecto no tiene arnés de tests contra PostgreSQL real (los tests usan mocks), por lo que las policies quedarían sin verificación efectiva. Se introduce cuando exista ese arnés.

### D8. `user_roles` NO se elimina
Los roles globales (`admin|auditor`) siguen activos hasta M21.2/M21.4: la autorización actual sigue dependiendo de ellos y el backfill (global→membership) debe diseñarse con los datos visibles. Eliminarlos ahora rompería login/`requireRole`.

### D9. Migración de usuarios existentes (estrategia, no ejecución)
M21.4 creará la organización inicial y: `bootstrap-admin` → Owner; usuarios existentes → Member (mapeo de roles: admin→Admin/Owner, auditor→Auditor); recursos existentes → organización inicial por FK/denormalización; `audit_events` de sistema por tenant del recurso, fallback org inicial. Verificación: cobertura 100 % de filas asignadas. El bootstrap legacy (`AUTH_BOOTSTRAP_ENABLED`) crea el Owner de la org inicial a partir de M21.2.

## Consecuencias
- El esquema queda preparado para M21.2 (autorización por membership), M21.3 (scoping en repos) y M21.4 (backfill + NOT NULL) sin nuevas migraciones estructurales.
- Los tests de contrato del esquema viven en `artifacts/api-server/src/__tests__/db-schema-m21-1.test.ts` (convención del repo: sin arnés contra BD).
- Sin cambios en OpenAPI/api-zod/api-client-react/frontend/rutas (ninguna dependencia estricta en esta fase).
