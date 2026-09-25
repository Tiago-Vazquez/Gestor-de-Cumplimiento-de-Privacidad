/**
 * M16.4 — Métricas operativas en formato Prometheus (text exposition 0.0.4).
 *
 * Implementación minimalista SIN dependencias nuevas (la spec lo pide:
 * "no introducir dependencias innecesarias"): contadores, gauge e histograma
 * con buckets fijos, renderizados a texto en `GET /api/metrics`.
 *
 * Convenciones:
 * - Los valores de label se escapan (`\\`, `"` y `\n`).
 * - El histograma emite `_bucket{le=...}`, `_sum` y `_count`.
 * - `resetMetrics()` existe SOLO para tests (por archivo, estado aislado).
 *
 * Cardinalidad: los labels HTTP usan la PLANTILLA de ruta de Express
 * (`/api/sources/:id`), nunca el path real con ids — el volumen de series es
 * acotado y estable.
 */

type Labels = Record<string, string>;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderSamples(name: string, labels: Labels, value: number): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return `${name} ${value}`;
  const rendered = entries
    .map(([key, val]) => `${key}="${escapeLabelValue(val)}"`)
    .join(",");
  return `${name}{${rendered}} ${value}`;
}

/** Suma de muestras por combinación de labels. */
class Counter {
  readonly kind = "counter" as const;
  private readonly samples = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = JSON.stringify(labels);
    const current = this.samples.get(key);
    if (current) {
      current.value += value;
    } else {
      this.samples.set(key, { labels: { ...labels }, value });
    }
  }

  /** Valor total (suma de todas las combinaciones de labels). */
  total(): number {
    let total = 0;
    for (const sample of this.samples.values()) total += sample.value;
    return total;
  }

  reset(): void {
    this.samples.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.kind}`];
    if (this.samples.size === 0) return [...lines, renderSamples(this.name, {}, 0)];
    for (const sample of this.samples.values()) {
      lines.push(renderSamples(this.name, sample.labels, sample.value));
    }
    return lines;
  }
}

/** Valor puntual (se fija; no se acumula). */
class Gauge {
  readonly kind = "gauge" as const;
  private value = 0;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number): void {
    this.value = value;
  }

  inc(value = 1): void {
    this.value += value;
  }

  dec(value = 1): void {
    this.value -= value;
  }

  reset(): void {
    this.value = 0;
  }

  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.kind}`, renderSamples(this.name, {}, this.value)];
  }
}

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Distribución de duraciones: buckets acumulativos + _sum + _count. */
class Histogram {
  readonly kind = "histogram" as const;
  private readonly counts = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = HISTOGRAM_BUCKETS,
  ) {}

  observe(labels: Labels = {}, value: number): void {
    const key = JSON.stringify(labels);
    let sample = this.counts.get(key);
    if (!sample) {
      sample = { labels: { ...labels }, buckets: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.counts.set(key, sample);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) sample.buckets[i] += 1;
    }
    sample.sum += value;
    sample.count += 1;
  }

  reset(): void {
    this.counts.clear();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.kind}`];
    for (const sample of this.counts.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(renderSamples(`${this.name}_bucket`, { ...sample.labels, le: String(this.buckets[i]) }, sample.buckets[i]));
      }
      lines.push(renderSamples(`${this.name}_bucket`, { ...sample.labels, le: "+Inf" }, sample.count));
      lines.push(renderSamples(`${this.name}_sum`, sample.labels, sample.sum));
      lines.push(renderSamples(`${this.name}_count`, sample.labels, sample.count));
    }
    return lines;
  }
}

/** Registro: crea las métricas del proceso y las renderiza en orden estable. */
class Registry {
  private readonly metrics: (Counter | Gauge | Histogram)[] = [];

  counter(name: string, help: string): Counter {
    const metric = new Counter(name, help);
    this.metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    const metric = new Gauge(name, help);
    this.metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const metric = new Histogram(name, help, buckets);
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    return this.metrics.flatMap((metric) => metric.render()).join("\n") + "\n";
  }

  reset(): void {
    for (const metric of this.metrics) metric.reset();
  }
}

export const metrics = new Registry();

// ---------------------------------------------------------------------------
// Métricas del dominio (M16.4). Sin labels de alta cardinalidad.
// ---------------------------------------------------------------------------

/** Total de requests HTTP servidos, por método, plantilla de ruta y status. */
export const httpRequestsTotal = metrics.counter("http_requests_total", "Total HTTP requests processed.");

/** Duración de los requests HTTP en milisegundos. */
export const httpRequestDurationMs = metrics.histogram(
  "http_request_duration_ms",
  "HTTP request duration in milliseconds.",
);

/** Ciclo de vida de scans (M16.3). */
export const scansStartedTotal = metrics.counter("scans_started_total", "Total scans started (manual + scheduled).");
export const scansCompletedTotal = metrics.counter("scans_completed_total", "Total scans completed successfully.");
export const scansFailedTotal = metrics.counter("scans_failed_total", "Total scans that ended failed (incl. cancelled).");
export const activeScans = metrics.gauge("active_scans", "Scans currently running in this process.");

/** Ciclo de vida del scheduler (M16.3). */
export const schedulerDispatchTotal = metrics.counter("scheduler_dispatch_total", "Scheduled scans dispatched to the standard pipeline.");
export const schedulerErrorsTotal = metrics.counter("scheduler_errors_total", "Scheduler dispatch failures.");

/** Solo para tests: reinicia todas las muestras del registro. */
export function resetMetrics(): void {
  metrics.reset();
}