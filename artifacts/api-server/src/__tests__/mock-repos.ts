import type {
  Activity,
  AuditEvent,
  Finding,
  Invitation,
  MaskingJob,
  Membership,
  Organization,
  Report,
  Rule,
  Scan,
  ScanSchedule,
  Source,
  User,
  UserRole,
  Session,
} from "@workspace/db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { decodeJwt } from "jose";
import {
  MASKABLE_FIELDS,
  deriveMaskerKey,
  maskValue,
  type MaskableField,
} from "../lib/masker";
import {
  MAX_MASKING_DATASET_BYTES,
  MAX_MASKING_RECORDS,
} from "../lib/masking-limits";
import { computeComplianceScore } from "../repositories/compliance-score";
import { buildTrendDayKeys, buildTrendPoints } from "../lib/trend-buckets";

/**
 * Stub in-memory de la capa de repositorios para los tests HTTP.
 *
 * Reproduce el comportamiento de los repositorios reales (incluidas sus
 * transacciones lógicas) contra arrays controlados, de modo que los tests
 * de la API nunca necesitan PostgreSQL. Los timestamps son objetos `Date`,
 * igual que las filas que devuelve Drizzle.
 *
 * Nada de esto toca la base de datos real: `vi.mock("../repositories")` en
 * cada suite sustituye el módulo completo antes de que `app` se cargue, por
 * lo que `@workspace/db` ni siquiera llega a importarse.
 */

/**
 * M21.1/M21.2 — columnas de tenancy (`tenant_id` en las tablas de negocio) y
 * contexto de sesión (`active_org_id`) añadidas con backfill TRANSITORIO
 * (asignación real en M21.4). En el mock quedan OPCIONALES: las filas demo y
 * las creadas por los tests no necesitan declararlas (equivale a NULL).
 */
type MockRow<T> = Omit<T, "tenantId"> & { tenantId?: string | null };
type MockSession = Omit<Session, "activeOrgId"> & { activeOrgId?: string | null };

export type MockState = {
  users: User[];
  userRoles: UserRole[];
  scanSchedules: ScanSchedule[];
  sessions: MockSession[];
  findings: MockRow<Finding>[];
  sources: (MockRow<Source> & { findingsCount: number })[];
  rules: Rule[];
  scans: MockRow<Scan>[];
  activity: MockRow<Activity>[];
  reports: MockRow<Report>[];
  /** M17: se inicializa vacío en createMockRepos. */
  auditEvents: MockRow<AuditEvent>[];
  /** M5.c: se inicializa perezosamente en createMockRepos. */
  maskingJobs?: MockRow<MaskingJob>[];
  /** M18: filas de rate_limit_hits para el store persistente mock. */
  rateLimitHits?: MockRateLimitHit[];
  /** M21.2: organizaciones, memberships e invitaciones (inicialización perezosa). */
  organizations?: Organization[];
  memberships?: Membership[];
  invitations?: Invitation[];
};

/** Fila mock de `rate_limit_hits` (M18 Fase 2). */
export interface MockRateLimitHit {
  key: string;
  hits: number;
  windowStartAt: Date;
  expiresAt: Date;
}

const SOURCE_NAMES: Record<string, string> = {
  "src-001": "Customer PostgreSQL",
  "src-002": "Analytics Warehouse",
  "src-003": "CRM MySQL",
  "src-004": "Payments PostgreSQL",
};

/**
 * Espejo EXACTO de la definición canónica de "finding activo" (D8;
 * `activeFindingsWhere()` en findings.repo): `status <> 'resolved'` AND
 * `superseded = false`. Único lugar en el mock para que los tres
 * consumidores (findings.countOpen, reports.create, dashboard) no diverjan.
 */
function isActiveFinding(finding: MockRow<Finding>): boolean {
  return finding.status !== "resolved" && finding.superseded === false;
}

/**
 * M21.5 — visibilidad ESTRICTA de una fila para la organización activa: visible
 * SOLO si `tenant_id` coincide exactamente con el contexto. Sin contexto
 * (`orgId` undefined) no hay scoping (espejo del repo real, que solo aplica el
 * predicado cuando `tenantId` viene definido). El fail-closed vive en la ruta.
 */
function tenantVisible(
  rowTenantId: string | null | undefined,
  orgId: string | undefined,
): boolean {
  if (orgId === undefined) return true;
  return rowTenantId === orgId;
}

// ---- FASE 7.3 (M5.c): espejo in-memory de masking.repo ----
// Réplica EXACTA de la semántica del repo real: validación de campos contra
// MASKABLE_FIELDS, 404 de fuente inexistente, job `failed` auditable sin
// dataset (nunca persistencia parcial), límites 1000 filas / ~2 MB, uso del
// masker REAL (M5.b) y actividad `masking` solo en éxito.
let maskingMockSeq = 0;

function stripDataset<T extends { dataset?: unknown }>(job: T): Omit<T, "dataset"> {
  const { dataset: _dataset, ...rest } = job;
  return rest;
}

function createMockMaskingRepos(state: MockState) {
  const jobs = () => (state.maskingJobs ??= []);
  const RAW_VALUES: Record<MaskableField, (i: number) => string> = {
    email: (i) => `user${i}@demo.com`,
    phone: (i) => `+54 9 11 5555 ${String(1000 + i).slice(-4)}`,
    national_id: (i) => `27.442.918-${i % 10}`,
    credit_card: (i) => `4539 0213 4567 ${String(8000 + (i % 10000)).padStart(4, "0")}`,
  };

  return {
    async list(pagination?: { limit: number; offset: number }, tenantId?: string) {
      const sorted = [...jobs()]
        .filter((job) => {
          if (tenantId === undefined) return true;
          const source = state.sources.find((s) => s.id === job.sourceId);
          return tenantVisible(source?.tenantId, tenantId);
        })
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        );
      const page = pagination
        ? sorted.slice(pagination.offset, pagination.offset + pagination.limit)
        : sorted;
      return page.map(stripDataset);
    },

    async getById(id: string, tenantId?: string) {
      const job = jobs().find((j) => j.id === id);
      if (!job) return null;
      if (tenantId !== undefined) {
        const source = state.sources.find((s) => s.id === job.sourceId);
        if (!tenantVisible(source?.tenantId, tenantId)) return null;
      }
      return stripDataset(job);
    },

    /** Única vía de salida del dataset (usada por /download). */
    async getByIdWithDataset(id: string, tenantId?: string) {
      const job = jobs().find((j) => j.id === id);
      if (!job) return null;
      if (tenantId !== undefined) {
        const source = state.sources.find((s) => s.id === job.sourceId);
        if (!tenantVisible(source?.tenantId, tenantId)) return null;
      }
      return { ...job };
    },

    async create(input: { sourceId: string; fields: string[]; at: Date; tenantId?: string }) {
      const unique = [...new Set(input.fields)];
      if (unique.length === 0) throw badRequest("At least one field is required");
      const unsupported = unique.filter(
        (f) => !(MASKABLE_FIELDS as readonly string[]).includes(f),
      );
      if (unsupported.length > 0) {
        throw badRequest(`Unsupported masking fields: ${unsupported.join(", ")}`);
      }
      const source = state.sources.find(
        (s) => s.id === input.sourceId && tenantVisible(s.tenantId, input.tenantId),
      );
      if (!source) throw notFound("Source not found");

      const completedAt = new Date(input.at.getTime() + 1);
      const base = {
        id: `mj-mock-${++maskingMockSeq}`,
        sourceId: input.sourceId,
        fields: unique,
        createdAt: input.at,
        completedAt,
      };
      const failWith = (error: string) => {
        const row = { ...base, status: "failed" as const, records: 0, error, dataset: null };
        jobs().push(row);
        return { ...row };
      };

      // Centinelas de fallo controlados por los tests (mismos códigos que el
      // repo real clasifica).
      if (source.name === "Unreachable PostgreSQL") return failWith("source_unreachable");
      if (!source.connectionConfig) return failWith("source_not_configured");
      if (source.name === "Oversized PostgreSQL") {
        const dataset = {
          fields: unique,
          rows: [{ [unique[0]!]: "x".repeat(MAX_MASKING_DATASET_BYTES + 1) }],
        };
        if (Buffer.byteLength(JSON.stringify(dataset), "utf8") > MAX_MASKING_DATASET_BYTES) {
          return failWith("dataset_too_large");
        }
      }

      const key = deriveMaskerKey("mock-master-key");
      const count = Math.min(source.records ?? 0, MAX_MASKING_RECORDS);
      const rows = Array.from({ length: count }, (_, i) =>
        Object.fromEntries(
          unique.map((t) => [
            t,
            maskValue(RAW_VALUES[t as MaskableField]!(i), t as MaskableField, key),
          ]),
        ),
      );
      const row = {
        ...base,
        status: "ready" as const,
        records: count,
        error: null,
        dataset: { fields: unique, rows },
      };
      jobs().push(row);
      // Actividad SOLO en éxito (igual que el repo real).
      state.activity.unshift({
        id: `a-mock-${++maskingMockSeq}`,
        type: "masking",
        title: "Datos anonimizados",
        description: `${count} registros preparados para testing`,
        createdAt: completedAt,
        severity: null,
      });
      return { ...row };
    },
  };
}

