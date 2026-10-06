import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Report, ReportContent, ReportContentRisk } from "@workspace/db";

/**
 * FASE 8 (PDF profesional) — generador del informe en PDF (servidor).
 *
 * Usa `pdf-lib` (isomórfica, sin dependencias nativas) para producir un
 * entregable autocontenido a partir del snapshot `content` persistido en
 * `reports.content`. El PDF es determinista: se renderiza exclusivamente desde
 * el snapshot (no relee hallazgos), de modo que es un artefacto auditable e
 * inmutable, coherente con la semántica de "foto verificable" del informe.
 */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;

const COLOR = {
  brand: rgb(0.09, 0.24, 0.27),
  accent: rgb(0.3, 0.5, 0.47),
  ink: rgb(0.13, 0.16, 0.18),
  muted: rgb(0.42, 0.46, 0.5),
  light: rgb(0.94, 0.96, 0.97),
  line: rgb(0.86, 0.89, 0.9),
  critical: rgb(0.72, 0.22, 0.2),
  high: rgb(0.85, 0.45, 0.12),
  medium: rgb(0.72, 0.55, 0.12),
  low: rgb(0.3, 0.52, 0.35),
  white: rgb(1, 1, 1),
} satisfies Record<string, RGB>;

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Medio",
  low: "Bajo",
};

const SEVERITY_COLOR: Record<string, RGB> = {
  critical: COLOR.critical,
  high: COLOR.high,
  medium: COLOR.medium,
  low: COLOR.low,
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current === "") {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** Mini-motor de layout con cursor vertical y paginación + pie de página. */
class Layout {
  private page: PDFPage;
  private y = A4_HEIGHT - MARGIN;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly footerText: string,
  ) {
    this.page = this.doc.addPage([A4_WIDTH, A4_HEIGHT]);
    this.drawFooter();
  }

  private addPage(): void {
    this.page = this.doc.addPage([A4_WIDTH, A4_HEIGHT]);
    this.y = A4_HEIGHT - MARGIN;
    this.drawFooter();
    this.page.drawText("Privaris", {
      x: MARGIN,
      y: A4_HEIGHT - 30,
      size: 9,
      font: this.bold,
      color: COLOR.accent,
    });
  }

  private drawFooter(): void {
    this.page.drawLine({
      start: { x: MARGIN, y: 42 },
      end: { x: A4_WIDTH - MARGIN, y: 42 },
      thickness: 0.5,
      color: COLOR.line,
    });
    this.page.drawText(this.footerText, {
      x: MARGIN,
      y: 26,
      size: 8,
      font: this.regular,
      color: COLOR.muted,
    });
  }

  header(organizationName: string): void {
    const bandHeight = 132;
    this.page.drawRectangle({
      x: 0,
      y: A4_HEIGHT - bandHeight,
      width: A4_WIDTH,
      height: bandHeight,
      color: COLOR.brand,
    });
    this.page.drawText("Privaris", { x: MARGIN, y: A4_HEIGHT - 62, size: 30, font: this.bold, color: COLOR.white });
    this.page.drawText("Gestión de cumplimiento y descubrimiento de datos sensibles", {
      x: MARGIN,
      y: A4_HEIGHT - 86,
      size: 10,
      font: this.regular,
      color: COLOR.accent,
    });
    this.page.drawText(organizationName, {
      x: MARGIN,
      y: A4_HEIGHT - 112,
      size: 13,
      font: this.bold,
      color: COLOR.white,
    });
    this.y = A4_HEIGHT - bandHeight - 18;
  }

  get currentPage() {
    return this.page;
  }

  get cursorY() {
    return this.y;
  }

  setCursorY(value: number): void {
    this.y = value;
  }

  advance(gap: number): void {
    this.y -= gap;
  }

  ensure(space: number): void {
    if (this.y - space < 70) this.addPage();
  }

  text(value: string, opts: { size?: number; font?: PDFFont; color?: RGB; gap?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font ?? this.regular;
    const color = opts.color ?? COLOR.ink;
    const lineHeight = size * 1.35;
    const lines = wrapText(value, font, size, CONTENT_WIDTH);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color });
      this.y -= lineHeight;
    }
    this.y -= opts.gap ?? 4;
  }

  heading(value: string): void {
    this.ensure(40);
    this.y -= 10;
    this.page.drawText(value, {
      x: MARGIN,
      y: this.y,
      size: 14,
      font: this.bold,
      color: COLOR.brand,
    });
    this.y -= 8;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: A4_WIDTH - MARGIN, y: this.y },
      thickness: 1,
      color: COLOR.accent,
    });
    this.y -= 18;
  }

  /** Fila clave→valor con sangría, opcionalmente con un punto de color. */
  keyValue(label: string, value: string, opts: { dot?: RGB; size?: number } = {}): void {
    const size = opts.size ?? 10;
    const lineHeight = size * 1.35;
    this.ensure(lineHeight);
    const dotX = MARGIN;
    if (opts.dot) {
      this.page.drawCircle({ x: dotX + 4, y: this.y + 2, size: 3, color: opts.dot });
    }
    const labelX = opts.dot ? MARGIN + 12 : MARGIN;
    this.page.drawText(label, { x: labelX, y: this.y, size, font: this.regular, color: COLOR.ink });
    const valueWidth = this.regular.widthOfTextAtSize(value, size);
    this.page.drawText(value, {
      x: A4_WIDTH - MARGIN - valueWidth,
      y: this.y,
      size,
      font: this.bold,
      color: COLOR.ink,
    });
    this.y -= lineHeight + 3;
  }
}

