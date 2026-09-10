import { BarChart3, CalendarRange, CheckCircle2, Download, FileBarChart2, FileText, LoaderCircle, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  downloadReport,
  getListReportsQueryKey,
  useCreateReport,
  useListReports,
} from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import type { Report, ReportInput } from '@workspace/api-client-react';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';

const periodLabel: Record<string, string> = { last_24h: 'Últimas 24 horas', last_7d: 'Últimos 7 días', last_30d: 'Últimos 30 días', quarter: 'Este trimestre' };
const date = (value: string) => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

function ReportCard({ report, onDownload }: { report: Report; onDownload: (id: string) => void }) {
  return <div className="group flex flex-col gap-4 border-b border-border/70 p-5 last:border-0 sm:flex-row sm:items-center" data-testid={`row-report-${report.id}`}><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e9eef5] text-[#45617d]"><FileText size={19} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-bold">{report.name}</p><StatusBadge value={report.status} kind="status" /></div><div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span>{periodLabel[report.period] ?? report.period}</span><span>·</span><span>{date(report.createdAt)}</span>{report.format && <><span>·</span><span className="font-mono uppercase">{report.format}</span></>}</div></div><div className="flex items-center gap-7 text-xs"><div><p className="label-caps">Hallazgos</p><p className="mt-1 font-mono font-bold">{report.findings}</p></div><div><p className="label-caps">Score</p><p className="mt-1 font-mono font-bold text-primary">{report.complianceScore.toFixed(1)}%</p></div>{report.status === 'ready' && <button onClick={() => onDownload(report.id)} className="rounded-lg border border-border p-2 text-muted-foreground hover:border-primary hover:text-primary" aria-label={`Descargar ${report.name}`} data-testid={`button-download-report-${report.id}`}><Download size={15} /></button>}</div></div>;
}

export default function ReportsPage() {
  const reportsQuery = useListReports();
  const queryClient = useQueryClient();
  const createReport = useCreateReport();
  const { isAdmin } = useAuth();
  const latestReport = reportsQuery.data?.[0];
  const cadence = latestReport ? (periodLabel[latestReport.period] ?? latestReport.period) : null;
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<ReportInput['period']>('last_30d');
  const [error, setError] = useState('');
  const submit = () => {
    if (!name.trim()) { setError('Ponle un nombre al informe.'); return; }
    setError('');
    createReport.mutate({ data: { name: name.trim(), period } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListReportsQueryKey() }); setName(''); setFormOpen(false); } , onError: () => setError('No se pudo crear el informe. Reintenta.') });
  };
  const handleDownload = async (id: string) => {
    const data = await downloadReport(id);
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `report-${data.id}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  return <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow="Evidencia y auditoría" title="Informes" description="Convierte el estado de cumplimiento en evidencia lista para compartir." action={isAdmin ? <button onClick={() => setFormOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#173d45] px-4 py-2.5 text-xs font-bold text-white transition-transform hover:-translate-y-0.5" data-testid="button-open-report-form"><Plus size={15} /> Generar informe</button> : undefined} />
    {formOpen && <div className="mb-6 rounded-2xl border border-[#bcded6] bg-[#edf8f4] p-5 shadow-[var(--shadow-card)]"><div className="flex items-start justify-between"><div><p className="label-caps text-[#4d7f77]">Nuevo informe de auditoría</p><h2 className="mt-1 font-display text-lg font-bold text-[#194b4b]">Define el periodo de evidencia</h2></div><button onClick={() => setFormOpen(false)} className="rounded-lg p-1.5 text-[#4d7f77] hover:bg-[#d4eee6]" aria-label="Cerrar formulario" data-testid="button-close-report-form"><X size={17} /></button></div><div className="mt-5 grid gap-3 md:grid-cols-[1fr_240px_auto] md:items-end"><label className="block"><span className="label-caps text-[#4d7f77]">Nombre</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Auditoría de privacidad — Q2" className="mt-2 h-11 w-full rounded-lg border border-[#bcded6] bg-white/70 px-3 text-sm outline-none focus:border-primary" data-testid="input-report-name" /></label><label className="block"><span className="label-caps text-[#4d7f77]">Periodo</span><select value={period} onChange={(event) => setPeriod(event.target.value as ReportInput['period'])} className="mt-2 h-11 w-full rounded-lg border border-[#bcded6] bg-white/70 px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="select-report-period">{Object.entries(periodLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button onClick={submit} disabled={createReport.isPending} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#173d45] px-4 text-xs font-bold text-white disabled:opacity-60" data-testid="button-submit-report">{createReport.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <FileBarChart2 size={15} />} Crear informe</button></div>{error && <p className="mt-3 text-xs font-semibold text-[#b14e43]">{error}</p>}</div>}
    <div className="mb-6 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><div className="flex items-center justify-between"><p className="label-caps">Informes generados</p><BarChart3 size={17} className="text-primary" /></div><p className="mt-2 font-display text-2xl font-bold">{reportsQuery.data?.length ?? 0}</p><p className="mt-1 text-xs text-muted-foreground">historial disponible</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><div className="flex items-center justify-between"><p className="label-caps">Listos para compartir</p><CheckCircle2 size={17} className="text-primary" /></div><p className="mt-2 font-display text-2xl font-bold">{reportsQuery.data?.filter((report: Report) => report.status === 'ready').length ?? 0}</p><p className="mt-1 text-xs text-muted-foreground">evidencia verificada</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><div className="flex items-center justify-between"><p className="label-caps">Cadencia</p><CalendarRange size={17} className="text-[#9c681d]" /></div><p className="mt-2 font-display text-2xl font-bold">{cadence ?? '—'}</p><p className="mt-1 text-xs text-muted-foreground">periodo del último informe generado</p></div></div>
    <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"><div className="border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Historial de informes</div>{reportsQuery.isLoading ? <div className="space-y-5 p-5">{[1, 2, 3].map((item) => <div className="flex gap-3" key={item}><div className="skeleton h-10 w-10 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-1/2 rounded" /><div className="mt-2 skeleton h-3 w-1/3 rounded" /></div></div>)}</div> : reportsQuery.isError ? <div className="p-12 text-center"><p className="font-display font-bold">No pudimos cargar los informes.</p><button onClick={() => reportsQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-reports">Reintentar</button></div> : reportsQuery.data?.length ? reportsQuery.data.map((report) => <ReportCard report={report} key={report.id} onDownload={handleDownload} />) : <div className="px-6 py-16 text-center"><FileBarChart2 className="mx-auto mb-3 text-muted-foreground/50" size={30} /><p className="font-display text-lg font-bold">Tu historial empieza aquí</p><p className="mt-1 text-sm text-muted-foreground">Genera un informe para capturar una foto verificable del cumplimiento.</p>{isAdmin && <button onClick={() => setFormOpen(true)} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-xs font-bold hover:border-primary" data-testid="button-empty-create-report"><Plus size={14} /> Generar primero</button>}</div>}</div>
  </section>;
}