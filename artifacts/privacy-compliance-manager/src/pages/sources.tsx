import { CloudCog, Database, GitBranch, HardDrive, LoaderCircle, Play, RefreshCw, Server, ShieldCheck, Table2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetDashboardQueryKey, getListSourcesQueryKey, useListSources, useStartScan } from '@workspace/api-client-react';
import type { DataSource } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';

const sourceIcons: Record<string, typeof Database> = { postgresql: Database, mysql: Server, mongodb: CloudCog, snowflake: HardDrive, bigquery: Table2 };
const sourceNames: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', snowflake: 'Snowflake', bigquery: 'BigQuery' };
const relative = (value: string) => { const hours = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 3600000)); return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`; };

function SourceRow({ source, canScan }: { source: DataSource; canScan: boolean }) {
  const queryClient = useQueryClient();
  const scan = useStartScan();
  const Icon = sourceIcons[source.kind] ?? Database;
  const scanSource = () => scan.mutate({ data: { sourceId: source.id } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } });
  return <div className="group grid gap-4 border-b border-border/70 px-5 py-5 last:border-0 md:grid-cols-[1.55fr_.8fr_.75fr_.72fr_.8fr_110px] md:items-center" data-testid={`row-source-${source.id}`}>
    <div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e9eef5] text-[#45617d]"><Icon size={19} /></div><div className="min-w-0"><p className="truncate text-sm font-bold">{source.name}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span>{sourceNames[source.kind] ?? source.kind}</span><span>·</span><span>{source.tables} tablas</span></p></div></div>
    <StatusBadge value={source.environment} kind="generic" />
    <StatusBadge value={source.status} kind="status" />
    <div><p className="font-mono text-xs font-medium">{source.records.toLocaleString('es-ES')}</p><p className="mt-1 text-[10px] text-muted-foreground">registros</p></div>
    <div><p className={`font-mono text-xs font-medium ${source.findings > 0 ? 'text-[#bb624c]' : 'text-primary'}`}>{source.findings}</p><p className="mt-1 text-[10px] text-muted-foreground">hallazgos · {relative(source.lastScanAt)}</p></div>
    {canScan ? <button disabled={scan.isPending} onClick={scanSource} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-60" data-testid={`button-scan-source-${source.id}`}>{scan.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={13} />} Escanear</button> : <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">solo lectura</span>}
  </div>;
}

export default function SourcesPage() {
  const sourcesQuery = useListSources();
  const { isAdmin } = useAuth();
  const sources = sourcesQuery.data ?? [];
  const scannedRecently = sources.filter((source) => {
    try { const age = Date.now() - new Date(source.lastScanAt).getTime(); return age < 7 * 24 * 60 * 60 * 1000; } catch { return false; }
  }).length;
  const coverage = sources.length > 0 ? Math.round((scannedRecently / sources.length) * 100) : null;
  let lastScanAt: string | null = null;
  for (const source of sources) {
    try { if (!lastScanAt || new Date(source.lastScanAt).getTime() > new Date(lastScanAt).getTime()) lastScanAt = source.lastScanAt; } catch { /* ignorar entradas sin fecha */ }
  }
  return <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow="Superficie de datos" title="Fuentes monitorizadas" description="Conexiones bajo vigilancia continua, con una acción de escaneo a un clic." action={<div className="flex items-center gap-2 rounded-xl border border-[#c9ded9] bg-[#edf8f4] px-3 py-2.5 text-xs font-bold text-[#267a6d]"><span className="h-2 w-2 rounded-full bg-[#31a886]" /> {sourcesQuery.data?.length ?? 0} conectadas</div>} />
    <div className="mb-6 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Cobertura total</p><p className="mt-2 font-display text-2xl font-bold">{coverage === null ? '—' : `${coverage}%`}</p><p className="mt-1 text-xs text-muted-foreground">{coverage === null ? 'sin fuentes conectadas' : `${scannedRecently} de ${sources.length} fuentes con escaneo en los últimos 7 días`}</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Registros bajo control</p><p className="mt-2 font-display text-2xl font-bold">{sources.reduce((sum, source) => sum + source.records, 0).toLocaleString('es-ES')}</p><p className="mt-1 text-xs text-muted-foreground">entre todos los entornos</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Última actualización</p><p className="mt-2 font-display text-2xl font-bold">{lastScanAt ? relative(lastScanAt) : '—'}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-primary"><RefreshCw size={12} /> último scan registrado en la conexión</p></div></div>
    {sourcesQuery.isLoading ? <div className="rounded-2xl border border-card-border bg-card p-5">{[1, 2, 3].map((row) => <div className="flex gap-3 border-b border-border py-5" key={row}><div className="skeleton h-10 w-10 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-1/3 rounded" /><div className="mt-2 skeleton h-3 w-1/4 rounded" /></div></div>)}</div> : sourcesQuery.isError ? <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-10 text-center"><p className="font-display font-bold">No pudimos conectar con las fuentes.</p><button onClick={() => sourcesQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-sources">Reintentar</button></div> : sourcesQuery.data?.length ? <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"><div className="hidden grid-cols-[1.55fr_.8fr_.75fr_.72fr_.8fr_110px] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>Fuente</span><span>Entorno</span><span>Estado</span><span>Registros</span><span>Hallazgos</span><span /></div>{sourcesQuery.data.map((source) => <SourceRow key={source.id} source={source} canScan={isAdmin} />)}</div> : <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center"><ShieldCheck className="mx-auto mb-3 text-muted-foreground/50" size={30} /><p className="font-display text-lg font-bold">Aún no hay fuentes conectadas</p><p className="mt-1 text-sm text-muted-foreground">Cuando añadas una conexión aparecerá aquí su cobertura.</p></div>}
  </section>;
}