export function createMockRepos() {
  const boot = new Date();
  const minutesAgo = (minutes: number) => new Date(boot.getTime() - minutes * 60_000);

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-mock-${++counter}`;

  /**
   * M21.2 — revoca TODAS las sesiones activas del usuario y limpia su contexto
   * activo para la organización dada (equivale in-tx a
   * revokeAllSessionsForUserTx + clearActiveOrgForOrgTx del repo real).
   */
  function revokeUserSessions(userSub: string, organizationId: string): number {
    let revoked = 0;
    for (const session of state.sessions) {
      if (session.userSub === userSub && session.revokedAt === null) {
        session.revokedAt = new Date();
        revoked += 1;
      }
    }
    for (const session of state.sessions) {
      if (session.userSub === userSub && session.activeOrgId === organizationId) {
        session.activeOrgId = null;
      }
    }
    return revoked;
  }

  const state: MockState = {
    users: [],
    userRoles: [],
  sessions: [],
  scanSchedules: [],
    findings: [
      { id: "f-001", title: "Emails de clientes sin cifrado", dataType: "email", sourceId: "src-001", sourceName: SOURCE_NAMES["src-001"], location: "public.customers.email", severity: "critical", status: "open", records: 12843, detectedAt: minutesAgo(12), regulation: "GDPR Art. 32", recommendation: "Cifrar la columna y restringir el acceso.", sample: "m••••••@empresa.com", createdAt: minutesAgo(12), updatedAt: minutesAgo(12), scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null, superseded: false },
      { id: "f-002", title: "Documento nacional en staging", dataType: "national_id", sourceId: "src-002", sourceName: SOURCE_NAMES["src-002"], location: "staging.user_profiles.national_id", severity: "high", status: "in_review", records: 4521, detectedAt: minutesAgo(38), regulation: "LGPD Art. 46", recommendation: "Tokenizar en cada refresh.", sample: "27.•••.•••-•", createdAt: minutesAgo(38), updatedAt: minutesAgo(38), scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null, superseded: false },
      { id: "f-003", title: "Teléfonos visibles en exportación", dataType: "phone", sourceId: "src-003", sourceName: SOURCE_NAMES["src-003"], location: "crm.contacts.phone", severity: "medium", status: "open", records: 2187, detectedAt: minutesAgo(74), regulation: "CCPA §1798.100", recommendation: "Enmascarar últimos cuatro dígitos.", sample: "+54 9 11 •••• 4821", createdAt: minutesAgo(74), updatedAt: minutesAgo(74), scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null, superseded: false },
      { id: "f-004", title: "Direcciones residenciales detectadas", dataType: "address", sourceId: "src-001", sourceName: SOURCE_NAMES["src-001"], location: "public.shipping_addresses.full_address", severity: "low", status: "resolved", records: 864, detectedAt: minutesAgo(120), regulation: "GDPR Art. 5", recommendation: "Mantener solo ciudad y CP.", sample: "Av. del L•••• 120", createdAt: minutesAgo(120), updatedAt: minutesAgo(120), scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null, superseded: false },
      { id: "f-005", title: "Tarjetas almacenadas en logs", dataType: "credit_card", sourceId: "src-004", sourceName: SOURCE_NAMES["src-004"], location: "logs.checkout.payload", severity: "critical", status: "open", records: 91, detectedAt: minutesAgo(186), regulation: "PCI DSS 3.4", recommendation: "Redactar payloads históricos.", sample: "•••• •••• •••• 4242", createdAt: minutesAgo(186), updatedAt: minutesAgo(186), scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null, superseded: false },
    ],
    sources: [
      { id: "src-001", name: SOURCE_NAMES["src-001"], kind: "postgresql", environment: "production", status: "healthy", lastScanAt: minutesAgo(12), tables: 48, records: 284_210, createdAt: minutesAgo(500), updatedAt: minutesAgo(12), findingsCount: 2, connectionConfig: null },
      { id: "src-002", name: SOURCE_NAMES["src-002"], kind: "snowflake", environment: "staging", status: "warning", lastScanAt: minutesAgo(38), tables: 126, records: 1_840_400, createdAt: minutesAgo(500), updatedAt: minutesAgo(38), findingsCount: 1, connectionConfig: null },
      { id: "src-003", name: SOURCE_NAMES["src-003"], kind: "mysql", environment: "production", status: "healthy", lastScanAt: minutesAgo(74), tables: 32, records: 98_321, createdAt: minutesAgo(500), updatedAt: minutesAgo(74), findingsCount: 1, connectionConfig: null },
      { id: "src-004", name: SOURCE_NAMES["src-004"], kind: "postgresql", environment: "production", status: "healthy", lastScanAt: minutesAgo(186), tables: 17, records: 61_550, createdAt: minutesAgo(500), updatedAt: minutesAgo(186), findingsCount: 1, connectionConfig: null },
    ],
    rules: [
      { id: "rule-001", name: "Email personal", category: "Identidad", regulation: "GDPR", enabled: true, detections: 12_843, lastTriggered: minutesAgo(12), createdAt: minutesAgo(500), updatedAt: minutesAgo(12) },
      { id: "rule-002", name: "Documento nacional", category: "Identidad", regulation: "LGPD", enabled: true, detections: 4_521, lastTriggered: minutesAgo(38), createdAt: minutesAgo(500), updatedAt: minutesAgo(38) },
      { id: "rule-003", name: "Tarjeta de crédito", category: "Finanzas", regulation: "PCI DSS", enabled: true, detections: 91, lastTriggered: minutesAgo(186), createdAt: minutesAgo(500), updatedAt: minutesAgo(186) },
      { id: "rule-004", name: "Teléfono", category: "Contacto", regulation: "CCPA", enabled: true, detections: 2_187, lastTriggered: minutesAgo(74), createdAt: minutesAgo(500), updatedAt: minutesAgo(74) },
      { id: "rule-005", name: "Datos de salud", category: "Salud", regulation: "HIPAA", enabled: false, detections: 0, lastTriggered: null, createdAt: minutesAgo(500), updatedAt: minutesAgo(500) },
    ],
    scans: [],
    activity: [
      { id: "a-001", type: "finding", title: "Nuevo hallazgo crítico", description: "Tarjetas almacenadas en logs de checkout", createdAt: minutesAgo(6), severity: "critical" },
      { id: "a-002", type: "scan", title: "Escaneo completado", description: "Customer PostgreSQL · 48 tablas revisadas", createdAt: minutesAgo(12), severity: null },
      { id: "a-003", type: "masking", title: "Datos anonimizados", description: "4.521 registros preparados para staging", createdAt: minutesAgo(32), severity: null },
      { id: "a-004", type: "report", title: "Informe mensual listo", description: "Auditoría de cumplimiento", createdAt: minutesAgo(86), severity: null },
      { id: "a-005", type: "system", title: "Regla actualizada", description: "Se activó la detección de documentos nacionales", createdAt: minutesAgo(145), severity: null },
    ],
    reports: [
      { id: "r-001", name: "Auditoría mensual", period: "last_30d", status: "ready", createdAt: minutesAgo(86), findings: 12, complianceScore: 90, format: "pdf" },
      { id: "r-002", name: "Revisión trimestral", period: "quarter", status: "ready", createdAt: minutesAgo(1820), findings: 40, complianceScore: 88, format: "pdf" },
    ],
    auditEvents: [],
  };

  // M21.5 — los datos demo (legacy, sin tenant) se sellean con la organización
  // canónica del backfill (org-bootstrap) para que el scoping estricto los haga
  // visibles a los tests (cuyo contexto sintético/de bootstrap es org-bootstrap).
  for (const row of state.findings) row.tenantId ??= "org-bootstrap";
  for (const row of state.sources) row.tenantId ??= "org-bootstrap";
  for (const row of state.activity) row.tenantId ??= "org-bootstrap";
  for (const row of state.reports) row.tenantId ??= "org-bootstrap";

  const repos = {
    sources: {
      async list(
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
        tenantId?: string,
      ) {
        return state.sources
          .filter((source) => tenantVisible(source.tenantId, tenantId))
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((source) => ({ ...source }));
      },
      async getById(id: string, tenantId?: string) {
        return (
          state.sources.find(
            (source) => source.id === id && tenantVisible(source.tenantId, tenantId),
          ) ?? null
        );
      },
      // M21.7 — flujo interno (scanner): lectura SIN scoping de tenant.
      async getByIdForScan(id: string) {
        return state.sources.find((source) => source.id === id) ?? null;
      },
      // FASE 7.0.5 (M1): réplica del repo real — devuelve la fuente con su
      // conteo real de hallazgos. Cada source del estado ya incluye el campo
      // findingsCount (se mantiene coherente con createSource que lo inicia en 0).
      async getByIdWithFindingsCount(id: string, tenantId?: string) {
        const source = state.sources.find(
          (source) => source.id === id && tenantVisible(source.tenantId, tenantId),
        );
        return source ? { ...source, findingsCount: source.findingsCount } : null;
      },
      // FASE 7.0.1: réplica del repo real — connectionConfig cifrado (mock) se
      // traduce a una configuración; null (legacy) se queda como null.
      decryptConnectionConfig(source: { connectionConfig: unknown }) {
        if (source.connectionConfig == null) return null;
        return {
          host: "mock-host",
          port: 5432,
          database: "mock-db",
          user: "mock-user",
          password: "mock-password",
          schema: "public",
        };
      },
      // FASE 7.0.0: CRUD con configuración de conexión (cifrado simulado). La
      // contraseña nunca se persiste en claro; el mock usa un marcador opaco.
      async createSource(input: {
        name: string;
        kind: string;
        environment: string;
        connection?: {
          host: string;
          port: number;
          database: string;
          user: string;
          password: string;
          schema?: string;
        };
        tenantId?: string | null;
      }) {
        const now = new Date();
        const created = {
          id: nextId("src"),
          name: input.name,
          kind: input.kind,
          environment: input.environment,
          status: "healthy" as const,
          lastScanAt: null,
          tables: 0,
          records: 0,
          // M21.3 — raíz de propiedad (D2: null si no hay contexto).
          tenantId: input.tenantId ?? null,
          connectionConfig: input.connection
            ? "mock-encrypted-connection-string"
            : null,
          createdAt: now,
          updatedAt: now,
          findingsCount: 0,
        };
        state.sources.push(created);
        return { ...created };
      },
      async updateSource(
        id: string,
        input: {
          name?: string;
          kind?: string;
          environment?: string;
          connection?: {
            host: string;
            port: number;
            database: string;
            user: string;
            password: string;
            schema?: string;
          } | null;
        },
        tenantId?: string,
      ) {
        const source = state.sources.find(
          (item) => item.id === id && tenantVisible(item.tenantId, tenantId),
        );
        if (!source) return null;
        if (input.name !== undefined) source.name = input.name;
        if (input.kind !== undefined) source.kind = input.kind;
        if (input.environment !== undefined) source.environment = input.environment;
        if (input.connection !== undefined) {
          source.connectionConfig = input.connection
            ? "mock-encrypted-connection-string"
            : null;
        }
        source.updatedAt = new Date();
        return { ...source };
      },
      async deleteSource(id: string, tenantId?: string) {
        const index = state.sources.findIndex(
          (item) => item.id === id && tenantVisible(item.tenantId, tenantId),
        );
        if (index === -1) return false;
        state.sources.splice(index, 1);
        return true;
      },
    },
    findings: {
      async list(
        filter: { status?: string; severity?: string } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
        tenantId?: string,
      ) {
        return state.findings
          .filter(
            (finding) =>
              (!filter.status || finding.status === filter.status) &&
              (!filter.severity || finding.severity === filter.severity) &&
              tenantVisible(finding.tenantId, tenantId),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((finding) => ({ ...finding }));
      },
      async updateStatus(
        { id, status, at }: { id: string; status: string; at: Date },
        tenantId?: string,
      ) {
        const finding = state.findings.find(
          (item) => item.id === id && tenantVisible(item.tenantId, tenantId),
        );
        if (!finding) return null;
        finding.status = status;
        finding.updatedAt = at;
        state.activity.unshift({
          id: nextId("a"),
          type: "finding",
          title: status === "resolved" ? "Hallazgo resuelto" : "Hallazgo actualizado",
          description: finding.title,
          createdAt: at,
          severity: finding.severity,
          tenantId: finding.tenantId,
        });
        return { ...finding };
      },
    },
    rules: {
      async list(pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }) {
        return state.rules
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((rule) => ({ ...rule }));
      },
      // FASE 7.0.1: reglas habilitadas (interruptor del catálogo del scanner).
      async listActive() {
        return state.rules.filter((rule) => rule.enabled).map((rule) => ({ ...rule }));
      },
      /** FASE 7.0.5 (espejo del repo real): solo `enabled` es gobernable. */
      async setEnabled({ id, enabled, at }: { id: string; enabled: boolean; at: Date }) {
        const rule = state.rules.find((item) => item.id === id);
        if (!rule) return null;
        rule.enabled = enabled;
        rule.updatedAt = at;
        return { ...rule };
      },
    },
    scans: {
      async startScan(
        { sourceId, startedAt, tenantId }: { sourceId: string; startedAt: Date; tenantId?: string },
      ) {
        const source = state.sources.find(
          (item) => item.id === sourceId && tenantVisible(item.tenantId, tenantId),
        );
        if (!source) return { ok: false, reason: "source_not_found" as const };

        const scan: MockRow<Scan> = {
          id: nextId("scan"),
          sourceId: source.id,
          status: "running",
          startedAt,
          completedAt: null,
          findingsCreated: 0,
          // FASE 7.1.0 M0: espejo de los defaults de la migración 0006.
          heartbeatAt: null,
          tablesScanned: 0,
          recordsRead: 0,
          cancelRequested: false,
        };
        state.scans.push(scan);
        source.lastScanAt = startedAt;
        source.updatedAt = startedAt;
        state.activity.unshift({
          id: nextId("a"),
          type: "scan",
          title: "Escaneo iniciado",
          description: `${source.name} · analizando ${source.tables} tablas`,
          createdAt: startedAt,
          severity: null,
        });
        return { ok: true, scan: { ...scan }, sourceName: source.name, sourceTables: source.tables };
      },
      // M21.7 — flujo interno (scheduler): inicia el scan SIN scoping de tenant.
      async startScanInternal({ sourceId, startedAt }: { sourceId: string; startedAt: Date }) {
        const source = state.sources.find((item) => item.id === sourceId);
        if (!source) return { ok: false, reason: "source_not_found" as const };
        const scan: MockRow<Scan> = {
          id: nextId("scan"),
          sourceId: source.id,
          status: "running",
          startedAt,
          completedAt: null,
          findingsCreated: 0,
          heartbeatAt: null,
          tablesScanned: 0,
          recordsRead: 0,
          cancelRequested: false,
        };
        state.scans.push(scan);
        source.lastScanAt = startedAt;
        source.updatedAt = startedAt;
        state.activity.unshift({
          id: nextId("a"),
          type: "scan",
          title: "Escaneo iniciado",
          description: `${source.name} · analizando ${source.tables} tablas`,
          createdAt: startedAt,
          severity: null,
        });
        return { ok: true, scan: { ...scan }, sourceName: source.name, sourceTables: source.tables };
      },
      // FASE 7.0.5: finaliza el scan en una ÚNICA transacción (findings + métricas
      // de fuente + detecciones por regla + estado completed). Réplica del repo
      // real: inserta findings, actualiza sources.tables/records, acumula
      // rules.detecciones y marca `completed` con findingsCreated = insertados.
      async finalizeScan(input: {
        scanId: string;
        sourceId: string;
        sourceName: string;
        completedAt: Date;
        findings: Array<{
          location: string;
          dataType: string;
          severity: string;
          records: number;
          sample: string;
          regulation: string;
          recommendation: string;
          title: string;
        }>;
        scannedTables: number;
        recordsRead: number;
        ruleDeltas: Map<string, number>;
      }) {
        const scan = state.scans.find((item) => item.id === input.scanId);
        if (!scan) return null;
        const source = state.sources.find((item) => item.id === input.sourceId);

        // 1. Insertar findings (con scan_id).
        const now = new Date();
        let insertedCount = 0;
        for (const finding of input.findings) {
          state.findings.push({
            id: nextId("f"),
            title: finding.title,
            dataType: finding.dataType,
            sourceId: input.sourceId,
            sourceName: input.sourceName,
            location: finding.location,
            severity: finding.severity,
            status: "open",
            records: finding.records,
            detectedAt: now,
            regulation: finding.regulation,
            recommendation: finding.recommendation,
            sample: finding.sample,
            scanId: input.scanId,
            fingerprint: null,
            firstSeenAt: now,
            lastSeenAt: now,
            lastSeenScanId: input.scanId,
            superseded: false,
            createdAt: now,
            updatedAt: now,
          });
          insertedCount += 1;
        }

        // 2. Actualizar métricas de la fuente.
        if (source) {
          source.tables = input.scannedTables;
          source.records = input.recordsRead;
        }

        // 3. Acumular detecciones por regla (vinculación por lower(name)).
        for (const [ruleNameLower, delta] of input.ruleDeltas) {
          if (delta <= 0) continue;
          const rule = state.rules.find(
            (r) => r.name.toLowerCase() === ruleNameLower,
          );
          if (rule) {
            rule.detections += delta;
            rule.lastTriggered = input.completedAt;
          }
        }

        // 4. Marcar scan como completed con findingsCreated = insertados.
        scan.status = "completed";
        scan.completedAt = input.completedAt;
        scan.findingsCreated = insertedCount;

        // 5. Registrar actividad de finalización.
        if (source) {
          state.activity.unshift({
            id: nextId("a"),
            type: "scan",
            title: "Escaneo completado",
            description: `${source.name} · ${input.scannedTables} tablas revisadas`,
            createdAt: input.completedAt,
            severity: null,
          });
        }

        return { ...scan };
      },
      // FASE 7.0.1/7.0.2: fallo del scanner con su causa (source_not_found |
      // source_not_scannable | connection_failed | persist_failed).
      // Idempotente: scan inexistente → null.
      async failScan({
        scanId,
        completedAt,
        reason,
      }: {
        scanId: string;
        completedAt: Date;
        reason:
          | "source_not_found"
          | "source_not_scannable"
          | "connection_failed"
          | "persist_failed"
          | "cancelled";
      }) {
        const scan = state.scans.find((item) => item.id === scanId);
        if (!scan) return null;
        // FASE 7.1.2 (M2, D2): un scan ya terminal no se sobrescribe ni
        // duplica la actividad de cierre (réplica del guard del repo real).
        if (scan.status !== "running") return { ...scan };
        scan.status = "failed";
        scan.completedAt = completedAt;
        const source = state.sources.find((item) => item.id === scan.sourceId);
        state.activity.unshift({
          id: nextId("a"),
          type: "scan",
          title: "Escaneo fallido",
          description: `${source?.name ?? scan.sourceId} · ${reason}`,
          createdAt: completedAt,
          severity: null,
        });
        return { ...scan };
      },

      // FASE 7.1.0 M0: latido best-effort — SOLO scans `running`; un scan que
      // ya terminó no se toca (réplica de la condición del WHERE del repo real).
      async heartbeatScan({ scanId, at, tablesScanned, recordsRead }: {
        scanId: string;
        at: Date;
        tablesScanned: number;
        recordsRead: number;
      }) {
        const scan = state.scans.find((item) => item.id === scanId);
        if (!scan || scan.status !== "running") return null;
        scan.heartbeatAt = at;
        scan.tablesScanned = tablesScanned;
        scan.recordsRead = recordsRead;
        // FASE 7.1.2 (M2): fila post-update (RETURNING) — expone el flag
        // `cancelRequested` vigente al scanner sin consultas extra.
        return { ...scan };
      },

      // FASE 7.1.1 (M1): historial — réplica del repo real: filtros exactos,
      // orden startedAt DESC con id DESC como tiebreak, paginación en memoria.
      async list(
        filters: { sourceId?: string; status?: string } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
        tenantId?: string,
      ) {
        return state.scans
          .filter((scan) => {
            if (filters.sourceId && scan.sourceId !== filters.sourceId) return false;
            if (filters.status && scan.status !== filters.status) return false;
            if (tenantId !== undefined) {
              const source = state.sources.find((s) => s.id === scan.sourceId);
              if (!tenantVisible(source?.tenantId, tenantId)) return false;
            }
            return true;
          })
          .sort(
            (a, b) =>
              b.startedAt.getTime() - a.startedAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit);
      },

      // FASE 7.1.1 (M1): detalle por id (null si no existe o es ajeno).
      async getById(id: string, tenantId?: string) {
        const scan = state.scans.find((scan) => scan.id === id);
        if (!scan) return null;
        if (tenantId !== undefined) {
          const source = state.sources.find((s) => s.id === scan.sourceId);
          if (!tenantVisible(source?.tenantId, tenantId)) return null;
        }
        return scan;
      },

      // FASE 7.1.2 (M2): cancelación cooperativa — réplica del repo real:
      // transacción/FOR UPDATE simulada por orden de chequeo; NO cambia
      // status (lo hace el scanner); idempotente mientras siga `running`.
      async requestCancel({ scanId, tenantId }: { scanId: string; tenantId?: string }) {
        const scan = state.scans.find((item) => item.id === scanId);
        if (!scan) return { ok: false as const, reason: "scan_not_found" as const };
        if (tenantId !== undefined) {
          const source = state.sources.find((s) => s.id === scan.sourceId);
          if (!tenantVisible(source?.tenantId, tenantId)) {
            return { ok: false as const, reason: "scan_not_found" as const };
          }
        }
        if (scan.status !== "running") {
          return { ok: false as const, reason: "scan_not_running" as const };
        }
        if (!scan.cancelRequested) scan.cancelRequested = true;
        return { ok: true as const, scan: { ...scan } };
      },

      // FASE 7.0.4 (refinado 7.1.0 M0): recuperación de huérfanos — marca
      // `failed(timeout)` los scans `running` cuyo último signo de vida
      // (heartbeatAt con fallback a startedAt, réplica del COALESCE del repo
      // real) es < before (comparación estricta). Los estados
      // `completed`/`failed` no se tocan; un scan cuya source fue eliminada
      // se recupera igualmente y sin actividad.
      async failStaleRunningScans({
        before,
        completedAt,
        reason,
      }: {
        before: Date;
        completedAt: Date;
        reason: "timeout";
      }) {
        const recovered: MockRow<Scan>[] = [];
        for (const scan of [...state.scans]) {
          const lastAlive = scan.heartbeatAt ?? scan.startedAt;
          if (scan.status !== "running" || lastAlive.getTime() >= before.getTime()) continue;
          scan.status = "failed";
          scan.completedAt = completedAt;
          const source = state.sources.find((item) => item.id === scan.sourceId);
          if (source) {
            state.activity.unshift({
              id: nextId("a"),
              type: "scan",
              title: "Escaneo fallido",
              description: `${source.name} · ${reason}`,
              createdAt: completedAt,
              severity: null,
            });
          }
          recovered.push({ ...scan });
        }
        return recovered;
      },
    },
    activity: {
      async list(
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
        tenantId?: string,
      ) {
        return state.activity
          .filter((event) => tenantVisible(event.tenantId, tenantId))
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((event) => ({ ...event }));
      },
      async create(values: {
        id: string;
        type: string;
        title: string;
        description: string;
        createdAt: Date;
        severity: string | null;
        tenantId?: string | null;
      }) {
        state.activity.unshift({ ...values, tenantId: values.tenantId ?? null });
        return { ...values, tenantId: values.tenantId ?? null };
      },
    },
    auditEvents: {
      /** M17 — inserta el evento con `createdAt` = ahora (como el default SQL). */
      async create(values: {
        id: string;
        actorUserId: string | null;
        action: string;
        resourceType: string;
        resourceId: string | null;
        result: string;
        requestId: string | null;
        metadata: Record<string, unknown>;
        tenantId?: string | null;
      }) {
        const row: MockRow<AuditEvent> = { ...values, createdAt: new Date(), tenantId: values.tenantId ?? null };
        state.auditEvents.unshift(row);
        return { ...row };
      },
      /** M17 — filtros + paginación, orden created_at DESC / id DESC (como la BD). */
      async list(
        filters: {
          actorUserId?: string;
          action?: string;
          resourceType?: string;
          resourceId?: string;
          result?: string;
          from?: Date;
          to?: Date;
          tenantId?: string;
        } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
      ) {
        return state.auditEvents
          .filter((event) => {
            if (filters.actorUserId !== undefined && event.actorUserId !== filters.actorUserId) return false;
            if (filters.action !== undefined && event.action !== filters.action) return false;
            if (filters.resourceType !== undefined && event.resourceType !== filters.resourceType) return false;
            if (filters.resourceId !== undefined && event.resourceId !== filters.resourceId) return false;
            if (filters.result !== undefined && event.result !== filters.result) return false;
            if (filters.from !== undefined && event.createdAt.getTime() < filters.from.getTime()) return false;
            if (filters.to !== undefined && event.createdAt.getTime() > filters.to.getTime()) return false;
            if (filters.tenantId !== undefined && !tenantVisible(event.tenantId, filters.tenantId)) return false;
            return true;
          })
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((event) => ({ ...event }));
      },
      /**
       * M21.7.3 — SOLO eventos de plataforma (tenant_id IS NULL). Disjunto de
       * `list` (que scoped por organización).
       */
      async listPlatform(
        filters: {
          actorUserId?: string;
          action?: string;
          resourceType?: string;
          resourceId?: string;
          result?: string;
          from?: Date;
          to?: Date;
        } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
      ) {
        return state.auditEvents
          .filter((event) => {
            if (event.tenantId !== null && event.tenantId !== undefined) return false;
            if (filters.actorUserId !== undefined && event.actorUserId !== filters.actorUserId) return false;
            if (filters.action !== undefined && event.action !== filters.action) return false;
            if (filters.resourceType !== undefined && event.resourceType !== filters.resourceType) return false;
            if (filters.resourceId !== undefined && event.resourceId !== filters.resourceId) return false;
            if (filters.result !== undefined && event.result !== filters.result) return false;
            if (filters.from !== undefined && event.createdAt.getTime() < filters.from.getTime()) return false;
            if (filters.to !== undefined && event.createdAt.getTime() > filters.to.getTime()) return false;
            return true;
          })
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((event) => ({ ...event }));
      },
    },
    reports: {
      async list(
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
        tenantId?: string,
      ) {
        return state.reports
          .filter((report) => tenantVisible(report.tenantId, tenantId))
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((report) => ({ ...report }));
      },
      async getById(id: string, tenantId?: string) {
        return (
          state.reports.find(
            (report) => report.id === id && tenantVisible(report.tenantId, tenantId),
          ) ?? null
        );
      },
      async create({ name, period, at, tenantId }: { name: string; period: string; at: Date; tenantId?: string }) {
        const openFindings = state.findings.filter(
          (finding) => isActiveFinding(finding) && tenantVisible(finding.tenantId, tenantId),
        ).length;
        const report: MockRow<Report> = {
          id: nextId("r"),
          name,
          period,
          status: "ready",
          createdAt: at,
          findings: openFindings,
          complianceScore: openFindings === 0 ? 100 : 0,
          format: "pdf",
          tenantId: tenantId ?? null,
        };
        state.reports.unshift(report);
        state.activity.unshift({
          id: nextId("a"),
          type: "report",
          title: "Informe generado",
          description: name,
          createdAt: at,
          severity: null,
          tenantId: report.tenantId,
        });
        return { ...report };
      },
    },
    dashboard: {
      async getDashboardData(tenantId?: string) {
        const sources = state.sources.filter((source) => tenantVisible(source.tenantId, tenantId));
        const open = state.findings.filter(
          (finding) => isActiveFinding(finding) && tenantVisible(finding.tenantId, tenantId),
        );
        const countsBySeverity: { critical: number; high: number; medium: number; low: number } = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const finding of open) {
          if (finding.severity in countsBySeverity) {
            countsBySeverity[finding.severity as keyof typeof countsBySeverity] += 1;
          }
        }
        const lastScanAt = sources.reduce<Date | null>(
          (acc, source) => (source.lastScanAt && (!acc || source.lastScanAt > acc) ? source.lastScanAt : acc),
          null,
        );
        const visibleScans = state.scans.filter((scan) => {
          if (tenantId === undefined) return true;
          const source = state.sources.find((s) => s.id === scan.sourceId);
          return tenantVisible(source?.tenantId, tenantId);
        });
        return {
          countsBySeverity,
          openFindings: open.length,
          protectedRecords: sources.reduce((sum, source) => sum + source.records, 0),
          monitoredSources: sources.length,
          lastScanAt,
          scanStatus: visibleScans.some((scan) => scan.status === "running") ? ("scanning" as const) : ("monitoring" as const),
          complianceScore: open.length === 0 ? 100 : 0,
        };
      },
    },

    // FASE 7.2 (M2.c): espejo del repositorio de compliance. Recalcula desde
    // el estado in-memory con la MISMA semántica canónica (isActiveFinding,
    // D8), usa computeComplianceScore como única fuente del score y reutiliza
    // el helper PURO real de buckets UTC (sin dependencias de BD).
    compliance: {
      async getComplianceSummary(tenantId?: string) {
        const active = state.findings.filter(
          (finding) => isActiveFinding(finding) && tenantVisible(finding.tenantId, tenantId),
        );
        const findingsBySeverity: { critical: number; high: number; medium: number; low: number } = {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        };
        const findingsByDataType: Record<string, number> = {};
        const bySource = new Map<string, { sourceId: string; sourceName: string; openFindings: number }>();
        for (const finding of active) {
          if (finding.severity in findingsBySeverity) {
            findingsBySeverity[finding.severity as keyof typeof findingsBySeverity] += 1;
          }
          findingsByDataType[finding.dataType] = (findingsByDataType[finding.dataType] ?? 0) + 1;
          if (finding.sourceId !== null) {
            const entry =
              bySource.get(finding.sourceId) ??
              { sourceId: finding.sourceId, sourceName: finding.sourceName, openFindings: 0 };
            entry.openFindings += 1;
            bySource.set(finding.sourceId, entry);
          }
        }
        const openFindings = active.length;
        return {
          complianceScore: computeComplianceScore({ openFindings }),
          openFindings,
          findingsBySeverity,
          findingsByDataType,
          findingsBySource: [...bySource.values()].sort(
            (a, b) =>
              b.openFindings - a.openFindings ||
              (a.sourceName < b.sourceName ? -1 : a.sourceName > b.sourceName ? 1 : 0) ||
              (a.sourceId < b.sourceId ? -1 : 1),
          ),
        };
      },
      async getComplianceTrend(days: number, _now?: Date, tenantId?: string) {
        const dayKeys = buildTrendDayKeys(days, new Date());
        return {
          days,
          points: buildTrendPoints({
            dayKeys,
            // Altas: canónicos (superseded = false) por firstSeenAt.
            // Resoluciones: filas actualmente 'resolved' por updatedAt
            // (misma semántica que las consultas del repositorio real).
            newFindings: state.findings
              .filter(
                (finding) =>
                  finding.superseded === false &&
                  tenantVisible(finding.tenantId, tenantId),
              )
              .map((finding) => ({ at: finding.firstSeenAt })),
            resolvedFindings: state.findings
              .filter(
                (finding) =>
                  finding.status === "resolved" &&
                  tenantVisible(finding.tenantId, tenantId),
              )
              .map((finding) => ({ at: finding.updatedAt })),
            completedScans: state.scans
              .filter((scan) => {
                if (scan.status !== "completed") return false;
                if (tenantId !== undefined) {
                  const source = state.sources.find((s) => s.id === scan.sourceId);
                  return tenantVisible(source?.tenantId, tenantId);
                }
                return true;
              })
              .map((scan) => ({ at: scan.completedAt, recordsRead: scan.recordsRead })),
          }),
        };
      },
    },
    users: {
      async getBySub(sub: string) {
        return state.users.find((user) => user.sub === sub) ?? null;
      },
      async getByEmail(email: string) {
        return state.users.find((user) => user.email === email) ?? null;
      },
      async updatePasswordHash(sub: string, passwordHash: string) {
        const user = state.users.find((u) => u.sub === sub);
        if (user) { user.passwordHash = passwordHash; user.updatedAt = new Date(); }
      },
      /**
       * M11.2.1: contrato del repo real, versión in-memory. Actualiza el hash
       * y revoca en un único paso todas las sesiones activas del usuario
       * EXCEPTO `exceptJti` (sesión actual, que debe sobrevivir al cambio).
       */
      async changePasswordAndRevokeOtherSessions(
        sub: string,
        passwordHash: string,
        exceptJti: string | null,
      ) {
        const user = state.users.find((u) => u.sub === sub);
        if (!user) return 0;
        user.passwordHash = passwordHash;
        user.updatedAt = new Date();
        let revoked = 0;
        for (const session of state.sessions) {
          if (
            session.userSub === sub &&
            session.revokedAt === null &&
            session.jti !== exceptJti
          ) {
            session.revokedAt = new Date();
            revoked += 1;
          }
        }
        return revoked;
      },
      async updateLastLogin(sub: string) {
        const user = state.users.find((u) => u.sub === sub);
        if (user) { user.lastLoginAt = new Date(); }
      },
      async upsertBySub(values: { sub: string; email: string; name: string | null }) {
        const existing = state.users.find((user) => user.sub === values.sub);
        if (existing) {
          existing.email = values.email;
          existing.name = values.name;
          existing.updatedAt = new Date();
          return { ...existing };
        }
        const created: User = {
          sub: values.sub,
          email: values.email,
          name: values.name,
          passwordHash: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.users.push(created);
        return { ...created };
      },
      /** Lista todos los usuarios ordenados por creación (proyección segura en la ruta). */
      async listUsers(pagination?: { limit: number; offset: number }) {
        const sorted = [...state.users].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        if (!pagination) return sorted;
        return sorted.slice(pagination.offset, pagination.offset + pagination.limit);
      },
      /**
       * Actualiza email/name de un usuario. `sub` NO es modificable:
       * es la identidad estable (igual que el repositorio real).
       */
      async updateProfile(sub: string, values: { email?: string; name?: string | null }) {
        const user = state.users.find((u) => u.sub === sub);
        if (!user) return null;
        if (values.email !== undefined) user.email = values.email;
        if (values.name !== undefined) user.name = values.name;
        user.updatedAt = new Date();
        return { ...user };
      },
    },
    userRoles: {
      async listRolesForUser(sub: string) {
        return state.userRoles
          .filter((role) => role.userSub === sub)
          .map((role) => role.role);
      },
      async addRole(sub: string, role: "admin" | "auditor") {
        if (!state.userRoles.some((item) => item.userSub === sub && item.role === role)) {
          state.userRoles.push({ userSub: sub, role, createdAt: new Date() });
        }
      },
      async setRoles(sub: string, roles: string[]) {
        state.userRoles = state.userRoles.filter((item) => item.userSub !== sub);
        for (const role of roles) {
          state.userRoles.push({ userSub: sub, role, createdAt: new Date() });
        }
        return roles;
      },
      /**
       * Variante U2 (6.3B.10): la invariante "siempre >= 1 admin" y la
       * deteccion de cambio efectivo se evaluan AL MOMENTO DE LA MUTACION,
       * equivalente in-tx tras los locks FOR UPDATE del repo real. Ante
       * rechazo no se muta nada (rollback).
       */
      /**
       * Variante U2 (6.3B.10): replica al repositorio real, que evalua la
       * invariante "siempre >= 1 admin" DENTRO de la operacion (en el repo,
       * tras los locks FOR UPDATE). Cuando se viola, lanza `forbidden` (403)
       * ANTES de mutar el estado (equivalente al ROLLBACK real). La
       * deteccion de cambio efectivo tambien ocurre al momento de mutar.
       * Contrato = SetRolesResult: { applied, changed, revokedSessions }.
       */
      async setRolesAndRevokeSessions(sub: string, roles: string[]) {
        const currentRoles = state.userRoles
          .filter((r) => r.userSub === sub)
          .map((r) => r.role);

        // Invariante: retirar el ultimo admin -> 403.
        const isLosingAdmin =
          currentRoles.includes("admin") && !roles.includes("admin");
        if (isLosingAdmin) {
          const otherAdmins = state.userRoles.filter(
            (r) => r.role === "admin" && r.userSub !== sub,
          );
          if (otherAdmins.length === 0) {
            throw forbidden("Cannot remove the last administrator role");
          }
        }

        // Cambio efectivo (ignora orden/duplicados), como en la tx real.
        const sortKey = (xs: string[]) => [...xs].sort().join(",");
        const changed = sortKey(currentRoles) !== sortKey(roles);
        if (!changed) {
          return { applied: [...currentRoles], changed: false, revokedSessions: 0 };
        }

        state.userRoles = state.userRoles.filter((r) => r.userSub !== sub);
        for (const role of roles) {
          state.userRoles.push({ userSub: sub, role, createdAt: new Date() });
        }
        let revokedSessions = 0;
        for (const session of state.sessions) {
          if (session.userSub === sub && session.revokedAt === null) {
            session.revokedAt = new Date();
            revokedSessions += 1;
          }
        }
        return { applied: [...roles], changed: true, revokedSessions };
      },
    },

    scanSchedules: {
      async upsert(
        input: { sourceId: string; enabled: boolean; intervalMinutes?: number; at: Date },
        tenantId?: string,
      ) {
        // Semántica del repo real: la fuente debe existir (lock FOR UPDATE
        // dentro de la transacción); si no, { ok: false, source_not_found }.
        const source = state.sources.find(
          (item) => item.id === input.sourceId && tenantVisible(item.tenantId, tenantId),
        );
        if (!source) return { ok: false, reason: "source_not_found" as const };
        const nextRunAt = input.enabled
          ? new Date(input.at.getTime() + (input.intervalMinutes ?? 1440) * 60_000)
          : null;
        const existing = state.scanSchedules.find((item) => item.sourceId === input.sourceId);
        const row = {
          id: existing?.id ?? `sched-${state.scanSchedules.length + 1}`,
          sourceId: input.sourceId,
          enabled: input.enabled,
          intervalMinutes: input.intervalMinutes ?? 1440,
          nextRunAt,
          lastRunAt: existing?.lastRunAt ?? null,
          lastStatus: existing?.lastStatus ?? null,
          lastError: existing?.lastError ?? null,
          createdAt: existing?.createdAt ?? input.at,
          updatedAt: input.at,
        };
        if (existing) Object.assign(existing, row);
        else state.scanSchedules.push(row);
        return { ok: true, schedule: row };
      },
      async getBySourceId(sourceId: string, tenantId?: string) {
        const schedule = state.scanSchedules.find((item) => item.sourceId === sourceId);
        if (!schedule) return null;
        if (tenantId !== undefined) {
          const source = state.sources.find((s) => s.id === sourceId);
          if (!tenantVisible(source?.tenantId, tenantId)) return null;
        }
        return schedule;
      },
      async claimDue({ now, limit }: { now: Date; limit: number }) {
        const due = state.scanSchedules
          .filter((row) => row.enabled && row.nextRunAt !== null && row.nextRunAt <= now)
          .slice(0, limit);
        const claimed = due.map((row) => {
          row.nextRunAt = new Date(now.getTime() + row.intervalMinutes * 60_000);
          row.lastRunAt = now;
          return { schedule: row };
        });
        return claimed;
      },
      async markResult(input: { id: string; status: "ok" | "skipped" | "error"; error?: string | null; at: Date }) {
        const row = state.scanSchedules.find((item) => item.id === input.id);
        if (row) {
          row.lastStatus = input.status;
          row.lastError = input.error ?? null;
        }
      },
    },
    rateLimits: {
      /** M18 — upsert fixed-window equivalente al SQL `ON CONFLICT ... RETURNING`. */
      async hit(key: string, windowMs: number) {
        const rows = (state.rateLimitHits ??= []);
        const now = Date.now();
        const existing = rows.find((r) => r.key === key);
        if (!existing) {
          const row: MockRateLimitHit = {
            key,
            hits: 1,
            windowStartAt: new Date(now),
            expiresAt: new Date(now + windowMs),
          };
          rows.push(row);
          return { totalHits: row.hits, resetTime: new Date(row.expiresAt) };
        }
        if (existing.expiresAt.getTime() <= now) {
          existing.hits = 1;
          existing.windowStartAt = new Date(now);
          existing.expiresAt = new Date(now + windowMs);
        } else {
          existing.hits += 1;
        }
        return { totalHits: existing.hits, resetTime: new Date(existing.expiresAt) };
      },
      async resetKey(key: string) {
        const rows = (state.rateLimitHits ??= []);
        const idx = rows.findIndex((r) => r.key === key);
        if (idx >= 0) rows.splice(idx, 1);
      },
      async resetAll(prefix?: string) {
        const rows = (state.rateLimitHits ??= []);
        state.rateLimitHits = prefix
          ? rows.filter((r) => !r.key.startsWith(`${prefix}:`))
          : [];
      },
      async decrementKey(key: string) {
        const row = (state.rateLimitHits ??= []).find((r) => r.key === key);
        if (row && row.hits > 0) row.hits -= 1;
      },
      async cleanupExpired() {
        const rows = (state.rateLimitHits ??= []);
        const now = Date.now();
        const before = rows.length;
        state.rateLimitHits = rows.filter((r) => r.expiresAt.getTime() > now);
        return before - state.rateLimitHits.length;
      },
    },
    sessions: {
      /**
       * [6.3B.12] Contrato transaccional del login (equivalente al repo real:
       * lock de users(sub) + lectura de roles + firma + alta de sesion). El
       * mock es secuencial (no hay carrera real) pero replica la semantica:
       * lee los roles ACTUALES, firma con ellos y crea la fila de sesion.
       * Si el build del token o el alta fallan no queda ningun cambio.
       */
      async createSessionForUser(
        sub: string,
        buildToken: (roles: string[]) => Promise<string>,
        activeOrgId?: string | null,
      ) {
        const roles = state.userRoles
          .filter((r) => r.userSub === sub)
          .map((r) => r.role);
        const jwt = await buildToken(roles);

        const { jti, exp } = decodeJwt(jwt);
        if (typeof jti !== "string" || typeof exp !== "number") {
          throw new Error("JWT without jti/exp; refusing to create session");
        }
        const created = {
          jti,
          userSub: sub,
          issuedAt: new Date(),
          expiresAt: new Date(exp * 1000),
          revokedAt: null,
          lastUsedAt: new Date(),
          // M21.2 — contexto de organización inicial (primera membership).
          activeOrgId: activeOrgId ?? null,
        };
        state.sessions.push(created);
        return { jwt, roles };
      },
      async findRawByJti(jti: string) {
        return state.sessions.find((s) => s.jti === jti) ?? null;
      },
      async cleanupStale(cutoff: Date) {
        const cutoffMs = cutoff.getTime();
        const before = state.sessions.length;
        state.sessions = state.sessions.filter(
          (s) =>
            s.expiresAt.getTime() > cutoffMs &&
            (s.revokedAt === null || s.revokedAt.getTime() > cutoffMs),
        );
        return before - state.sessions.length;
      },
      async findActiveByJti(jti: string, idleSeconds: number) {
        const now = new Date();
        const idleThreshold = new Date(now.getTime() - idleSeconds * 1000);
        const session = state.sessions.find((s) => {
          // `lastUsedAt` ausente (sesiones creadas manualmente en tests de
          // M11.2.2 y anteriores) equivale a la migración con DEFAULT NOW():
          // se trata como actividad reciente, igual que en producción.
          const lastUsed = s.lastUsedAt ?? now;
          return (
            s.jti === jti &&
            s.revokedAt === null &&
            s.expiresAt > now &&
            lastUsed > idleThreshold
          );
        });
        return session ? { ...session } : null;
      },
      async touchLastUsed(jti: string) {
        const session = state.sessions.find((s) => s.jti === jti);
        if (session) session.lastUsedAt = new Date();
      },
      async revokeByJti(jti: string) {
        const session = state.sessions.find(
          (s) => s.jti === jti && s.revokedAt === null,
        );
        if (!session) return false;
        session.revokedAt = new Date();
        return true;
      },
      /** M11.2.1 — variante transaccional: mismo comportamiento, firma de tx. */
      async revokeAllSessionsForUserTx(_tx: unknown, userSub: string) {
        let revoked = 0;
        for (const session of state.sessions) {
          if (session.userSub === userSub && session.revokedAt === null) {
            session.revokedAt = new Date();
            revoked += 1;
          }
        }
        return revoked;
      },
      /** M11.2.2 — lista sesiones activas del usuario, emisión descendente. */
      async listActiveByUser(userSub: string) {
        const now = new Date();
        return state.sessions
          .filter(
            (s) =>
              s.userSub === userSub &&
              s.revokedAt === null &&
              s.expiresAt > now,
          )
          .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
          .map((s) => ({ ...s }));
      },
      /** M11.2.2 — revoca TODAS las sesiones activas del usuario (incluida actual). */
      async revokeAllForUser(userSub: string) {
        let revoked = 0;
        for (const session of state.sessions) {
          if (session.userSub === userSub && session.revokedAt === null) {
            session.revokedAt = new Date();
            revoked += 1;
          }
        }
        return revoked;
      },

      /**
       * M21.2 — fija la organización activa de una sesión. Replica el repo
       * real: valida membership ANTES de mutar (misma tx lógica) y devuelve
       * `false` si la sesión no existe o no pertenece al usuario.
       */
      async setActiveOrganization(
        jti: string,
        userSub: string,
        organizationId: string,
      ) {
        const memberships = (state.memberships ??= []);
        const membership = memberships.find(
          (m) => m.userSub === userSub && m.organizationId === organizationId,
        );
        if (!membership) return false;
        const session = state.sessions.find(
          (s) => s.jti === jti && s.userSub === userSub,
        );
        if (!session) return false;
        session.activeOrgId = organizationId;
        return true;
      },

      /** M21.2 — limpia el contexto activo de las sesiones de un usuario para una org. */
      async clearActiveOrgForOrg(userSub: string, organizationId: string) {
        let cleared = 0;
        for (const session of state.sessions) {
          if (session.userSub === userSub && session.activeOrgId === organizationId) {
            session.activeOrgId = null;
            cleared += 1;
          }
        }
        return cleared;
      },

      /**
       * M21.2 — organización activa resuelta EN CADA REQUEST: la sesión debe
       * existir, tener contexto, y la membership debe seguir viva (fail-closed).
       */
      async resolveActiveOrganization(jti: string, userSub: string) {
        const session = state.sessions.find(
          (s) => s.jti === jti && s.userSub === userSub,
        );
        if (!session || session.activeOrgId === null) return null;
        const membership = (state.memberships ??= []).find(
          (m) =>
            m.userSub === userSub && m.organizationId === session.activeOrgId,
        );
        if (!membership) return null;
        return { organizationId: membership.organizationId, role: membership.role };
      },
    },

    // ---- M21.2: organizaciones ----
    organizations: {
      async getByIds(ids: string[]) {
        const orgs = (state.organizations ??= []);
        const map = new Map<
          string,
          { id: string; name: string; slug: string; createdAt: Date }
        >();
        for (const org of orgs) {
          if (ids.includes(org.id)) {
            map.set(org.id, {
              id: org.id,
              name: org.name,
              slug: org.slug,
              createdAt: org.createdAt,
            });
          }
        }
        return map;
      },
      async getById(id: string) {
        const orgs = (state.organizations ??= []);
        const org = orgs.find((row) => row.id === id);
        if (!org) return null;
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          createdAt: org.createdAt,
        };
      },
      async exists(id: string) {
        return (state.organizations ??= []).some((org) => org.id === id);
      },
    },

    // ---- M21.2: memberships (autoridad empresarial) ----
    memberships: {
      async getByUserAndOrg(userSub: string, organizationId: string) {
        return (
          (state.memberships ??= []).find(
            (m) => m.userSub === userSub && m.organizationId === organizationId,
          ) ?? null
        );
      },
      /** Primera organización del usuario (orden de ingreso): default del login. */
      async getFirstOrgForUser(userSub: string) {
        const rows = (state.memberships ??= [])
          .filter((m) => m.userSub === userSub)
          .sort(
            (a, b) =>
              a.joinedAt.getTime() - b.joinedAt.getTime() ||
              a.organizationId.localeCompare(b.organizationId),
          );
        return rows[0]?.organizationId ?? null;
      },
      /** Organizaciones del usuario + rol (orden de ingreso). */
      async listByUser(userSub: string) {
        const orgs = (state.organizations ??= []);
        return (state.memberships ??= [])
          .filter((m) => m.userSub === userSub)
          .sort(
            (a, b) =>
              a.joinedAt.getTime() - b.joinedAt.getTime() ||
              a.organizationId.localeCompare(b.organizationId),
          )
          .map((m) => {
            const org = orgs.find((row) => row.id === m.organizationId);
            if (!org) return null;
            return {
              organization: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                createdAt: org.createdAt,
              },
              role: m.role,
              joinedAt: m.joinedAt,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);
      },
      /** Miembros de una organización con identidad pública (sin credenciales). */
      async listByOrg(organizationId: string) {
        return (state.memberships ??= [])
          .filter((m) => m.organizationId === organizationId)
          .sort(
            (a, b) =>
              a.joinedAt.getTime() - b.joinedAt.getTime() ||
              a.userSub.localeCompare(b.userSub),
          )
          .map((m) => {
            const user = state.users.find((u) => u.sub === m.userSub);
            if (!user) return null;
            return {
              sub: user.sub,
              email: user.email,
              name: user.name,
              role: m.role,
              joinedAt: m.joinedAt,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);
      },
      /** Alta idempotente por PK compuesta (`null` = ya existía). */
      async create(values: {
        organizationId: string;
        userSub: string;
        role: string;
        invitedBy?: string | null;
      }) {
        const memberships = (state.memberships ??= []);
        if (
          memberships.some(
            (m) =>
              m.organizationId === values.organizationId &&
              m.userSub === values.userSub,
          )
        ) {
          return null;
        }
        const created: Membership = {
          organizationId: values.organizationId,
          userSub: values.userSub,
          role: values.role,
          invitedBy: values.invitedBy ?? null,
          joinedAt: new Date(),
        };
        memberships.push(created);
        return { ...created };
      },
      /**
       * Cambio de rol: replica al repo real — invariante de último
       * owner/admin evaluada AL MOMENTO DE MUTAR, `owner` inmutable, y
       * revocación de sesiones + limpieza de contexto en la misma operación.
       */
      async updateRole(
        organizationId: string,
        userSub: string,
        nextRole: string,
      ) {
        const memberships = (state.memberships ??= []);
        const target = memberships.find(
          (m) => m.organizationId === organizationId && m.userSub === userSub,
        );
        if (!target) throw notFound("Member not found");
        if (target.role === "owner") {
          throw forbidden(
            "Ownership transfer is required to change the owner membership",
          );
        }
        if (target.role === nextRole) {
          return { revokedSessions: 0 };
        }
        const remainingGovernors = memberships.filter(
          (m) =>
            m.organizationId === organizationId &&
            m.userSub !== userSub &&
            (m.role === "owner" || m.role === "admin"),
        );
        if (
          (target.role === "owner" || target.role === "admin") &&
          remainingGovernors.length === 0
        ) {
          throw forbidden("Cannot remove the last organization admin");
        }
        target.role = nextRole;
        return {
          revokedSessions: revokeUserSessions(userSub, organizationId),
        };
      },
      /** Baja de miembro: mismas invariantes que updateRole. */
      async remove(organizationId: string, userSub: string) {
        const memberships = (state.memberships ??= []);
        const targetIndex = memberships.findIndex(
          (m) => m.organizationId === organizationId && m.userSub === userSub,
        );
        if (targetIndex === -1) throw notFound("Member not found");
        const target = memberships[targetIndex];
        if (target.role === "owner") {
          throw forbidden(
            "Ownership transfer is required to remove the owner membership",
          );
        }
        const remainingGovernors = memberships.filter(
          (m) =>
            m.organizationId === organizationId &&
            m.userSub !== userSub &&
            (m.role === "owner" || m.role === "admin"),
        );
        if (
          (target.role === "owner" || target.role === "admin") &&
          remainingGovernors.length === 0
        ) {
          throw forbidden("Cannot remove the last organization admin");
        }
        memberships.splice(targetIndex, 1);
        return {
          revokedSessions: revokeUserSessions(userSub, organizationId),
        };
      },
    },

    // ---- M21.2: invitaciones (el token NUNCA se persiste, solo su hash) ----
    invitations: {
      async create(values: {
        organizationId: string;
        email: string;
        role: string;
        tokenHash: string;
        expiresAt: Date;
        invitedBy: string;
      }) {
        const invitations = (state.invitations ??= []);
        const created: Invitation = {
          id: nextId("inv"),
          organizationId: values.organizationId,
          email: values.email,
          role: values.role,
          tokenHash: values.tokenHash,
          expiresAt: values.expiresAt,
          acceptedAt: null,
          invitedBy: values.invitedBy,
          createdAt: new Date(),
        };
        invitations.push(created);
        return { ...created };
      },
      /** Proyección SIN token_hash (nunca sale de la BD). */
      async listByOrg(organizationId: string) {
        return (state.invitations ??= [])
          .filter((invitation) => invitation.organizationId === organizationId)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            expiresAt: invitation.expiresAt,
            acceptedAt: invitation.acceptedAt,
            createdAt: invitation.createdAt,
          }));
      },
      /** Revoca (borra) una invitación pendiente de ESA organización. */
      async revoke(organizationId: string, invitationId: string) {
        const invitations = (state.invitations ??= []);
        const index = invitations.findIndex(
          (invitation) =>
            invitation.id === invitationId &&
            invitation.organizationId === organizationId,
        );
        if (index === -1) return false;
        invitations.splice(index, 1);
        return true;
      },
      /**
       * Aceptación atómica (espejo del repo real): valida estado + consumo +
       * alta del membership. `expectedEmail` hace la invitación PERSONAL;
       * mismatch → `not_found` (mismo contrato que token inexistente, sin
       * filtrar cuál de los dos falló).
       */
      async consumeByTokenHash(input: {
        tokenHash: string;
        userSub: string;
        now: Date;
        expectedEmail?: string;
      }) {
        const invitations = (state.invitations ??= []);
        const invitation = invitations.find(
          (row) => row.tokenHash === input.tokenHash,
        );
        if (!invitation) {
          return { ok: false as const, reason: "not_found" as const };
        }
        if (
          input.expectedEmail !== undefined &&
          invitation.email !== input.expectedEmail
        ) {
          return { ok: false as const, reason: "not_found" as const };
        }
        if (invitation.acceptedAt) {
          return { ok: false as const, reason: "already_accepted" as const };
        }
        if (invitation.expiresAt.getTime() <= input.now.getTime()) {
          return { ok: false as const, reason: "expired" as const };
        }
        const memberships = (state.memberships ??= []);
        if (
          memberships.some(
            (m) =>
              m.organizationId === invitation.organizationId &&
              m.userSub === input.userSub,
          )
        ) {
          return { ok: false as const, reason: "already_member" as const };
        }
        memberships.push({
          organizationId: invitation.organizationId,
          userSub: input.userSub,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          joinedAt: input.now,
        });
        invitation.acceptedAt = input.now;
        return {
          ok: true as const,
          organizationId: invitation.organizationId,
          role: invitation.role,
          invitationId: invitation.id,
        };
      },
    },
  };

  state.maskingJobs ??= [];
  const reposWithMasking = { ...repos, masking: createMockMaskingRepos(state) };
  return { repos: reposWithMasking, state };
}