export async function generateReportPdf(report: Report, content: ReportContent | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const snapshot: ReportContent = content ?? {
    version: "1.0",
    generatedAt: report.createdAt.toISOString(),
    organizationName: "Organización",
    executiveSummary: "Este informe se generó antes de la introducción del contenido detallado en PDF.",
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    findingsByDataType: [],
    topRisks: [],
    recommendations: [],
  };

  const layout = new Layout(
    doc,
    regular,
    bold,
    `Generado el ${formatDate(snapshot.generatedAt)} · Privaris · v${snapshot.version}`,
  );

  layout.header(snapshot.organizationName);

  layout.text(report.name, { size: 16, font: bold, color: COLOR.brand, gap: 2 });
  layout.text(`Fecha de generación: ${formatDate(snapshot.generatedAt)}`, { size: 9, color: COLOR.muted, gap: 12 });

  drawScore();

  layout.heading("Resumen ejecutivo");
  layout.text(snapshot.executiveSummary, { size: 10, gap: 6 });

  layout.heading("Hallazgos por severidad");
  for (const severity of ["critical", "high", "medium", "low"] as const) {
    layout.keyValue(SEVERITY_LABEL[severity], String(snapshot.severityCounts[severity]), {
      dot: SEVERITY_COLOR[severity],
    });
  }

  layout.heading("Hallazgos por tipo de dato");
  if (snapshot.findingsByDataType.length === 0) {
    layout.text("Sin hallazgos activos.", { size: 10, color: COLOR.muted, gap: 4 });
  } else {
    for (const item of snapshot.findingsByDataType) {
      layout.keyValue(item.label, String(item.count));
    }
  }

  layout.heading("Principales riesgos detectados");
  if (snapshot.topRisks.length === 0) {
    layout.text("No se detectaron riesgos activos.", { size: 10, color: COLOR.muted, gap: 4 });
  } else {
    for (const risk of snapshot.topRisks) drawRisk(risk);
  }

  layout.heading("Recomendaciones");
  if (snapshot.recommendations.length === 0) {
    layout.text("Sin recomendaciones pendientes.", { size: 10, color: COLOR.muted, gap: 4 });
  } else {
    for (const recommendation of snapshot.recommendations) drawBullet(recommendation);
  }

  return doc.save();

  function drawScore(): void {
    const page = layout.currentPage;
    const top = layout.cursorY;
    const boxHeight = 70;
    page.drawRectangle({
      x: MARGIN,
      y: top - boxHeight,
      width: CONTENT_WIDTH,
      height: boxHeight,
      color: COLOR.light,
      borderColor: COLOR.line,
      borderWidth: 0.5,
    });
    page.drawText("Compliance Score", {
      x: MARGIN + 16,
      y: top - 24,
      size: 9,
      font: regular,
      color: COLOR.muted,
    });
    const scoreText = String(report.complianceScore);
    const scoreWidth = bold.widthOfTextAtSize(scoreText, 30);
    page.drawText(scoreText, { x: MARGIN + 16, y: top - 62, size: 30, font: bold, color: COLOR.brand });
    page.drawText("/ 100", { x: MARGIN + 16 + scoreWidth + 6, y: top - 44, size: 11, font: regular, color: COLOR.muted });
    page.drawText(`${report.findings} hallazgos activos`, {
      x: MARGIN + 220,
      y: top - 44,
      size: 10,
      font: regular,
      color: COLOR.ink,
    });
    layout.setCursorY(top - boxHeight - 14);
  }

  function drawRisk(risk: ReportContentRisk): void {
    const page = layout.currentPage;
    const dotColor = SEVERITY_COLOR[risk.severity] ?? COLOR.muted;
    for (const line of wrapText(risk.title, bold, 10.5, CONTENT_WIDTH - 16)) {
      layout.ensure(14);
      page.drawCircle({ x: MARGIN + 4, y: layout.cursorY + 2, size: 3, color: dotColor });
      page.drawText(line, { x: MARGIN + 12, y: layout.cursorY, size: 10.5, font: bold, color: COLOR.ink });
      layout.advance(14);
    }
    const meta = `${SEVERITY_LABEL[risk.severity] ?? risk.severity} · ${risk.dataType} · ${risk.source} · ${risk.records} registros · ${risk.regulation}`;
    layout.text(meta, { size: 8.5, color: COLOR.muted, gap: 2 });
    if (risk.recommendation) {
      layout.text(risk.recommendation, { size: 9, color: COLOR.ink, gap: 10 });
    } else {
      layout.advance(8);
    }
  }

  function drawBullet(recommendation: string): void {
    const page = layout.currentPage;
    for (const line of wrapText(recommendation, regular, 9.5, CONTENT_WIDTH - 16)) {
      layout.ensure(13);
      page.drawText("•", { x: MARGIN, y: layout.cursorY, size: 9.5, font: bold, color: COLOR.accent });
      page.drawText(line, { x: MARGIN + 12, y: layout.cursorY, size: 9.5, font: regular, color: COLOR.ink });
      layout.advance(13);
    }
    layout.advance(5);
  }
}
