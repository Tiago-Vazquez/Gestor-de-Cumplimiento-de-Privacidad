import { repos } from "../repositories";
import { logger } from "../lib/logger";
import {
  connectPg,
  listTables,
  readPage,
  type PgConnector,
} from "../connectors/postgres";

/**
 * Scanner PostgreSQL MVP (FASE 7.0.1).
 *
 * Ejecuta reglas de detección de información sensible sobre las tablas de una
 * fuente PostgreSQL externa y materializa los resultados como `findings`
 * asociados al scan.
 *
 * Decisiones de diseño:
 * - El catálogo EJECUTABLE es built-in (patrones, severidad, regulación...):
 *   el schema `rules` no almacena patrones, así que actúa como interruptor por
 *   nombre cuando el seed coincide (case-insensitive); si no coincide o no hay
 *   reglas activas, se usa el catálogo por defecto. Documentado para que un
 *   futuro seed de reglas ejecutables (con columna de patrón) lo reemplace.
 * - Lifecycle: running → completed | failed, gestionado vía repos.scans.
 * - El conector se cierra SIEMPRE en `finally` (las credenciales nunca hacen
 *   leak: no se loguean host/port/user/password).
 * - Frontera de volumen: máximos de páginas por tabla, tablas por scan,
 *   longitud por campo y findings por scan para no saturar la plataforma.
 */

export interface DetectionRule {
  name: string;
  category: string;
  regulation: string;
  dataType: string;
  severity: string;
  recommendation: string;
  pattern: RegExp;
}

/** Catálogo por defecto (MVP): PII y datos financieros básicos. */
export const BUILT_IN_RULES: DetectionRule[] = [
  {
    name: "email",
    category: "pii",
    regulation: "GDPR Art. 32",
    dataType: "email",
    severity: "high",
    recommendation: "Cifrar la columna y restringir el acceso.",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  },
  {
    name: "phone",
    category: "pii",
    regulation: "LGPD Art. 46",
    dataType: "phone",
    severity: "medium",
    recommendation: "Enmascarar los últimos dígitos del número.",
    pattern: /\+?[\d][\d\s().-]{6,}\d/,
  },
  {
    name: "national_id",
    category: "pii",
    regulation: "LGPD Art. 46",
    dataType: "national_id",
    severity: "high",
    recommendation: "Tokenizar el documento de identidad.",
    pattern: /\b\d{2}\.?\d{3}\.?\d{3}-?[\dA-Z]\b/,
  },
  {
    name: "credit_card",
    category: "financial",
    regulation: "PCI DSS 3.4",
    dataType: "credit_card",
    severity: "critical",
    recommendation: "No almacenar PAN sin cifrar y purgar de logs.",
    // FASE 7.0.3: patrón lineal — máx. 1 separador entre dígitos y alternativas
    // mutuamente excluyentes según el siguiente carácter, sin backtracking
    // combinatorio sobre runs de separadores. Misma semántica: 13-16 dígitos
    // con \b en ambos extremos.
    pattern: /\b\d(?:[ -]?\d){12,15}\b/,
  },
];

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_TABLE = 100; // 100k filas máximo por tabla en el MVP
const MAX_TABLES_PER_SCAN = 100; // FASE 7.0.3: tope de tablas por scan (selección alfabética determinista)
const MAX_FINDINGS_PER_SCAN = 50;
const MAX_FIELD_LENGTH = 4096; // FASE 7.0.3: ventana máxima por celda antes de evaluar patrones
const SAMPLE_CAP = 120;

export interface RunScanInput {
  scanId: string;
  sourceId: string;
  /** Inyectable en tests; por defecto el conector real. */
  connector?: PgConnector;
}

interface MatchAgg {
  table: string;
  column: string;
  rule: DetectionRule;
  count: number;
  sample: string;
}

/**
 * Resuelve las reglas ejecutables (HIGH #1, 7.0.2): consulta TODAS las reglas
 * de BD (no solo las activas) para distinguir ausencia de configuración,
 * habilitación explícita y deshabilitación explícita.
 *
 * - Sin reglas configuradas → catálogo builtin completo.
 * - Regla conocida enabled → se ejecuta.
 * - Regla conocida disabled → JAMÁS se ejecuta (ni siquiera vía fallback).
 * - Regla desconocida → inerte (no altera el catálogo).
 * - Si ninguna builtin coincide con la configuración, el fallback usa el
 *   catálogo por defecto EXCLUYENDO las explícitamente deshabilitadas.
 */
