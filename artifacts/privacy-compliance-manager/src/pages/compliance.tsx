import { RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import {
  getGetComplianceQueryKey,
  getGetComplianceTrendQueryKey,
  useGetCompliance,
  useGetComplianceTrend,
} from '@workspace/api-client-react';
import { MetricCard, LoadingCards } from '@/components/metric-card';
import { PageHeading } from '@/components/app-shell';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Line, LineChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';

type Window = 7 | 14 | 30 | 90;

const WINDOWS: { value: Window; label: string }[] = [
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

const chartConfig = {
  newFindings: { label: 'Nuevos hallazgos', color: '#e59b40' },
  resolvedFindings: { label: 'Resueltos', color: '#55a995' },
  completedScans: { label: 'Escaneos', color: '#3f577c' },
} satisfies ChartConfig;

function ComplianceError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-8 text-center"
      data-testid="compliance-error"
    >
      <ShieldAlert className="mx-auto mb-3 text-[#bf5a4e]" size={28} />
      <h2 className="font-display text-lg font-bold">No pudimos cargar el cumplimiento</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        El servicio no respondió. Reintenta para volver a conectar la consola.
      </p>
      <button
        onClick={onRetry}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-xs font-bold text-background transition-transform hover:-translate-y-0.5"
        data-testid="button-retry-compliance"
      >
        <RefreshCw size={14} /> Reintentar
      </button>
    </div>
  );
}

function TrendChart({ days }: { days: Window }) {
  const trendQuery = useGetComplianceTrend(
    { days },
    { query: { queryKey: getGetComplianceTrendQueryKey({ days }) } },
  );
  const points = trendQuery.data?.points ?? [];

  if (trendQuery.isLoading) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/30" data-testid="chart-loading">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw size={14} className="animate-spin" /> Cargando tendencia...
        </div>
      </div>
    );
  }

  if (trendQuery.isError || points.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/30" data-testid="chart-empty">
        <p className="text-xs text-muted-foreground">
          {trendQuery.isError ? 'No se pudo cargar la tendencia.' : 'Sin datos de tendencia.'}
        </p>
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="h-[300px] w-full" data-testid="chart-trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line type="monotone" dataKey="newFindings" stroke="var(--color-newFindings)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="resolvedFindings" stroke="var(--color-resolvedFindings)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="completedScans" stroke="var(--color-completedScans)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

export default function CompliancePage() {
  const [window, setWindow] = useState<Window>(30);
  const complianceQuery = useGetCompliance({ query: { queryKey: getGetComplianceQueryKey() } });
  const compliance = complianceQuery.data;

  const bySeverity = compliance?.findingsBySeverity;
  const bySource = compliance?.findingsBySource;
  const byDataType = compliance?.findingsByDataType;

  return (
    <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
      <PageHeading
        eyebrow="Cumplimiento"
        title="Compliance"
        description="Estado actual de cumplimiento y tendencia de hallazgos en el tiempo."
        action={
          <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1" data-testid="window-selector">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                onClick={() => setWindow(w.value)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  window === w.value
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`button-window-${w.value}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      {complianceQuery.isLoading ? (
        <LoadingCards />
      ) : complianceQuery.isError || !compliance ? (
        <ComplianceError onRetry={() => complianceQuery.refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Puntuación"
              value={`${compliance.complianceScore.toFixed(1)}%`}
              detail="cumplimiento global"
              icon={ShieldAlert}
              tone="teal"
            />
            <MetricCard
              label="Hallazgos abiertos"
              value={compliance.openFindings.toLocaleString('es-ES')}
              detail="requieren seguimiento"
              icon={TrendingUp}
              tone="amber"
            />
            <MetricCard
              label="Críticos"
              value={(bySeverity?.critical ?? 0).toLocaleString('es-ES')}
              detail="máxima prioridad"
              icon={ShieldAlert}
              tone="coral"
            />
            <MetricCard
              label="Altos"
              value={(bySeverity?.high ?? 0).toLocaleString('es-ES')}
              detail="prioridad elevada"
              icon={ShieldAlert}
              tone="navy"
            />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Tendencia
                  </p>
                  <h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">
                    Evolución en {window} días
                  </h2>
                </div>
                <TrendingUp size={19} className="text-primary" />
              </div>
              <TrendChart days={window} />
            </div>

            <div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Por fuente
                  </p>
                  <h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">
                    Hallazgos por fuente
                  </h2>
                </div>
              </div>
              <div className="space-y-2">
                {bySource && bySource.length > 0 ? (
                  bySource.map((s) => (
                    <div key={s.sourceId} className="flex items-center justify-between rounded-lg border border-border px-3 py-2" data-testid={`row-source-${s.sourceId}`}>
                      <span className="text-xs font-semibold">{s.sourceName}</span>
                      <span className="font-mono text-xs font-medium">{s.openFindings}</span>
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">Sin fuentes con hallazgos.</p>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Por tipo de dato
                </p>
                <h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">
                  Hallazgos por tipo de dato
                </h2>
              </div>
            </div>
            {byDataType && Object.keys(byDataType).length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(byDataType).map(([dataType, total]) => (
                  <div
                    key={dataType}
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                    data-testid={`row-datatype-${dataType}`}
                  >
                    <span className="text-xs font-semibold">{dataType}</span>
                    <span className="font-mono text-xs font-medium">{total}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">Sin hallazgos por tipo de dato.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
