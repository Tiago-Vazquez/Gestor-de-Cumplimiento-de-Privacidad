import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import privacyRouter from "./privacy";
import { requireAuth } from "../auth/middleware";

const router: IRouter = Router();

// Endpoints públicos: health check y flujo de autenticación (login/logout/me).
router.use(healthRouter);
router.use("/auth", authRouter);

// Todo lo demás bajo /api requiere autenticación JWT.
router.use(requireAuth());

router.use(privacyRouter);

export default router;
