/**
 * Bus de eventos para sesión expirada.
 *
 * Cuando cualquier request recibe 401 (token inválido/expirado), se notifica
 * a través de este bus para que el AuthProvider pueda limpiar el estado y
 * redirigir a /login.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Registra un listener para cuando se detecte una sesión expirada.
 * Retorna una función para desregistrar el listener.
 */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Notifica a todos los listeners que la sesión expiró.
 */
export function notifySessionExpired(): void {
  listeners.forEach((listener) => listener());
}
