import { mysqlConnector } from "./mysql";
import { postgresConnector } from "./postgres";
import {
  ConnectorError,
  type SourceConnector,
  type SupportedSourceKind,
} from "./types";

/**
 * M23.1 — Registry (factory) de conectores de fuentes externas.
 *
 * Único punto de resolución conector↔kind para el scanner y masking:
 * consumidores NO importan motores concretos (`postgres.ts`/`mysql.ts`);
 * solo piden `getConnector(kind)`. Un kind sin registro lanza
 * `ConnectorError("unsupported")` — el scanner lo traduce a
 * `source_not_scannable` ANTES de tocar credenciales (nunca intenta
 * conectarse vía PostgreSQL con un kind distinto).
 *
 * M23.2: al añadir MongoDB se registra aquí y se extiende `ConnectionConfig`
 * en `types.ts` (el `Record<SupportedSourceKind, …>` fuerza ambos cambios).
 */
const connectors: Record<SupportedSourceKind, SourceConnector> = {
  postgresql: postgresConnector,
  mysql: mysqlConnector,
};

/** ¿El kind tiene conector registrado en esta versión? */
export function isSupportedKind(kind: string): kind is SupportedSourceKind {
  return Object.hasOwn(connectors, kind);
}

/**
 * Resuelve el conector para un kind. Lanza `ConnectorError("unsupported")`
 * si no está registrado (el kind no es secreto: es un valor de enum de BD).
 */
export function getConnector(kind: string): SourceConnector {
  if (!isSupportedKind(kind)) {
    throw new ConnectorError("unsupported", `Unsupported source kind: ${kind}`);
  }
  return connectors[kind];
}

/** Kinds con conector disponible (orden de registro). */
export function supportedKinds(): SupportedSourceKind[] {
  return Object.keys(connectors) as SupportedSourceKind[];
}
