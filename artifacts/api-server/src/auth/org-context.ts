import type { NextFunction, Request, Response } from "express";
import { forbidden } from "./errors";
import { authDisabled } from "./tokens";
import type { AuthedRequest } from "./middleware";
import { repos } from "../repositories";
import { ORG_ROLES, type OrgRole } from "../repositories/memberships.repo";

/**
 * Organización sintética usada por el bypass de dev/tests (`AUTH_DISABLED`):
 * coincide con la organización canónica del backfill para que el scoping
 * estricto sea consistente en pruebas sin PostgreSQL real.
 */
const DEV_ORG_ID = "org-bootstrap";

/**
 * M21.2 — Contexto de organización (ADR-002).
 *
 * Cadena de autorización: AUTHENTICACIÓN (requireAuth: quién es) →
 * MEMBERSHIP (esta capa: ¿pertenece a la organización?) → AUTORIZACIÓN
 * (requireOrgRole: ¿qué puede hacer dentro de ella?).
 *
 * La organización activa vive en la SESIÓN (`sessions.active_org_id`) y se
 * re-resuelve contra la BD en cada request:
 * - Nunca se acepta `organization_id` del cliente por header/body para
 *   autorizar (solo `POST /api/orgs/active` lo fija, validando membership).
 * - Si la membership desapareció (baja/revocación), el contexto cae aunque el
 *   JWT siga vigente: fail-closed.
 * - Usuarios sin organizaciones: sin contexto (solo endpoints identitarios).
 *
 * En dev/tests con `AUTH_DISABLED=true` se inyecta un contexto sintético de
 * admin (espejo exacto del bypass de `requireAuth`/`requireRole`); en
 * producción el bypass NUNCA aplica.
 */

export interface OrgContext {
  organizationId: string;
  role: OrgRole;
}

export interface OrgAuthedRequest extends AuthedRequest {
  orgContext?: OrgContext;
}

/**
 * M21.7.2 — gate del REINO ORGANIZACIÓN.
 *
 * Devuelve el contexto de organización ya resuelto (por `requireOrgContext` o
 * `attachOrgContext`) y lanza 403 si no existe — fail-closed. Es el único
 * camino de acceso a los datos de negocio, SIEMPRE scoped a la organización
 * activa del request. Puede combinarse con `requireOrgRole` para las
 * operaciones que además exigen un rol dentro de la organización.
 */
export function resolvedOrgContext(req: Request): OrgContext {
  const context = (req as OrgAuthedRequest).orgContext;
  if (!context) {
    throw forbidden("No active organization");
  }
  return context;
}

/**
 * M21.3 — adjunta el contexto resuelto SIN fallar si no existe organización.
 * Espejo leniente de `requireOrgContext`: se usa en los routers de negocio
 * para poblar `req.orgContext` (scoping) sin romper a usuarios sin org.
 */
export function attachOrgContext() {
  return async function attachOrgContextMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const context = await resolveOrgContext(req);
    if (context) {
      (req as OrgAuthedRequest).orgContext = context;
    }
    next();
  };
}

export async function resolveOrgContext(
  req: Request,
): Promise<OrgContext | null> {
  if (authDisabled()) {
    // M21.5 — el contexto sintético de dev/tests se alinea con la organización
    // canónica del backfill (org-bootstrap), de modo que el scoping estricto
    // sea consistente entre pruebas AUTH_DISABLED y el flujo real.
    return { organizationId: DEV_ORG_ID, role: "owner" };
  }
  const user = (req as AuthedRequest).user;
  if (!user?.sub || !user.jti) return null;
  // Re-resuelve contra BD (sesión + membership viva).
  const resolved = await repos.sessions.resolveActiveOrganization(user.jti, user.sub);
  if (!resolved) return null;
  // Fail-closed: un role fuera del vocabulario (defensa en profundidad sobre
  // el CHECK de BD) no concede contexto.
  if (!ORG_ROLES.includes(resolved.role as OrgRole)) return null;
  return { organizationId: resolved.organizationId, role: resolved.role as OrgRole };
}

/** Exige contexto de organización válido (después de requireAuth). */
export function requireOrgContext() {
  return async function requireOrgContextMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const context = await resolveOrgContext(req);
    if (!context) {
      throw forbidden("No active organization");
    }
    (req as OrgAuthedRequest).orgContext = context;
    next();
  };
}

/**
 * Exige uno de los roles de la organización activa (después de requireOrgContext).
 * `owner > admin > auditor > member`.
 */
export function requireOrgRole(...roles: readonly OrgRole[]) {
  return function requireOrgRoleMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const context = (req as OrgAuthedRequest).orgContext;
    if (!context || !roles.includes(context.role)) {
      throw forbidden("Organization role required");
    }
    next();
  };
}