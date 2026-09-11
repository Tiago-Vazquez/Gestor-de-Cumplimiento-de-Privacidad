import { Router, type IRouter } from "express";
import {
  CancelScanParams,
  CancelScanResponse,
  CreateMaskingJobBody,
  CreateMaskingJobResponse,
  CreateReportBody,
  GetActivityResponse,
  GetComplianceResponse,
  GetComplianceTrendQueryParams,
  GetComplianceTrendResponse,
  GetDashboardResponse,
  GetMaskingJobParams,
  GetMaskingJobResponse,
  GetReportParams,
  GetReportResponse,
  DownloadMaskingJobParams,
  DownloadMaskingJobResponse,
  DownloadReportParams,
  DownloadReportResponse,
  GetScanParams,
  GetScanResponse,
  ListFindingsQueryParams,
  ListFindingsResponse,
  ListMaskingJobsQueryParams,
  ListMaskingJobsResponse,
  ListReportsResponse,
  ListReportsResponseItem,
  ListRulesResponse,
  ListScansQueryParams,
  ListScansResponse,
  ListSourcesResponse,
  PreviewMaskingBody,
  PreviewMaskingResponse,
  StartScanBody,
  StartScanResponse,
  UpdateFindingBody,
  UpdateFindingParams,
  UpdateFindingResponse,
  UpdateRuleBody,
  UpdateRuleParams,
  UpdateRuleResponse,
} from "@workspace/api-zod";
import { conflict, notFound } from "../lib/errors";
import { parsePagination } from "../lib/pagination";
import { logger } from "../lib/logger";
import {
  mapActivity,
  mapComplianceSummary,
  mapComplianceTrend,
  mapFinding,
  mapMaskingJob,
  mapReport,
  mapRule,
  mapScan,
  mapSource,
} from "../mappers";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";
import { runScan } from "../services/scanner";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res) => {
  const data = await repos.dashboard.getDashboardData();

  // D9: el contrato exige `lastScanAt` como string incluso con la base de
  // datos vacía; sin ningún escaneo registrado se expone el instante de la
  // consulta. Todo lo demás proviene de PostgreSQL, sin valores demo.
  res.json(GetDashboardResponse.parse({
    complianceScore: data.complianceScore,
    openFindings: data.openFindings,
    criticalFindings: data.countsBySeverity.critical,
    protectedRecords: data.protectedRecords,
    monitoredSources: data.monitoredSources,
    lastScanAt: (data.lastScanAt ?? new Date()).toISOString(),
    scanStatus: data.scanStatus,
    findingsBySeverity: data.countsBySeverity,
  }));
});

// FASE 7.2 (M2.c): métricas de compliance. Mismo modelo que /dashboard:
// sesión requerida por el middleware global de /api; el repositorio
// recalcula en cada lectura con el criterio canónico D8.
router.get("/compliance", async (_req, res) => {
  const data = await repos.compliance.getComplianceSummary();
  res.json(GetComplianceResponse.parse(mapComplianceSummary(data)));
});

// Trend diario UTC. `days` se valida con el zod del contrato (coerce +
// 1..90 + default 30; fuera de rango → ZodError → 400 problem+json).
// La ventana SQL se acota dentro del repositorio.
router.get("/compliance/trend", async (req, res) => {
  const params = GetComplianceTrendQueryParams.parse(req.query);
  const data = await repos.compliance.getComplianceTrend(params.days);
  res.json(GetComplianceTrendResponse.parse(mapComplianceTrend(data)));
});

router.get("/activity", async (req, res) => {
  const rows = await repos.activity.list(parsePagination(req.query));
  res.json(GetActivityResponse.parse(rows.map(mapActivity)));
});

router.get("/findings", async (req, res) => {
  const params = ListFindingsQueryParams.parse(req.query);
  const pagination = parsePagination(req.query);
  const rows = await repos.findings.list(
    { status: params.status, severity: params.severity },
    pagination,
  );
  res.json(ListFindingsResponse.parse(rows.map(mapFinding)));
});

