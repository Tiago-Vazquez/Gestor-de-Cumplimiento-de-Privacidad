import { Router, type IRouter } from "express";
import {
  CreateReportBody,
  GetActivityResponse,
  GetDashboardResponse,
  ListFindingsQueryParams,
  ListFindingsResponse,
  ListRulesResponse,
  ListSourcesResponse,
  PreviewMaskingBody,
  PreviewMaskingResponse,
  StartScanBody,
  StartScanResponse,
  UpdateFindingBody,
  UpdateFindingParams,
  UpdateFindingResponse,
} from "@workspace/api-zod";
import { notFound } from "../lib/errors";

type Severity = "critical" | "high" | "medium" | "low";
type FindingStatus = "open" | "in_review" | "resolved";

const now = new Date();
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

const findings = [
  {
    id: "f-001",
    title: "Emails de clientes sin cifrado",
    dataType: "email" as const,
    source: "Customer PostgreSQL",
    location: "public.customers.email",
    severity: "critical" as Severity,
    status: "open" as FindingStatus,
    records: 12843,
    detectedAt: minutesAgo(12),
    regulation: "GDPR Art. 32",
    recommendation: "Cifrar la columna y restringir el acceso al rol de soporte.",
    sample: "m••••••@empresa.com",
  },
  {
    id: "f-002",
    title: "Documento nacional en entorno de staging",
    dataType: "national_id" as const,
    source: "Analytics Warehouse",
    location: "staging.user_profiles.national_id",
    severity: "high" as Severity,
    status: "in_review" as FindingStatus,
    records: 4521,
    detectedAt: minutesAgo(38),
    regulation: "LGPD Art. 46",
    recommendation: "Aplicar tokenización automática en cada refresh de staging.",
    sample: "27.•••.•••-•",
  },
  {
    id: "f-003",
    title: "Teléfonos visibles en exportación",
    dataType: "phone" as const,
    source: "CRM MySQL",
    location: "crm.contacts.phone",
    severity: "medium" as Severity,
    status: "open" as FindingStatus,
    records: 2187,
    detectedAt: minutesAgo(74),
    regulation: "CCPA §1798.100",
    recommendation: "Enmascarar los últimos cuatro dígitos en las exportaciones.",
    sample: "+54 9 11 •••• 4821",
  },
  {
    id: "f-004",
    title: "Direcciones residenciales detectadas",
    dataType: "address" as const,
    source: "Customer PostgreSQL",
    location: "public.shipping_addresses.full_address",
    severity: "low" as Severity,
    status: "resolved" as FindingStatus,
    records: 864,
    detectedAt: minutesAgo(120),
    regulation: "GDPR Art. 5",
    recommendation: "Mantener únicamente ciudad y código postal para analítica.",
    sample: "Av. del L•••• 120",
  },
  {
    id: "f-005",
    title: "Tarjetas almacenadas en logs",
    dataType: "credit_card" as const,
    source: "Payments PostgreSQL",
    location: "logs.checkout.payload",
    severity: "critical" as Severity,
    status: "open" as FindingStatus,
    records: 91,
    detectedAt: minutesAgo(186),
    regulation: "PCI DSS 3.4",
    recommendation: "Eliminar payloads históricos y activar redacción de logs.",
    sample: "•••• •••• •••• 4242",
  },
];

const sources = [
  {
    id: "src-001",
    name: "Customer PostgreSQL",
    kind: "postgresql" as const,
    environment: "production" as const,
    status: "healthy" as const,
    lastScanAt: minutesAgo(12),
    tables: 48,
    records: 284_210,
    findings: 2,
  },
  {
    id: "src-002",
    name: "Analytics Warehouse",
    kind: "snowflake" as const,
    environment: "staging" as const,
    status: "warning" as const,
    lastScanAt: minutesAgo(38),
    tables: 126,
    records: 1_840_400,
    findings: 1,
  },
  {
    id: "src-003",
    name: "CRM MySQL",
    kind: "mysql" as const,
    environment: "production" as const,
    status: "healthy" as const,
    lastScanAt: minutesAgo(74),
    tables: 32,
    records: 98_321,
    findings: 1,
  },
  {
    id: "src-004",
    name: "Payments PostgreSQL",
    kind: "postgresql" as const,
    environment: "production" as const,
    status: "healthy" as const,
    lastScanAt: minutesAgo(186),
    tables: 17,
    records: 61_550,
    findings: 1,
  },
];

