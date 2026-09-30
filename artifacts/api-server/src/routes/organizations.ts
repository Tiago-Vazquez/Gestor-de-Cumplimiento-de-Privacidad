/**
 * Rutas de organizaciones y membresías (M21.2 — ADR-002).
 *
 * Endpoints:
 *   GET    /api/orgs                            — organizaciones del usuario
 *   GET    /api/orgs/current                    — organización activa de la sesión
 *   POST   /api/orgs/active                     — fija la organización activa
 *   GET    /api/orgs/current/members            — miembros de la org activa
 *   PATCH  /api/orgs/current/members/:sub       — cambia el rol de un miembro
 *   DELETE /api/orgs/current/members/:sub       — elimina un miembro
 *   GET    /api/orgs/current/invitations        — invitaciones de la org
 *   POST   /api/orgs/current/invitations        — crea una invitación (token una vez)
 *   DELETE /api/orgs/current/invitations/:id    — revoca una invitación
 *   POST   /api/orgs/invitations/accept         — acepta una invitación (personal)
 *
 * Seguridad (cadena AUTHENTICACIÓN → MEMBERSHIP → AUTORIZACIÓN):
 * - El router se monta tras requireAuth + requireCsrf en routes/index.ts.
 * - El contexto de organización activa se resuelve SIEMPRE server-side
 *   (`requireOrgContext` re-valida sesión + membership en cada request);
 *   NUNCA se acepta `organization_id` del cliente para autorizar.
 * - `requireOrgRole("owner", "admin")` gobierna las mutaciones de members e
 *   invitaciones; la invariante "la org nunca queda sin owner/admin" y la
 *   protección del `owner` viven DENTRO del repositorio (locks FOR UPDATE),
 *   la ruta solo mapea los errores a problem+json.
 * - El token de invitación se entrega UNA sola vez en la respuesta de creación
 *   y no se persiste (solo su hash SHA-256); NUNCA se registra en auditoría.
 */
import { Router } from "express";
import { z } from "zod";
import { repos } from "../repositories";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import { requireOrgContext, requireOrgRole, type OrgAuthedRequest } from "../auth/org-context";
import { authDisabled } from "../auth/tokens";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { normalizeEmail } from "../auth/validation";
import { logger } from "../lib/logger";
import { recordAuditEvent } from "../lib/audit";
import {
  INVITATION_TTL_MS,
  INVITABLE_ROLES,
  generateInvitationToken,
  hashInvitationToken,
} from "../repositories/invitations.repo";

const router: ReturnType<typeof Router> = Router();

/** F1 (6.3B.20): los path params se validan explícitamente. */
const SubParams = z.object({ sub: z.string().min(1).max(64) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const ActiveOrgBody = z.object({ organizationId: z.string().min(1).max(64) });
const RoleBody = z.object({ role: z.enum(["admin", "auditor", "member"]) });
const InvitationBody = z.object({
  email: z.string().min(3).max(254),
  role: z.enum(["admin", "auditor", "member"]),
});
const AcceptBody = z.object({ token: z.string().min(16).max(256) });

/** Identidad autenticada del request (el router vive tras requireAuth). */
function requireUser(req: AuthedRequest): { sub: string; email: string | null; jti?: string } {
  const user = req.user;
  if (!user?.sub) throw unauthorized("Missing or invalid session");
  return user;
}

/** Contexto de organización ya resuelto por requireOrgContext. */
function requireContext(req: AuthedRequest): { organizationId: string; role: string } {
  const context = (req as OrgAuthedRequest).orgContext;
  if (!context) throw forbidden("No active organization");
  return context;
}

/** GET /api/orgs — organizaciones del usuario autenticado (orden de ingreso). */
router.get("/", async (req, res) => {
  const user = requireUser(req as AuthedRequest);
  const memberships = await repos.memberships.listByUser(user.sub);
  res.status(200).json(memberships);
});

/** GET /api/orgs/current — organización activa de la sesión (+ rol del usuario). */
router.get("/current", requireOrgContext(), async (req, res) => {
  const user = requireUser(req as AuthedRequest);
  const context = requireContext(req as AuthedRequest);
  const [org, membership] = await Promise.all([
    repos.organizations.getById(context.organizationId),
    repos.memberships.getByUserAndOrg(user.sub, context.organizationId),
  ]);
  if (!org) throw notFound("Organization not found");
  res.status(200).json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    role: membership?.role ?? context.role,
    joinedAt: membership?.joinedAt ?? null,
  });
});

