import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * Trusted proxy hops in front of this server. Hardening 6.3B.23 (F23-01,
 * fail-closed): the default is to trust NO proxy, so `req.ip` always reflects
 * the socket peer and cannot be spoofed via `X-Forwarded-For`. Deployments
 * behind a reverse proxy (load balancer, CDN, Replit router) MUST enable it
 * explicitly with `TRUST_PROXY=true|1|<n>` — without it the rate limiters would
 * key off the proxy's own IP and shared-NAT clients would collide on a bucket.
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return false;
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

// Unmatched /api/* routes always get an API problem+json 404 — never the SPA.
app.use("/api", notFoundHandler);

// Compiled React frontend (SPA), served by this same server. The directory is
// resolved relative to this module so it works both from src (vitest) and from
// the esbuild bundle (dist). STATIC_ROOT overrides it if the deployment layout
// ever changes.
const frontendDir = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "privacy-compliance-manager",
      "dist",
      "public",
    );
const frontendIndex = path.join(frontendDir, "index.html");
const serveFrontend = existsSync(frontendIndex);

if (serveFrontend) {
  logger.info({ frontendDir }, "Serving compiled React frontend");
  app.use(express.static(frontendDir));
  app.use((req, res, next) => {
    // SPA fallback for browser navigation only. Unmatched /api/* routes were
    // already answered above and never reach this fallback.
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(frontendIndex, (error) => {
      if (error) {
        next(error);
      }
    });
  });
} else {
  logger.warn(
    { frontendIndex },
    "Compiled frontend not found; running in API-only mode",
  );
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
