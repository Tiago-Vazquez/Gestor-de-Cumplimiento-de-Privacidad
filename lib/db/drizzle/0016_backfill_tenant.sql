-- M21.4 — Backfill de datos legacy multi-tenant (ADR-001 D5/D9).
-- Idempotente: centinela `tenant_id IS NULL` + `ON CONFLICT DO NOTHING`.
-- Se ejecuta en UNA transacción (drizzle-kit migrate); fallo = rollback total.

-- 1. Organización inicial (id determinístico; converge con ensureBootstrapOrganization)
INSERT INTO "organizations" ("id", "name", "slug", "status", "created_at")
VALUES ('org-bootstrap', 'Bootstrap Organization', 'bootstrap', 'active', now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- 2. Memberships: usuarios SIN membership → org-bootstrap (mapeo de roles aprobado)
INSERT INTO "memberships" ("organization_id", "user_sub", "role", "invited_by", "joined_at")
SELECT 'org-bootstrap',
       u."sub",
       CASE
         WHEN u."sub" = 'bootstrap-admin' THEN 'owner'
         WHEN EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_sub" = u."sub" AND ur."role" = 'admin') THEN 'admin'
         WHEN EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_sub" = u."sub" AND ur."role" = 'auditor') THEN 'auditor'
         ELSE 'member'
       END,
       NULL,
       u."created_at"
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_sub" = u."sub")
ON CONFLICT ("organization_id", "user_sub") DO NOTHING;
--> statement-breakpoint

-- 3. sources (raíz de propiedad) → org inicial
UPDATE "sources" SET "tenant_id" = 'org-bootstrap' WHERE "tenant_id" IS NULL;
--> statement-breakpoint

-- 4. reports (raíz independiente) → org inicial
UPDATE "reports" SET "tenant_id" = 'org-bootstrap' WHERE "tenant_id" IS NULL;
--> statement-breakpoint

-- 5. activity (sin referencia a recurso) → org inicial
UPDATE "activity" SET "tenant_id" = 'org-bootstrap' WHERE "tenant_id" IS NULL;
--> statement-breakpoint

-- 6. findings: fuente válida primero, huérfanos después
UPDATE "findings" f SET "tenant_id" = s."tenant_id"
FROM "sources" s
WHERE f."tenant_id" IS NULL AND f."source_id" = s."id" AND s."tenant_id" IS NOT NULL;
--> statement-breakpoint

UPDATE "findings" SET "tenant_id" = 'org-bootstrap' WHERE "tenant_id" IS NULL;
--> statement-breakpoint

-- 7. audit_events (por capas, determinista)
-- 7a. source → sources.tenant_id
UPDATE "audit_events" ae SET "tenant_id" = s."tenant_id"
FROM "sources" s
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'source' AND ae."resource_id" = s."id";
--> statement-breakpoint

-- 7b. report → reports.tenant_id
UPDATE "audit_events" ae SET "tenant_id" = r."tenant_id"
FROM "reports" r
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'report' AND ae."resource_id" = r."id";
--> statement-breakpoint

-- 7c. scan → scans.source_id → source tenant
UPDATE "audit_events" ae SET "tenant_id" = s."tenant_id"
FROM "scans" sc JOIN "sources" s ON sc."source_id" = s."id"
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'scan' AND ae."resource_id" = sc."id";
--> statement-breakpoint

-- 7d. masking_job → masking_jobs.source_id → source tenant
UPDATE "audit_events" ae SET "tenant_id" = s."tenant_id"
FROM "masking_jobs" mj JOIN "sources" s ON mj."source_id" = s."id"
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'masking_job' AND ae."resource_id" = mj."id";
--> statement-breakpoint

-- 7e. schedule → resource_id ES el id de la source
UPDATE "audit_events" ae SET "tenant_id" = s."tenant_id"
FROM "sources" s
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'schedule' AND ae."resource_id" = s."id";
--> statement-breakpoint

-- 7f. organization → resource_id ES el id de la organización
UPDATE "audit_events" ae SET "tenant_id" = ae."resource_id"
WHERE ae."tenant_id" IS NULL AND ae."resource_type" = 'organization'
  AND ae."resource_id" IN (SELECT "id" FROM "organizations");
--> statement-breakpoint

-- 7g. membership / invitation → organización desde metadata.organizationId
UPDATE "audit_events" ae SET "tenant_id" = ae."metadata"->>'organizationId'
WHERE ae."tenant_id" IS NULL
  AND ae."resource_type" IN ('membership','invitation')
  AND ae."metadata"->>'organizationId' IS NOT NULL;
--> statement-breakpoint

-- 7h. session / user → primera membership del actor (excluyendo plataforma)
UPDATE "audit_events" ae SET "tenant_id" = first_org."org_id"
FROM (
  SELECT DISTINCT ON (m."user_sub") m."user_sub", m."organization_id" AS "org_id"
  FROM "memberships" m
  ORDER BY m."user_sub", m."joined_at" ASC, m."organization_id" ASC
) first_org
WHERE ae."tenant_id" IS NULL
  AND ae."resource_type" IN ('session','user')
  AND ae."actor_user_id" = first_org."user_sub"
  AND NOT (ae."resource_type" = 'user'   AND ae."action" = 'user_roles_updated')
  AND NOT (ae."resource_type" = 'session' AND ae."action" = 'security_violation');
--> statement-breakpoint

-- 7i. rule / plataforma → permanecen NULL (no se tocan)

-- 7j. fallback: restantes NULL atribuibles → org inicial (plataforma queda NULL)
UPDATE "audit_events" ae SET "tenant_id" = 'org-bootstrap'
WHERE ae."tenant_id" IS NULL
  AND ae."action" NOT IN ('rule_enabled','rule_disabled','user_roles_updated','security_violation');
--> statement-breakpoint

-- 8. sessions: primera membership determinista (joined_at ASC, organization_id ASC)
UPDATE "sessions" s SET "active_org_id" = (
  SELECT m."organization_id" FROM "memberships" m
  WHERE m."user_sub" = s."user_sub"
  ORDER BY m."joined_at" ASC, m."organization_id" ASC LIMIT 1
) WHERE s."active_org_id" IS NULL;
--> statement-breakpoint

-- 9. sesiones con active_org_id huérfano → primera membership válida (o NULL)
UPDATE "sessions" s SET "active_org_id" = (
  SELECT m."organization_id" FROM "memberships" m
  WHERE m."user_sub" = s."user_sub"
  ORDER BY m."joined_at" ASC, m."organization_id" ASC LIMIT 1
) WHERE s."active_org_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "memberships" m2
    WHERE m2."user_sub" = s."user_sub" AND m2."organization_id" = s."active_org_id"
  );
