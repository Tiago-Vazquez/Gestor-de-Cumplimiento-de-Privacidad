import { and, asc, count, eq } from "drizzle-orm";
import { db, findingsTable, sourcesTable, type Source } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { decrypt, encrypt } from "../lib/secret-manager";
import { logger } from "../lib/logger";
import { normalizeConnectionConfig, type ConnectionConfig } from "../connectors/types";
import { newId } from "./ids";
import { tenantScopeStrict, withTenant } from "./tenant";
import { bgDb } from "@workspace/db/background";

export type SourceWithFindingsCount = Source & { findingsCount: number };

/**
 * Configuración de conexión para fuentes externas (FASE 7.0.0; M23.1).
 * Unión discriminada por `kind` (postgresql | mysql) definida en
 * `connectors/types.ts`. Se almacena cifrada en `sources.connection_config`
 * y solo se descifra cuando el scanner/masking necesita abrir la conexión.
 * Alias mantenido por compatibilidad con rutas y tests existentes.
 */
export type SourceConnectionConfig = ConnectionConfig;

/**
 * Cifra la configuración de conexión antes de persistirla.
 * Fail-closed: si SOURCE_ENCRYPTION_KEY no está configurada, lanza error.
 */
export function encryptConnectionConfig(config: ConnectionConfig): string {
  return encrypt(JSON.stringify(config));
}

/**
 * Descifra y VALIDA la configuración de conexión (M23.1, server-side):
 * devuelve la unión discriminada por `kind` o `null` (fail-closed) si la
 * fuente no tiene configuración, el descifrado falla, el kind no tiene
 * conector, el kind guardado no coincide con el de la fuente, o la forma no
 * cumple el contrato. Nunca lanza con contenido de config en el log.
 */
export function decryptConnectionConfig(source: Source): ConnectionConfig | null {
  if (!source.connectionConfig) {
    return null;
  }
  // connectionConfig viene como jsonb (string cifrado)
  const encrypted = typeof source.connectionConfig === "string"
    ? source.connectionConfig
    : String(source.connectionConfig);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(encrypted));
  } catch (error) {
    // FASE 7.0.5 (M8): distinguir ausencia de configuración (null limpio arriba)
    // de fallo de descifrado. Se registra con sourceId para diagnóstico, sin
    // campos de configuración, plaintext, ciphertext ni claves.
    logger.warn(
      { sourceId: source.id, err: error },
      "Connection config decryption failed; treated as not scannable",
    );
    return null;
  }
  const config = normalizeConnectionConfig(source.kind, parsed);
  if (!config) {
    // Forma inválida / kind sin conector / kind mismatch → fail-closed.
    logger.warn(
      { sourceId: source.id, kind: source.kind },
      "Connection config failed validation; treated as not scannable",
    );
    return null;
  }
  return config;
}

/**
 * Determina si una fuente está configurada para scanning.
 */
export function isScannable(source: Source): boolean {
  return source.connectionConfig != null;
}

export interface CreateSourceInput {
  name: string;
  kind: string;
  environment: string;
  connection?: SourceConnectionConfig;
  /** M21.4 — tenant propietario (contexto de organización activa, SIEMPRE). */
  tenantId: string;
}

export interface UpdateSourceInput {
  name?: string;
  kind?: string;
  environment?: string;
  connection?: SourceConnectionConfig | null;
}

/**
 * Crea una fuente con configuración de conexión cifrada (opcional).
 * La contraseña viaja en el body de la request pero NUNCA se persiste en
 * texto plano: se cifra antes del INSERT.
 */
export async function createSource(input: CreateSourceInput): Promise<Source> {
  const now = new Date();
  const values = {
    id: newId("src"),
    name: input.name,
    kind: input.kind,
    environment: input.environment,
    status: "healthy" as const,
    lastScanAt: null,
    tables: 0,
    records: 0,
    connectionConfig: input.connection
      ? encryptConnectionConfig(input.connection)
      : null,
    // M21.4 — raíz de propiedad del recurso (tenant_id NOT NULL).
    tenantId: input.tenantId,
    createdAt: now,
    updatedAt: now,
  };
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.insert(sourcesTable).values(values).returning();
    return row;
  });
}