const rules = [
  { id: "rule-001", name: "Email personal", category: "Identidad", regulation: "GDPR", enabled: true, detections: 12_843, lastTriggered: minutesAgo(12) },
  { id: "rule-002", name: "Documento nacional", category: "Identidad", regulation: "LGPD", enabled: true, detections: 4_521, lastTriggered: minutesAgo(38) },
  { id: "rule-003", name: "Tarjeta de crédito", category: "Finanzas", regulation: "PCI DSS", enabled: true, detections: 91, lastTriggered: minutesAgo(186) },
  { id: "rule-004", name: "Teléfono", category: "Contacto", regulation: "CCPA", enabled: true, detections: 2_187, lastTriggered: minutesAgo(74) },
  { id: "rule-005", name: "Datos de salud", category: "Salud", regulation: "HIPAA", enabled: false, detections: 0, lastTriggered: "Nunca" },
];

const activity = [
  { id: "a-001", type: "finding" as const, title: "Nuevo hallazgo crítico", description: "Tarjetas almacenadas en logs de checkout", createdAt: minutesAgo(6), severity: "critical" as Severity },
  { id: "a-002", type: "scan" as const, title: "Escaneo completado", description: "Customer PostgreSQL · 48 tablas revisadas", createdAt: minutesAgo(12), severity: null },
  { id: "a-003", type: "masking" as const, title: "Datos anonimizados", description: "4.521 registros preparados para staging", createdAt: minutesAgo(32), severity: null },
  { id: "a-004", type: "report" as const, title: "Informe mensual listo", description: "Auditoría de cumplimiento · julio 2026", createdAt: minutesAgo(86), severity: null },
  { id: "a-005", type: "system" as const, title: "Regla actualizada", description: "Se activó la detección de documentos nacionales", createdAt: minutesAgo(145), severity: null },
];

const reports = [
  { id: "r-001", name: "Auditoría mensual · Julio 2026", period: "last_30d", status: "ready" as const, createdAt: minutesAgo(86), findings: 31, complianceScore: 94, format: "pdf" as const },
  { id: "r-002", name: "Revisión trimestral Q2 2026", period: "quarter", status: "ready" as const, createdAt: minutesAgo(1_820), findings: 118, complianceScore: 89, format: "pdf" as const },
];

const router: IRouter = Router();

router.get("/dashboard", (_req, res) => {
  const openFindings = findings.filter((finding) => finding.status !== "resolved");
  const counts = {
    critical: openFindings.filter((finding) => finding.severity === "critical").length,
    high: openFindings.filter((finding) => finding.severity === "high").length,
    medium: openFindings.filter((finding) => finding.severity === "medium").length,
    low: openFindings.filter((finding) => finding.severity === "low").length,
  };
  res.json(GetDashboardResponse.parse({
    complianceScore: 94,
    openFindings: openFindings.length,
    criticalFindings: counts.critical,
    protectedRecords: 2_486_730,
    monitoredSources: sources.length,
    lastScanAt: sources[0].lastScanAt,
    scanStatus: "monitoring",
    findingsBySeverity: counts,
  }));
});

router.get("/activity", (_req, res) => {
  res.json(GetActivityResponse.parse(activity));
});

router.get("/findings", (req, res) => {
  const params = ListFindingsQueryParams.parse(req.query);
  const filtered = findings.filter((finding) =>
    (!params.status || finding.status === params.status) &&
    (!params.severity || finding.severity === params.severity),
  );
  res.json(ListFindingsResponse.parse(filtered));
});

