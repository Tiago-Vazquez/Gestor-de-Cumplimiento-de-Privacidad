import { Router, type IRouter } from "express";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
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
  const connection: SourceConnectionConfig | undefined = body.connection
    ? {
        host: body.connection.host,
        port: body.connection.port,
        database: body.connection.database,
        user: body.connection.user,
        password: body.connection.password,
        schema: body.connection.schema,
      }
    : undefined;

  const created = await repos.sources.createSource({
    name: body.name,
    kind: body.kind,
    environment: body.environment,
    connection,
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
  // FASE 7.0.5 (M1): conteo real de hallazgos en lugar del hardcode 0
  const source = await repos.sources.getByIdWithFindingsCount(id);
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

  let connection: SourceConnectionConfig | undefined = undefined;
  if ("connection" in body && body.connection) {
    connection = {
      host: body.connection.host,
      port: body.connection.port,
      database: body.connection.database,
      user: body.connection.user,
      password: body.connection.password,
      schema: body.connection.schema,
    };
  }

  const updated = await repos.sources.updateSource(id, {
    name: body.name,
    kind: body.kind,
    environment: body.environment,
    connection,
  });
  if (!updated) {
    throw notFound("Source not found");
  }

  // FASE 7.0.5 (M1): conteo real de hallazgos en lugar del hardcode 0
  const withCount = await repos.sources.getByIdWithFindingsCount(id);

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
  const deleted = await repos.sources.deleteSource(id);
  if (!deleted) {
    throw notFound("Source not found");
  }
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
  const source = await repos.sources.getById(id);
  if (!source) {
    throw notFound("Source not found");
  }
  const schedule = await repos.scanSchedules.getBySourceId(id);
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

  const result = await repos.scanSchedules.upsert({
    sourceId: id,
    enabled: body.enabled,
    intervalMinutes: normalized.intervalMinutes,
    at: new Date(),
  });
  if (!result.ok) {
    if (result.reason === "source_not_found") {
      throw notFound("Source not found");
    }
    throw badRequest("intervalMinutes must be an integer between 15 and 10080");
  }
  res.json(UpdateSourceScheduleResponse.parse(toScheduleResponse(result.schedule)));
});

export default router;