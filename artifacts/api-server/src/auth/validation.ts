/**
 * Normaliza un email para almacenamiento y búsqueda consistente.
 * - Elimina espacios exteriores
 * - Convierte a lowercase
 * - Retorna null si el email es inválido
 */
export function normalizeEmail(email: string): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return null;
  // Validación básica: debe tener @ con algo antes y después
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return normalized;
}

/**
 * Valida que una contraseña cumpla la política mínima:
 * - No vacía
 * - Mínimo 12 caracteres
 */
export function isValidPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 12;
}

/**
 * Valida que un nombre sea aceptable (opcional, no vacío si se provee).
 */
export function isValidName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0;
}
