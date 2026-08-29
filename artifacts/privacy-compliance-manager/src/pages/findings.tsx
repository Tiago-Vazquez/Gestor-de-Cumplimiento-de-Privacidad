import { Check, ChevronRight, CircleX, Filter, Search, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListFindingsQueryKey, useListFindings, useUpdateFinding } from '@workspace/api-client-react';
import type { Finding, FindingSeverity, FindingStatus } from '@workspace/api-client-react';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';

const date = (value: string) => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const dataLabels: Record<string, string> = { email: 'Email', phone: 'Teléfono', national_id: 'ID nacional', credit_card: 'Tarjeta', health: 'Salud', address: 'Dirección', password: 'Contraseña' };

function FindingsSkeleton() {
  return <div className="rounded-2xl border border-card-border bg-card p-4">{[1, 2, 3, 4, 5].map((row) => <div className="flex gap-4 border-b border-border py-5 last:border-0" key={row}><div className="skeleton h-3 w-2/5 rounded" /><div className="skeleton h-3 w-20 rounded" /><div className="skeleton h-3 w-16 rounded" /></div>)}</div>;
}

function FindingDrawer({ finding, onClose, onUpdated }: { finding: Finding; onClose: () => void; onUpdated: (status: FindingStatus) => void }) {
  const queryClient = useQueryClient();
  const updateFinding = useUpdateFinding();
  const [message, setMessage] = useState('');
  const statusOptions: FindingStatus[] = ['open', 'in_review', 'resolved'];
  const updateStatus = (status: FindingStatus) => {
    setMessage('');
    updateFinding.mutate({ id: finding.id, data: { status } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFindingsQueryKey() });
        setMessage('Estado actualizado');
        onUpdated(status);
      },
      onError: () => setMessage('No se pudo actualizar. Intenta de nuevo.'),
    });
  };
  return <div className="fixed inset-0 z-50 flex justify-end bg-[#172538]/20 backdrop-blur-[2px]" onClick={onClose}>
    <div className="h-full w-full max-w-[550px] overflow-y-auto border-l border-border bg-background px-6 py-7 shadow-2xl sm:px-8" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><div className="mb-3 flex items-center gap-2"><StatusBadge value={finding.severity} kind="severity" /><span className="font-mono text-[10px] text-muted-foreground">#{finding.id}</span></div><h2 className="font-display text-[25px] font-bold leading-tight tracking-[-0.04em]">{finding.title}</h2></div><button onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Cerrar detalle" data-testid="button-close-finding"><X size={19} /></button></div>
      <div className="mt-7 grid grid-cols-2 gap-3"><div className="rounded-xl border border-border bg-card p-4"><p className="font-mono text-[10px] uppercase text-muted-foreground">Registros</p><p className="mt-2 font-display text-xl font-bold">{finding.records.toLocaleString('es-ES')}</p></div><div className="rounded-xl border border-border bg-card p-4"><p className="font-mono text-[10px] uppercase text-muted-foreground">Detectado</p><p className="mt-2 text-sm font-bold">{date(finding.detectedAt)}</p></div></div>
      <div className="mt-7 space-y-6"><div><p className="label-caps">Ubicación</p><p className="mt-2 text-sm font-semibold">{finding.source} <span className="mx-1 text-muted-foreground">/</span> <span className="font-mono text-xs">{finding.location}</span></p></div><div><p className="label-caps">Tipo de dato</p><p className="mt-2 text-sm font-semibold">{dataLabels[finding.dataType] ?? finding.dataType}</p></div><div><p className="label-caps">Marco regulatorio</p><p className="mt-2 inline-flex items-center rounded-md bg-[#e4f2ef] px-2 py-1 font-mono text-xs font-medium text-[#267a6d]">{finding.regulation}</p></div><div className="rounded-xl border border-[#efdfbb] bg-[#fff9ed] p-4"><p className="flex items-center gap-2 text-xs font-bold text-[#90611d]"><ShieldAlert size={15} /> Recomendación</p><p className="mt-2 text-sm leading-6 text-[#775e36]">{finding.recommendation}</p></div>{finding.sample && <div><p className="label-caps">Muestra detectada</p><div className="mt-2 overflow-x-auto rounded-xl border border-border bg-[#19263a] p-4 font-mono text-xs text-[#b5d9d2]">{finding.sample}</div></div>}</div>
      <div className="mt-8 border-t border-border pt-6"><p className="label-caps mb-3">Cambiar estado</p><div className="grid grid-cols-3 gap-2">{statusOptions.map((status) => <button key={status} disabled={updateFinding.isPending} onClick={() => updateStatus(status)} className={`rounded-lg border px-3 py-2.5 text-xs font-bold transition-colors ${finding.status === status ? 'border-primary bg-[#e4f2ef] text-[#267a6d]' : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground'}`} data-testid={`button-status-${status}`}><span className="flex items-center justify-center gap-1.5">{finding.status === status && <Check size={13} />}{status === 'open' ? 'Abierto' : status === 'in_review' ? 'En revisión' : 'Resuelto'}</span></button>)}</div>{message && <p className={`mt-3 text-xs ${message.startsWith('No') ? 'text-[#b14e43]' : 'text-primary'}`}>{message}</p>}</div>
    </div>
  </div>;
}

