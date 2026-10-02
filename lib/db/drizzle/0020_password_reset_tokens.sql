-- ============================================================================
-- M30.0 — Recuperación de contraseña: tabla `password_reset_tokens`.
--
-- Clona el diseño de seguridad ya probado en `invitations`:
--   * `token_hash` guarda SOLO el hash SHA-256. El token en claro (32 bytes
--     aleatorios) se genera en runtime, viaja una vez por el seam de entrega
--     y NUNCA se persiste.
--   * Índice único sobre `token_hash`: lookup por hash + no colisión.
--   * `consumed_at` marca el uso único (NULL = pendiente), igual que
--     `invitations.accepted_at`.
--   * CHECK de expiración: un token no puede nacer ya expirado.
--
-- A diferencia de `invitations`, no hay `organization_id`: el reset es de la
-- cuenta, no de una organización.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
"id" text PRIMARY KEY,
"user_sub" text NOT NULL,
"token_hash" text NOT NULL,
"expires_at" timestamp with time zone NOT NULL,
"consumed_at" timestamp with time zone,
"requested_ip" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "password_reset_tokens_user_sub_users_sub_fk" FOREIGN KEY ("user_sub") REFERENCES "users"("sub") ON DELETE cascade,
CONSTRAINT "password_reset_tokens_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE("token_hash");
EXCEPTION
 WHEN duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_sub_users_sub_fk" FOREIGN KEY ("user_sub") REFERENCES "users"("sub") ON DELETE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_sub");
--> statement-breakpoint
-- M30.0: permisos para `app_role` (rol con el que corre el API HTTP).
--
-- La migración 0018 hace `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_role`
-- y concede privileges TABLA POR TABLA. Una tabla creada despues NO los hereda:
-- sin este GRANT, `POST /api/auth/password/forgot` fallaria con
-- `permission denied` al insertar, devolviendo un 500 en la rama de cuenta
-- existente y rompiendo la garantia anti-enumeracion.
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO app_role;