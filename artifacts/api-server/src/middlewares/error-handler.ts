/**
 * Central error handler — always the last middleware in the chain.
 *
 * Mapping:
 * - ZodError            → 400 problem+json with sanitized validation issues
 * - AppError            → its own HTTP status/title/detail
 * - body-parser errors  → 400 (malformed JSON) / 413 (payload too large) / 415
 * - anything else       → 500 with a generic body
 *
 * Security rules:
 * - Stack traces and internal error details are NEVER sent to the client in
 *   production; they are only logged server-side (with req.id when available).
 * - In non-production, the error message is included in `detail` to speed up
 *   local debugging.
 */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  sendProblemJson,
  statusTitle,
  type ProblemDetails,
  type ValidationIssue,
} from "../lib/problem-json";

const isProduction = process.env.NODE_ENV === "production";

function toValidationIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/** body-parser sets `err.type` for its known failure modes. */
function bodyParserErrorType(err: unknown): string | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const type = (err as unknown as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * pino-http augments `http.IncomingMessage` (and therefore Express's Request)
 * with a request id. Read it defensively so this file does not depend on the
 * augmentation being loaded.
 */
function requestId(req: Request): string | number | undefined {
  const candidate = (req as unknown as { id?: unknown }).id;
  return typeof candidate === "string" || typeof candidate === "number"
    ? candidate
    : undefined;
}

function logError(req: Request, message: string, err: unknown): void {
  logger.error({ reqId: requestId(req), err }, message);
}

// Express identifies error handlers by arity (4 parameters); `_next` must stay.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // If the response already started streaming, delegating is the only safe
  // option; Express will close the connection.
  if (res.headersSent) {
    _next(err);
    return;
  }

  const instance = req.originalUrl?.split("?")[0];

  // 1) Validation errors from the shared Zod schemas → 400.
  if (err instanceof ZodError) {
    logger.warn(
      { reqId: requestId(req), issues: toValidationIssues(err) },
      "Request validation failed",
    );
    sendProblemJson(res, {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Validation failed",
      instance,
      errors: toValidationIssues(err),
    });
    return;
  }

  // 2) Known application errors → their own status.
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logError(req, "Application error", err);
    } else {
      logger.warn(
        { reqId: requestId(req), status: err.status, detail: err.detail },
        "Application error",
      );
    }
    sendProblemJson(res, {
      type: "about:blank",
      title: err.title,
      status: err.status,
      detail: err.detail,
      instance,
    });
    return;
  }

  // 3) Known body-parser failures → their corresponding status.
  const bodyParserType = bodyParserErrorType(err);
  if (bodyParserType === "entity.parse.failed") {
    logger.warn({ reqId: requestId(req) }, "Malformed request body");
    sendProblemJson(res, {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Malformed request body",
      instance,
    });
    return;
  }
  if (bodyParserType === "entity.too.large" || bodyParserType === "parameters.too.many") {
    logger.warn({ reqId: requestId(req), type: bodyParserType }, "Request body too large");
    sendProblemJson(res, {
      type: "about:blank",
      title: "Payload Too Large",
      status: 413,
      detail: "Request body exceeds the allowed size",
      instance,
    });
    return;
  }
  if (bodyParserType === "charset.unsupported" || bodyParserType === "encoding.unsupported") {
    logger.warn({ reqId: requestId(req), type: bodyParserType }, "Unsupported request encoding");
    sendProblemJson(res, {
      type: "about:blank",
      title: "Unsupported Media Type",
      status: 415,
      detail: "Unsupported request encoding",
      instance,
    });
    return;
  }

  // 4) Unknown errors → 500 with a generic body. Full details go to the
  //    server logs only; the client never sees stack traces in production.
  logError(req, "Unhandled error", err);
  const problem: ProblemDetails = {
    type: "about:blank",
    title: statusTitle(500),
    status: 500,
    instance,
  };
  if (!isProduction) {
    problem.detail = err instanceof Error ? err.message : String(err);
  }
  sendProblemJson(res, problem);
}