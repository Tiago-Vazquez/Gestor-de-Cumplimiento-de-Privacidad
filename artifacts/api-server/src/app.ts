import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";
import { sendProblemJson } from "./lib/problem-json";
import { notFoundHandler } from "./middlewares/not-found";
import { errorHandler } from "./middlewares/error-handler";

const isProduction = process.env.NODE_ENV === "production";

/** Positive number from an env var, falling back to `fallback` when unset/invalid. */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Trusted proxy hops in front of this server (Replit's router adds one).
 * Configurable via TRUST_PROXY: "true"/"false", a hop count, or a proxy
 * IP/subnet. Defaults to 1, which is correct behind the Replit router.
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return 1;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const hops = Number(raw);
  if (!Number.isNaN(hops)) return hops;
  return raw;
}

/**
 * CORS allowlist. Never "*" in production: unset means same-origin only
 * (how Replit serves the app). In development it defaults to the local Vite
 * dev servers so the frontend can call the API cross-origin.
 */
function resolveCorsOrigins(): string[] {
  const raw =
    process.env.CORS_ORIGINS ??
    (isProduction
      ? ""
      : [
          "http://localhost:5173",
          "http://localhost:5174",
          "http://127.0.0.1:5173",
          "http://127.0.0.1:5174",
        ].join(","));
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const corsOrigins = resolveCorsOrigins();

const rateLimitWindowMs = numberFromEnv("RATE_LIMIT_WINDOW_MS", 60_000);
const rateLimitMax = numberFromEnv("RATE_LIMIT_MAX", 100);
const rateLimitMutationsMax = numberFromEnv("RATE_LIMIT_MUTATIONS_MAX", 30);
const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? "16kb";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Respond with problem+json so every error body in the API shares one format.
function rateLimitHandler(
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
  options: { statusCode: number },
): void {
  sendProblemJson(res, {
    type: "about:blank",
    title: "Too Many Requests",
    status: options.statusCode,
    detail: "Too many requests, please try again later.",
  });
}

const generalLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  limit: rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  // Keep the health endpoint unthrottled for monitoring probes.
  skip: (req) => req.path === "/healthz",
});

const mutationsLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  limit: rateLimitMutationsMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req) => !MUTATING_METHODS.has(req.method),
});

const app: Express = express();

app.set("trust proxy", resolveTrustProxy());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(helmet());

app.use(
  cors({
    origin:
      corsOrigins.length === 0
        ? false // same-origin only: no CORS headers are emitted
        : (origin, callback) => {
            // Non-browser clients (curl, server-to-server) send no Origin.
            if (!origin || corsOrigins.includes(origin)) {
              callback(null, true);
              return;
            }
            // Reject silently: without CORS headers the browser blocks it.
            callback(null, false);
          },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.use("/api", generalLimiter, mutationsLimiter);

app.use(express.json({ limit: jsonBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonBodyLimit }));

app.use("/api", router);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
