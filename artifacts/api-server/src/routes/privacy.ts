import { Router, type IRouter } from "express";
import {
  CreateReportBody,
  GetActivityResponse,
  GetDashboardResponse,
  ListFindingsQueryParams,
  ListFindingsResponse,
  ListReportsResponse,
  ListReportsResponseItem,
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
import { parsePagination } from "../lib/pagination";
import { logger } from "../lib/logger";
import {
  mapActivity,
  mapFinding,
  mapReport,
  mapRule,
  mapScan,
  mapSource,
} from "../mappers";
import { repos } from "../repositories";
import { requireRole } from "../auth/middleware";

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

router.post("/scans", requireRole("admin"), async (req, res) => {
  const { sourceId } = StartScanBody.parse(req.body);

  const result = await repos.scans.startScan({ sourceId, startedAt: new Date() });
  if (!result.ok) {
    throw notFound("Source not found");
  }

  // El contrato mantiene el ciclo running → completed: se responde 202 en
  // cuanto el escaneo está persistido y la finalización se actualiza en
  // PostgreSQL (no en un objeto en memoria). No se inventan hallazgos:
  // `findingsCreated` cuenta los findings ya persistidos de la fuente.
  res.status(202).json(StartScanResponse.parse(mapScan(result.scan)));

  setTimeout(() => {
    void repos.scans
      .completeScan({ scanId: result.scan.id, completedAt: new Date() })
      .then((completed) => {
        if (!completed) {
          logger.error({ scanId: result.scan.id }, "Scan to complete was not found");
        }
      })
      .catch((error) => {
        logger.error({ err: error, scanId: result.scan.id }, "Failed to complete scan");
      });
  }, 1500);
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

export default router;
