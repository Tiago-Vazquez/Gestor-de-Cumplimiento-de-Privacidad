import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { isScanSchedulerRunning } from "../services/scan-scheduler";

const router: IRouter = Router();

// `HEALTHCHECK_DB` (valores "true"/"1") mantiene el chequeo de base de datos de
// `/healthz` como opt-in, para que desarrollo local y tests nunca exijan
// PostgreSQL. `/readyz` es en cambio fail-closed: es el probe con el que un
// orquestador decide si el proceso puede recibir tráfico.
function dbCheckEnabled(): boolean {
  const raw = process.env.HEALTHCHECK_DB;
  return raw === "true" || raw === "1";
}

/**
 * M16.5 — respuesta enriquecida de los probes: estado del proceso + subsistemas
 * (base de datos, scheduler) SIN secretos. Campos aditivos sobre el contrato
 * `HealthCheckResponse` (el `status` se conserva; el OpenAPI no cambia).
 */
const EnrichedHealthResponse = z.object({
  status: z.enum(["ok", "error"]),
  /** `unknown` = este probe por diseño NO consulta la base de datos (livez/healthz opt-in). */
  database: z.enum(["ok", "error", "unknown"]),
  scheduler: z.enum(["running", "stopped"]),
});

/** Conectividad con PostgreSQL compartida por `/healthz` y `/readyz`. */
async function databaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    logger.error({ err: error }, "Healthcheck: database unreachable");
    return false;
  }
}

// GET /api/livez — liveness: el proceso está vivo. Nunca consulta PostgreSQL
// (un fallo de base de datos no reinicia un contenedor sano): `database` se
// reporta como "unknown" (no comprobada, por diseño).
router.get("/livez", (_req, res) => {
  res.json(EnrichedHealthResponse.parse({
    status: "ok",
    database: "unknown",
    scheduler: isScanSchedulerRunning() ? "running" : "stopped",
  }));
});

// GET /api/readyz — readiness fail-closed: 200 solo si PostgreSQL responde.
router.get("/readyz", async (_req, res) => {
  const database = (await databaseReachable()) ? "ok" : "error";
  res.status(database === "ok" ? 200 : 503).json(EnrichedHealthResponse.parse({
    status: database === "ok" ? "ok" : "error",
    database,
    scheduler: isScanSchedulerRunning() ? "running" : "stopped",
  }));
});

// GET /api/healthz — probe combinado original, conservado por compatibilidad
// (`.replit-artifact/artifact.toml` lo usa como startup probe). El chequeo de
// base de datos sigue siendo opt-in (HEALTHCHECK_DB).
router.get("/healthz", async (_req, res) => {
  const database = dbCheckEnabled() ? ((await databaseReachable()) ? "ok" : "error") : "unknown";
  res.status(database === "error" ? 503 : 200).json(EnrichedHealthResponse.parse({
    status: database === "error" ? "error" : "ok",
    database,
    scheduler: isScanSchedulerRunning() ? "running" : "stopped",
  }));
});

export default router;
