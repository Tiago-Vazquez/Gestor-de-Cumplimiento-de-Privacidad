/**
 * Centralized environment variable parsing.
 * Single source of truth for reading numeric/string configs with safe fallbacks.
 */

/**
 * Positive number from an env var, falling back to `fallback` when unset/invalid.
 * Non-positive or non-finite values fall back to `fallback`.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Session idle timeout in seconds.
 * After this period of inactivity, a session is considered expired and the next
 * request will require re-authentication.
 *
 * Controlled by `SESSION_IDLE_SECONDS`. Default: 1800 (30 minutes).
 */
export function sessionIdleSeconds(): number {
  return numberFromEnv("SESSION_IDLE_SECONDS", 1800);
}
