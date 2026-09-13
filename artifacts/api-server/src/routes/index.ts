import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import privacyRouter from "./privacy";
import sourcesRouter from "./sources";
import usersRouter from "./users";
import csrfRouter from "./csrf";
import { requireAuth } from "../auth/middleware";
import { requireCsrf } from "../auth/csrf";

const router: IRouter = Router();

// Endpoints públicos: health check y flujo de autenticación (login/logout/me).
router.use(healthRouter);
router.use("/auth", authRouter);

// Todo lo demás bajo /api requiere autenticación JWT.
router.use(requireAuth());

// M11.1 — CSRF centralizado: exige X-CSRF-Token en POST/PUT/PATCH/DELETE
// cuando la sesión viaja por cookie de navegador. Debe ir DESPUÉS de que
// requireAuth resolvió req.user y ANTES de los handlers mutativos.
router.use(requireCsrf());

router.use(privacyRouter);

// CRUD de fuentes de datos (FASE 7.0.0): listado leíble por cualquier usuario
// autenticado; mutaciones exigen rol `admin` (dentro del router).
router.use("/sources", sourcesRouter);

// Administración de usuarios: adicionalmente exige rol `admin` (dentro del
// router). Montado tras requireAuth para que req.user esté disponible.
router.use("/users", usersRouter);

// GET /api/csrf-token — expone SOLO el token CSRF de la sesión actual.
router.use("/csrf-token", csrfRouter);

export default router;
