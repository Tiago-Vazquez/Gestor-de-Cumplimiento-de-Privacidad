import { Activity as ActivityIcon, ArrowRight, Database, LockKeyhole, Radar, RefreshCw, ShieldAlert, TimerReset } from 'lucide-react';
import { Link } from 'wouter';
import { getGetActivityQueryKey, getGetDashboardQueryKey, useGetActivity, useGetDashboard } from '@workspace/api-client-react';
import type { Activity, Dashboard } from '@workspace/api-client-react';
import { MetricCard, LoadingCards } from '@/components/metric-card';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';

const formatRelative = (date: string) => {
  const mins = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 1440) return `hace ${Math.round(mins / 60)} h`;
  return `hace ${Math.round(mins / 1440)} d`;
};

const formatHeaderDate = () => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());

function DashboardError({ onRetry }: { onRetry: () => void }) {
  return <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-8 text-center"><ShieldAlert className="mx-auto mb-3 text-[#bf5a4e]" size={28} /><h2 className="font-display text-lg font-bold">No pudimos cargar el pulso de cumplimiento</h2><p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">El servicio no respondió. Reintenta para volver a conectar la consola.</p><button onClick={onRetry} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-xs font-bold text-background transition-transform hover:-translate-y-0.5" data-testid="button-retry-dashboard"><RefreshCw size={14} /> Reintentar</button></div>;
}

function SeverityRail({ dashboard }: { dashboard: Dashboard }) {
  const values = [
    { key: 'critical', label: 'Críticos', color: '#d85d4d', value: dashboard.findingsBySeverity.critical },
    { key: 'high', label: 'Altos', color: '#e59b40', value: dashboard.findingsBySeverity.high },
    { key: 'medium', label: 'Medios', color: '#d9bd5d', value: dashboard.findingsBySeverity.medium },
    { key: 'low', label: 'Bajos', color: '#55a995', value: dashboard.findingsBySeverity.low },
  ];
  const total = values.reduce((sum, item) => sum + item.value, 0) || 1;
  return <div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
    <div className="mb-5 flex items-start justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Mapa de riesgo</p><h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">Hallazgos por severidad</h2></div><Link href="/findings" className="text-xs font-bold text-primary hover:underline" data-testid="link-view-findings">Ver todos</Link></div>
    <div className="mb-5 flex h-3 overflow-hidden rounded-full bg-muted">{values.map((item) => <div key={item.key} style={{ backgroundColor: item.color, width: `${(item.value / total) * 100}%` }} />)}</div>
    <div className="space-y-3">{values.map((item) => <div className="flex items-center gap-3" key={item.key}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} /><span className="flex-1 text-xs text-muted-foreground">{item.label}</span><span className="font-mono text-xs font-medium">{item.value.toLocaleString('es-ES')}</span><span className="w-10 text-right font-mono text-[10px] text-muted-foreground">{Math.round((item.value / total) * 100)}%</span></div>)}</div>
  </div>;
}

function ActivityFeed({ activities, loading }: { activities?: Activity[]; loading: boolean }) {
  return <div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
    <div className="mb-2 flex items-start justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Registro vivo</p><h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">Actividad reciente</h2></div><ActivityIcon size={19} className="text-primary" /></div>
    {loading ? <div className="space-y-4 pt-5">{[1, 2, 3, 4].map((item) => <div className="flex gap-3" key={item}><div className="skeleton h-8 w-8 rounded-full" /><div className="flex-1"><div className="skeleton h-3 w-3/5 rounded" /><div className="mt-2 skeleton h-3 w-4/5 rounded" /></div></div>)}</div> : activities?.length ? <div className="divide-y divide-border/70">{activities.slice(0, 5).map((item) => <div className="flex gap-3 py-4 first:pt-3 last:pb-1" key={item.id} data-testid={`activity-${item.id}`}><div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${item.severity === 'critical' || item.severity === 'high' ? 'bg-[#fae6e1] text-[#b14e43]' : 'bg-[#e4f2ef] text-[#237b6c]'}`}>{item.type === 'scan' ? <Radar size={15} /> : item.type === 'report' ? <ActivityIcon size={15} /> : <ShieldAlert size={15} />}</div><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><p className="truncate text-xs font-bold">{item.title}</p><time className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatRelative(item.createdAt)}</time></div><p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">{item.description}</p></div></div>)}</div> : <div className="py-10 text-center text-sm text-muted-foreground">Sin actividad reciente.</div>}
  </div>;
}

export default function DashboardPage() {
  const dashboardQuery = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: 10_000 } });
  const activityQuery = useGetActivity({ query: { queryKey: getGetActivityQueryKey(), refetchInterval: 10_000 } });
  const dashboard = dashboardQuery.data;
  return <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow={`Vista de control · ${formatHeaderDate()}`} title="Siempre un paso adelante." description="El pulso de tus datos sensibles, reunido en un solo lugar." action={<div className="flex items-center gap-2 rounded-full border border-[#bcded6] bg-[#eff9f6] px-3 py-2 text-xs font-semibold text-[#267a6d]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#31a886]" /> Monitoreo activo</div>} />
    {dashboardQuery.isLoading ? <LoadingCards /> : dashboardQuery.isError || !dashboard ? <DashboardError onRetry={() => dashboardQuery.refetch()} /> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Puntuación" value={`${dashboard.complianceScore.toFixed(1)}%`} detail="cumplimiento global" icon={ShieldAlert} tone="teal" />
        <MetricCard label="Hallazgos abiertos" value={dashboard.openFindings.toLocaleString('es-ES')} detail="requieren seguimiento" icon={Radar} tone="amber" />
        <MetricCard label="Registros protegidos" value={dashboard.protectedRecords.toLocaleString('es-ES')} detail="en fuentes monitorizadas" icon={LockKeyhole} tone="navy" />
        <MetricCard label="Fuentes conectadas" value={dashboard.monitoredSources.toString()} detail={`último scan ${formatRelative(dashboard.lastScanAt)}`} icon={Database} tone="coral" />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
        <SeverityRail dashboard={dashboard} />
        <ActivityFeed activities={activityQuery.data} loading={activityQuery.isLoading} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_.6fr]">
        <div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]">
          <div className="flex items-start justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Cadencia operativa</p><h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">Cobertura de escaneo</h2></div><TimerReset size={19} className="text-primary" /></div>
          <div className="mt-7 flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-5 py-10 text-center"><div><p className="text-sm font-bold">{dashboard.scanStatus === 'scanning' ? 'Escaneo en curso' : 'Monitoreo activo'}</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">El histórico de cobertura aparecerá cuando el motor de escaneo registre ejecuciones sobre las fuentes.</p></div></div>
        </div>
        <div className="rounded-2xl border border-[#c9ded9] bg-[#edf8f4] p-5 shadow-[var(--shadow-card)]"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#d4eee6] text-[#237b6c]"><LockKeyhole size={18} /></div><h2 className="mt-6 font-display text-xl font-bold tracking-[-0.04em] text-[#194b4b]">La privacidad no espera.</h2><p className="mt-2 text-sm leading-6 text-[#4c7470]">Hay {dashboard.criticalFindings} hallazgos críticos que necesitan una decisión hoy.</p><Link href="/findings" className="mt-6 inline-flex items-center gap-2 text-xs font-bold text-[#237b6c] hover:gap-3" data-testid="link-review-critical">Revisar prioridad <ArrowRight size={14} /></Link></div>
      </div>
    </>}
  </section>;
}