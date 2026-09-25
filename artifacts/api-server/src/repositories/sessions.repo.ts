import { and, desc, eq, gt, isNull, isNotNull, lte, or } from "drizzle-orm";
import {
  db,
  membershipsTable,
  sessionsTable,
  usersTable,
  userRolesTable,
  type Session,
} from "@workspace/db";
import { decodeJwt } from "jose";

/**
 * Sesiones server-side (allowlist por `jti`). El login registra la fila con el
 * `jti` del JWT emitido; `requireAuth` exige fila activa; logout revoca.
 * `ON DELETE CASCADE` en la FK garantiza que eliminar un usuario invalida sus
 * sesiones al instante. "Activa" = no revocada y no expirada (la expiración
 * autoritativa sigue siendo la del JWT; aquí es redundancia defensiva).
 */

/**
 * [6.3B.12] Login transaccional - cierre del riesgo U3 (carrera login +
 * role-change que podia emitir un JWT con roles stale y sesion allowlist
 * activa). La sesion del JWT se crea en la MISMA transaccion que lockea la
 * fila del usuario (SELECT ... FOR UPDATE) y lee sus roles; el mismo lock
 * que setRolesAndRevokeSessions adquiere como primer paso (6.3B.10), asi
 * que ambos flujos se serializan y no puede sobrevivir un JWT stale con
 * fila activa. buildToken recibe los roles leidos dentro de la tx; ante
 * error, la transaccion hace ROLLBACK sin dejar sesion ni JWT emitido.
 */
export async function createSessionForUser(
  sub: string,
  buildToken: (roles: string[]) => Promise<string>,
  activeOrgId?: string | null,
): Promise<{ jwt: string; roles: string[] }> {
  return db.transaction(async (tx) => {
    // Lock 1 (mismo orden que setRolesAndRevokeSessions): fila del usuario.
    await tx
      .select({ sub: usersTable.sub })
      .from(usersTable)
      .where(eq(usersTable.sub, sub))
      .for("update");

    // Lectura de roles DENTRO de la tx, tras adquirir el lock.
    const roleRows = await tx
      .select({ role: userRolesTable.role })
      .from(userRolesTable)
      .where(eq(userRolesTable.userSub, sub));
    const roles = roleRows.map((row) => row.role);

    const jwt = await buildToken(roles);

    const { jti, exp } = decodeJwt(jwt);
    if (typeof jti !== "string" || typeof exp !== "number") {
      throw new Error("JWT without jti/exp; refusing to create session");
    }
    await tx.insert(sessionsTable).values({
      jti,
      userSub: sub,
      expiresAt: new Date(exp * 1000),
      // M21.2 — contexto de organización inicial (primera membership). El
      // usuario puede cambiarlo con POST /api/orgs/active (valida membership).
      activeOrgId: activeOrgId ?? null,
    });

    return { jwt, roles };
  });
}

/** Devuelve la sesión solo si está activa (no revocada, no expirada y sin idle). */
export async function findActiveByJti(
  jti: string,
  idleSeconds: number,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.jti, jti),
        isNull(sessionsTable.revokedAt),
        gt(sessionsTable.expiresAt, new Date()),
        gt(
          sessionsTable.lastUsedAt,
          new Date(Date.now() - idleSeconds * 1000),
        ),
      ),
    );
  return row ?? null;
}

/** Actualiza el timestamp de última actividad de la sesión. */
/**
 * M18 Fase 5 — fila cruda de sesión por `jti`, sin filtros de actividad.
 * La usa `requireAuth` para distinguir la razón de un rechazo (expirada vs
 * inactiva vs revocada/desconocida) y auditarla. `null` ⇒ jti desconocido.
 */
export async function findRawByJti(jti: string): Promise<Session | null> {
  const rows = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.jti, jti))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * M18 Fase 3 — purga de sesiones huérfanas: elimina las expiradas antes del
 * corte y las revocadas con antigüedad mayor que la retención (el corte es
 * `now - retention`). Devuelve cuántas filas eliminó.
 */
export async function cleanupStale(cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(sessionsTable)
    .where(
      or(
        lte(sessionsTable.expiresAt, cutoff),
        and(
          isNotNull(sessionsTable.revokedAt),
          lte(sessionsTable.revokedAt, cutoff),
        ),
      ),
    )
    .returning({ jti: sessionsTable.jti });
  return deleted.length;
}

export async function touchLastUsed(jti: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessionsTable.jti, jti));
}

/** Revoca la sesión si estaba activa; true si la revocación fue efectiva. */
export async function revokeByJti(jti: string): Promise<boolean> {
  const rows = await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.jti, jti), isNull(sessionsTable.revokedAt)))
    .returning({ jti: sessionsTable.jti });
  return rows.length > 0;
}

