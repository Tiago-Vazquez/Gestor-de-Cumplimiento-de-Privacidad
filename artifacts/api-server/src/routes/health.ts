import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// `HEALTHCHECK_DB` (valores "true"/"1") mantiene el chequeo de base de datos de
// `/healthz` como opt-in, para que desarrollo local y tests nunca exijan
// PostgreSQL. `/readyz` es en cambio fail-closed: es el probe con el que un
// orquestador decide si el proceso puede recibir tráfico.
function dbCheckEnabled(): boolean {
  const raw = process.env.HEALTHCHECK_DB;
  return raw === "true" || raw === "1";
}

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

// GET /api/livez — liveness: el proceso está vivo. Nunca consulta PostgreSQL,
// así que un fallo de base de datos no reinicia un contenedor sano.
router.get("/livez", (_req, res) => {
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// GET /api/readyz — readiness fail-closed: 200 solo si PostgreSQL responde.
router.get("/readyz", async (_req, res) => {
  if (!(await databaseReachable())) {
    res.status(503).json({ status: "error" });
    return;
  }
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

// GET /api/healthz — probe combinado original, conservado por compatibilidad
// (`.replit-artifact/artifact.toml` lo usa como startup probe).
router.get("/healthz", async (_req, res) => {
  if (dbCheckEnabled() && !(await databaseReachable())) {
    res.status(503).json({ status: "error" });
    return;
  }
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
