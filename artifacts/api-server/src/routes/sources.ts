import { Router, type IRouter } from "express";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
import { notFound } from "../lib/errors";
import {
  CreateSourceBody,
  CreateSourceResponse,
  GetSourceParams,
  GetSourceResponse,
  UpdateSourceBody,
  UpdateSourceParams,
  UpdateSourceResponse,
  DeleteSourceParams,
} from "@workspace/api-zod";
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

export default router;