export async function resolveActiveRules(): Promise<DetectionRule[]> {
  const all = await repos.rules.list();
  if (all.length === 0) return BUILT_IN_RULES;

  const disabled = new Set(
    all.filter((rule) => !rule.enabled).map((rule) => rule.name.toLowerCase()),
  );
  const enabled = new Set(
    all.filter((rule) => rule.enabled).map((rule) => rule.name.toLowerCase()),
  );

  const matched = BUILT_IN_RULES.filter((rule) => {
    const key = rule.name.toLowerCase();
    return enabled.has(key) && !disabled.has(key);
  });
  if (matched.length > 0) return matched;

  // Fallback (seed sin coincidencias con el catálogo, p. ej. nombres display
  // en español): catálogo por defecto menos las explícitamente deshabilitadas.
  return BUILT_IN_RULES.filter((rule) => !disabled.has(rule.name.toLowerCase()));
}

function detectRows(
  table: string,
  rows: Record<string, unknown>[],
  rules: DetectionRule[],
  agg: Map<string, MatchAgg>,
): void {
  for (const row of rows) {
    for (const [column, rawValue] of Object.entries(row)) {
      if (rawValue === null || rawValue === undefined) continue;
      const value = String(rawValue);
      if (value.length === 0) continue;
      // FASE 7.0.3: la evaluación de patrones se acota a una ventana máxima por
      // celda (defensa en profundidad frente a patrones patológicos).
      const capped = value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;
      for (const rule of rules) {
        if (rule.pattern.test(capped)) {
          const key = `${table}.${column}|${rule.name}`;
          const existing = agg.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            agg.set(key, {
              table,
              column,
              rule,
              count: 1,
              sample: capped.slice(0, SAMPLE_CAP),
            });
          }
        }
      }
    }
  }
}

function capFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Razones terminales de fallo de un scan (HIGH #2, 7.0.2).
 */
type FailReason =
  | "source_not_found"
  | "source_not_scannable"
  | "connection_failed"
  | "persist_failed";

/**
 * Marca un scan como `failed` garantizando que un fallo del propio `failScan`
 * no produzca una segunda excepción no controlada (nunca lanza). Registra
 * contexto (scanId/sourceId/motivo) sin credenciales ni connectionConfig.
 */
async function failScanSafe(
  scanId: string,
  sourceId: string,
  reason: FailReason,
  originalError?: unknown,
): Promise<void> {
  try {
    await repos.scans.failScan({ scanId, completedAt: new Date(), reason });
  } catch (failError) {
    logger.error(
      { err: failError, originalErr: originalError, scanId, sourceId, reason },
      "Failed to mark scan as failed",
    );
  }
}

/**
 * Cuerpo del escaneo: fuente inexistente o no escaneable → `failed` sin efectos
 * secundarios; fallo de conexión/lectura → cierra la conexión y `failed`. Los
 * hallazgos agregados se persisten con `repos.scans.finalizeScan`. Los
 * errores de persistencia se propagan al wrapper `runScan`, que garantiza el
 * estado terminal `failed` (HIGH #2).
 */
async function runScanInner(input: RunScanInput): Promise<void> {
  const connector = input.connector ?? {
    connect: connectPg,
    listTables,
    readPage,
  };

  let source;
  try {
    source = await repos.sources.getById(input.sourceId);
  } catch (error) {
    logger.error({ err: error, scanId: input.scanId, sourceId: input.sourceId }, "Scan failed: could not load source");
    await failScanSafe(input.scanId, input.sourceId, "persist_failed", error);
    return;
  }
  if (!source) {
    // La source fue eliminada entre startScan y runScan: estado terminal failed.
    logger.warn({ scanId: input.scanId, sourceId: input.sourceId }, "Scan failed: source not found");
    await failScanSafe(input.scanId, input.sourceId, "source_not_found");
    return;
  }

  const config = repos.sources.decryptConnectionConfig(source);
  if (!config) {
    logger.warn(
      { scanId: input.scanId, sourceId: input.sourceId },
      "Scan failed: source has no connection configuration",
    );
    await failScanSafe(input.scanId, input.sourceId, "source_not_scannable");
    return;
  }

  const rules = await resolveActiveRules();
  const matches = new Map<string, MatchAgg>();
  let connection;

  const schema = config.schema ?? "public";
  let scannedTables: string[] = [];
  let recordsRead = 0;
  let tables: string[] = [];

  try {
    connection = await connector.connect(config);
    tables = await listTables(connection, schema);
    for (const table of tables.slice(0, MAX_TABLES_PER_SCAN)) {
      let offset = 0;
      let tableCompleted = true;
      for (let page = 0; page < MAX_PAGES_PER_TABLE; page += 1) {
        const rows = await connector.readPage(connection, table, { limit: PAGE_SIZE, offset });
        if (rows.length === 0) break;
        recordsRead += rows.length;
        detectRows(table, rows, rules, matches);
        offset += PAGE_SIZE;
        if (rows.length < PAGE_SIZE) break;
      }
      if (tableCompleted) {
        scannedTables.push(table);
      }
    }

    if (scannedTables.length < tables.length) {
      logger.warn(
        {
          scanId: input.scanId,
          sourceId: input.sourceId,
          total: tables.length,
          scanned: scannedTables.length,
          max: MAX_TABLES_PER_SCAN,
        },
        "Scan table cap applied",
      );
    }
  } catch (error) {
    logger.error({ err: error, scanId: input.scanId, sourceId: input.sourceId }, "Scan failed: connection/read error");
    if (connection) {
      await connection.close().catch(() => undefined);
    }
    await failScanSafe(input.scanId, input.sourceId, "connection_failed", error);
    return;
  }

  if (connection) {
    await connection.close().catch((error) =>
      logger.error({ err: error, scanId: input.scanId }, "Error closing scan connection"));
  }

  const findings = [...matches.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FINDINGS_PER_SCAN)
    .map((match) => ({
      location: `${match.table}.${match.column}`,
      dataType: match.rule.dataType,
      severity: match.rule.severity,
      records: match.count,
      sample: match.sample,
      regulation: match.rule.regulation,
      recommendation: match.rule.recommendation,
      title: `${capFirst(match.rule.dataType.replace(/_/g, " "))} detectado en ${match.table}.${match.column}`,
    }));

  // FASE 7.0.5: los deltas de detección por regla se calculan de la misma
  // agregación de matches (cero re-matching, cero doble conteo). La vinculación
  // con `rules` es por `lower(name)` — la misma clave de gobernanza de 7.0.2.
  const ruleDeltas = new Map<string, number>();
  for (const match of matches.values()) {
    const key = match.rule.name.toLowerCase();
    ruleDeltas.set(key, (ruleDeltas.get(key) ?? 0) + match.count);
  }

  // FASE 7.0.5: finaliza el scan en una ÚNICA transacción (findings + métricas
  // de fuente + detecciones por regla + estado completed). Si falla, el wrapper
  // 7.0.2 marca `failed(persist_failed)`.
  await repos.scans.finalizeScan({
    scanId: input.scanId,
    sourceId: input.sourceId,
    sourceName: source.name,
    findings,
    scannedTables: scannedTables.length,
    recordsRead,
    ruleDeltas,
    completedAt: new Date(),
  });

  logger.info(
    { scanId: input.scanId, sourceId: input.sourceId, findings: findings.length },
    "Scan completed",
  );
}

/**
 * Wrapper del ciclo de vida (HIGH #2, 7.0.2): garantiza que cualquier error
 * conocido después de `startScan` produzca un estado terminal:
 * - éxito → `completed`;
 * - fallo recuperable (source inexistente, no escaneable, conexión/lectura) →
 *   `failed(reason)` vía `failScanSafe`;
 * - error no previsto (persistencia en `finalizeScan`) →
 *   `failed(persist_failed)`.
 * Si el propio `failScan` falla, queda registrado y no genera unhandled
 * rejection. El `.catch` del endpoint permanece como última línea de defensa.
 */
export async function runScan(input: RunScanInput): Promise<void> {
  try {
    await runScanInner(input);
  } catch (error) {
    logger.error(
      { err: error, scanId: input.scanId, sourceId: input.sourceId },
      "Scan failed: unhandled error",
    );
    await failScanSafe(input.scanId, input.sourceId, "persist_failed", error);
  }
}
