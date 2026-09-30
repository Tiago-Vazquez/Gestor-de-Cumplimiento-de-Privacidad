-- ============================================================================
-- M21.9 (FASE 5) — RLS multi-tenant: roles, grants y políticas de aislamiento.
--
-- Arquitectura de privilegios:
--   * HTTP/API            → app_role  (NOSUPERUSER, NOBYPASSRLS, sujeto a RLS)
--   * trusted/background  → bg_role   (NOSUPERUSER, BYPASSRLS)
--   * migraciones/admin   → privacy   (owner/superuser; NO usado por la API HTTP)
--
-- Idempotente: roles vía DO (IF NOT EXISTS), atributos re-afirmados con
-- ALTER ROLE, políticas vía DROP POLICY IF EXISTS + CREATE POLICY.
--
-- ROLLBACK (manual, orden inverso):
--   DROP POLICY IF EXISTS <x>_tenant_isolation ON <x>;  -- 7 tablas
--   ALTER TABLE <x> NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE <x> DISABLE ROW LEVEL SECURITY;
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_role, bg_role;
--   DROP ROLE IF EXISTS app_role; DROP ROLE IF EXISTS bg_role;
-- ============================================================================

-- 1. Roles -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bg_role') THEN
    CREATE ROLE bg_role LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

ALTER ROLE app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE bg_role NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
--> statement-breakpoint
-- Contraseñas DEV-ONLY (idénticas a los defaults de docker-compose). En
-- producción: `ALTER ROLE ... PASSWORD '<secreto>'` + setear el env real.
ALTER ROLE app_role PASSWORD 'app-role-dev-only';
--> statement-breakpoint
ALTER ROLE bg_role PASSWORD 'bg-role-dev-only';
--> statement-breakpoint

-- 2. Grants bg_role (inventario exacto de Fase 4; sin DELETE, sin ownership) -
GRANT USAGE ON SCHEMA public TO bg_role;
--> statement-breakpoint
GRANT SELECT, UPDATE          ON sources        TO bg_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE  ON findings       TO bg_role;
--> statement-breakpoint
GRANT SELECT, UPDATE          ON rules          TO bg_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE  ON scans          TO bg_role;
--> statement-breakpoint
GRANT INSERT                  ON activity       TO bg_role;
--> statement-breakpoint
GRANT SELECT, UPDATE          ON scan_schedules TO bg_role;
--> statement-breakpoint

-- 3. Grants app_role (operaciones HTTP; en tablas tenant queda sujeto a RLS) -
GRANT USAGE ON SCHEMA public TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sources        TO app_role;
--> statement-breakpoint
GRANT SELECT, UPDATE                 ON findings       TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT                 ON reports        TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT                 ON activity       TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE         ON scans          TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE         ON scan_schedules TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT                 ON masking_jobs   TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT                 ON organizations  TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE         ON users          TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE         ON user_roles     TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships    TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations    TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions       TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_hits TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT                 ON audit_events   TO app_role;
--> statement-breakpoint
GRANT SELECT, UPDATE                 ON rules          TO app_role;
--> statement-breakpoint

-- 4. RLS: ENABLE + FORCE -----------------------------------------------------
ALTER TABLE sources        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE findings       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reports        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scans          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE masking_jobs   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sources        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE findings       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reports        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activity       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scans          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scan_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE masking_jobs   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- 5. Policies directas (tablas con tenant_id propio) -------------------------
-- SELECT/UPDATE/DELETE → USING; INSERT → WITH CHECK. Un único policy cubre
-- todos los comandos; fail-closed: `current_setting(..., true)` devuelve NULL
-- si el contexto no está fijado, y `tenant_id = NULL` no matchea ninguna fila.
DROP POLICY IF EXISTS sources_tenant_isolation ON sources;
CREATE POLICY sources_tenant_isolation ON sources
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

DROP POLICY IF EXISTS findings_tenant_isolation ON findings;
CREATE POLICY findings_tenant_isolation ON findings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

DROP POLICY IF EXISTS reports_tenant_isolation ON reports;
CREATE POLICY reports_tenant_isolation ON reports
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

DROP POLICY IF EXISTS activity_tenant_isolation ON activity;
CREATE POLICY activity_tenant_isolation ON activity
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- 6. Policies heredadas (pertenencia derivada de `sources` vía source_id) -----
-- El subquery EXISTS se evalúa como `app_role`, por lo que queda sujeto al RLS
-- de `sources` (que exige `tenant_id = current_setting`). Ambas restricciones
-- son coherentes (refuerzan el mismo predicado), de modo que una fila solo es
-- visible/modificable cuando SU fuente pertenece al tenant activo. No hay
-- recursión (la policy de `sources` es un predicado simple, sin subquery).
DROP POLICY IF EXISTS scans_tenant_isolation ON scans;
CREATE POLICY scans_tenant_isolation ON scans
  USING (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS scan_schedules_tenant_isolation ON scan_schedules;
CREATE POLICY scan_schedules_tenant_isolation ON scan_schedules
  USING (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS masking_jobs_tenant_isolation ON masking_jobs;
CREATE POLICY masking_jobs_tenant_isolation ON masking_jobs
  USING (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_id
        AND s.tenant_id = current_setting('app.tenant_id', true)
    )
  );

