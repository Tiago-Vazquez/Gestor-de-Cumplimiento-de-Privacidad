import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { repos } from "../repositories";
import { logger } from "./logger";
import { REQUEST_ID_HEADER, requestIdFromHeader } from "./request-id";
import type { AuthedRequest } from "../auth/middleware";

/**
 * M17 — Registro de auditoría administrativa (helper de escritura).
 *
 * Contrato de uso:
 * - `recordAuditEvent` es BEST-EFFORT: nunca lanza. Un fallo de auditoría se
 *   registra en el log estructurado y JAMÁS rompe la acción auditada ni su
 *   respuesta HTTP (misma política que el resto de efectos secundarios).
 * - Los llamadores hacen `await` del registro (determinismo: cuando el handler
 *   continúa, el evento ya está persistido) salvo en el scanner, que corre en
 *   background sin cliente esperando.
 * - `metadata` es SOLO información operacional (ids, contadores, tipos,
 *   estados, nombres de campos). El saneado se aplica en el punto de registro
 *   (defensa en profundidad): se descartan claves sensibles por nombre y
 *   valores que no sean primitivos o arrays de primitivos.
 *
 * Lo que NO debe llegar nunca aquí (ni a la tabla `audit_events`):
 * contraseñas, hashes, JWT, cookies, tokens CSRF, claves de cifrado,
 * credenciales de conexión (connectionConfig) y datos descubiertos por los
 * scans. `request_id` es un identificador de correlación, no un secreto.
 */

/**
 * Vocabulario cerrado de acciones auditadas. Debe coincidir con el
 * `description` de `AuditEvent.action` en el contrato OpenAPI.
 */
export type AuditAction =
  | "login_success"
  | "login_failure"
  | "logout"
  | "logout_all"
  | "session_revoked"
  | "password_changed"
  | "user_updated"
  | "user_roles_updated"
  | "source_created"
  | "source_updated"
  | "source_deleted"
  | "schedule_created"
  | "schedule_updated"
  | "schedule_enabled"
  | "schedule_disabled"
  | "scan_started"
  | "scan_cancelled"
  | "scan_failed"
  | "report_created"
  | "report_downloaded"
  | "masking_job_created"
  | "dataset_downloaded"
  | "rule_enabled"
  | "rule_disabled"
  | "session_expired"
  | "inactivity_timeout"
  // M21.2 — multi-tenancy: contexto de organización, members e invitaciones.
  | "org_context_switched"
  | "member_role_updated"
  | "member_removed"
  | "invitation_created"
  | "invitation_revoked"
  | "invitation_accepted"
  | "security_violation";

/** Tipos de recurso afectado. */
export type AuditResourceType =
  | "session"
  | "user"
  | "source"
  | "schedule"
  | "scan"
  | "report"
  | "masking_job"
  | "rule"
  // M21.2 — multi-tenancy.
  | "organization"
  | "membership"
  | "invitation";

export type AuditResult = "success" | "failure";

/**
 * Origen de un evento interno (sin request HTTP). Se persiste en
 * `metadata.origin` y `actor_user_id` queda `null`: en el scheduler y el
 * reaper el actor es el sistema, no una persona.
 */
export type AuditOrigin = "scanner" | "scheduler" | "recovery";

export type AuditEventInput = {
  /** Request HTTP origen (para actor y correlation id `X-Request-Id`). */
  req?: Request;
  /** Actor explícito cuando no hay request autenticado (login) o es el sistema. */
  actorUserId?: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string | null;
  /** Default `success`: el llamador solo marca `failure` cuando lo sabe. */
  result?: AuditResult;
  origin?: AuditOrigin;
  metadata?: Record<string, unknown>;
};

/** Claves cuyo nombre (case-insensitive) nunca se persiste. */
const FORBIDDEN_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|jwt|cookie|authorization|credential|connection|csrf|api[-_]?key|encryption|private[-_]?key|salt|hash)/i;

/** Firma de un JWT compacto: `x.y.z` en base64url. */
const JWT_LIKE_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const MAX_METADATA_KEYS = 32;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_ITEMS = 20;
const REDACTED = "[redacted]";

/**
 * Normaliza un valor de metadata a algo persistible y seguro:
 * - string → se trunca; un JWT candidato se sustituye por `[redacted]`;
 * - number finito, boolean y Date (→ ISO) se conservan;
 * - arrays → hasta 20 elementos saneados;
 * - cualquier otra cosa (objetos anidados, funciones, undefined, NaN, Symbol)
 *   se DESCARTA: mejor un evento incompleto que un secreto filtrado dentro de
 *   un objeto anidado.
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string": {
      if (JWT_LIKE_PATTERN.test(value)) return REDACTED;
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}…`
        : value;
    }
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "boolean":
      return value;
    case "object": {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
      }
      if (Array.isArray(value)) {
        return value
          .slice(0, MAX_ARRAY_ITEMS)
          .map(sanitizeValue)
          .filter((item) => item !== undefined);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Saneado de metadata (exportado para tests y para documentar el contrato):
 * descarta claves sensibles por nombre, limita la cantidad de claves y sanea
 * cada valor. Devuelve siempre un objeto (posiblemente vacío).
 */
export function sanitizeAuditMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!input) return safe;

  let kept = 0;
  for (const [key, value] of Object.entries(input)) {
    if (kept >= MAX_METADATA_KEYS) break;
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeValue(value);
    if (sanitized === undefined) continue;
    safe[key] = sanitized;
    kept += 1;
  }
  return safe;
}

/** Actor del evento: el `sub` de la sesión autenticada, o `null`. */
export function resolveAuditActor(req?: Request): string | null {
  const user = (req as AuthedRequest | undefined)?.user;
  return user?.sub ?? null;
}

/**
 * Correlation id del evento: el `req.id` asignado por pino-http (M16.1). Si el
 * request no pasó por el middleware se intenta el header `X-Request-Id`
 * validado; en acciones internas devuelve `null`. Nunca se genera un id nuevo:
 * el evento debe poder cruzarse con los logs de su request.
 */
export function resolveAuditRequestId(req?: Request): string | null {
  if (!req) return null;
  const fromContext = typeof req.id === "string" && req.id.length > 0 ? req.id : null;
  if (fromContext) return fromContext;
  return requestIdFromHeader(req.headers?.[REQUEST_ID_HEADER]) ?? null;
}

/**
 * Persiste un evento de auditoría. NUNCA lanza (best-effort): cualquier fallo
 * queda en el log con la acción y el tipo de recurso, sin secretos.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    const metadata = sanitizeAuditMetadata({
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.metadata ?? {}),
    });

    await repos.auditEvents.create({
      // PK con UUID COMPLETO (no el `newId` abreviado de 8 hex de otras
      // entidades): la auditoría es append-only y crece sin techo, así que se
      // prioriza evitar colisiones de PK sobre el estilo visual del id.
      id: `audit-${randomUUID()}`,
      actorUserId: input.actorUserId ?? resolveAuditActor(input.req),
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result ?? "success",
      requestId: resolveAuditRequestId(input.req),
      metadata,
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
      },
      "Audit event could not be persisted",
    );
  }
}