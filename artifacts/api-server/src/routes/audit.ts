import { Router, type IRouter } from "express";
import { ListAuditEventsQueryParams, ListAuditEventsResponse, ListAuditEventsPlatformQueryParams, ListAuditEventsPlatformResponse } from "@workspace/api-zod";
import { repos } from "../repositories";
import { requirePlatformAdmin } from "../auth/middleware";
import { resolvedOrgContext } from "../auth/org-context";
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
 * Seguridad (M21.7.2, decisión B — reino ORGANIZACIÓN, org-scoped):
 * - Requiere rol GLOBAL `admin` (el `requireRole` del router) Y contexto de
 *   organización válido (`resolvedOrgContext` en el handler).
 * - Por tanto: admin global + org → acceso; admin global sin org → 403 (falta
 *   contexto); admin de org sin rol global → 403 (falta rol global).
 * - La paginación se resuelve en SQL (LIMIT/OFFSET, `parsePagination`): la
 *   tabla de auditoría nunca se devuelve completa y `limit > 100` → 400.
 * - `metadata` se sirve tal cual se persistió: su contenido seguro se garantiza
 *   en el punto de registro (`lib/audit.ts`), no aquí.
 */
const router: IRouter = Router();

// M21.7.2/7.3 — ambos endpoints exigen rol global admin (reino plataforma).
// El endpoint org-scoped añade resolvedOrgContext en el handler; el de
// plataforma NO (un admin global sin membership debe poder consultarlo).
router.use(requirePlatformAdmin());

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

/**
 * GET /api/audit-events/platform — reino PLATAFORMA (M21.7.3).
 *
 * Devuelve SOLO eventos con `tenant_id IS NULL` (acciones de plataforma y
 * eventos de sistema sin organización). NO usa `resolvedOrgContext`: un admin
 * global sin membership puede consultarlo. Conjunto disjunto de
 * `GET /api/audit-events` (org-scoped).
 */
router.get("/platform", async (req, res) => {
  const params = ListAuditEventsPlatformQueryParams.parse(req.query);
  const pagination = parsePagination(req.query);

  const from = parseInstant(params.from, "from");
  const to = parseInstant(params.to, "to");
  if (from && to && from.getTime() > to.getTime()) {
    throw badRequest("from must be earlier than or equal to to");
  }

  const rows = await repos.auditEvents.listPlatform(
    {
      actorUserId: params.actor,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      result: params.result,
      from,
      to,
    },
    pagination,
  );

  res.json(ListAuditEventsPlatformResponse.parse(rows.map(mapAuditEvent)));
});

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
      tenantId: resolvedOrgContext(req).organizationId,
    },
    pagination,
  );

  // La salida se valida contra el contrato (misma política que el resto de
  // listados): fechas ISO + vocabulario de action/resourceType/result.
  res.json(ListAuditEventsResponse.parse(rows.map(mapAuditEvent)));
});

export default router;