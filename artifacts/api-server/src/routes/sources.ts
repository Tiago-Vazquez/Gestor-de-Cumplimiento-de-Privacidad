import { Router, type IRouter } from "express";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
import { resolvedOrgContext } from "../auth/org-context";
import { badRequest, notFound } from "../lib/errors";
import {
  CreateSourceBody,
  CreateSourceResponse,
  GetSourceParams,
  GetSourceResponse,
  GetSourceScheduleParams,
  GetSourceScheduleResponse,
  UpdateSourceBody,
  UpdateSourceParams,
  UpdateSourceResponse,
  UpdateSourceScheduleBody,
  UpdateSourceScheduleParams,
  UpdateSourceScheduleResponse,
  DeleteSourceParams,
} from "@workspace/api-zod";
import {
  SCAN_SCHEDULE_DEFAULT_MINUTES,
  normalizeIntervalMinutes,
} from "../repositories/scan-schedules.repo";
import type { SourceConnectionConfig } from "../repositories/sources.repo";
import { recordAuditEvent } from "../lib/audit";

const router: IRouter = Router();

/**
 * FASE 7.0.0 — CRUD de fuentes de datos.
 * Todas las mutaciones requieren rol `admin`. El listado es para cualquier
 * usuario autenticado (lectura). La contraseña viaja en el body pero NUNCA
 * se devuelve en la respuesta (write-only): SourceDetail no incluye connection.
 */

// POST /api/sources — crear fuente (admin)
router.post("/", requireRole("admin"), async (req, res) => {
  const body = CreateSourceBody.parse(req.body);
  // M21.4 — crear una fuente exige organización activa (tenant_id NOT NULL).
  const tenantId = resolvedOrgContext(req).organizationId;
  // M23.1 — la config de conexión es una unión discriminada por `kind` y DEBE
  // coincidir con el kind de la fuente: una config MySQL jamás se persistirá
  // bajo una fuente PostgreSQL (ni viceversa). Validación server-side.
  let connection: SourceConnectionConfig | undefined = undefined;
  if (body.connection) {
    if (body.connection.kind !== body.kind) {
      throw badRequest("connection.kind must match the source kind");
    }
    connection = body.connection;
  }

  const created = await repos.sources.createSource({
    name: body.name,
    kind: body.kind,
    environment: body.environment,
    connection,
    // M21.3 — la fuente hereda la organización activa (D2).
    tenantId,
  });

  // M17 — creación de fuente: solo metadatos operacionales. La conexión
  // (host/usuario/contraseña) NUNCA se audita.
  await recordAuditEvent({
    req,
    action: "source_created",
    resourceType: "source",
    resourceId: created.id,
    result: "success",
    metadata: {
      kind: created.kind,
      environment: created.environment,
      scannable: created.connectionConfig != null,
    },
  });

  res.status(201).json(CreateSourceResponse.parse({
    id: created.id,
    name: created.name,
    kind: created.kind,
    environment: created.environment,
    status: created.status,
    lastScanAt: created.lastScanAt ? created.lastScanAt.toISOString() : null,
    tables: created.tables,
    records: created.records,
    // FASE 7.0.5 (M1): el conteo real de hallazgos (0 para fuente recién creada)
    findings: 0,
    scannable: created.connectionConfig != null,
  }));
});

// GET /api/sources/:id — detalle de fuente (autenticado)
router.get("/:id", async (req, res) => {
  const { id } = GetSourceParams.parse(req.params);
  const tenantId = resolvedOrgContext(req).organizationId;
  // FASE 7.0.5 (M1): conteo real de hallazgos en lugar del hardcode 0
  const source = await repos.sources.getByIdWithFindingsCount(id, tenantId);
  if (!source) {
    throw notFound("Source not found");
  }

  res.json(GetSourceResponse.parse({
    id: source.id,
    name: source.name,
    kind: source.kind,
    environment: source.environment,
    status: source.status,
    lastScanAt: source.lastScanAt ? source.lastScanAt.toISOString() : null,
    tables: source.tables,
    records: source.records,
    findings: source.findingsCount,
    scannable: source.connectionConfig != null,
  }));
});

// PATCH /api/sources/:id — actualizar fuente (admin)
router.patch("/:id", requireRole("admin"), async (req, res) => {
  const { id } = UpdateSourceParams.parse(req.params);
  const body = UpdateSourceBody.parse(req.body);
  const tenantId = resolvedOrgContext(req).organizationId;

  // M23.1 — para validar el match connection.kind ↔ kind efectivo necesitamos
  // la fuente actual (kind puede omitirse en el PATCH). 404 sin mutar si no
  // existe o es de otro tenant (mismo contrato que updateSource → null).
  const existing = await repos.sources.getById(id, tenantId);
  if (!existing) {
    throw notFound("Source not found");
  }

  let connection: SourceConnectionConfig | undefined = undefined;
  if (body.connection) {
    const effectiveKind = body.kind ?? existing.kind;
    if (body.connection.kind !== effectiveKind) {
      throw badRequest("connection.kind must match the source kind");
    }
    connection = body.connection;
  }

  const updated = await repos.sources.updateSource(id, {
    name: body.name,
    kind: body.kind,
    environment: body.environment,
    connection,
  }, tenantId);
  if (!updated) {
    throw notFound("Source not found");
  }

  // FASE 7.0.5 (M1): conteo real de hallazgos en lugar del hardcode 0
  const withCount = await repos.sources.getByIdWithFindingsCount(id, tenantId);

  // M17 — actualización de fuente: se auditan los CAMPOS enviados (nombres),
  // nunca los valores (la conexión incluye contraseña).
  await recordAuditEvent({
    req,
    action: "source_updated",
    resourceType: "source",
    resourceId: updated.id,
    result: "success",
    metadata: { fields: Object.keys(body) },
  });

  res.json(UpdateSourceResponse.parse({
    id: updated.id,
    name: updated.name,
    kind: updated.kind,
    environment: updated.environment,
    status: updated.status,
    lastScanAt: updated.lastScanAt ? updated.lastScanAt.toISOString() : null,
    tables: updated.tables,
    records: updated.records,
    findings: withCount?.findingsCount ?? 0,
    scannable: updated.connectionConfig != null,
  }));
});

