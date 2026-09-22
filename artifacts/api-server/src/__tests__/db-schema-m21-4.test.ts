import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M21.4 — Tests de modelo/migración para el backfill multi-tenant y el retiro
 * transitorio de `tenant_id IS NULL` (constraint NOT NULL).
 *
 * Convención del repo (ver `db-schema-m21-1.test.ts`): sin arnés contra
 * PostgreSQL real; el SQL queda cubierto por typecheck + lectura de los
 * artefactos reales (migración SQL, snapshot y journal).
 *
 * Cubre:
 * - `0016` (backfill): organización inicial `org-bootstrap`, memberships
 *   derivados de usuarios, backfill de sources/reports/activity/findings,
 *   resolución por capas de audit_events, y `sessions.active_org_id`.
 * - `0017` (constraints): `SET NOT NULL` SOLO en sources/findings/reports/
 *   activity (audit_events y sessions permanecen nullable).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dbDir = resolve(repoRoot, "lib/db");

const journal = JSON.parse(
  readFileSync(resolve(dbDir, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string }[] };

const m216 = journal.entries.find((entry) => entry.tag.startsWith("0016_"))!;
const m217 = journal.entries.find((entry) => entry.tag.startsWith("0017_"))!;

const backfillSql = readFileSync(resolve(dbDir, "drizzle", `${m216.tag}.sql`), "utf8");
const notNullSql = readFileSync(resolve(dbDir, "drizzle", `${m217.tag}.sql`), "utf8");

const snapshot = JSON.parse(
  readFileSync(resolve(dbDir, "drizzle/meta", `${m217.tag.split("_")[0]}_snapshot.json`), "utf8"),
) as {
  tables: Record<string, { columns: Record<string, { notNull: boolean }> }>;
};

describe("M21.4 — backfill multi-tenant y tenant_id NOT NULL", () => {
  it("el journal registra 0016 (backfill) y 0017 (constraints) en orden", () => {
    expect(m216.idx).toBe(16);
    expect(m216.tag).toMatch(/^0016_/);
    expect(m217.idx).toBe(17);
    expect(m217.tag).toMatch(/^0017_/);
  });

  it("0016 crea la organización inicial org-bootstrap de forma idempotente", () => {
    expect(backfillSql).toContain("INSERT INTO \"organizations\"");
    expect(backfillSql).toContain("'org-bootstrap'");
    expect(backfillSql).toContain("ON CONFLICT (\"id\") DO NOTHING");
  });

  it("0016 deriva memberships con el mapeo de roles aprobado", () => {
    expect(backfillSql).toContain("INSERT INTO \"memberships\"");
    expect(backfillSql).toContain("'bootstrap-admin' THEN 'owner'");
    expect(backfillSql).toContain("'admin'");
    expect(backfillSql).toContain("'auditor'");
    expect(backfillSql).toContain("'member'");
    // Usuarios que ya poseen membership no reciben otra.
    expect(backfillSql).toContain("NOT EXISTS (SELECT 1 FROM \"memberships\" m WHERE m.\"user_sub\" = u.\"sub\")");
  });

  it("0016 backfillea las raíces legacy a org-bootstrap", () => {
    for (const table of ["sources", "reports", "activity"]) {
      expect(backfillSql).toContain(
        `UPDATE \"${table}\" SET \"tenant_id\" = 'org-bootstrap' WHERE \"tenant_id\" IS NULL`,
      );
    }
  });

  it("0016 backfillea findings por source válida y huérfanos a org-bootstrap", () => {
    expect(backfillSql).toContain(
      'UPDATE "findings" f SET "tenant_id" = s."tenant_id"',
    );
    expect(backfillSql).toContain(
      'UPDATE "findings" SET "tenant_id" = \'org-bootstrap\' WHERE "tenant_id" IS NULL',
    );
  });

  it("0016 resuelve audit_events por capas y respeta plataforma NULL", () => {
    // recurso → tenant del recurso
    expect(backfillSql).toContain('"resource_type" = \'source\'');
    expect(backfillSql).toContain('"resource_type" = \'report\'');
    expect(backfillSql).toContain('"resource_type" = \'scan\'');
    expect(backfillSql).toContain('"resource_type" = \'masking_job\'');
    expect(backfillSql).toContain('"resource_type" = \'schedule\'');
    expect(backfillSql).toContain('"resource_type" = \'organization\'');
    // membership/invitation → metadata.organizationId
    expect(backfillSql).toContain("\"metadata\"->>'organizationId'");
    // plataforma permanece NULL
    expect(backfillSql).toContain("'user_roles_updated'");
    expect(backfillSql).toContain("'security_violation'");
    expect(backfillSql).toContain("'rule_enabled'");
  });

  it("0016 backfillea sessions.active_org_id con la primera membership", () => {
    expect(backfillSql).toContain('UPDATE "sessions" s SET "active_org_id"');
    expect(backfillSql).toContain('ORDER BY m."joined_at" ASC, m."organization_id" ASC LIMIT 1');
  });

  it("0017 aplica SET NOT NULL solo a las 4 tablas de raíz", () => {
    for (const table of ["sources", "findings", "reports", "activity"]) {
      expect(notNullSql).toContain(
        `ALTER TABLE \"${table}\" ALTER COLUMN \"tenant_id\" SET NOT NULL`,
      );
    }
    expect(notNullSql).not.toContain('"audit_events"');
    expect(notNullSql).not.toContain('"sessions"');
  });

  it("el snapshot 0017 refleja tenant_id NOT NULL (y nullable donde corresponde)", () => {
    for (const table of ["activity", "findings", "reports", "sources"]) {
      expect(snapshot.tables[`public.${table}`].columns.tenant_id.notNull).toBe(true);
    }
    expect(snapshot.tables["public.audit_events"].columns.tenant_id.notNull).toBe(false);
    expect(snapshot.tables["public.sessions"].columns.active_org_id.notNull).toBe(false);
  });
});