/**
 * POST /api/orgs/active — fija la organización activa de la SESIÓN.
 * Único punto donde el cliente influye en el contexto, y solo nombrando una
 * organización de la que YA es miembro: la autoridad sigue siendo la BD.
 */
router.post("/active", async (req, res) => {
  const user = requireUser(req as AuthedRequest);
  const parsed = ActiveOrgBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("organizationId is required");
  const { organizationId } = parsed.data;

  // Espejo exacto del bypass de requireAuth/requireOrgContext en dev/tests.
  if (authDisabled()) {
    res.status(200).json({ organizationId, role: "owner" });
    return;
  }
  if (!user.jti) throw unauthorized("Missing or invalid session");

  const membership = await repos.memberships.getByUserAndOrg(user.sub, organizationId);
  if (!membership) throw forbidden("Not a member of this organization");

  const switched = await repos.sessions.setActiveOrganization(
    user.jti,
    user.sub,
    organizationId,
  );
  if (!switched) throw unauthorized("Missing or invalid session");

  logger.info(
    { event: "org_context_switched", sub: user.sub, organizationId },
    "Active organization switched",
  );
  await recordAuditEvent({
    req,
    action: "org_context_switched",
    resourceType: "organization",
    resourceId: organizationId,
    result: "success",
  });

  res.status(200).json({ organizationId, role: membership.role });
});

/** GET /api/orgs/current/members — miembros de la organización activa. */
router.get("/current/members", requireOrgContext(), async (req, res) => {
  const context = requireContext(req as AuthedRequest);
  res.status(200).json(await repos.memberships.listByOrg(context.organizationId));
});

/**
 * PATCH /api/orgs/current/members/:sub — cambia el rol de un miembro
 * (owner|admin). `owner` es inmutable (M21.2: la transferencia es una
 * operación explícita futura); la invariante de último owner/admin la aplica
 * el repositorio dentro de su transacción.
 */
router.patch(
  "/current/members/:sub",
  requireOrgContext(),
  requireOrgRole("owner", "admin"),
  async (req, res) => {
    const actor = requireUser(req as AuthedRequest);
    const context = requireContext(req as AuthedRequest);
    const { sub } = SubParams.parse(req.params);
    const parsed = RoleBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("role must be one of 'admin', 'auditor' or 'member'");

    const result = await repos.memberships.updateRole(
      context.organizationId,
      sub,
      parsed.data.role,
    );

    logger.info(
      {
        event: "member_role_updated",
        sub: actor.sub,
        target: sub,
        organizationId: context.organizationId,
        role: parsed.data.role,
        revokedSessions: result.revokedSessions,
      },
      "Member role updated",
    );
    await recordAuditEvent({
      req,
      action: "member_role_updated",
      resourceType: "membership",
      resourceId: sub,
      result: "success",
      metadata: {
        organizationId: context.organizationId,
        role: parsed.data.role,
        revokedSessions: result.revokedSessions,
      },
    });

    res.status(200).json({
      sub,
      role: parsed.data.role,
      revokedSessions: result.revokedSessions,
    });
  },
);

/**
 * DELETE /api/orgs/current/members/:sub — elimina un miembro (owner|admin).
 * El afectado pierde el acceso empresarial AL INSTANTE: sus sesiones se
 * revocan y su contexto activo se limpia en la misma transacción del repo.
 */
router.delete(
  "/current/members/:sub",
  requireOrgContext(),
  requireOrgRole("owner", "admin"),
  async (req, res) => {
    const actor = requireUser(req as AuthedRequest);
    const context = requireContext(req as AuthedRequest);
    const { sub } = SubParams.parse(req.params);

    const result = await repos.memberships.remove(context.organizationId, sub);

    logger.info(
      {
        event: "member_removed",
        sub: actor.sub,
        target: sub,
        organizationId: context.organizationId,
        revokedSessions: result.revokedSessions,
      },
      "Member removed from organization",
    );
    await recordAuditEvent({
      req,
      action: "member_removed",
      resourceType: "membership",
      resourceId: sub,
      result: "success",
      metadata: {
        organizationId: context.organizationId,
        revokedSessions: result.revokedSessions,
      },
    });

    res.status(200).json({
      removed: true,
      revokedSessions: result.revokedSessions,
    });
  },
);