router.patch("/findings/:id", requireRole("admin"), async (req, res) => {
  const { id } = UpdateFindingParams.parse(req.params);
  const { status } = UpdateFindingBody.parse(req.body);

  const updated = await repos.findings.updateStatus({ id, status, at: new Date() });
  if (!updated) {
    throw notFound("Finding not found");
  }

  res.json(UpdateFindingResponse.parse(mapFinding(updated)));
});

router.get("/sources", async (req, res) => {
  const rows = await repos.sources.list(parsePagination(req.query));
  res.json(ListSourcesResponse.parse(rows.map(mapSource)));
});

router.get("/rules", async (req, res) => {
  const rows = await repos.rules.list(parsePagination(req.query));
  res.json(ListRulesResponse.parse(rows.map(mapRule)));
});

// FASE 7.0.5 (M7): PATCH /api/rules/:id — actualizar únicamente `enabled`.
// Solo admin. El resto de campos (patrón, severidad, regulación) es built-in.
// El cambio es efectivo en el siguiente scan (resolveActiveRules lee BD).
router.patch("/rules/:id", requireRole("admin"), async (req, res) => {
  const { id } = UpdateRuleParams.parse(req.params);
  const { enabled } = UpdateRuleBody.parse(req.body);

  const updated = await repos.rules.setEnabled({ id, enabled, at: new Date() });
  if (!updated) {
    throw notFound("Rule not found");
  }

  res.json(UpdateRuleResponse.parse(mapRule(updated)));
});

router.post("/scans", requireRole("admin"), async (req, res) => {
  const { sourceId } = StartScanBody.parse(req.body);

  const result = await repos.scans.startScan({ sourceId, startedAt: new Date() });
  if (!result.ok) {
    // FASE 7.0.5 (M2): 409 si ya hay un scan running para esta fuente
    if (result.reason === "scan_already_running") {
      throw conflict("A scan is already running for this source");
    }
    throw notFound("Source not found");
  }

  // Contrato: 202 en cuanto el scan `running` está persistido. FASE 7.0.1:
  // la ejecución real la hace el scanner (fase 7.0.1) en background: lee la
  // fuente PostgreSQL externa, aplica el catálogo de reglas y materializa
  // findings; si la fuente no es escaneable o falla la conexión, marca
  // `failed` con su causa. Nunca lanza tras la respuesta: los errores quedan
  // registrados en el scan y en el log.
  res.status(202).json(StartScanResponse.parse(mapScan(result.scan)));

  void runScan({ scanId: result.scan.id, sourceId }).catch((error) => {
    logger.error({ err: error, scanId: result.scan.id }, "Scanner crashed");
  });
});

// FASE 7.1.1 (M1): historial de scans — lectura para cualquier usuario
// autenticado (igual que /sources y /findings). Orden newest-first; filtros
// exactos sourceId/status ya validados por el contrato; paginación en SQL.
router.get("/scans", async (req, res) => {
  const params = ListScansQueryParams.parse(req.query);
  const rows = await repos.scans.list(
    { sourceId: params.sourceId, status: params.status },
    parsePagination(req.query),
  );
  res.json(ListScansResponse.parse(rows.map(mapScan)));
});

router.get("/scans/:id", async (req, res) => {
  const { id } = GetScanParams.parse(req.params);
  const scan = await repos.scans.getById(id);
  if (!scan) {
    throw notFound("Scan not found");
  }
  res.json(GetScanResponse.parse(mapScan(scan)));
});

// FASE 7.1.2 (M2): cancelación cooperativa — solo admin. Marca el flag; el
// scanner se detiene en su siguiente yield (≤ 1 intervalo de heartbeat) y
// finaliza `failed(cancelled)`. 202 = solicitud aceptada (el scan aún puede
// completarse si no quedaban yields — carrera documentada). Idempotente
// mientras siga `running`; 409 si ya alcanzó estado terminal por sí mismo.
router.post("/scans/:id/cancel", requireRole("admin"), async (req, res) => {
  const { id } = CancelScanParams.parse(req.params);
  const result = await repos.scans.requestCancel({ scanId: id });
  if (!result.ok) {
    if (result.reason === "scan_not_found") {
      throw notFound("Scan not found");
    }
    throw conflict("Scan already reached a terminal state");
  }
  res.status(202).json(CancelScanResponse.parse(mapScan(result.scan)));
});

