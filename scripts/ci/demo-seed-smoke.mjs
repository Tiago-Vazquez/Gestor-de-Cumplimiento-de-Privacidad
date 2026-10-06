#!/usr/bin/env node
/**
 * Smoke test del dataset demo (FASE 2). Requiere una PostgreSQL LOCAL ya
 * migrada (las guardas del seed exigen localhost). Corre el seed DOS veces y
 * verifica las invariantes. Es un smoke test acotado, NO una suite de
 * integración completa.
 *
 * Uso:
 *   SMOKE_DATABASE_URL='postgresql://privacy:...@localhost:5432/privacy' \
 *   node scripts/ci/demo-seed-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(new URL('../../lib/db/package.json', import.meta.url));
const pg = require('pg');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = path.join(ROOT, 'scripts', 'demo', 'seed-demo-data.mjs');
const DB_URL = process.env.SMOKE_DATABASE_URL ?? process.env.ADMIN_DATABASE_URL;
const PASSWORD = process.env.SMOKE_DEMO_PASSWORD ?? 'demo-password-123456';

if (!DB_URL) {
  console.error('SMOKE_DATABASE_URL is required');
  process.exit(1);
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failures += 1;
  }
}

function runSeed() {
  const r = spawnSync(process.execPath, [SEED], {
    env: {
      ...process.env,
      DEMO_SEED_CONFIRM: 'demo',
      NODE_ENV: 'development',
      ADMIN_DATABASE_URL: DB_URL,
      DATABASE_URL: DB_URL,
      DEMO_USER_PASSWORD: PASSWORD,
    },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('seed run failed:\n', r.stderr || r.stdout);
    process.exit(1);
  }
}

const EXPECTED = {
  'nexa-financiera': { score: 90, sev: { critical: 0, high: 0, medium: 3, low: 1 } },
  'vitalis-salud': { score: 73, sev: { critical: 0, high: 2, medium: 3, low: 4 } },
  'retail-andino': { score: 60, sev: { critical: 1, high: 1, medium: 4, low: 6 } },
  'technova-labs': { score: 35, sev: { critical: 2, high: 3, medium: 3, low: 5 } },
  'lexcorp-legal': { score: 8, sev: { critical: 4, high: 3, medium: 3, low: 2 } },
};

function scoreOf(sev) {
  return Math.max(0, 100 - (sev.low + 3 * sev.medium + 7 * sev.high + 15 * sev.critical));
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
const many = async (sql, params = []) => (await client.query(sql, params)).rows;

async function snapshot() {
  const g = async (sql) => (await one(sql)).n;
  return {
    orgs: await g(`SELECT count(*)::int AS n FROM organizations WHERE id LIKE 'demo-org-%'`),
    sources: await g(`SELECT count(*)::int AS n FROM sources WHERE tenant_id LIKE 'demo-org-%'`),
    findings: await g(`SELECT count(*)::int AS n FROM findings WHERE tenant_id LIKE 'demo-org-%'`),
    reports: await g(`SELECT count(*)::int AS n FROM reports WHERE tenant_id LIKE 'demo-org-%'`),
    users: await g(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@demo.example.invalid'`),
  };
}

console.log('1. Ejecutando seed (1ª vez)…');
runSeed();
const first = await snapshot();

console.log('2. Ejecutando seed (2ª vez)…');
runSeed();
const second = await snapshot();

console.log('3. Verificando invariantes:');
check(first.orgs === 5, `exactamente 5 organizaciones demo (got ${first.orgs})`);
check(first.sources === 15, `15 fuentes demo (got ${first.sources})`);
check(first.findings >= 70 && first.findings <= 80, `findings en 70..80 (got ${first.findings})`);
check(first.reports === 10, `10 reports demo (got ${first.reports})`);
check(first.users === 11, `11 usuarios demo (got ${first.users})`);

// Reglas globales 4/4 (catálogo único, sin tenant).
const rules = await many(`SELECT key FROM rules WHERE id LIKE 'demo-rule-%' ORDER BY key`);
check(
  rules.length === 4 &&
    ['credit_card', 'email', 'national_id', 'phone'].every((k) => rules.some((r) => r.key === k)),
  'reglas globales 4/4: email, phone, national_id, credit_card',
);

// Severidades abiertas + score derivado por organización.
for (const [slug, exp] of Object.entries(EXPECTED)) {
  const org = await one(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
  if (!org) {
    check(false, `org ${slug} existe`);
    continue;
  }
  const rows = await many(
    `SELECT severity, count(*)::int AS n FROM findings WHERE tenant_id = $1 AND status='open' AND superseded=false GROUP BY severity`,
    [org.id],
  );
  const sev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) if (sev[r.severity] !== undefined) sev[r.severity] = r.n;
  const sevOk = Object.keys(exp.sev).every((k) => sev[k] === exp.sev[k]);
  check(sevOk, `${slug} severidades abiertas ${JSON.stringify(exp.sev)} (got ${JSON.stringify(sev)})`);
  const score = scoreOf(sev);
  check(score === exp.score, `${slug} score ${exp.score} (got ${score})`);
}

// Reports con content JSONB (la base para el PDF de Fase 1).
const reportsNoContent = await one(
  `SELECT count(*)::int AS n FROM reports WHERE tenant_id LIKE 'demo-org-%' AND content IS NULL`,
);
check(reportsNoContent.n === 0, 'todos los reports tienen content JSONB');

// Aislamiento de tenant: ningún finding con tenant_id distinto del de su source.
const leaked = await one(
  `SELECT count(*)::int AS n FROM findings f JOIN sources s ON f.source_id = s.id WHERE f.tenant_id <> s.tenant_id`,
);
check(leaked.n === 0, 'aislamiento de tenant: ningún finding con tenant_id distinto de su source');

// Relaciones source -> scan -> finding.
const badScanSource = await one(
  `SELECT count(*)::int AS n FROM scans sc LEFT JOIN sources s ON sc.source_id = s.id WHERE s.id IS NULL`,
);
check(badScanSource.n === 0, 'todos los scans referencian una source válida');
const badFindingScan = await one(
  `SELECT count(*)::int AS n FROM findings f JOIN scans sc ON f.scan_id = sc.id WHERE f.source_id <> sc.source_id`,
);
check(badFindingScan.n === 0, 'findings.scan_id coherente con su source');

// Idempotencia: la segunda ejecución no duplicó.
check(
  JSON.stringify(first) === JSON.stringify(second),
  `idempotente: conteos estables entre ejecuciones (${JSON.stringify(first)})`,
);

await client.end();
if (failures > 0) {
  console.error(`\nSMOKE FAILED (${failures})`);
  process.exit(1);
}
console.log('\nSMOKE OK');

