import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Liveness is always 200. Readiness (DB connectivity) is opt-in via the
// HEALTHCHECK_DB env var (values "true"/"1") so local dev and unit tests never
// require a database. Deployments set HEALTHCHECK_DB=true so the startup probe
// fails fast if PostgreSQL is unreachable.
function dbCheckEnabled(): boolean {
  const raw = process.env.HEALTHCHECK_DB;
  return raw === "true" || raw === "1";
}

router.get("/healthz", async (_req, res) => {
  if (dbCheckEnabled()) {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      logger.error({ err: error }, "Healthcheck: database unreachable");
      res.status(503).json({ status: "error" });
      return;
    }
  }
  res.json(HealthCheckResponse.parse({ status: "ok" }));
});

export default router;
