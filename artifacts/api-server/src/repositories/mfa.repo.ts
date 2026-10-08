import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { decodeJwt } from "jose";
import {
  db,
  mfaRecoveryCodesTable,
  sessionsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { newId } from "./ids";

/**
 * MFA (TOTP) — repositorio.
 *
 * La capa de rutas hace el cifrado/descifrado del secreto (`secret-manager`) y
 * la verificación TOTP (`lib/totp`). Este repositorio solo persiste el estado
 * MFA y los códigos de recuperación, clonando los patrones transaccionales ya
 * auditados (`password-reset.repo.ts`, `invitations.repo.ts`).
 */

export const MFA_RECOVERY_CODE_COUNT = 10;

const RECOVERY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_CODE_LENGTH = 10;

/** Genera un recovery code aleatorio y legible. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return code;
}

/** Solo el hash viaja a la BD; el código plano existe en memoria/respuesta. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Normaliza un recovery code introducido (mayúsculas, sin espacios/guiones). */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/** Genera N pares { plain, hash } para enrolamiento/regeneración. */
export function generateRecoveryCodes(
  count: number = MFA_RECOVERY_CODE_COUNT,
): { plain: string; hash: string }[] {
  return Array.from({ length: count }, () => {
    const plain = generateRecoveryCode();
    return { plain, hash: hashRecoveryCode(plain) };
  });
}

/**
 * Regenera los recovery codes: borra todos los del usuario y crea los nuevos
 * en una transacción. Devuelve los códigos en claro (UNA sola vez).
 */
export async function regenerateRecoveryCodes(userSub: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx
      .delete(mfaRecoveryCodesTable)
      .where(eq(mfaRecoveryCodesTable.userSub, userSub));
    if (codes.length > 0) {
      await tx.insert(mfaRecoveryCodesTable).values(
        codes.map((c) => ({
          id: newId("mrc"),
          userSub,
          codeHash: c.hash,
        })),
      );
    }
  });
  return codes.map((c) => c.plain);
}

export type ConsumeRecoveryResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_used" };

/**
 * Consumo atómico (single-use): `FOR UPDATE` + `used_at IS NULL` serializa los
 * consumidores concurrentes; el segundo ve `used_at` ya fijado.
 */
export async function consumeRecoveryCode(
  userSub: string,
  codeHash: string,
  now: Date,
): Promise<ConsumeRecoveryResult> {
  return db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(mfaRecoveryCodesTable)
      .where(
        and(
          eq(mfaRecoveryCodesTable.userSub, userSub),
          eq(mfaRecoveryCodesTable.codeHash, codeHash),
        ),
      )
      .for("update")
      .limit(1);
    if (!code) return { ok: false as const, reason: "not_found" as const };
    if (code.usedAt) return { ok: false as const, reason: "already_used" as const };

    const consumed = await tx
      .update(mfaRecoveryCodesTable)
      .set({ usedAt: now })
      .where(
        and(
          eq(mfaRecoveryCodesTable.id, code.id),
          isNull(mfaRecoveryCodesTable.usedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodesTable.id });
    if (consumed.length === 0) {
      return { ok: false as const, reason: "already_used" as const };
    }

    return { ok: true as const };
  });
}

/** Lista los recovery codes del usuario (sin exponer el hash). */
export async function listRecoveryCodes(
  userSub: string,
): Promise<{ id: string; usedAt: Date | null; createdAt: Date }[]> {
  return db
    .select({
      id: mfaRecoveryCodesTable.id,
      usedAt: mfaRecoveryCodesTable.usedAt,
      createdAt: mfaRecoveryCodesTable.createdAt,
    })
    .from(mfaRecoveryCodesTable)
    .where(eq(mfaRecoveryCodesTable.userSub, userSub));
}

// --- Estado MFA en `users` ---

export interface MfaState {
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  mfaSecretSetAt: Date | null;
  mfaEnabledAt: Date | null;
  mfaLastVerifiedStep: number | null;
}

export async function getMfaState(userSub: string): Promise<MfaState | null> {
  const [row] = await db
    .select({
      mfaEnabled: usersTable.mfaEnabled,
      mfaSecretEncrypted: usersTable.mfaSecretEncrypted,
      mfaSecretSetAt: usersTable.mfaSecretSetAt,
      mfaEnabledAt: usersTable.mfaEnabledAt,
      mfaLastVerifiedStep: usersTable.mfaLastVerifiedStep,
    })
    .from(usersTable)
    .where(eq(usersTable.sub, userSub));
  return row ?? null;
}

/**
 * Guarda el secreto cifrado como PENDIENTE de enrolamiento. No toca
 * `mfa_enabled` (permanece false hasta `enableMfa`).
 *
 * Protección anti-sobrescritura: solo escribe si `mfa_enabled = false`
 * (defensa en profundidad frente al guard de 409 de la ruta). Devuelve
 * `false` si MFA ya está habilitado (0 filas afectadas) — el llamador
 * debe tratarlo como conflicto.
 */