// DELETE /api/sources/:id — eliminar fuente (admin)
router.delete("/:id", requireRole("admin"), async (req, res) => {
  const { id } = DeleteSourceParams.parse(req.params);
  const tenantId = resolvedOrgContext(req).organizationId;
  const deleted = await repos.sources.deleteSource(id, tenantId);
  if (!deleted) {
    throw notFound("Source not found");
  }

  // M17 — borrado de fuente. Sin metadata: el recurso ya no existe y no se
  // conserva ninguna copia de su configuración.
  await recordAuditEvent({
    req,
    action: "source_deleted",
    resourceType: "source",
    resourceId: id,
    result: "success",
  });

  res.status(204).end();
});

/**
 * M10.5 — Horario de escaneo automático por fuente (scheduled scans).
 * GET es lectura autenticada; PUT es admin (igual que el resto de mutaciones
 * de fuentes). Sin fila de schedule → default disabled (intervalo diario,
 * `SCAN_SCHEDULE_DEFAULT_MINUTES`), según el contrato `GetSourceScheduleResponse`.
 */

function toScheduleResponse(row: {
  sourceId: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
}) {
  return {
    sourceId: row.sourceId,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastStatus: row.lastStatus,
  };
}

// GET /api/sources/:id/schedule — horario de la fuente (autenticado)
router.get("/:id/schedule", async (req, res) => {
  const { id } = GetSourceScheduleParams.parse(req.params);
  const tenantId = resolvedOrgContext(req).organizationId;
  const source = await repos.sources.getById(id, tenantId);
  if (!source) {
    throw notFound("Source not found");
  }
  const schedule = await repos.scanSchedules.getBySourceId(id, tenantId);
  const response = schedule
    ? toScheduleResponse(schedule)
    : toScheduleResponse({
        sourceId: id,
        enabled: false,
        intervalMinutes: SCAN_SCHEDULE_DEFAULT_MINUTES,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
      });
  res.json(GetSourceScheduleResponse.parse(response));
});

// PUT /api/sources/:id/schedule — crear/actualizar horario (admin)
router.put("/:id/schedule", requireRole("admin"), async (req, res) => {
  const { id } = UpdateSourceScheduleParams.parse(req.params);
  const body = UpdateSourceScheduleBody.parse(req.body);
  const tenantId = resolvedOrgContext(req).organizationId;

  // Regla de negocio del contrato: enabled=true exige intervalo dentro de
  // [15, 10080]; enabled=false lo acepta opcional (default diario). Se usa la
  // MISMA función pura que valida el repo (única fuente de verdad; sin SQL
  // directo en la ruta).
  const normalized = normalizeIntervalMinutes({
    enabled: body.enabled,
    intervalMinutes: body.intervalMinutes,
  });
  if (!normalized.ok) {
    throw badRequest(
      normalized.reason === "missing_interval"
        ? "intervalMinutes is required when enabled is true"
        : "intervalMinutes must be an integer between 15 and 10080",
    );
  }

  // M17 — se lee el estado PREVIO del horario para poder clasificar la acción
  // (creado / habilitado / deshabilitado / actualizado) y registrar el
  // before→after. Se guardan SNAPSHOTS de los valores previos (no la fila) para
  // que la clasificación no dependa de la identidad del objeto devuelto.
  const previous = await repos.scanSchedules.getBySourceId(id, tenantId);
  const previousEnabled = previous?.enabled ?? null;
  const previousIntervalMinutes = previous?.intervalMinutes ?? null;

  const result = await repos.scanSchedules.upsert({
    sourceId: id,
    enabled: body.enabled,
    intervalMinutes: normalized.intervalMinutes,
    at: new Date(),
  }, tenantId);
  if (!result.ok) {
    if (result.reason === "source_not_found") {
      throw notFound("Source not found");
    }
    throw badRequest("intervalMinutes must be an integer between 15 and 10080");
  }

  // M17 — una única acción por request (sin eventos duplicados): el primer PUT
  // crea el horario; después se distingue el cambio de estado de la mera
  // reprogramación del intervalo.
  const action =
    previousEnabled === null
      ? "schedule_created"
      : previousEnabled !== result.schedule.enabled
        ? result.schedule.enabled
          ? "schedule_enabled"
          : "schedule_disabled"
        : "schedule_updated";

  await recordAuditEvent({
    req,
    action,
    resourceType: "schedule",
    resourceId: id,
    result: "success",
    metadata: {
      enabled: result.schedule.enabled,
      intervalMinutes: result.schedule.intervalMinutes,
      previousEnabled,
      previousIntervalMinutes,
    },
  });

  res.json(UpdateSourceScheduleResponse.parse(toScheduleResponse(result.schedule)));
});

export default router;