/**
 * Lista las sesiones ACTIVAS de un usuario (no revocadas y no expiradas),
 * ordenadas por emisión descendente. Para `GET /api/auth/sessions` (M11.2.2):
 * devuelve solo metadatos propios de la fila — jti, fechas — nunca el claim
 * csrf (que vive en el JWT, no en la fila) ni ningún secreto.
 */
export async function listActiveByUser(userSub: string): Promise<Session[]> {
  return db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.userSub, userSub),
        isNull(sessionsTable.revokedAt),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessionsTable.issuedAt));
}

/**
 * Revoca TODAS las sesiones activas de un usuario (incluida la actual).
 * Para `POST /api/auth/logout-all` (M11.2.2). No transaccional: la revocación
 * es idempotente (re-chequea revoked_at IS NULL) y un fallo a mitad de camino
 * solo deja sesiones activas que la expiración del JWT invalidará igualmente.
 * Devuelve el número de sesiones revocadas en esta llamada.
 */
export async function revokeAllForUser(userSub: string): Promise<number> {
  const rows = await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.userSub, userSub), isNull(sessionsTable.revokedAt)))
    .returning({ jti: sessionsTable.jti });
  return rows.length;
}

/**
 * M21.2 — Fija (o cambia) la organización activa de UNA sesión.
 * La membership se valida DENTRO de la transacción: nunca se confía en un
 * valor del cliente sin re-verificar contra `memberships`.
 */
export async function setActiveOrganization(
  jti: string,
  userSub: string,
  organizationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ role: membershipsTable.role })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userSub, userSub),
          eq(membershipsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!membership) return false;

    const rows = await tx
      .update(sessionsTable)
      .set({ activeOrgId: organizationId })
      .where(and(eq(sessionsTable.jti, jti), eq(sessionsTable.userSub, userSub)))
      .returning({ jti: sessionsTable.jti });
    return rows.length > 0;
  });
}

/** Limpia el contexto activo de las sesiones del usuario cuando la membership de esa org desaparece. */
export async function clearActiveOrgForOrg(
  userSub: string,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .update(sessionsTable)
    .set({ activeOrgId: null })
    .where(
      and(
        eq(sessionsTable.userSub, userSub),
        eq(sessionsTable.activeOrgId, organizationId),
      ),
    )
    .returning({ jti: sessionsTable.jti });
  return rows.length;
}

/** Variante transaccional de clearActiveOrgForOrg (compone con revocaciones). */
export async function clearActiveOrgForOrgTx(
  tx: Pick<typeof db, "update">,
  userSub: string,
  organizationId: string,
): Promise<number> {
  const rows = await tx
    .update(sessionsTable)
    .set({ activeOrgId: null })
    .where(
      and(
        eq(sessionsTable.userSub, userSub),
        eq(sessionsTable.activeOrgId, organizationId),
      ),
    )
    .returning({ jti: sessionsTable.jti });
  return rows.length;
}

/**
 * M21.2 — Organización activa resuelta EN CADA REQUEST. Siempre contra la BD:
 * si la membership desapareció (baja/revocación), el contexto cae aunque la
 * sesión siga viva (el acceso a endpoints de plataforma es identitario).
 */
export async function resolveActiveOrganization(
  jti: string,
  userSub: string,
): Promise<{ organizationId: string; role: string } | null> {
  const [row] = await db
    .select({
      organizationId: sessionsTable.activeOrgId,
      role: membershipsTable.role,
    })
    .from(sessionsTable)
    .innerJoin(
      membershipsTable,
      and(
        eq(membershipsTable.organizationId, sessionsTable.activeOrgId),
        eq(membershipsTable.userSub, sessionsTable.userSub),
      ),
    )
    .where(and(eq(sessionsTable.jti, jti), eq(sessionsTable.userSub, userSub)))
    .limit(1);
  if (!row || !row.organizationId) return null;
  return { organizationId: row.organizationId, role: row.role };
}

/**
 * Variante transaccional: revoca todas las sesiones activas de un usuario
 * dentro de una transacción ya abierta (`tx`). Permite componer operaciones
 * atómicas (p. ej. cambio de roles + revocación) sin abrir una transacción
 * anidada: ante cualquier error, la transacción hace ROLLBACK y devuelve
 * sesiones y roles al estado previo.
 */
export async function revokeAllSessionsForUserTx(
  tx: Pick<typeof db, "update">,
  userSub: string,
): Promise<number> {
  const rows = await tx
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.userSub, userSub), isNull(sessionsTable.revokedAt)))
    .returning({ jti: sessionsTable.jti });
  return rows.length;
}

