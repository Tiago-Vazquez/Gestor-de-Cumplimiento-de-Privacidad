/**
 * Rutas de administración de usuarios (solo rol `admin`).
 *
 * Endpoints:
 *   GET    /api/users          — lista segura de usuarios
 *   GET    /api/users/:sub     — usuario individual
 *   PATCH  /api/users/:sub     — modificar email/name (NO sub)
 *   PATCH  /api/users/:sub/roles — reemplazar roles (backend-authoritative)
 *
 * Seguridad:
 * - Todos los endpoints exigen requireAuth() + requireRole("admin").
 * - NUNCA se devuelve passwordHash ni ninguna credencial.
 * - Los roles NUNCA provienen del cliente: se leen/escriben en `user_roles`.
 * - Protección del último administrador (6.3B.10): la invariante "siempre ≥ 1
 *   admin" se aplica DENTRO de la transacción del repositorio con locks
 *   `FOR UPDATE` (sin carrera TOCTOU y sin N+1); la ruta solo mapea el 403.
 * - No hay DELETE en esta fase (requiere política completa de último admin).
 */
import { Router } from "express";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
import { normalizeEmail, isValidName } from "../auth/validation";
import { badRequest, conflict, notFound } from "../lib/errors";
import { logger } from "../lib/logger";

const router: ReturnType<typeof Router> = Router();

const VALID_ROLES = new Set(["admin", "auditor"]);

/** Proyección pública de un usuario: nunca incluye passwordHash. */
function toPublicUser(user: {
  sub: string;
  email: string;
  name: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}, roles: string[]) {
  return {
    sub: user.sub,
    email: user.email,
    name: user.name,
    roles,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

// Todas las rutas de este router requieren sesión válida + rol admin.
router.use(requireRole("admin"));

/** GET /api/users — listado seguro de usuarios con sus roles. */
router.get("/", async (_req, res) => {
  const users = await repos.users.listUsers();
  const result = await Promise.all(
    users.map(async (user) =>
      toPublicUser(user, await repos.userRoles.listRolesForUser(user.sub)),
    ),
  );
  res.status(200).json(result);
});

/** GET /api/users/:sub — usuario individual (proyección pública). */
router.get("/:sub", async (req, res) => {
  const user = await repos.users.getBySub(req.params.sub);
  if (!user) throw notFound("User not found");
  const roles = await repos.userRoles.listRolesForUser(user.sub);
  res.status(200).json(toPublicUser(user, roles));
});

/** PATCH /api/users/:sub — modifica solo email/name; `sub` es inmutable. */
router.patch("/:sub", async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; name?: unknown };
  const updates: { email?: string; name?: string | null } = {};

  if (body.email !== undefined) {
    if (typeof body.email !== "string") throw badRequest("Invalid email");
    const normalized = normalizeEmail(body.email);
    if (!normalized) throw badRequest("A valid email is required");
    const existing = await repos.users.getByEmail(normalized);
    if (existing && existing.sub !== req.params.sub) {
      throw conflict("Email already in use");
    }
    updates.email = normalized;
  }

  if (body.name !== undefined) {
    if (body.name === null) {
      updates.name = null;
    } else if (isValidName(body.name)) {
      updates.name = body.name.trim();
    } else {
      throw badRequest("Invalid name");
    }
  }

  if (Object.keys(updates).length === 0) {
    throw badRequest("No updatable fields provided (email, name)");
  }

  const updated = await repos.users.updateProfile(req.params.sub, updates);
  if (!updated) throw notFound("User not found");
  const roles = await repos.userRoles.listRolesForUser(updated.sub);
  logger.info({ sub: updated.sub, event: "user_updated" }, "User updated by admin");
  res.status(200).json(toPublicUser(updated, roles));
});

/** PATCH /api/users/:sub/roles — reemplaza roles; autoridad exclusiva del backend. */
router.patch("/:sub/roles", async (req, res) => {
  const body = (req.body ?? {}) as { roles?: unknown };

  if (!Array.isArray(body.roles) || body.roles.some((r) => !VALID_ROLES.has(r as string))) {
    throw badRequest("roles must be an array containing only 'admin' and/or 'auditor'");
  }
  const nextRoles = [...new Set(body.roles as string[])];

  const user = await repos.users.getBySub(req.params.sub);
  if (!user) throw notFound("User not found");

  // Los roles van embebidos en el JWT y `requireRole` no relee la BD; por eso
  // un cambio EFECTIVO de roles revoca todas las sesiones activas del usuario.
  // 6.3B.10: la invariante de último admin y la detección de cambio efectivo
  // se evalúan DENTRO de la transacción del repositorio (locks FOR UPDATE),
  // de modo que la decisión se toma sobre el estado real al momento de mutar.
  // Si la operación dejaría 0 admins, el repo lanza el 403 y hace ROLLBACK.
  const result = await repos.userRoles.setRolesAndRevokeSessions(user.sub, nextRoles);

  logger.info(
    {
      sub: user.sub,
      event: "roles_changed",
      roles: result.applied,
      revokedSessions: result.revokedSessions,
    },
    "User roles changed",
  );
  res.status(200).json(toPublicUser(user, result.applied));
});

export default router;