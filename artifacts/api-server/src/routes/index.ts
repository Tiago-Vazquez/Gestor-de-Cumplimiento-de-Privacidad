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

// M21.3 — contexto de organización (leniente, D2 transitorio): pobla
// `req.orgContext` para el scoping de los routers de negocio. Sin contexto =
// sin scoping (compatibilidad legacy); el fail-closed estricto vive en los
// endpoints de organizaciones (requireOrgContext).
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
