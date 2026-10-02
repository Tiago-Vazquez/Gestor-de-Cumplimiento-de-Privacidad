import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, passwordResetTokensTable, usersTable, sessionsTable } from "@workspace/db";
import { newId } from "./ids";

/**
 * M30.0 — Recuperación de contraseña (flujo backend).
 *
 * Clona el diseño de `invitations.repo.ts`, que ya está auditado:
 *
 * - El token NUNCA se persiste. Se genera con `randomBytes(32)` (256 bits de
 *   entropía), se entrega UNA vez por el seam de entrega y en la BD solo vive
 *   su hash SHA-256.
 * - `consumeByTokenHash` es el núcleo anti-carrera: el `SELECT ... FOR UPDATE`
 *   serializa a los reinyectores concurrentes y la actualización final lleva
 *   `IS NULL`, de modo que el segundo ve `consumed_at` ya fijado.
 * - Cualquier fallo devuelve ROLLBACK: no se cambia la contraseña a medias.
 */

/** Ventana de validez del enlace. Corta a propósito: el token es una credencial. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;

/** Solo el hash viaja a la BD; el token plano existe en memoria y en el seam. */
export function generatePasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ConsumePasswordResetResult =
  | { ok: true; userSub: string }
  | { ok: false; reason: "not_found" | "already_used" | "expired" };

/**
 * Crea el token e invalida los pendientes anteriores del mismo usuario.
 *
 * Invalidar es deliberado: pedir un reset dos veces NO debe dejar dos enlaces
 * vivos, porque solo se entrega el último.
 */
export async function create(values: {
  userSub: string;
  tokenHash: string;
  expiresAt: Date;
  requestedIp?: string | null;
}): Promise<PasswordResetToken> {
  const now = new Date();
  const [row] = await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokensTable)
      .set({ consumedAt: now })
      .where(
        and(
          eq(passwordResetTokensTable.userSub, values.userSub),
          isNull(passwordResetTokensTable.consumedAt),
        ),
      );
    return tx
      .insert(passwordResetTokensTable)
      .values({
        id: newId("prt"),
        userSub: values.userSub,
        tokenHash: values.tokenHash,
        expiresAt: values.expiresAt,
        requestedIp: values.requestedIp ?? null,
      })
      .returning();
  });
  return row;
}

/**
 * Consumo atómico: valida estado, cambia la contraseña y revoca TODAS las
 * sesiones del usuario en UNA transacción.
 *
 * Revocar todas (incluida la de quien hace el reset) es lo correcto: si el
 * token se usó, el resto de sesiones existentes quedó potencialmente
 * expuestas junto a la contraseña que se acaba de cambiar.
 */
export async function consumeByTokenHash(input: {
  tokenHash: string;
  newPasswordHash: string;
  now: Date;
}): Promise<ConsumePasswordResetResult> {
  return db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.tokenHash, input.tokenHash))
      .for("update")
      .limit(1);
    if (!token) return { ok: false as const, reason: "not_found" as const };
    if (token.consumedAt) return { ok: false as const, reason: "already_used" as const };
    if (token.expiresAt.getTime() <= input.now.getTime()) {
      return { ok: false as const, reason: "expired" as const };
    }

    await tx
      .update(usersTable)
      .set({ passwordHash: input.newPasswordHash })
      .where(eq(usersTable.sub, token.userSub));

    // Toda sesión del usuario queda revocada (INCLUDING las vivas).
    await tx
      .update(sessionsTable)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(sessionsTable.userSub, token.userSub),
          isNull(sessionsTable.revokedAt),
        ),
      );

    // Consumo condicionado a `IS NULL`: doble defensa ante carreras.
    const consumed = await tx
      .update(passwordResetTokensTable)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(passwordResetTokensTable.id, token.id),
          isNull(passwordResetTokensTable.consumedAt),
        ),
      )
      .returning({ id: passwordResetTokensTable.id });
    if (consumed.length === 0) return { ok: false as const, reason: "already_used" as const };

    return { ok: true as const, userSub: token.userSub };
  });
}