#!/usr/bin/env node
/**
 * M29.1 / FASE 2 — Datos sintéticos de DEMO empresarial (opt-in, nunca automático).
 *
 * REGLA DURA: este script NUNCA se ejecuta al arrancar la aplicación. Solo
 * cuando una persona lo invoca de forma explícita y confirma el entorno.
 *
 * Guardas (todas abortan ANTES de tocar la base):
 *   1. DEMO_SEED_CONFIRM debe ser exactamente "demo".
 *   2. NODE_ENV no puede ser "production".
 *   3. La URL de conexión debe parecer local (localhost / 127.0.0.1 / ::1).
 *
 * 100 % sintético: sin emails, nombres, teléfonos, DNI, tarjetas, API keys ni
 * credenciales reales. La contraseña demo llega por DEMO_USER_PASSWORD; si no
 * se define, no se crea ningún usuario con password.
 *
 * Idempotente: IDs deterministas + ON CONFLICT DO NOTHING. Reejecutarlo repone
 * los datos sin duplicar. NO borra, NO trunca, NO resetea.
 */
import { createRequire } from 'node:module';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const require = createRequire(new URL('../../lib/db/package.json', import.meta.url));
const pg = require('pg');

const CONFIRM_TOKEN = 'demo';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function die(msg) {
  console.error(`demo-seed: ABORTADO — ${msg}`);
  process.exit(1);
}

function assertGuards() {
  if (process.env.DEMO_SEED_CONFIRM !== CONFIRM_TOKEN) {
    die(`falta la confirmación explícita. Use: DEMO_SEED_CONFIRM=${CONFIRM_TOKEN} pnpm run demo:seed`);
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
    die(`ADMIN_DATABASE_URL no es una URL válida: ${url}`);
  }
  if (!LOCAL_HOSTS.includes(host)) {
    die(`el host "${host}" no es local; este script se niega a escribir fuera de localhost/127.0.0.1.`);
  }
}

// ---------------------------------------------------------------------------
// Catálogo global de reglas (BUILT_IN_RULES: email|phone|national_id|credit_card).
// `rules` NO tiene tenant_id: se siembra UNA vez y es compartido por todas las orgs.
// ---------------------------------------------------------------------------
const RULES = [
  { id: 'demo-rule-email', key: 'email', name: 'Emails en columnas de texto', category: 'pii', regulation: 'GDPR Art. 32' },
  { id: 'demo-rule-phone', key: 'phone', name: 'Teléfonos en texto libre', category: 'pii', regulation: 'LGPD Art. 46' },
  { id: 'demo-rule-national-id', key: 'national_id', name: 'Documentos de identidad', category: 'pii', regulation: 'LGPD Art. 46' },
  { id: 'demo-rule-credit-card', key: 'credit_card', name: 'Tarjetas de pago', category: 'financial', regulation: 'PCI DSS 3.4' },
];

// Perfil por tipo de dato (coincide con BUILT_IN_RULES): título, sample enmascarado,
// regulación y recomendación. `sample` es SIEMPRE sintético y enmascarado.
const DATA_TYPES = {
  email: { label: 'Emails', sample: 'j*****@*****.com', regulation: 'GDPR Art. 32', recommendation: 'Cifrar la columna y restringir el acceso.' },
  phone: { label: 'Teléfonos', sample: '+54 9 **** 1234', regulation: 'LGPD Art. 46', recommendation: 'Enmascarar los últimos dígitos del número.' },
  national_id: { label: 'Documentos de identidad', sample: '**.***.***', regulation: 'LGPD Art. 46', recommendation: 'Tokenizar el documento de identidad.' },
  credit_card: { label: 'Tarjetas de pago', sample: '**** **** **** 4242', regulation: 'PCI DSS 3.4', recommendation: 'No almacenar PAN sin cifrar y purgar de logs.' },
};

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/** Usuario presentador: rol global admin + membership owner en las 5 organizaciones. */
const PRESENTER = { sub: 'demo-presenter', email: 'demo-presenter@demo.example.invalid', name: 'Presentador Demo' };

