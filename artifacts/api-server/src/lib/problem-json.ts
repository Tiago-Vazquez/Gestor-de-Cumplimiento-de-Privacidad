/**
 * RFC 9457 (Problem Details for HTTP APIs) serialization helpers.
 *
 * Every error response uses `application/problem+json` with the canonical
 * fields: `type`, `title`, `status`, `detail` and `instance`. Validation
 * failures additionally carry an `errors` array. The frontend's
 * `custom-fetch` already extracts `title`/`detail` from error bodies, so
 * these responses surface nicely in the UI without any client changes.
 */
import type { Response } from "express";

export interface ValidationIssue {
  /** Dot-joined property path, e.g. `data.sourceId`. `(root)` when empty. */
  path: string;
  message: string;
}

export interface ProblemDetails {
  /** Canonical type URI; `about:blank` means "see HTTP status code". */
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Request path that produced the problem (no query string). */
  instance?: string;
  errors?: ValidationIssue[];
}

const PROBLEM_JSON_CONTENT_TYPE = "application/problem+json";

/** Standard HTTP reason phrases for the statuses this API emits. */
const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? "Error";
}

/** Serialize a problem and send it with the correct status and content type. */
export function sendProblemJson(res: Response, problem: ProblemDetails): void {
  res
    .status(problem.status)
    .set("Content-Type", PROBLEM_JSON_CONTENT_TYPE)
    .json(problem);
}