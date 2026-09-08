import type {
  Activity,
  Finding,
  Report,
  Rule,
  Scan,
  Source,
  User,
  UserRole,
  Session,
} from "@workspace/db";
import { forbidden } from "../lib/errors";
import { decodeJwt } from "jose";

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

export type MockState = {
  users: User[];
  userRoles: UserRole[];
  sessions: Session[];
  findings: Finding[];
  sources: (Source & { findingsCount: number })[];
  rules: Rule[];
  scans: Scan[];
  activity: Activity[];
  reports: Report[];
};

const SOURCE_NAMES: Record<string, string> = {
  "src-001": "Customer PostgreSQL",
  "src-002": "Analytics Warehouse",
  "src-003": "CRM MySQL",
  "src-004": "Payments PostgreSQL",
};

export function createMockRepos() {
  const boot = new Date();
  const minutesAgo = (minutes: number) => new Date(boot.getTime() - minutes * 60_000);

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-mock-${++counter}`;

  const state: MockState = {
    users: [],
    userRoles: [],
  sessions: [],
    findings: [
      { id: "f-001", title: "Emails de clientes sin cifrado", dataType: "email", sourceId: "src-001", sourceName: SOURCE_NAMES["src-001"], location: "public.customers.email", severity: "critical", status: "open", records: 12843, detectedAt: minutesAgo(12), regulation: "GDPR Art. 32", recommendation: "Cifrar la columna y restringir el acceso.", sample: "m••••••@empresa.com", createdAt: minutesAgo(12), updatedAt: minutesAgo(12), scanId: null },
      { id: "f-002", title: "Documento nacional en staging", dataType: "national_id", sourceId: "src-002", sourceName: SOURCE_NAMES["src-002"], location: "staging.user_profiles.national_id", severity: "high", status: "in_review", records: 4521, detectedAt: minutesAgo(38), regulation: "LGPD Art. 46", recommendation: "Tokenizar en cada refresh.", sample: "27.•••.•••-•", createdAt: minutesAgo(38), updatedAt: minutesAgo(38), scanId: null },
      { id: "f-003", title: "Teléfonos visibles en exportación", dataType: "phone", sourceId: "src-003", sourceName: SOURCE_NAMES["src-003"], location: "crm.contacts.phone", severity: "medium", status: "open", records: 2187, detectedAt: minutesAgo(74), regulation: "CCPA §1798.100", recommendation: "Enmascarar últimos cuatro dígitos.", sample: "+54 9 11 •••• 4821", createdAt: minutesAgo(74), updatedAt: minutesAgo(74), scanId: null },
      { id: "f-004", title: "Direcciones residenciales detectadas", dataType: "address", sourceId: "src-001", sourceName: SOURCE_NAMES["src-001"], location: "public.shipping_addresses.full_address", severity: "low", status: "resolved", records: 864, detectedAt: minutesAgo(120), regulation: "GDPR Art. 5", recommendation: "Mantener solo ciudad y CP.", sample: "Av. del L•••• 120", createdAt: minutesAgo(120), updatedAt: minutesAgo(120), scanId: null },
      { id: "f-005", title: "Tarjetas almacenadas en logs", dataType: "credit_card", sourceId: "src-004", sourceName: SOURCE_NAMES["src-004"], location: "logs.checkout.payload", severity: "critical", status: "open", records: 91, detectedAt: minutesAgo(186), regulation: "PCI DSS 3.4", recommendation: "Redactar payloads históricos.", sample: "•••• •••• •••• 4242", createdAt: minutesAgo(186), updatedAt: minutesAgo(186), scanId: null },
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
  };

  const repos = {
    sources: {
      async list(pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }) {
        return state.sources
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((source) => ({ ...source }));
      },
      async getById(id: string) {
        return state.sources.find((source) => source.id === id) ?? null;
      },
      // FASE 7.0.5 (M1): réplica del repo real — devuelve la fuente con su
      // conteo real de hallazgos. Cada source del estado ya incluye el campo
      // findingsCount (se mantiene coherente con createSource que lo inicia en 0).
      async getByIdWithFindingsCount(id: string) {
        const source = state.sources.find((source) => source.id === id);
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
      ) {
        const source = state.sources.find((item) => item.id === id);
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
      async deleteSource(id: string) {
        const index = state.sources.findIndex((item) => item.id === id);
        if (index === -1) return false;
        state.sources.splice(index, 1);
        return true;
      },
      async touchLastScan({ id, at }: { id: string; at: Date }) {
        const source = state.sources.find((item) => item.id === id);
        if (!source) return null;
        source.lastScanAt = at;
        source.updatedAt = at;
        return { ...source };
      },
    },
    findings: {
      async list(
        filter: { status?: string; severity?: string } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
      ) {
        return state.findings
          .filter(
            (finding) =>
              (!filter.status || finding.status === filter.status) &&
              (!filter.severity || finding.severity === filter.severity),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((finding) => ({ ...finding }));
      },
      async getById(id: string) {
        return state.findings.find((finding) => finding.id === id) ?? null;
      },
      async updateStatus({ id, status, at }: { id: string; status: string; at: Date }) {
        const finding = state.findings.find((item) => item.id === id);
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
        });
        return { ...finding };
      },
      async countOpen() {
        return state.findings.filter((finding) => finding.status !== "resolved").length;
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
    },
    scans: {
      async startScan({ sourceId, startedAt }: { sourceId: string; startedAt: Date }) {
        const source = state.sources.find((item) => item.id === sourceId);
        if (!source) return { ok: false, reason: "source_not_found" as const };

        const scan: Scan = {
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
          | "persist_failed";
      }) {
        const scan = state.scans.find((item) => item.id === scanId);
        if (!scan) return null;
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
        if (!scan || scan.status !== "running") return;
        scan.heartbeatAt = at;
        scan.tablesScanned = tablesScanned;
        scan.recordsRead = recordsRead;
      },

      // FASE 7.1.1 (M1): historial — réplica del repo real: filtros exactos,
      // orden startedAt DESC con id DESC como tiebreak, paginación en memoria.
      async list(
        filters: { sourceId?: string; status?: string } = {},
        pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
      ) {
        return state.scans
          .filter(
            (scan) =>
              (!filters.sourceId || scan.sourceId === filters.sourceId) &&
              (!filters.status || scan.status === filters.status),
          )
          .sort(
            (a, b) =>
              b.startedAt.getTime() - a.startedAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(pagination.offset, pagination.offset + pagination.limit);
      },

      // FASE 7.1.1 (M1): detalle por id (null si no existe).
      async getById(id: string) {
        return state.scans.find((scan) => scan.id === id) ?? null;
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
        const recovered: Scan[] = [];
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
      async list(pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }) {
        return state.activity
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((event) => ({ ...event }));
      },
      async create(values: { id: string; type: string; title: string; description: string; createdAt: Date; severity: string | null }) {
        state.activity.unshift({ ...values });
        return { ...values };
      },
    },
    reports: {
      async list(pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }) {
        return state.reports
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((report) => ({ ...report }));
      },
      async create({ name, period, at }: { name: string; period: string; at: Date }) {
        const openFindings = state.findings.filter((f) => f.status !== "resolved").length;
        const report: Report = {
          id: nextId("r"),
          name,
          period,
          status: "ready",
          createdAt: at,
          findings: openFindings,
          complianceScore: openFindings === 0 ? 100 : 0,
          format: "pdf",
        };
        state.reports.unshift(report);
        state.activity.unshift({
          id: nextId("a"),
          type: "report",
          title: "Informe generado",
          description: name,
          createdAt: at,
          severity: null,
        });
        return { ...report };
      },
    },
    dashboard: {
      async getDashboardData() {
        const open = state.findings.filter((finding) => finding.status !== "resolved");
        const countsBySeverity: { critical: number; high: number; medium: number; low: number } = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const finding of open) {
          if (finding.severity in countsBySeverity) {
            countsBySeverity[finding.severity as keyof typeof countsBySeverity] += 1;
          }
        }
        const lastScanAt = state.sources.reduce<Date | null>(
          (acc, source) => (source.lastScanAt && (!acc || source.lastScanAt > acc) ? source.lastScanAt : acc),
          null,
        );
        return {
          countsBySeverity,
          openFindings: open.length,
          protectedRecords: state.sources.reduce((sum, source) => sum + source.records, 0),
          monitoredSources: state.sources.length,
          lastScanAt,
          scanStatus: state.scans.some((scan) => scan.status === "running") ? ("scanning" as const) : ("monitoring" as const),
          complianceScore: open.length === 0 ? 100 : 0,
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
        };
        state.sessions.push(created);
        return { jwt, roles };
      },
      async findActiveByJti(jti: string) {
        const now = new Date();
        const session = state.sessions.find(
          (s) => s.jti === jti && s.revokedAt === null && s.expiresAt > now,
        );
        return session ? { ...session } : null;
      },
      async revokeByJti(jti: string) {
        const session = state.sessions.find(
          (s) => s.jti === jti && s.revokedAt === null,
        );
        if (!session) return false;
        session.revokedAt = new Date();
        return true;
      },
    },
  };

  return { repos, state };
}