router.get("/reports", async (req, res) => {
  const rows = await repos.reports.list(parsePagination(req.query));
  // F9 (6.3B.20): la salida se valida contra el esquema del contrato antes
  // de enviarla (fallback no validado eliminado).
  res.json(ListReportsResponse.parse(rows.map(mapReport)));
});

router.post("/reports", requireRole("admin"), async (req, res) => {
  const { name, period } = CreateReportBody.parse(req.body);
  const report = await repos.reports.create({ name, period, at: new Date() });
  res.status(201).json(ListReportsResponseItem.parse(mapReport(report)));
});

router.get("/reports/:id", async (req, res) => {
  const { id } = GetReportParams.parse(req.params);
  const report = await repos.reports.getById(id);
  if (!report) {
    throw notFound("Report not found");
  }
  res.json(GetReportResponse.parse(mapReport(report)));
});

router.get("/reports/:id/download", async (req, res) => {
  const { id } = DownloadReportParams.parse(req.params);
  const report = await repos.reports.getById(id);
  if (!report) {
    throw notFound("Report not found");
  }
  res.attachment(`report-${report.id}.json`);
  res.json(DownloadReportResponse.parse(mapReport(report)));
});

router.post("/masking/preview", requireRole("admin"), async (req, res) => {
  const { sourceId, fields } = PreviewMaskingBody.parse(req.body);

  // La fuente se valida contra PostgreSQL; el resto del preview no persiste
  // nada (operación sin estado) y sus filas son sintéticas, nunca datos de
  // dominio reales.
  const source = await repos.sources.getById(sourceId);
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

// FASE 7.3 (M5.c): trabajos de anonimización. Flujo SÍNCRONO: el POST ejecuta
// el job completo (validación de campos → lectura paginada de la fuente con
// el conector existente → masker determinista M5.b → persistencia atómica del
// dataset) y responde 201 con el job ya `ready` o `failed` (auditable; los
// estados queued/running quedan reservados por el contrato). El dataset vive
// en masking_jobs.dataset y SOLO sale por /download: el listado y el detalle
// lo omiten porque mapMaskingJob ni siquiera acepta la columna.
router.get("/masking/jobs", async (req, res) => {
  const params = ListMaskingJobsQueryParams.parse(req.query);
  const rows = await repos.masking.list(params);
  res.json(ListMaskingJobsResponse.parse(rows.map(mapMaskingJob)));
});

router.post("/masking/jobs", requireRole("admin"), async (req, res) => {
  const body = CreateMaskingJobBody.parse(req.body);
  const job = await repos.masking.create({
    sourceId: body.sourceId,
    fields: body.fields,
    at: new Date(),
  });
  res.status(201).json(CreateMaskingJobResponse.parse(mapMaskingJob(job)));
});

router.get("/masking/jobs/:id", async (req, res) => {
  const { id } = GetMaskingJobParams.parse(req.params);
  const job = await repos.masking.getById(id);
  if (!job) {
    throw notFound("Masking job not found");
  }
  res.json(GetMaskingJobResponse.parse(mapMaskingJob(job)));
});

// El download devuelve EXACTAMENTE el dataset persistido por ese job: nunca
// relee la fuente ni re-anonimiza (patrón downloadReport de M4).
router.get("/masking/jobs/:id/download", async (req, res) => {
  const { id } = DownloadMaskingJobParams.parse(req.params);
  const job = await repos.masking.getByIdWithDataset(id);
  if (!job || job.status !== "ready" || !job.dataset) {
    throw notFound("Masking dataset not available");
  }
  res.attachment(`masking-job-${job.id}.json`);
  res.json(DownloadMaskingJobResponse.parse({
    jobId: job.id,
    records: job.records,
    fields: job.dataset.fields,
    rows: job.dataset.rows,
  }));
});

export default router;
