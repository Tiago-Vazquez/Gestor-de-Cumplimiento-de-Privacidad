import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M21.1 — Tests de modelo/migración para la fundación multi-tenant.
 *
 * El proyecto NO tiene arnés de tests contra PostgreSQL real (convención
 * establecida: el SQL queda cubierto por typecheck + verificación de los
 * constraints en la migración, ver `scan-schedules-repo.test.ts`). Estos
 * tests validan el CONTRATO del esquema leyendo los artefactos reales:
 * la migración SQL generada por drizzle-kit, su snapshot y el journal.
 *
 * Cubre: organizations (slug único + status CHECK), memberships (PK
 * compuesta anti-duplicado + FKs + roles del membership), invitations
 * (token_hash único + roles sin `owner`), tenant_id en las entidades
 * decididas por el ADR-001 (y NO en las que derivan por source), índices
 * y la ausencia de FK de auditoría (retención).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dbDir = resolve(repoRoot, "lib/db");

const journal = JSON.parse(
  readFileSync(resolve(dbDir, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string }[] };

// M21.1 queda anclada POR TAG (0014_…): el journal es append-only y M21.2
// añadió después la entrada 0015 (active_org_id); resolver "la última"
// rompería este contrato ante cada migración nueva.
const m211 = journal.entries.find((entry) => entry.tag.startsWith("0014_"))!;
const m212 = journal.entries.find((entry) => entry.tag.startsWith("0015_"));
const migrationSql = readFileSync(resolve(dbDir, "drizzle", `${m211.tag}.sql`), "utf8");
const snapshot = JSON.parse(
  readFileSync(resolve(dbDir, "drizzle/meta", `${m211.tag.split("_")[0]}_snapshot.json`), "utf8"),
) as {
  tables: Record<string, { name: string; columns: Record<string, { name: string }> }>;
};
const schemaIndex = readFileSync(resolve(dbDir, "src/schema/index.ts"), "utf8");

describe("M21.1 — migración multi-tenant (fundación de datos)", () => {
  it("la migración es la 0014 y el journal la registra como entrada nueva (append-only)", () => {
    // El journal de drizzle empieza en idx 0 (0000_…): 15 entradas para idx 0..14.
    expect(m211.idx).toBe(14);
    expect(m211.tag).toMatch(/^0014_/);
    // M21.2 añadió después la 0015 (sessions.active_org_id): append-only.
    expect(m212).toBeDefined();
    expect(m212!.idx).toBe(15);
    expect(m212!.tag).toMatch(/^0015_/);
    expect(journal.entries.length).toBeGreaterThanOrEqual(16);
    expect(journal.entries.filter((e) => e.idx === 13).map((e) => e.tag)).toEqual([
      "0013_uneven_nico_minoru",
    ]);
  });

  it("organizations: slug único y status restringido a active|suspended", () => {
    expect(migrationSql).toContain('CREATE TABLE "organizations"');
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug")',
    );
    expect(migrationSql).toContain(
      "CHECK (\"organizations\".\"status\" in ('active', 'suspended'))",
    );
  });

  it("memberships: PK compuesta anti-duplicado, FKs reales y roles del membership", () => {
    expect(migrationSql).toContain('PRIMARY KEY("organization_id","user_sub")');
    expect(migrationSql).toContain(
      "CHECK (\"memberships\".\"role\" in ('owner', 'admin', 'auditor', 'member'))",
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("user_sub") REFERENCES "public"."users"("sub") ON DELETE cascade',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("invited_by") REFERENCES "public"."users"("sub") ON DELETE set null',
    );
  });

  it("invitations: token_hash único (solo hash), roles sin owner y FKs", () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations" USING btree ("token_hash")',
    );
    // El owner NO se reparte por invitación (transferencia explícita en M21.2+).
    expect(migrationSql).toContain(
      "CHECK (\"invitations\".\"role\" in ('admin', 'auditor', 'member'))",
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk"',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_sub_fk"',
    );
  });
  it("tenant_id: presente en sources/findings/reports/activity/audit_events, NULLABLE (backfill en M21.4)", () => {
    for (const table of ["activity", "audit_events", "findings", "reports", "sources"]) {
      expect(migrationSql).toContain(`ALTER TABLE "${table}" ADD COLUMN "tenant_id" text;`);
    }
    // Ningún NOT NULL forzado antes del backfill real (regla M21.1).
    expect(migrationSql).not.toContain('"tenant_id" text NOT NULL');
    expect(migrationSql).not.toContain('"tenant_id" text DEFAULT');
  });

  it("tenant_id: derivables por source (scans/masking/schedules) NO lo reciben", () => {
    // La integridad fluye por source_id (FK CASCADE): sin columna redundante.
    for (const table of ["scans", "masking_jobs", "scan_schedules"]) {
      expect(migrationSql).not.toMatch(
        new RegExp(`ALTER TABLE "${table}" ADD COLUMN "tenant_id"`),
      );
    }
  });

  it("audit_events.tenant_id SIN FK (retención, como actor_user_id)", () => {
    const auditLine = migrationSql
      .split("--> statement-breakpoint")
      .find((line) => line.includes('ALTER TABLE "audit_events" ADD COLUMN "tenant_id"'));
    expect(auditLine).toBeDefined();
    expect(auditLine!).not.toContain("REFERENCES");
  });

  it("tenant_id con FK RESTRICT hacia organizations donde corresponde (no cascade)", () => {
    for (const table of ["activity", "findings", "reports", "sources"]) {
      expect(migrationSql).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action`,
      );
    }
  });

  it("índices nuevos justificados por el ADR-001", () => {
    const expected = [
      'CREATE INDEX "sources_tenant_id_idx" ON "sources" USING btree ("tenant_id")',
      'CREATE INDEX "findings_tenant_id_idx" ON "findings" USING btree ("tenant_id")',
      'CREATE INDEX "reports_tenant_created_idx" ON "reports" USING btree ("tenant_id","created_at")',
      'CREATE INDEX "activity_tenant_created_idx" ON "activity" USING btree ("tenant_id","created_at")',
      'CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at")',
      'CREATE INDEX "memberships_user_sub_idx" ON "memberships" USING btree ("user_sub")',
      'CREATE INDEX "invitations_org_email_idx" ON "invitations" USING btree ("organization_id","email")',
    ];
    for (const fragment of expected) {
      expect(migrationSql).toContain(fragment);
    }
  });

  it("el snapshot 0014 refleja las 3 tablas nuevas y las columnas tenant_id", () => {
    expect(snapshot.tables["public.organizations"]).toBeDefined();
    expect(snapshot.tables["public.memberships"]).toBeDefined();
    expect(snapshot.tables["public.invitations"]).toBeDefined();
    expect(snapshot.tables["public.organizations"].columns.slug).toBeDefined();
    expect(snapshot.tables["public.memberships"].columns.role).toBeDefined();
    expect(snapshot.tables["public.findings"].columns.tenant_id).toBeDefined();
    expect(snapshot.tables["public.sources"].columns.tenant_id).toBeDefined();
    // rules sigue siendo catálogo global (sin tenant_id) según ADR-001.
    expect(snapshot.tables["public.rules"].columns.tenant_id).toBeUndefined();
    // sessions sin active_org_id (decisión M21.2).
    expect(snapshot.tables["public.sessions"].columns.active_org_id).toBeUndefined();
  });

  it("schema/index.ts exporta organizations, memberships e invitations", () => {
    expect(schemaIndex).toContain('export * from "./organizations";');
    expect(schemaIndex).toContain('export * from "./memberships";');
    expect(schemaIndex).toContain('export * from "./invitations";');
  });
});