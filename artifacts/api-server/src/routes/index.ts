import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import privacyRouter from "./privacy";
import usersRouter from "./users";
import { requireAuth } from "../auth/middleware";

const router: IRouter = Router();

// Endpoints públicos: health check y flujo de autenticación (login/logout/me).
router.use(healthRouter);
router.use("/auth", authRouter);

// Todo lo demás bajo /api requiere autenticación JWT.
router.use(requireAuth());

router.use(privacyRouter);

// Administración de usuarios: adicionalmente exige rol `admin` (dentro del
// router). Montado tras requireAuth para que req.user esté disponible.
router.use("/users", usersRouter);

export default router;
