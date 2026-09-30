import { randomUUID } from "node:crypto";

/**
 * M16.1 — Correlación de requests.
 *
 * El correlation id viaja en el header `X-Request-Id`:
 * - Si el cliente lo envía y tiene un formato seguro, se REUTILIZA.
 * - Si no llega (o es inválido), se genera un UUID v4.
 *
 * El id resultante queda en `req.id` (contexto de request, lo usa pino-http y
 * el error-handler), se devuelve en el header de respuesta `X-Request-Id` y
 * aparece en los logs estructurados.
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** Formato aceptado: hasta 128 caracteres de [A-Za-z0-9._-] (sin espacios ni
 * saltos de línea: evita inyección en headers y cardinalidad basura). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Extrae un request id válido del header entrante (`string` o `string[]`
 * según el header). Devuelve null si no llega o si no pasa la validación.
 */
export function requestIdFromHeader(
  raw: string | string[] | undefined,
): string | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Genera un correlation id nuevo (UUID v4). */
export function newRequestId(): string {
  return randomUUID();
}

/** Resuelve el correlation id de un request: reutiliza el del cliente o genera uno. */
export function resolveRequestId(
  raw: string | string[] | undefined,
): string {
  return requestIdFromHeader(raw) ?? newRequestId();
}