// ---------------------------------------------------------------------------
// Dataset empresarial sintético. Cada finding = [dataType, severity, location,
// records]; title/sample/regulation/recommendation derivan de DATA_TYPES.
// Los scores NO se insertan: se calculan en lectura con ADR-004.
//   score = max(0, 100 - (low + 3*medium + 7*high + 15*critical))
// ---------------------------------------------------------------------------
const ORGS = [
  {
    id: 'demo-org-nexa', slug: 'nexa-financiera', name: 'Nexa Financiera',
    users: [
      { sub: 'nexa-ops', email: 'nexa-ops@demo.example.invalid', name: 'Operador Nexa', role: 'member' },
      { sub: 'nexa-auditor', email: 'nexa-auditor@demo.example.invalid', name: 'Auditor Nexa', role: 'auditor' },
    ],
    sources: [
      { id: 'nexa-src-crm', name: 'CRM Producción', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 42, records: 580000,
        open: [['email','medium','users.email',4800], ['phone','medium','customers.phone',2100]],
        resolved: [['email','low','newsletter.subscribers',8000], ['phone','medium','customers.phone',1500]] },
      { id: 'nexa-src-core', name: 'Core Bancario', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 88, records: 1200000,
        open: [['national_id','medium','clients.national_id',950], ['email','low','newsletter.subscribers',15000]],
        resolved: [['national_id','medium','clients.national_id',400]] },
      { id: 'nexa-src-analytics', name: 'Analytics de Clientes', kind: 'mysql', environment: 'staging', status: 'warning', tables: 24, records: 310000,
        open: [],
        resolved: [['email','high','partners.email',600], ['email','low','newsletter.subscribers',3000]] },
    ],
  },
  {
    id: 'demo-org-vitalis', slug: 'vitalis-salud', name: 'Vitalis Salud',
    users: [
      { sub: 'vitalis-ops', email: 'vitalis-ops@demo.example.invalid', name: 'Operador Vitalis', role: 'member' },
      { sub: 'vitalis-auditor', email: 'vitalis-auditor@demo.example.invalid', name: 'Auditor Vitalis', role: 'auditor' },
    ],
    sources: [
      { id: 'vitalis-src-pacientes', name: 'Historia Clínica', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 36, records: 245000,
        open: [['national_id','high','patients.national_id',1200], ['email','high','patients.email',3400], ['phone','medium','patients.phone',2600]],
        resolved: [['email','high','patients.email',2000]] },
      { id: 'vitalis-src-laboratorio', name: 'Resultados de Laboratorio', kind: 'mysql', environment: 'production', status: 'healthy', tables: 18, records: 98000,
        open: [['email','medium','staff.email',900], ['email','low','appointments.contact_email',5200]],
        resolved: [['phone','medium','patients.phone',1800]] },
      { id: 'vitalis-src-documentos', name: 'Almacén Documental', kind: 'postgresql', environment: 'staging', status: 'warning', tables: 12, records: 150000,
        open: [['credit_card','medium','billing.credit_card',800], ['phone','low','appointments.contact_phone',4100], ['national_id','low','legacy.patient_national_id',600], ['email','low','newsletter.subscribers',7100]],
        resolved: [['national_id','high','patients.national_id',700], ['credit_card','medium','billing.credit_card',500]] },
    ],
  },
  {
    id: 'demo-org-retail', slug: 'retail-andino', name: 'Grupo Retail Andino',
    users: [
      { sub: 'retail-ops', email: 'retail-ops@demo.example.invalid', name: 'Operador Retail', role: 'member' },
      { sub: 'retail-auditor', email: 'retail-auditor@demo.example.invalid', name: 'Auditor Retail', role: 'auditor' },
    ],
    sources: [
      { id: 'retail-src-ventas', name: 'Facturación y Ventas', kind: 'postgresql', environment: 'production', status: 'warning', tables: 54, records: 760000,
        open: [['credit_card','critical','orders.payment_card',1500], ['national_id','high','customers.national_id',3300], ['email','medium','customers.email',8100]],
        resolved: [['credit_card','critical','orders.payment_card',900]] },
      { id: 'retail-src-inventario', name: 'Inventario', kind: 'mysql', environment: 'production', status: 'healthy', tables: 22, records: 210000,
        open: [['phone','medium','customers.phone',6900], ['credit_card','medium','loyalty.credit_card',1200], ['email','low','newsletter.subscribers',22000]],
        resolved: [['email','medium','customers.email',5000]] },
      { id: 'retail-src-fidelizacion', name: 'Programa de Fidelización', kind: 'postgresql', environment: 'development', status: 'offline', tables: 16, records: 88000,
        open: [['email','medium','suppliers.contact_email',900], ['phone','low','orders.delivery_phone',9500], ['national_id','low','returns.customer_national_id',700], ['credit_card','low','archived.payment_card',400], ['email','low','support.contact_email',1800], ['phone','low','support.contact_phone',1500]],
        resolved: [['national_id','high','customers.national_id',2000], ['email','low','newsletter.subscribers',12000]] },
    ],
  },
  {
    id: 'demo-org-technova', slug: 'technova-labs', name: 'TechNova Labs',
    users: [
      { sub: 'technova-ops', email: 'technova-ops@demo.example.invalid', name: 'Operador TechNova', role: 'member' },
      { sub: 'technova-auditor', email: 'technova-auditor@demo.example.invalid', name: 'Auditor TechNova', role: 'auditor' },
    ],
    sources: [
      { id: 'technova-src-analitica', name: 'Plataforma de Analítica', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 61, records: 410000,
        open: [['credit_card','critical','billing.credit_card',2100], ['credit_card','critical','analytics.raw_events_card',3400], ['email','high','users.email',8900]],
        resolved: [['credit_card','critical','billing.credit_card',1500]] },
      { id: 'technova-src-usuarios', name: 'Directorio de Usuarios', kind: 'mysql', environment: 'production', status: 'warning', tables: 28, records: 190000,
        open: [['phone','medium','users.phone',5600], ['email','low','newsletter.subscribers',31000]],
        resolved: [['email','high','users.email',6000]] },
      { id: 'technova-src-logs', name: 'Logs de Aplicación', kind: 'postgresql', environment: 'staging', status: 'offline', tables: 44, records: 500000,
        open: [['national_id','high','hr.national_id',500], ['email','high','logs.user_email',12000], ['credit_card','medium','crm.credit_card',700], ['email','medium','partners.contact_email',800], ['phone','low','support.contact_phone',2800], ['national_id','low','legacy.national_id',300], ['email','low','marketing.leads_email',15000], ['phone','low','marketing.leads_phone',12000]],
        resolved: [['national_id','high','hr.national_id',300], ['email','low','newsletter.subscribers',9000]] },
    ],
  },
  {
    id: 'demo-org-lexcorp', slug: 'lexcorp-legal', name: 'Estudio LexCorp',
    users: [
      { sub: 'lexcorp-ops', email: 'lexcorp-ops@demo.example.invalid', name: 'Operador LexCorp', role: 'member' },
      { sub: 'lexcorp-auditor', email: 'lexcorp-auditor@demo.example.invalid', name: 'Auditor LexCorp', role: 'auditor' },
    ],
    sources: [
      { id: 'lexcorp-src-clientes', name: 'Expedientes de Clientes', kind: 'postgresql', environment: 'production', status: 'warning', tables: 33, records: 120000,
        open: [['credit_card','critical','billing.client_card',600], ['national_id','critical','clients.national_id',900], ['email','high','clients.email',2100]],
        resolved: [['national_id','critical','clients.national_id',500]] },
      { id: 'lexcorp-src-correo', name: 'Archivo de Correspondencia', kind: 'mysql', environment: 'production', status: 'healthy', tables: 9, records: 36000,
        open: [['phone','high','clients.phone',1800], ['email','high','cases.opponent_email',700], ['email','medium','correspondence.sender_email',3200]],
        resolved: [['email','high','clients.email',1200]] },
      { id: 'lexcorp-src-facturacion', name: 'Facturación', kind: 'postgresql', environment: 'development', status: 'offline', tables: 15, records: 54000,
        open: [['credit_card','critical','fees.payment_card',450], ['national_id','critical','hr.national_id',120], ['phone','medium','correspondence.sender_phone',2600], ['credit_card','medium','expenses.credit_card',180], ['email','low','newsletter.subscribers',900], ['phone','low','reception.contact_phone',600]],
        resolved: [['credit_card','critical','fees.payment_card',300], ['email','medium','correspondence.sender_email',2000], ['phone','low','reception.contact_phone',400]] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers (espejo de la política ADR-004 y del snapshot ReportContent)
// ---------------------------------------------------------------------------
function computeScore(sev) {
  return Math.max(0, Math.min(100, 100 - (sev.low + 3 * sev.medium + 7 * sev.high + 15 * sev.critical)));
}

function buildExecutiveSummary(orgName, score, total, sev) {
  const b = [
    `${sev.critical} crítico${sev.critical === 1 ? '' : 's'}`,
    `${sev.high} alto${sev.high === 1 ? '' : 's'}`,
    `${sev.medium} medio${sev.medium === 1 ? '' : 's'}`,
    `${sev.low} bajo${sev.low === 1 ? '' : 's'}`,
  ];
  return `Informe de cumplimiento de ${orgName}. El compliance score es ${score} / 100 sobre ${total} hallazgo${total === 1 ? '' : 's'} activo${total === 1 ? '' : 's'} (${b.join(', ')}).`;
}

/** Espejo determinista de `reports.repo.create()`: construye el `content` JSONB. */
function buildReportContent(orgName, openFindings, generatedAtIso) {
  const sev = { critical: 0, high: 0, medium: 0, low: 0 };
  const dataTypeCount = {};
  for (const f of openFindings) {
    if (sev[f.severity] !== undefined) sev[f.severity] += 1;
    dataTypeCount[f.dataType] = (dataTypeCount[f.dataType] || 0) + 1;
  }
  const total = sev.critical + sev.high + sev.medium + sev.low;
  const score = computeScore(sev);
  const findingsByDataType = Object.entries(dataTypeCount)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const sorted = [...openFindings].sort((a, b) =>
    (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
    b.records - a.records ||
    (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const topRisks = sorted.slice(0, 5).map((f) => ({
    title: f.title,
    severity: f.severity,
    dataType: f.dataType,
    source: f.sourceName,
    records: f.records,
    regulation: f.regulation,
    recommendation: f.recommendation,
  }));
  const recommendations = [...new Set(sorted.slice(0, 15).map((f) => f.recommendation).filter((r) => r && r.length > 0))].slice(0, 8);
  return {
    version: '1.0',
    generatedAt: generatedAtIso,
    organizationName: orgName,
    executiveSummary: buildExecutiveSummary(orgName, score, total, sev),
    severityCounts: sev,
    findingsByDataType,
    topRisks,
    recommendations,
  };
}

function iso(daysAgo, plusMinutes = 0) {
  return new Date(Date.now() - daysAgo * 86400000 + plusMinutes * 60000).toISOString();
}

// Hash scrypt IDÉNTICO a @workspace/auth (`hashPassword`) para que el login
// (`verifyPassword`) acepte las contraseñas demo. Autocontenido: no requiere
// cargar el paquete TypeScript `@workspace/auth` desde un script .mjs.
const scryptAsync = promisify(scrypt);
async function hashPassword(password) {
  const salt = randomBytes(32);
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  assertGuards();
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const summary = {};
  const q = async (label, sql, values = []) => {
    const r = await client.query(sql, values);
    summary[label] = (summary[label] || 0) + (r.rowCount ?? 0);
  };

  // Contraseña demo (una sola para todos los usuarios sintéticos).
  const demoPassword = process.env.DEMO_USER_PASSWORD;
  let passwordHash = null;
  if (demoPassword) {
    if (demoPassword.length < 8) die('DEMO_USER_PASSWORD debe tener al menos 8 caracteres.');
    passwordHash = await hashPassword(demoPassword);
  }

  // 1. Reglas globales (catálogo único, compartido).
  for (const r of RULES) {
    await q('rules', `INSERT INTO rules (id, key, name, category, regulation, enabled, detections, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,true,0, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.key, r.name, r.category, r.regulation]);
  }

  // 2. Presentador global: rol admin + membership owner en las 5 orgs.
  if (passwordHash) {
    await q('users', `INSERT INTO users (sub, email, name, password_hash, created_at, updated_at)
      VALUES ($1,$2,$3,$4, now(), now()) ON CONFLICT (sub) DO NOTHING`,
      [PRESENTER.sub, PRESENTER.email, PRESENTER.name, passwordHash]);
    await q('user_roles', `INSERT INTO user_roles (user_sub, role, created_at)
      VALUES ($1, 'admin', now()) ON CONFLICT (user_sub, role) DO NOTHING`, [PRESENTER.sub]);
  }

  for (const org of ORGS) {
    // 3. Organización.
    await q('organizations', `INSERT INTO organizations (id, name, slug, status, created_at)
      VALUES ($1,$2,$3,'active', now()) ON CONFLICT (id) DO NOTHING`, [org.id, org.name, org.slug]);

    if (passwordHash) {
      await q('memberships', `INSERT INTO memberships (organization_id, user_sub, role, joined_at)
        VALUES ($1,$2,'owner', now()) ON CONFLICT (organization_id, user_sub) DO NOTHING`, [org.id, PRESENTER.sub]);
      // 4. Usuarios operativos (member + auditor), cada uno SOLO en esta org.
      for (const u of org.users) {
        await q('users', `INSERT INTO users (sub, email, name, password_hash, created_at, updated_at)
          VALUES ($1,$2,$3,$4, now(), now()) ON CONFLICT (sub) DO NOTHING`, [u.sub, u.email, u.name, passwordHash]);
        await q('memberships', `INSERT INTO memberships (organization_id, user_sub, role, joined_at)
          VALUES ($1,$2,$3, now()) ON CONFLICT (organization_id, user_sub) DO NOTHING`, [org.id, u.sub, u.role]);
      }
    }

    // 5. Fuentes, scans y hallazgos.
    const orgOpenFindings = [];
    for (const src of org.sources) {
      await q('sources', `INSERT INTO sources (id, tenant_id, name, kind, environment, status, tables, records, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [src.id, org.id, src.name, src.kind, src.environment, src.status, src.tables, src.records]);

      // Construye los hallazgos de esta fuente (open + resolved) en JS.
      let fi = 0;
      const build = (spec, status) => {
        const [dataType, severity, location, records] = spec;
        const dt = DATA_TYPES[dataType];
        fi += 1;
        const detectedDays = status === 'open' ? ((fi % 4) + 1) * 7 : 30 + (fi % 20);
        const resolvedDays = status === 'resolved' ? (fi % 15) + 1 : 0;
        return {
          id: `${src.id}-find-${fi}`,
          title: `${dt.label} en ${location}`,
          dataType,
          severity,
          location,
          records,
          status,
          sourceId: src.id,
          sourceName: src.name,
          regulation: dt.regulation,
          recommendation: dt.recommendation,
          sample: dt.sample,
          scanId: status === 'open' ? `${src.id}-scan-${(fi % 4) + 1}` : null,
          detectedAt: iso(detectedDays),
          firstSeenAt: iso(detectedDays),
          lastSeenAt: status === 'resolved' ? iso(resolvedDays) : iso(detectedDays),
        };
      };
      const findings = [
        ...src.open.map((s) => build(s, 'open')),
        ...src.resolved.map((s) => build(s, 'resolved')),
      ];
      // 6. Scans históricos completed (4 por fuente, fechas escalonadas ~30 días).
      // Se insertan ANTES de los findings para satisfacer la FK findings.scan_id → scans.id.
      const openPerScan = {};
      for (const f of findings) if (f.status === 'open' && f.scanId) openPerScan[f.scanId] = (openPerScan[f.scanId] || 0) + 1;
      for (let s = 1; s <= 4; s++) {
        const daysAgo = s * 7;
        const scanId = `${src.id}-scan-${s}`;
        await q('scans', `INSERT INTO scans
            (id, source_id, status, started_at, completed_at, findings_created, tables_scanned, records_read, cancel_requested)
          VALUES ($1,$2,'completed',$3,$4,$5,$6,$7,false)
          ON CONFLICT (id) DO NOTHING`,
          [scanId, src.id, iso(daysAgo), iso(daysAgo, 20), openPerScan[scanId] || 0, src.tables, Math.round(src.records * (0.3 + s * 0.12))]);
      }

      // 7. Findings (ahora con scan_id apuntando a scans existentes).
      for (const f of findings) {
        if (f.status === 'open') orgOpenFindings.push(f);
        await q('findings', `INSERT INTO findings
            (id, tenant_id, source_id, source_name, title, data_type, location, severity, status,
             records, detected_at, regulation, recommendation, sample, scan_id,
             first_seen_at, last_seen_at, superseded, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18,$19)
          ON CONFLICT (id) DO NOTHING`,
          [f.id, org.id, f.sourceId, f.sourceName, f.title, f.dataType, f.location, f.severity, f.status,
           f.records, f.detectedAt, f.regulation, f.recommendation, f.sample, f.scanId,
           f.firstSeenAt, f.lastSeenAt, f.firstSeenAt, f.lastSeenAt]);
      }
    }

    // 7. Scan failed (opcional, coherente: completed_at = started_at + minutos).
    if (org.id === 'demo-org-lexcorp') {
      await q('scans', `INSERT INTO scans (id, source_id, status, started_at, completed_at, findings_created, tables_scanned, records_read, cancel_requested)
        VALUES ('lexcorp-src-facturacion-scan-fail','lexcorp-src-facturacion','failed',$1,$2,0,0,0,false)
        ON CONFLICT (id) DO NOTHING`, [iso(3), iso(3, 8)]);
    }
    if (org.id === 'demo-org-technova') {
      await q('scans', `INSERT INTO scans (id, source_id, status, started_at, completed_at, findings_created, tables_scanned, records_read, cancel_requested)
        VALUES ('technova-src-logs-scan-fail','technova-src-logs','failed',$1,$2,0,0,0,false)
        ON CONFLICT (id) DO NOTHING`, [iso(5), iso(5, 6)]);
    }

    // 8. Reports (1-2 por org). El PDF se genera en descarga; aquí solo el content JSONB.
    const openTotal = orgOpenFindings.length;
    const sev = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of orgOpenFindings) if (sev[f.severity] !== undefined) sev[f.severity] += 1;
    const score = computeScore(sev);
    const reports = [
      { id: `${org.id}-report-month`, name: 'Informe de cumplimiento mensual', period: 'last_30d', daysAgo: 2 },
      { id: `${org.id}-report-quarter`, name: 'Revisión trimestral', period: 'quarter', daysAgo: 30 },
    ];
    for (const rep of reports) {
      const createdAt = iso(rep.daysAgo);
      const content = buildReportContent(org.name, orgOpenFindings, createdAt);
      await q('reports', `INSERT INTO reports
          (id, tenant_id, name, period, status, created_at, findings, compliance_score, format, content)
        VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,'pdf',$8::jsonb)
        ON CONFLICT (id) DO NOTHING`,
        [rep.id, org.id, rep.name, rep.period, createdAt, openTotal, score, JSON.stringify(content)]);
    }

    // 9. Actividad determinista para que el dashboard no arranque vacío.
    const acts = [
      ['Informe generado', `Informe de cumplimiento mensual · ${org.name}`, 'report', null],
      ['Escaneo completado', `${org.sources[0].name} · revisado`, 'scan', null],
      ['Hallazgo crítico detectado', 'Nuevo hallazgo de tarjetas de pago', 'finding', 'critical'],
      ['Regla actualizada', 'Catálogo de detección sincronizado', 'system', null],
      ['Datos de demo cargados', 'Dataset sintético de demostración', 'system', null],
    ];
    for (let i = 0; i < acts.length; i++) {
      const [title, description, type, severity] = acts[i];
      await q('activity', `INSERT INTO activity (id, tenant_id, type, title, description, severity, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING`,
        [`${org.id}-act-${i + 1}`, org.id, type, title, description, severity, iso(i + 1)]);
    }
  }

  // 10. Scan running (opcional, DEMO_INCLUDE_RUNNING_SCAN=true). Respeta el índice único.
  if (process.env.DEMO_INCLUDE_RUNNING_SCAN === 'true') {
    await q('scans', `INSERT INTO scans (id, source_id, status, started_at, findings_created, tables_scanned, records_read, cancel_requested)
      VALUES ('retail-src-ventas-scan-running','retail-src-ventas','running',$1,0,0,0,false)
      ON CONFLICT (id) DO NOTHING`, [iso(0, -5)]);
  }

  await client.end();
  console.log('demo-seed: OK (idempotente). Filas insertadas o ya presentes:');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  console.log('  scores (derivados en lectura):');
  for (const org of ORGS) {
    const sev = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const src of org.sources) {
      for (const s of src.open) if (sev[s[1]] !== undefined) sev[s[1]] += 1;
    }
    console.log(`  ${org.name}: ${computeScore(sev)}`);
  }
  if (!passwordHash) {
    console.log('  (no se crearon usuarios: define DEMO_USER_PASSWORD si los necesitas)');
  }
}

main().catch((err) => {
  console.error('demo-seed: ERROR —', err instanceof Error ? err.message : err);
  process.exit(1);
});