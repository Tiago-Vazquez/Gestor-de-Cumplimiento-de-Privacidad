import { randomUUID } from "node:crypto";

/**
 * Genera identificadores con el mismo estilo visible que tenían los datos
 * demo (f-…, src-…, a-…, scan-…, r-…) pero únicos y aleatorios.
 * El contrato solo exige `string`, por lo que el formato es libre.
 */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
