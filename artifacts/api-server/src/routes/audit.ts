import { Router, type IRouter } from "express";
import { ListAuditEventsQueryParams, ListAuditEventsResponse } from "@workspace/api-zod";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
import { optionalOrgContext } from "../auth/org-context";
import { badRequest } from "../lib/errors";
import { parsePagination } from "../lib/pagination";
import { mapAuditEvent } from "../mappers";

/**
 * M17 — Trazabilidad administrativa: consulta de `audit_events`.
 *
 * Endpoint:
 *   GET /api/audit-events — eventos más recientes primero, paginados y con
 *   filtros combinables (actor, action, resourceType, resourceId, result,
 *   rango temporal from/to).
 *
 * Seguridad:
 * - SOLO rol `admin` (el `requireRole` del router se aplica a todas las rutas).
 * - La paginación se resuelve en SQL (LIMIT/OFFSET, `parsePagination`): la
 *   tabla de auditoría nunca se devuelve completa y `limit > 100` → 400.
 * - `metadata` se sirve tal cual se persistió: su contenido seguro se garantiza
 *   en el punto de registro (`lib/audit.ts`), no aquí.
 */
const router: IRouter = Router();

router.use(requireRole("admin"));

/**
 * Convierte un filtro temporal ISO-8601 en `Date`. Un valor no parseable → 400
 * (el contrato no declara `format: date-time` para evitar `zod.uuid()`/
 * `zod.int()` de Zod 4 en el cliente generado, así que la validación temporal
 * vive aquí, igual que la semántica de rango).
 */
function parseInstant(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`${field} must be an ISO-8601 date-time`);
  }
  return parsed;
}

router.get("/", async (req, res) => {
  const params = ListAuditEventsQueryParams.parse(req.query);
  const pagination = parsePagination(req.query);

  const from = parseInstant(params.from, "from");
  const to = parseInstant(params.to, "to");
  if (from && to && from.getTime() > to.getTime()) {
    throw badRequest("from must be earlier than or equal to to");
  }

  const rows = await repos.auditEvents.list(
    {
      actorUserId: params.actor,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      result: params.result,
      from,
      to,
      // M21.3 — scoping por tenant activo (D2).
      tenantId: optionalOrgContext(req)?.organizationId,
    },
    pagination,
  );

  // La salida se valida contra el contrato (misma política que el resto de
  // listados): fechas ISO + vocabulario de action/resourceType/result.
  res.json(ListAuditEventsResponse.parse(rows.map(mapAuditEvent)));
});

export default router;