/**
 * Actualiza una fuente. Los campos no proporcionados se conservan.
 * Si `connection` se proporciona, se cifra. Si es `null`, se borra la config.
 * Si es `undefined`, no se toca.
 */
export async function updateSource(
  id: string,
  input: UpdateSourceInput,
  tenantId: string,
): Promise<Source | null> {
  const existing = await getById(id, tenantId);
  if (!existing) return null;

  const set: Partial<Source> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.environment !== undefined) set.environment = input.environment;
  if (input.connection !== undefined) {
    set.connectionConfig = input.connection
      ? encryptConnectionConfig(input.connection)
      : null;
  }

  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .update(sourcesTable)
      .set(set)
      // M21.8 — scoping ESTRICTO en el WHERE + tenant context transaccional.
      .where(
        and(
          eq(sourcesTable.id, id),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Elimina una fuente. FASE 7.0.5 (opción B): los scans asociados se eliminan
 * automáticamente (ON DELETE CASCADE); los hallazgos sobreviven con
 * `source_id = NULL` como evidencia histórica de cumplimiento (ON DELETE
 * SET NULL), preservando `source_name` para la atribución.
 */
export async function deleteSource(id: string, tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .delete(sourcesTable)
      // M21.8 — scoping ESTRICTO en el DELETE + tenant context transaccional.
      .where(
        and(
          eq(sourcesTable.id, id),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      )
      .returning({ id: sourcesTable.id });
    return row !== undefined;
  });
}

/**
 * FASE 7.0.5 (M1): detalle de fuente con el número REAL de hallazgos
 * asociados (conteo en SQL vía LEFT JOIN, igual que `list`). Antes el detalle
 * devolvía `findings: 0` hardcodeado.
 */
export async function getByIdWithFindingsCount(
  id: string,
  tenantId: string,
): Promise<SourceWithFindingsCount | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ source: sourcesTable, findingsCount: count(findingsTable.id) })
      .from(sourcesTable)
      .leftJoin(findingsTable, eq(findingsTable.sourceId, sourcesTable.id))
      .where(
        and(
          eq(sourcesTable.id, id),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      )
      .groupBy(sourcesTable.id);
    return row ? { ...row.source, findingsCount: row.findingsCount } : null;
  });
}

/**
 * Fuentes monitoreadas con el número de hallazgos asociados (D3: el contrato
 * expone `findings` como conteo, que no es columna de la tabla).
 * Orden estable: creación y, a igualdad, id.
 * F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET sobre el GROUP BY).
 */
export async function list(
  pagination: Pagination | undefined,
  tenantId: string,
): Promise<SourceWithFindingsCount[]> {
  return withTenant(tenantId, async (tx) => {
    let query = tx
      .select({ source: sourcesTable, findingsCount: count(findingsTable.id) })
      .from(sourcesTable)
      .leftJoin(findingsTable, eq(findingsTable.sourceId, sourcesTable.id))
      .where(tenantScopeStrict(sourcesTable.tenantId, tenantId))
      .groupBy(sourcesTable.id)
      .orderBy(asc(sourcesTable.createdAt), asc(sourcesTable.id))
      .$dynamic();
    if (pagination) {
      query = query.limit(pagination.limit).offset(pagination.offset);
    }

    const rows = await query;
    return rows.map((row) => ({ ...row.source, findingsCount: row.findingsCount }));
  });
}

export async function getById(id: string, tenantId: string): Promise<Source | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.id, id),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      );
    return row ?? null;
  });
}

/**
 * M21.7 — flujo interno (scanner): lectura de la fuente SIN scoping de tenant.
 * El scanner procesa una fuente concreta que ya fue iniciada; el tenant se
 * deriva de la propia fila (raíz de propiedad), no del contexto de un request.
 */
export async function getByIdForScan(id: string): Promise<Source | null> {
  const [row] = await bgDb().select().from(sourcesTable).where(eq(sourcesTable.id, id));
  return row ?? null;
}
