import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, invitationsTable, membershipsTable } from "@workspace/db";
import { newId } from "./ids";

/**
 * M21.2 — Invitaciones (flujo backend sobre el modelo de M21.1).
 *
 * El token NUNCA se persiste: se genera aleatorio (32 bytes), se entrega una
 * única vez al destinatario en la respuesta (flujo temporal MVP, sin email) y
 * en BD solo vive su hash SHA-256 (índice único `invitations_token_hash_key`).
 *
 * `consumeByTokenHash` es el núcleo anti-carrera (doble aceptación): UNA
 * transacción con `FOR UPDATE` sobre la fila de la invitación serializa los
 * aceptantes concurrentes; el segundo ve `accepted_at` ya fijado (o la PK
 * compuesta del membership rechaza el segundo insert). Cualquier fallo →
 * ROLLBACK: no se crea membership ni se marca aceptada a medias.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Roles invitables. El `owner` se transfiere explícitamente, nunca se invita. */
export const INVITABLE_ROLES: readonly ("admin" | "auditor" | "member")[] = [
  "admin",
  "auditor",
  "member",
];

export type Invitation = typeof invitationsTable.$inferSelect;

/** Solo el hash viaja a la BD; el token plano existe en memoria y respuesta. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function create(values: {
  organizationId: string;
  email: string;
  role: (typeof INVITABLE_ROLES)[number];
  tokenHash: string;
  expiresAt: Date;
  invitedBy: string;
}): Promise<Invitation> {
  const [row] = await db
    .insert(invitationsTable)
    .values({
      id: newId("inv"),
      organizationId: values.organizationId,
      email: values.email,
      role: values.role,
      tokenHash: values.tokenHash,
      expiresAt: values.expiresAt,
      invitedBy: values.invitedBy,
    })
    .returning();
  return row;
}

/** Proyección SIN token_hash (nunca sale de la BD). */
export async function listByOrg(
  organizationId: string,
): Promise<
  { id: string; email: string; role: string; expiresAt: Date; acceptedAt: Date | null; createdAt: Date }[]
> {
  return db
    .select({
      id: invitationsTable.id,
      email: invitationsTable.email,
      role: invitationsTable.role,
      expiresAt: invitationsTable.expiresAt,
      acceptedAt: invitationsTable.acceptedAt,
      createdAt: invitationsTable.createdAt,
    })
    .from(invitationsTable)
    .where(eq(invitationsTable.organizationId, organizationId))
    .orderBy(desc(invitationsTable.createdAt), asc(invitationsTable.id));
}

/** Revoca (borra) una invitación pendiente de ESA organización. */
export async function revoke(organizationId: string, invitationId: string): Promise<boolean> {
  const rows = await db
    .delete(invitationsTable)
    .where(
      and(
        eq(invitationsTable.id, invitationId),
        eq(invitationsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: invitationsTable.id });
  return rows.length > 0;
}

export type ConsumeInvitationResult =
  | { ok: true; organizationId: string; role: string; invitationId: string }
  | { ok: false; reason: "not_found" | "already_accepted" | "expired" | "already_member" };

/**
 * Aceptación atómica: valida estado + consume (accepted_at) + alta del
 * membership en UNA transacción. El email ya fue validado contra el usuario
 * autenticado por la capa de rutas (la invitación es personal).
 */
export async function consumeByTokenHash(input: {
  tokenHash: string;
  userSub: string;
  now: Date;
  /**
   * Email del usuario autenticado (la invitación es PERSONAL). Si viene y no
   * coincide con `invitations.email`, se responde `not_found` — mismo contrato
   * que un token inexistente, para no filtrar cuál de los dos falló.
   */
  expectedEmail?: string;
}): Promise<ConsumeInvitationResult> {
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.tokenHash, input.tokenHash))
      .for("update")
      .limit(1);
    if (!invitation) return { ok: false, reason: "not_found" as const };
    if (input.expectedEmail !== undefined && invitation.email !== input.expectedEmail) {
      return { ok: false, reason: "not_found" as const };
    }
    if (invitation.acceptedAt) return { ok: false, reason: "already_accepted" as const };
    if (invitation.expiresAt.getTime() <= input.now.getTime()) {
      return { ok: false, reason: "expired" as const };
    }

    // Alta idempotente por PK compuesta: la carrera de dos aceptaciones
    // simultáneas la resuelve la BD (el segundo insert no inserta).
    const [membership] = await tx
      .insert(membershipsTable)
      .values({
        organizationId: invitation.organizationId,
        userSub: input.userSub,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
      })
      .onConflictDoNothing({
        target: [membershipsTable.organizationId, membershipsTable.userSub],
      })
      .returning();
    if (!membership) return { ok: false, reason: "already_member" as const };

    // Consumo: solo la fila aún no aceptada (doble defensa contra carreras).
    // `acceptedAt` es NULL para una invitación pendiente: la comparación usa
    // IS NULL (eq contra null no es válido en SQL).
    const consumed = await tx
      .update(invitationsTable)
      .set({ acceptedAt: input.now })
      .where(
        and(eq(invitationsTable.id, invitation.id), isNull(invitationsTable.acceptedAt)),
      )
      .returning({ id: invitationsTable.id });
    if (consumed.length === 0) return { ok: false, reason: "already_accepted" as const };

    return {
      ok: true,
      organizationId: invitation.organizationId,
      role: invitation.role,
      invitationId: invitation.id,
    };
  });
}