export async function beginMfaSetup(
  userSub: string,
  encryptedSecret: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(usersTable)
    .set({
      mfaSecretEncrypted: encryptedSecret,
      mfaSecretSetAt: now,
    })
    .where(and(eq(usersTable.sub, userSub), eq(usersTable.mfaEnabled, false)))
    .returning({ sub: usersTable.sub });
  return rows.length > 0;
}

/** Marca MFA habilitado (el código TOTP ya fue verificado por la ruta). */
export async function enableMfa(userSub: string, now: Date): Promise<void> {
  await db
    .update(usersTable)
    .set({
      mfaEnabled: true,
      mfaEnabledAt: now,
    })
    .where(eq(usersTable.sub, userSub));
}

/**
 * Deshabilita MFA: limpia secreto y metadatos y ELIMINA todos los recovery
 * codes del usuario en la misma transacción (no quedan códigos huérfanos
 * que pudieran volver a servir en un re-habilitar).
 */
export async function disableMfa(userSub: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaSecretSetAt: null,
        mfaEnabledAt: null,
        mfaLastVerifiedStep: null,
      })
      .where(eq(usersTable.sub, userSub));
    await tx
      .delete(mfaRecoveryCodesTable)
      .where(eq(mfaRecoveryCodesTable.userSub, userSub));
  });
}

/**
 * Anti-replay: avance condicional atómico del último time-step verificado.
 * Solo avanza (nunca retrocede). Devuelve false si el step ya fue verificado.
 */
export async function advanceLastVerifiedStep(
  userSub: string,
  step: number,
): Promise<boolean> {
  const rows = await db
    .update(usersTable)
    .set({ mfaLastVerifiedStep: step })
    .where(
      and(
        eq(usersTable.sub, userSub),
        or(
          isNull(usersTable.mfaLastVerifiedStep),
          lt(usersTable.mfaLastVerifiedStep, step),
        ),
      ),
    )
    .returning({ sub: usersTable.sub });
  return rows.length > 0;
}

// --- Sesiones MFA (Fase 2): pre-MFA y promoción ---

/**
 * Marca (o desmarca) una sesión como pre-MFA (`sessions.mfa_pending`).
 * Usado por el login para crear la sesión de desafío (TTL 5 min).
 */
export async function setSessionMfaPending(
  jti: string,
  value: boolean,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ mfaPending: value })
    .where(eq(sessionsTable.jti, jti));
}

export type PromoteResult =
  | { ok: true; jwt: string; roles: string[] }
  | { ok: false; reason: "replay" };

/**
 * Promueve una sesión pre-MFA a sesión completa en UNA transacción:
 *  1. lock de la fila del usuario (mismo orden que `createSessionForUser`);
 *  2. (opcional) anti-replay `mfa_last_verified_step` (`advanceStep`) — gate
 *     atómico: dos verificaciones concurrentes del mismo step → solo una gana;
 *  3. lectura de roles dentro de la misma tx;
 *  4. firma del JWT completo (via `buildToken`);
 *  5. revocación de la sesión pendiente;
 *  6. alta de la sesión completa (`mfa_pending=false`).
 *
 * Si `advanceStep` no avanza (replay) → ROLLBACK total y `ok:false`.
 * Si `advanceStep` está ausente (recuperación por recovery code) solo se
 * ejecutan 3–6.
 */
export async function promotePendingSession(input: {
  userSub: string;
  pendingJti: string;
  buildToken: (roles: string[]) => Promise<string>;
  activeOrgId?: string | null;
  now: Date;
  advanceStep?: number;
}): Promise<PromoteResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ sub: usersTable.sub })
      .from(usersTable)
      .where(eq(usersTable.sub, input.userSub))
      .for("update");

    if (input.advanceStep !== undefined) {
      const advanced = await tx
        .update(usersTable)
        .set({ mfaLastVerifiedStep: input.advanceStep })
        .where(
          and(
            eq(usersTable.sub, input.userSub),
            or(
              isNull(usersTable.mfaLastVerifiedStep),
              lt(usersTable.mfaLastVerifiedStep, input.advanceStep),
            ),
          ),
        )
        .returning({ sub: usersTable.sub });
      if (advanced.length === 0) {
        return { ok: false as const, reason: "replay" as const };
      }
    }

    const roleRows = await tx
      .select({ role: userRolesTable.role })
      .from(userRolesTable)
      .where(eq(userRolesTable.userSub, input.userSub));
    const roles = roleRows.map((r) => r.role);

    const jwt = await input.buildToken(roles);
    const { jti, exp } = decodeJwt(jwt);
    if (typeof jti !== "string" || typeof exp !== "number") {
      throw new Error("JWT without jti/exp; refusing to promote session");
    }

    await tx
      .update(sessionsTable)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(sessionsTable.jti, input.pendingJti),
          eq(sessionsTable.userSub, input.userSub),
        ),
      );

    await tx.insert(sessionsTable).values({
      jti,
      userSub: input.userSub,
      expiresAt: new Date(exp * 1000),
      activeOrgId: input.activeOrgId ?? null,
      mfaPending: false,
    });

    return { ok: true as const, jwt, roles };
  });
}