export default function FindingsPage() {
  const [status, setStatus] = useState<'' | 'open' | 'in_review' | 'resolved'>('');
  const [severity, setSeverity] = useState<'' | 'critical' | 'high' | 'medium' | 'low'>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Finding | null>(null);
  const findingsQuery = useListFindings({ status: status || undefined, severity: severity || undefined });
  const findings = (findingsQuery.data ?? []).filter((finding) => `${finding.title} ${finding.source} ${finding.location}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow="Centro de respuesta" title="Hallazgos" description="Revisa, prioriza y documenta cada exposición antes de que se convierta en riesgo." action={<div className="rounded-xl border border-border bg-card px-4 py-3 text-right shadow-sm"><p className="font-mono text-[10px] uppercase text-muted-foreground">Vista actual</p><p className="mt-1 text-sm font-bold">{findings.length} resultados</p></div>} />
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-card-border bg-card p-3 shadow-[var(--shadow-card)] md:flex-row md:items-center">
      <div className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por hallazgo, fuente o ubicación" className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary" data-testid="input-search-findings" /></div>
      <div className="flex items-center gap-2"><Filter size={14} className="ml-1 text-muted-foreground" /><select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="select-severity-filter"><option value="">Severidad</option><option value="critical">Crítico</option><option value="high">Alto</option><option value="medium">Medio</option><option value="low">Bajo</option></select><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="select-status-filter"><option value="">Estado</option><option value="open">Abierto</option><option value="in_review">En revisión</option><option value="resolved">Resuelto</option></select></div>
    </div>
    {findingsQuery.isLoading ? <FindingsSkeleton /> : findingsQuery.isError ? <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-10 text-center"><CircleX className="mx-auto mb-3 text-[#bf5a4e]" /><p className="font-display font-bold">No pudimos cargar los hallazgos.</p><button onClick={() => findingsQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-findings">Reintentar conexión</button></div> : findings.length === 0 ? <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center"><ShieldAlert className="mx-auto mb-3 text-muted-foreground/45" size={30} /><p className="font-display text-lg font-bold">No hay hallazgos con estos filtros</p><p className="mt-1 text-sm text-muted-foreground">Prueba con otra combinación o limpia la búsqueda.</p><button onClick={() => { setStatus(''); setSeverity(''); setSearch(''); }} className="mt-5 rounded-lg border border-border bg-background px-4 py-2 text-xs font-bold hover:border-primary" data-testid="button-clear-filters">Limpiar filtros</button></div> : <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"><div className="hidden grid-cols-[1.6fr_.8fr_.75fr_.65fr_.7fr_24px] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>Hallazgo</span><span>Fuente</span><span>Severidad</span><span>Registros</span><span>Estado</span><span /></div>{findings.map((finding) => <button onClick={() => setSelected(finding)} key={finding.id} className="grid w-full grid-cols-1 gap-3 border-b border-border/70 px-5 py-4 text-left transition-colors last:border-0 hover:bg-[#f5faf8] md:grid-cols-[1.6fr_.8fr_.75fr_.65fr_.7fr_24px] md:items-center md:gap-4" data-testid={`row-finding-${finding.id}`}><div className="min-w-0"><p className="truncate text-sm font-bold">{finding.title}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span className="font-mono">{dataLabels[finding.dataType]}</span><span>·</span>{finding.location}</p></div><span className="text-xs font-semibold text-muted-foreground md:block">{finding.source}</span><span><StatusBadge value={finding.severity} kind="severity" /></span><span className="font-mono text-xs">{finding.records.toLocaleString('es-ES')}</span><span><StatusBadge value={finding.status} kind="status" /></span><ChevronRight size={16} className="hidden text-muted-foreground md:block" /></button>)}</div>}
    {selected && <FindingDrawer finding={selected} onClose={() => setSelected(null)} onUpdated={(status) => setSelected({ ...selected, status })} />}
  </section>;
}