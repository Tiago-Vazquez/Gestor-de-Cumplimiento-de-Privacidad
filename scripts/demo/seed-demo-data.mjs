#!/usr/bin/env node
/**
 * M29.1 — Datos sinteticos de DEMO (opt-in, nunca automatico).
 *
 * REGLA DURA: este script NUNCA se ejecuta al arrancar la aplicacion. Solo
 * cuando una persona lo invoca de forma explicita y confirma el entorno.
 *
 * Guardas (todas abortan ANTES de tocar la base):
 *   1. DEMO_SEED_CONFIRM debe ser exactamente "demo".
 *   2. NODE_ENV no puede ser "production".
 *   3. La URL de conexion debe parecer local (localhost / 127.0.0.1 / ::1).
 *
 * No contiene secretos, contrasenas ni credenciales de fuentes. La contrasena
 * del usuario demo llega por DEMO_USER_PASSWORD; si no se define, no se crea
 * ningun usuario con password.
 *
 * Idempotente: todo se inserta con ON CONFLICT DO NOTHING sobre claves
 * deterministas, de modo que reejecutarlo repone los datos sin duplicar.
 * Sigue el patron de lib/db/src/provision-admin.ts.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// pg y @workspace/auth se resuelven desde el workspace lib/db, que ya los
// declara. Asi este script corre SIN anadir dependencias a @workspace/scripts
// (anadirlas exigiria reinstalar y tocar el lockfile).
const require = createRequire(new URL('../../lib/db/package.json', import.meta.url));
const pg = require('pg');

const CONFIRM_TOKEN = 'demo';
const ORG_ID = 'demo-org';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function die(msg) {
  console.error(`demo-seed: ABORTADO — ${msg}`);
  process.exit(1);
}

function assertGuards() {
  if (process.env.DEMO_SEED_CONFIRM !== CONFIRM_TOKEN) {
    die(`falta la confirmacion explicita. Use: DEMO_SEED_CONFIRM=${CONFIRM_TOKEN} pnpm run demo:seed`);
  }
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
    die('NODE_ENV=production: este script solo escribe en desarrollo o demo.');
  }
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) die('falta ADMIN_DATABASE_URL o DATABASE_URL.');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    die(`ADMIN_DATABASE_URL no es una URL valida: ${url}`);
  }
  if (!LOCAL_HOSTS.includes(host)) {
    die(`el host "${host}" no es local; este script se niega a escribir fuera de localhost/127.0.0.1.`);
  }
}

async function main() {
  assertGuards();
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const summary = {};
  const q = async (label, sql, values = []) => {
    const r = await client.query(sql, values);
    summary[label] = r.rowCount ?? 0;
  };

  // 1. Organizacion de demo
  await q('organizations', `INSERT INTO organizations (id, name, slug, status, created_at)
    VALUES ($1, $2, $3, 'active', now()) ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, 'Demo Organization', 'demo-org']);

  // 2. Usuario demo (opcional; la contrasena NUNCA vive en el repo)
  const demoPassword = process.env.DEMO_USER_PASSWORD;
  if (demoPassword) {
    if (demoPassword.length < 8) die('DEMO_USER_PASSWORD debe tener al menos 8 caracteres.');
    const { hashPassword } = require('@workspace/auth');
    const hash = await hashPassword(demoPassword);
    const sub = 'demo-user';
    await q('users', `INSERT INTO users (sub, email, name, password_hash, created_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now()) ON CONFLICT (sub) DO NOTHING`,
      [sub, 'demo@demo.example', 'Demo User', hash]);
    await q('user_roles', `INSERT INTO user_roles (user_sub, role, created_at, updated_at)
      VALUES ($1, 'admin', now(), now()) ON CONFLICT DO NOTHING`, [sub]);
    await q('memberships', `INSERT INTO memberships (organization_id, user_sub, role, joined_at)
      VALUES ($1, $2, 'owner', now()) ON CONFLICT (organization_id, user_sub) DO NOTHING`,
      [ORG_ID, sub]);
  }

  // 3. Fuente de demo SIN conexion: connection_config NULL => scannable=false.
  await q('sources', `INSERT INTO sources (id, tenant_id, name, kind, environment, status, tables, records, created_at, updated_at)
    VALUES ($1,$2,$3,'postgresql','development','healthy',4,1200, now(), now())
    ON CONFLICT (id) DO NOTHING`,
    ['demo-src-1', ORG_ID, 'Demo PostgreSQL Source']);

  // 4. Hallazgos sinteticos (columnas notNull segun lib/db/src/schema/findings.ts)
  const findings = [
    ['demo-find-1', 'Email', 'pii', 'users.email', 'high', 480, 'GDPR', 'Cifrar la columna'],
    ['demo-find-2', 'Phone', 'pii', 'users.phone', 'medium', 120, 'GDPR', 'Revisar el tratamiento'],
    ['demo-find-3', 'Nombre completo', 'pii', 'customers.full_name', 'low', 40, 'RGPD Art. 4', 'Documentar el proposito'],
  ];
  for (const [id, title, dataType, location, severity, records, regulation, recommendation] of findings) {
    await q('findings', `INSERT INTO findings
        (id, tenant_id, source_id, source_name, title, data_type, location, severity, status,
         records, detected_at, regulation, recommendation, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9, now(), $10, $11, now(), now())
      ON CONFLICT (id) DO NOTHING`,
      [id, ORG_ID, 'demo-src-1', 'Demo PostgreSQL Source', title, dataType, location, severity, records, regulation, recommendation]);
  }

  // 5. Reglas de compliance. OJO: `rules` NO tiene tenant_id (catalogo global).
  for (const [id, name, category, regulation] of [
    ['demo-rule-1', 'Emails en columnas de texto', 'pii', 'GDPR'],
    ['demo-rule-2', 'Telefonos en texto libre', 'pii', 'GDPR'],
  ]) {
    await q('rules', `INSERT INTO rules (id, name, category, regulation, enabled, detections, created_at, updated_at)
      VALUES ($1,$2,$3,$4,true,0, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [id, name, category, regulation]);
  }

  // 6. Actividad reciente para que el dashboard no arranque vacio.
  await q('activity', `INSERT INTO activity (id, tenant_id, type, title, description, created_at)
    SELECT $1 || '-' || g, $2, 'demo', 'Datos de demo cargados', 'Actividad sintetica para la demostracion', now() - (g || ' minutes')::interval
    FROM generate_series(1, 5) AS g
    ON CONFLICT (id) DO NOTHING`, [randomUUID(), ORG_ID]);

  await client.end();
  console.log('demo-seed: OK (idempotente). Filas insertadas o ya presentes:');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  if (!demoPassword) {
    console.log('  (no se creo usuario: define DEMO_USER_PASSWORD si lo necesitas)');
  }
}

main().catch((err) => {
  console.error('demo-seed: ERROR —', err instanceof Error ? err.message : err);
  process.exit(1);
});