/** GET /api/orgs/current/invitations — invitaciones de la org (owner|admin). */
router.get(
  "/current/invitations",
  requireOrgContext(),
  requireOrgRole("owner", "admin"),
  async (req, res) => {
    const context = requireContext(req as AuthedRequest);
    res.status(200).json(await repos.invitations.listByOrg(context.organizationId));
  },
);

/**
 * POST /api/orgs/current/invitations — crea una invitación (owner|admin).
 * El token se entrega UNA única vez en esta respuesta (flujo temporal MVP sin
 * email); en BD solo vive su hash. El `owner` nunca se invita: se transfiere.
 */
router.post(
  "/current/invitations",
  requireOrgContext(),
  requireOrgRole("owner", "admin"),
  async (req, res) => {
    const actor = requireUser(req as AuthedRequest);
    const context = requireContext(req as AuthedRequest);
    const parsed = InvitationBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest("email and role ('admin' | 'auditor' | 'member') are required");
    }
    const email = normalizeEmail(parsed.data.email);
    if (!email) throw badRequest("A valid email is required");
    if (!INVITABLE_ROLES.includes(parsed.data.role)) {
      throw badRequest("role must be one of 'admin', 'auditor' or 'member'");
    }

    const token = generateInvitationToken();
    const invitation = await repos.invitations.create({
      organizationId: context.organizationId,
      email,
      role: parsed.data.role,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      invitedBy: actor.sub,
    });

    logger.info(
      {
        event: "invitation_created",
        sub: actor.sub,
        organizationId: context.organizationId,
        invitationId: invitation.id,
        role: invitation.role,
      },
      "Invitation created",
    );
    // NUNCA se registra el token (ni su hash) en auditoría ni en logs.
    await recordAuditEvent({
      req,
      action: "invitation_created",
      resourceType: "invitation",
      resourceId: invitation.id,
      result: "success",
      metadata: { organizationId: context.organizationId, role: invitation.role },
    });

    res.status(201).json({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      token,
    });
  },
);

/** DELETE /api/orgs/current/invitations/:id — revoca una invitación (owner|admin). */
router.delete(
  "/current/invitations/:id",
  requireOrgContext(),
  requireOrgRole("owner", "admin"),
  async (req, res) => {
    const context = requireContext(req as AuthedRequest);
    const { id } = IdParams.parse(req.params);

    const revoked = await repos.invitations.revoke(context.organizationId, id);
    if (!revoked) throw notFound("Invitation not found");

    await recordAuditEvent({
      req,
      action: "invitation_revoked",
      resourceType: "invitation",
      resourceId: id,
      result: "success",
      metadata: { organizationId: context.organizationId },
    });

    res.status(200).json({ revoked: true });
  },
);

/**
 * POST /api/orgs/invitations/accept — aceptación PERSONAL de una invitación.
 * Requiere sesión válida pero NO contexto de organización (el invitado aún no
 * pertenece a ninguna org, o no a esta). La invitación se consume de forma
 * atómica: transacción + FOR UPDATE en el repo cierran la doble aceptación.
 * La asignación automática de la org activa ocurre al volver a iniciar sesión;
 * aquí el invitado puede fijarla con POST /api/orgs/active.
 */
router.post("/invitations/accept", async (req, res) => {
  const user = requireUser(req as AuthedRequest);
  const parsed = AcceptBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("token is required");

  const result = await repos.invitations.consumeByTokenHash({
    tokenHash: hashInvitationToken(parsed.data.token),
    userSub: user.sub,
    now: new Date(),
    // La invitación es personal: si el email no coincide, mismo contrato que
    // un token inexistente (no se filtra cuál de los dos falló).
    expectedEmail: user.email ?? undefined,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        throw notFound("Invitation not found");
      case "expired":
        throw new AppError(410, "Gone", "Invitation expired");
      case "already_accepted":
        throw conflict("Invitation already accepted");
      case "already_member":
        throw conflict("Already a member of this organization");
    }
  }

  logger.info(
    {
      event: "invitation_accepted",
      sub: user.sub,
      organizationId: result.organizationId,
      invitationId: result.invitationId,
      role: result.role,
    },
    "Invitation accepted",
  );
  await recordAuditEvent({
    req,
    action: "invitation_accepted",
    resourceType: "invitation",
    resourceId: result.invitationId,
    result: "success",
    metadata: { organizationId: result.organizationId, role: result.role },
  });

  res.status(201).json({
    organizationId: result.organizationId,
    role: result.role,
  });
});

export default router;
