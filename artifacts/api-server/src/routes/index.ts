import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import privacyRouter from "./privacy";
import sourcesRouter from "./sources";
import usersRouter from "./users";
import auditRouter from "./audit";
import organizationsRouter from "./organizations";
import csrfRouter from "./csrf";
import { requireAuth } from "../auth/middleware";
import { requireCsrf } from "../auth/csrf";
import { attachOrgContext } from "../auth/org-context";
import { metrics } from "../lib/metrics";

/**
 * M21.7.2 — REINOS DE AUTORIZACIÓN (ADR-003 D2).
 *
 * La cadena global de /api resuelve AUTENTICACIÓN (requireAuth → req.user),
 * CSRF (requireCsrf) y el contexto de organización de forma leniente
 * (attachOrgContext → req.orgContext si existe membership). La AUTORIZACIÓN se
 * divide en DOS reinos explícitos:
 *
 *   PLATAFORMA  → `requirePlatformAdmin()` (alias de requireRole("admin"),
 *                 SIN resolvedOrgContext). Superficie: /api/users,
 *                 PATCH /rules/:id y —en M21.7.3— la auditoría de plataforma.
 *                 Un admin global sin membership puede operar esta superficie.
 *
 *   ORGANIZACIÓN → `resolvedOrgContext` (requiere contexto de org válido;
 *                 fail-closed), opcionalmente + `requireOrgRole`. Superficie:
 *                 sources, scans, findings, reports, activity, dashboard,
 *                 compliance, masking, schedule y auditoría org-scoped.
 *
 * Matriz efectiva (M21.7.2, decisiones B+C):
 *   - Admin global, sin org:  plataforma 200; auditoría/negocio 403.
 *   - Admin global, con org:  todo 200.
 *   - Admin de org, sin rol global: lectura de negocio 200; plataforma,
 *     auditoría y mutaciones de negocio 403 (las mutaciones conservan
 *     requireRole("admin") global).
 *   - Miembro/auditor de org: lectura de negocio 200; resto 403.
 */
const router: IRouter = Router();

// Endpoints públicos: health check y flujo de autenticación (login/logout/me).
router.use(healthRouter);
router.use("/auth", authRouter);

// M16.4 — métricas operativas en formato Prometheus. Público igual que los
// health probes: es infraestructura operativa (un scraper de métricas no tiene
// sesión de usuario); en despliegues con perímetro, el reverse proxy puede
// restringirlo por red. Contenido: solo contadores/gauge/histograma — sin
// datos de negocio ni secretos.
router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
});

// Todo lo demás bajo /api requiere autenticación JWT.
router.use(requireAuth());

// M11.1 — CSRF centralizado: exige X-CSRF-Token en POST/PUT/PATCH/DELETE
// cuando la sesión viaja por cookie de navegador. Debe ir DESPUÉS de que
// requireAuth resolvió req.user y ANTES de los handlers mutativos.
router.use(requireCsrf());

// M21.7 — contexto de organización (leniente): pobla `req.orgContext` para que
// los routers de negocio resuelvan su scoping. El fail-closed estricto vive en
// `resolvedOrgContext` (reino organización): sin contexto = 403, nunca datos
// sin scoping.
router.use(attachOrgContext());

router.use(privacyRouter);

// CRUD de fuentes de datos (FASE 7.0.0): listado leíble por cualquier usuario
// autenticado; mutaciones exigen rol `admin` (dentro del router).
router.use("/sources", sourcesRouter);

// Administración de usuarios: adicionalmente exige rol `admin` (dentro del
// router). Montado tras requireAuth para que req.user esté disponible.
router.use("/users", usersRouter);

// M17 — trazabilidad administrativa (solo rol `admin`, aplicado dentro del
// router). Montado tras requireAuth para que req.user esté disponible y el
// correlation id del request (M16.1) ya exista.
router.use("/audit-events", auditRouter);

// GET /api/csrf-token — expone SOLO el token CSRF de la sesión actual.
router.use("/csrf-token", csrfRouter);

// M21.2 — organizaciones, membresías e invitaciones (ADR-002). Montado tras
// requireAuth + requireCsrf: el contexto de organización activa se resuelve
// SIEMPRE server-side (requireOrgContext) y las mutaciones exigen roles de
// organización (requireOrgRole) dentro del router.
router.use("/orgs", organizationsRouter);

export default router;
