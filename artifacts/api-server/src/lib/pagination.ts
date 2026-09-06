import { z } from "zod";

/**
 * Paginación offset/limit server-side (hardening F4, 6.3B.20).
 *
 * Contrato: `?limit=<1..100>&offset=<>=0`. Default 50, máximo 100. Los valores
 * se coaccionan desde el query string (siempre texto) y se rechazan enteros
 * no válidos (decimales, negativos, NaN). El límite máximo se aplica AQUÍ y
 * además debe reflejarse en la consulta de BD (LIMIT/OFFSET), nunca solo en
 * el frontend. `999999999` (o cualquier valor > 100) se satura a 100 no por
 * clamp silencioso: se rechaza con 400 para que el cliente corrija.
 */
export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1, "limit must be >= 1")
    .max(100, "limit must be <= 100")
    .default(50),
  offset: z.coerce
    .number()
    .int()
    .min(0, "offset must be >= 0")
    .default(0),
});

export type Pagination = { limit: number; offset: number };

/**
 * Parsea y valida los parámetros de paginación de un query string.
 * Lanza ZodError (=> 400 via error-handler) si algún parámetro es inválido.
 * Ignora claves ajenas (comportamiento Zod por defecto, strip).
 */
export function parsePagination(query: unknown): Pagination {
  return PaginationQuery.parse(query);
}
