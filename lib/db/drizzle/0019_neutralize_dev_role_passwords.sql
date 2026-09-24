-- ============================================================================
-- M22 (P0-1) — Neutraliza las contraseñas dev-only de app_role / bg_role.
--
-- La migración 0018 creó los roles con contraseñas dev-only hardcodeadas
-- ('app-role-dev-only' / 'bg-role-dev-only'). Esta migración las INVALIDA de
-- forma fail-closed (PASSWORD NULL = login por contraseña deshabilitado), de
-- modo que NINGUNA credencial utilizable quede versionada en el repositorio.
--
-- Las contraseñas REALES se provisionan en runtime por `db:provision-roles`
-- (lee APP_ROLE_PASSWORD / BG_ROLE_PASSWORD del entorno y ejecuta
-- `ALTER ROLE ... PASSWORD`). Esta migración NO fija ninguna contraseña.
--
-- Seguro para instalaciones nuevas y existentes: 0018 ya corrió (creó los
-- roles y las contraseñas dev), 0019 las invalida, y el provisioning posterior
-- (o la rotación manual) fija la contraseña real.
--
-- ROLLBACK / rotación: re-ejecutar `db:provision-roles` con los secretos del
-- entorno (no hay contraseña que "recuperar" de una migración).
-- ============================================================================

-- Re-afirma atributos (defensa en profundidad; idénticos a 0018).
ALTER ROLE app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE bg_role NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
--> statement-breakpoint

-- Neutraliza las contraseñas dev-only versionadas en 0018.
ALTER ROLE app_role PASSWORD NULL;
--> statement-breakpoint
ALTER ROLE bg_role PASSWORD NULL;
--> statement-breakpoint
