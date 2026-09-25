/**
 * Fase 6 (M18) — topes de entrada. El body ya está limitado a 16kb
 * (`JSON_BODY_LIMIT`), pero sin cotas por campo una sola request podía enviar
 * un email de miles de caracteres (consulta/almacenamiento) o un password
 * desmedido que se pasa íntegro a scrypt (coste CPU/RAM amplificable).
 */
export const EMAIL_MAX_LENGTH = 254; // límite de RFC 5321 para la ruta del correo
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
export const NAME_MAX_LENGTH = 200;

/**
 * Normaliza un email para almacenamiento y búsqueda consistente.
 * - Elimina espacios exteriores
 * - Convierte a lowercase
 * - Retorna null si el email es inválido (vacío, sin @, o excesivamente largo)
 */
export function normalizeEmail(email: string): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (normalized.length > EMAIL_MAX_LENGTH) return null;
  // Validación básica: debe tener @ con algo antes y después
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return normalized;
}

/**
 * Valida que una contraseña cumpla la política:
 * - No vacía y de tipo string
 * - Mínimo 12 caracteres
 * - Máximo 1024 caracteres (tope de Fase 6: acota el trabajo de scrypt)
 */
export function isValidPassword(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

/**
 * Valida que un nombre sea aceptable (opcional, no vacío si se provee) y no
 * exceda el tope de Fase 6 (se almacena en una columna `text` sin límite
 * propio, así que la cota vive aquí).
 */
export function isValidName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= NAME_MAX_LENGTH;
}
