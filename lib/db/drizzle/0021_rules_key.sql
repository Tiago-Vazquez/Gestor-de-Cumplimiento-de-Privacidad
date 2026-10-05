-- ============================================================================
-- M37.0 — Separación de identidad técnica (`key`) y nombre visible (`name`).
--
-- `rules.key` es la identidad técnica estable que asocia una fila persistida
-- con una entrada de BUILT_IN_RULES (`email|phone|national_id|credit_card`).
-- Es NOT NULL + UNIQUE y NO editable vía API (solo `enabled` es gobernable).
--
-- Orden seguro para bases existentes:
--   1. Añadir `key` como nullable.
--   2. Backfill determinista por `id` (mapping confirmado en M36.2).
--   3. `SET NOT NULL` (verifica que ninguna fila quede sin key).
--   4. Constraint UNIQUE (respalda una única fila por clave técnica).
-- ============================================================================
ALTER TABLE "rules" ADD COLUMN "key" text;
--> statement-breakpoint
-- Backfill determinista por `id`. Las ids `rule-00X` son mocks en memoria
-- (no existen en BD); se incluyen por completitud del mapping de M36.2 pero
-- no afectan a filas reales. Cualquier fila no mapeable queda con `key` NULL
-- y provoca el fallo del `SET NOT NULL` siguiente (backfill incompleto).
UPDATE "rules"
SET "key" = CASE "id"
  WHEN 'demo-rule-1' THEN 'email'
  WHEN 'demo-rule-2' THEN 'phone'
  WHEN 'rule-001' THEN 'email'
  WHEN 'rule-002' THEN 'national_id'
  WHEN 'rule-003' THEN 'credit_card'
  WHEN 'rule-004' THEN 'phone'
END
WHERE "key" IS NULL;
--> statement-breakpoint
-- Verificación implícita: falla si quedó alguna fila sin key (backfill incompleto).
ALTER TABLE "rules" ALTER COLUMN "key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_key_unique" UNIQUE("key");
