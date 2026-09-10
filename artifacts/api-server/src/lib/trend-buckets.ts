/**
 * Helper PURO de buckets diarios UTC para el trend de compliance (FASE 7.2,
 * M2.b). Sin IO y sin reloj: la fecha de referencia llega por parámetro, de
 * modo que la agregación es determinista y testeable sin PostgreSQL ni mocks
 * de tiempo.
 *
 * El día calendario es SIEMPRE UTC (`YYYY-MM-DD`): es la identidad del bucket
 * (decisión de contrato M2.a, sin ambigüedad de zona horaria). Los instantes
 * se atribuyen al día UTC en que ocurren, ignorando la zona local del proceso.
 */

/** Milisegundos en un día UTC (no hay DST en UTC; aritmética de ventana segura). */
export const UTC_MS_PER_DAY = 86_400_000;

/** Clave de día calendario UTC (`YYYY-MM-DD`) de un instante. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Instante de medianoche UTC (`00:00:00.000Z`) de una clave de día. */
export function utcDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/**
 * Exactamente `days` claves de día UTC que terminan HOY (incluido), la más
 * antigua primero. `now` se trunca a su día UTC, así que la ventana no
 * depende de la hora del request.
 */
export function buildTrendDayKeys(days: number, now: Date): string[] {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`days debe ser un entero >= 1, recibido ${days}`);
  }
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(utcDayKey(new Date(todayUtc - offset * UTC_MS_PER_DAY)));
  }
  return keys;
}

/** Un punto del trend de compliance, con contadores ya agregados por día. */
export type TrendPointBucket = {
  date: string;
  newFindings: number;
  resolvedFindings: number;
  completedScans: number;
  recordsScanned: number;
};

/**
 * Ensambla los puntos del trend: un punto POR clave recibida (cero-incluido:
 * los días sin actividad cuentan 0), en el mismo orden de `dayKeys` (más
 * antiguo primero).
 *
 * Cada evento se atribuye al día UTC de su instante (`at`); los eventos con
 * `at` nulo o fuera de la ventana se descartan (el SQL ya acota la ventana a
 * [primer día 00:00Z, último día 24:00Z); este descarte es defensa en
 * profundidad, no la fuente de verdad).
 *
 * `recordsScanned` SUMA `recordsRead` de todos los scans completados
 * atribuidos al día (misma atribución por `completedAt`).
 */
export function buildTrendPoints(input: {
  dayKeys: readonly string[];
  newFindings: Iterable<{ at: Date | null }>;
  resolvedFindings: Iterable<{ at: Date | null }>;
  completedScans: Iterable<{ at: Date | null; recordsRead: number }>;
}): TrendPointBucket[] {
  type Bucket = Omit<TrendPointBucket, "date">;
  const byDay = new Map<string, Bucket>();
  for (const key of input.dayKeys) {
    byDay.set(key, { newFindings: 0, resolvedFindings: 0, completedScans: 0, recordsScanned: 0 });
  }

  const bucketOf = (at: Date | null): Bucket | undefined =>
    at === null ? undefined : byDay.get(utcDayKey(at));

  for (const event of input.newFindings) {
    const bucket = bucketOf(event.at);
    if (bucket) bucket.newFindings += 1;
  }
  for (const event of input.resolvedFindings) {
    const bucket = bucketOf(event.at);
    if (bucket) bucket.resolvedFindings += 1;
  }
  for (const scan of input.completedScans) {
    const bucket = bucketOf(scan.at);
    if (bucket) {
      bucket.completedScans += 1;
      bucket.recordsScanned += scan.recordsRead;
    }
  }

  return input.dayKeys.map((date) => {
    const bucket = byDay.get(date);
    if (!bucket) {
      throw new Error(`bucket faltante para el día ${date}`);
    }
    return { date, ...bucket };
  });
}
