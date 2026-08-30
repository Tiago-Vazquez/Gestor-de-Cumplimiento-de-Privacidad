/**
 * Catch-all for requests that no route handled.
 *
 * Mounted after the API router, so it only sees unmatched paths. Responds
 * with a problem+json 404 instead of Express's default HTML error page.
 */
import type { NextFunction, Request, Response } from "express";
import { sendProblemJson } from "../lib/problem-json";

export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  sendProblemJson(res, {
    type: "about:blank",
    title: "Not Found",
    status: 404,
    detail: `Route ${req.method} ${req.path} does not exist`,
    instance: req.originalUrl?.split("?")[0],
  });
}