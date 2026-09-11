/**
 * Límites del MVP de masking jobs (FASE 7.3 / M5.c).
 *
 * Viven en un módulo puro (sin BD) para que el repo real y el espejo
 * in-memory de los tests HTTP compartan EXACTAMENTE los mismos valores.
 */

/** Máximo de registros leídos/anonimizados por job (cap duro de lectura). */
export const MAX_MASKING_RECORDS = 1000;

/** Máximo tamaño serializado del dataset persistido (~2 MB). */
export const MAX_MASKING_DATASET_BYTES = 2_000_000;
