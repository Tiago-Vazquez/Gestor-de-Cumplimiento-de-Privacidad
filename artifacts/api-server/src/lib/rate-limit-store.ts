import type { Store } from "express-rate-limit";
import { repos } from "../repositories";

/**
 * M18 Fase 2 — store persistente de rate limiting sobre PostgreSQL para los
 * limiters sensibles. Sin Redis: la BD ya es una dependencia del proceso y
 * `express-rate-limit` v7 consume cualquier Store que implemente su interfaz.
 * `AUTH_RATE_LIMIT_STORE=postgres` activa este store (default `memory`, que
 * mantiene el comportamiento de tests y desarrollo sin BD).
 */
export type RateLimitStoreKind = "memory" | "postgres";

export function authRateLimitStoreKind(): RateLimitStoreKind {
  const raw = (process.env.AUTH_RATE_LIMIT_STORE ?? "memory")
    .trim()
    .toLowerCase();
  return raw === "postgres" ? "postgres" : "memory";
}

/**
 * Devuelve el store persistente solo si el modo `postgres` está activo;
 * `undefined` deja que express-rate-limit use su MemoryStore (default).
 * express-rate-limit llama `init` con las opciones del limiter (incluida la
 * ventana) antes de usar el store, por lo que la ventana efectiva por
 * incremento proviene de ahí.
 *
 * `namespace` es obligatorio y se antepone a la clave (`login:{ip}:{email}`).
 * Sin él, limiters distintos con la misma fórmula de clave compartirían
 * contador en la tabla y se sabotearían entre sí: p. ej. `registerLimiter` y
 * `loginLimiter` generan ambos `${ip}:${email}`, así que el registro consumía
 * el bucket de login (5/15 min) y un alta seguida de 4 logins ya bloqueaba
 * con 429. Con MemoryStore el aislamiento era implícito (una instancia por
 * limiter); con la tabla compartida hay que hacerlo explícito. También hace
 * observable en `rate_limit_hits.key` qué limiter consumió cada ventana.
 */
export function optionalPersistentStore(namespace: string): Store | undefined {
  if (authRateLimitStoreKind() !== "postgres") return undefined;
  const prefix = namespace.trim().length > 0 ? namespace.trim() : "default";
  const namespaced = (key: string): string => `${prefix}:${key}`;
  let windowMs = 60_000;
  const store: Store = {
    init: (options) => {
      if (typeof options?.windowMs === "number" && options.windowMs > 0) {
        windowMs = options.windowMs;
      }
    },
    increment: (key) => repos.rateLimits.hit(namespaced(key), windowMs),
    decrement: (key) => repos.rateLimits.decrementKey(namespaced(key)),
    resetKey: (key) => repos.rateLimits.resetKey(namespaced(key)),
    // `resetAll` de la interfaz Store es global por definición; se acota al
    // namespace para no borrar los buckets de otros limiters.
    resetAll: () => repos.rateLimits.resetAll(prefix),
  };
  return store;
}