router.patch("/findings/:id", (req, res) => {
  const { id } = UpdateFindingParams.parse(req.params);
  const { status } = UpdateFindingBody.parse(req.body);
  const finding = findings.find((item) => item.id === id);
  if (!finding) {
    throw notFound("Finding not found");
  }
  finding.status = status;
  activity.unshift({
    id: `a-${Date.now()}`,
    type: "finding",
    title: status === "resolved" ? "Hallazgo resuelto" : "Hallazgo actualizado",
    description: finding.title,
    createdAt: new Date().toISOString(),
    severity: finding.severity,
  });
  res.json(UpdateFindingResponse.parse(finding));
});

router.get("/sources", (_req, res) => {
  res.json(ListSourcesResponse.parse(sources));
});

router.get("/rules", (_req, res) => {
  res.json(ListRulesResponse.parse(rules));
});

router.post("/scans", (req, res) => {
  const { sourceId } = StartScanBody.parse(req.body);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw notFound("Source not found");
  }
  const startedAt = new Date().toISOString();
  const scan: {
    id: string;
    sourceId: string;
    status: "queued" | "running" | "completed";
    startedAt: string;
    completedAt: string | null;
    findingsCreated: number;
  } = {
    id: `scan-${Date.now()}`,
    sourceId,
    status: "running" as const,
    startedAt,
    completedAt: null,
    findingsCreated: 0,
  };
  source.lastScanAt = startedAt;
  activity.unshift({
    id: `a-${Date.now()}`,
    type: "scan",
    title: "Escaneo iniciado",
    description: `${source.name} · analizando ${source.tables} tablas`,
    createdAt: startedAt,
    severity: null,
  });
  setTimeout(() => {
    scan.status = "completed";
    const completedAt = new Date().toISOString();
    scan.completedAt = completedAt;
    scan.findingsCreated = source.findings;
    activity.unshift({
      id: `a-${Date.now()}`,
      type: "scan",
      title: "Escaneo completado",
      description: `${source.name} · ${source.tables} tablas revisadas`,
      createdAt: completedAt,
      severity: null,
    });
  }, 1500);
  res.status(202).json(StartScanResponse.parse(scan));
});

router.get("/reports", (_req, res) => {
  res.json(reports);
});

router.post("/reports", (req, res) => {
  const { name, period } = CreateReportBody.parse(req.body);
  const report = {
    id: `r-${Date.now()}`,
    name,
    period,
    status: "ready" as const,
    createdAt: new Date().toISOString(),
    findings: findings.filter((finding) => finding.status !== "resolved").length,
    complianceScore: 94,
    format: "pdf" as const,
  };
  reports.unshift(report);
  activity.unshift({
    id: `a-${Date.now()}`,
    type: "report",
    title: "Informe generado",
    description: name,
    createdAt: report.createdAt,
    severity: null,
  });
  res.status(201).json(report);
});

router.post("/masking/preview", (req, res) => {
  const { sourceId, fields } = PreviewMaskingBody.parse(req.body);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw notFound("Source not found");
  }
  const masked = new Set(fields);
  const rows = [
    { id: "usr_4021", email: masked.has("email") ? "u••••@demo.com" : "user4021@demo.com", phone: masked.has("phone") ? "+54 •••• 4821" : "+54 9 11 5555 4821", national_id: masked.has("national_id") ? "27.•••.•••-•" : "27.442.918-6" },
    { id: "usr_4022", email: masked.has("email") ? "a••••@demo.com" : "ana4022@demo.com", phone: masked.has("phone") ? "+54 •••• 9304" : "+54 9 11 5555 9304", national_id: masked.has("national_id") ? "20.•••.•••-•" : "20.118.562-9" },
    { id: "usr_4023", email: masked.has("email") ? "j••••@demo.com" : "juan4023@demo.com", phone: masked.has("phone") ? "+54 •••• 1170" : "+54 9 11 5555 1170", national_id: masked.has("national_id") ? "31.•••.•••-•" : "31.785.120-4" },
  ];
  res.json(PreviewMaskingResponse.parse({
    sourceId,
    records: source.records,
    maskedFields: fields,
    rows,
  }));
});

export default router;