/**
 * Application-level error type for known, expected failures.
 *
 * Throwing an `AppError` from a route handler (sync or async) lets Express 5
 * forward it to the central error handler, which maps it to a problem+json
 * response with the corresponding HTTP status.
 */
export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;

  constructor(status: number, title: string, detail?: string, options?: { cause?: unknown }) {
    super(detail ?? title, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

/** 404 for a resource that exists as a concept but was not found. */
export function notFound(detail?: string): AppError {
  return new AppError(404, "Not Found", detail);
}

/** 400 for semantically invalid input (after parsing succeeded). */
export function badRequest(detail?: string): AppError {
  return new AppError(400, "Bad Request", detail);
}

/** 401 when authentication is missing or invalid. */
export function unauthorized(detail?: string): AppError {
  return new AppError(401, "Unauthorized", detail);
}

/** 403 when the authenticated user lacks the required role. */
export function forbidden(detail?: string): AppError {
  return new AppError(403, "Forbidden", detail);
}

/** 409 when a resource conflicts with the current state (e.g. duplicate email). */
export function conflict(detail?: string): AppError {
  return new AppError(409, "Conflict", detail);
}

/**
 * Detecta errores de violación UNIQUE de PostgreSQL (SQLSTATE 23505).
 *
 * El driver node-postgres (`pg`) expone el SQLSTATE como `error.code`.
 * Cuando Drizzle lanza una DatabaseError, el error original vive en
 * `error.cause`; por tanto se comprueban ambas ubicaciones. Útil para
 * traducir carreras check-then-act en 409 en lugar de 500 (F23-02).
 */
export function isConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const directCode = (err as { code?: unknown }).code;
  if (directCode === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code;
    if (causeCode === "23505") return true;
  }
  return false;
}