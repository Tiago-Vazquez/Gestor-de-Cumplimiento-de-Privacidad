import { ArrowRight, Braces, Check, Download, EyeOff, Fingerprint, Info, LoaderCircle, Play, RotateCcw, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Drawer } from 'vaul';
import {
  downloadMaskingJob,
  getGetMaskingJobQueryKey,
  getListMaskingJobsQueryKey,
  useCreateMaskingJob,
  useGetMaskingJob,
  useListMaskingJobs,
  useListSources,
  usePreviewMasking,
} from '@workspace/api-client-react';
import type { MaskingJob, MaskingPreview } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { toast } from '@/hooks/use-toast';

// Catálogo alineado con MASKABLE_FIELDS del backend (M5.b): `address` NUNCA se
// envía; el backend lo rechaza con 400 (fields ⊆ MASKABLE_FIELDS).
const fieldOptions = ['email', 'phone', 'national_id', 'credit_card'];
const labels: Record<string, string> = { email: 'email', phone: 'phone', national_id: 'national_id', credit_card: 'credit_card' };

const PAGE_SIZE = 10;

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch {
    return '—';
  }
};

function JobDetailDrawer({ job, onClose }: { job: MaskingJob; onClose: () => void }) {
  const detailQuery = useGetMaskingJob(job.id, {
    query: {
      queryKey: getGetMaskingJobQueryKey(job.id),
      refetchInterval: (query) => {
        const data = query.state.data;
        return data && (data.status === 'queued' || data.status === 'running') ? 5_000 : false;
      },
    },
  });

  // El listado ya trae los metadatos; el detalle refresca jobs no terminales.
  const current = detailQuery.data ?? job;

  const handleDownload = async () => {
    const dataset = await downloadMaskingJob(current.id);
    if (!dataset) return;
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `masking-job-${dataset.jobId}.json`;
    document.body.appendChild(link);
    link.click();
  };

  return (
    <Drawer.Root open={true} onClose={onClose}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="fixed bottom-0 right-0 top-0 flex w-full max-w-md flex-col border-l border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <Fingerprint size={18} className="text-primary" />
              <Drawer.Title className="font-display text-lg font-bold">Detalle del job</Drawer.Title>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Cerrar" data-testid="button-close-masking-drawer">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {detailQuery.isError && !detailQuery.data ? (
              <div className="rounded-xl border border-[#edc5bd] bg-[#fff8f6] p-6 text-center">
                <p className="font-display font-bold">No se pudo cargar el detalle</p>
                <button onClick={() => detailQuery.refetch()} className="mt-3 text-xs font-bold text-primary underline" data-testid="button-retry-masking-detail">
                  Reintentar
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <StatusBadge value={current.status} kind="scan" />
                  {current.status === 'ready' && (
                    <button
                      onClick={handleDownload}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                      data-testid={`button-download-masking-job-${current.id}`}
                    >
                      <Download size={13} />
                      Descargar dataset
                    </button>
                  )}
                </div>
                {current.status === 'failed' && (
                  <div className="rounded-lg border border-[#edc5bd] bg-[#fff8f6] p-3 text-xs text-[#bf5a4e]" data-testid="detail-masking-error">
                    El job falló{current.error ? `: ${current.error}` : ''}. Revisa la fuente y reintenta.
                  </div>
                )}
                <div className="rounded-xl border border-card-border bg-card p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">ID</p>
                  <p className="mt-1 font-mono text-xs text-foreground break-all" data-testid="detail-masking-job-id">{current.id}</p>
                </div>
                <div className="rounded-xl border border-card-border bg-card p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Campos</p>
                  <p className="mt-1 text-xs font-medium">{current.fields.map((field) => labels[field] ?? field).join(', ')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Registros</p>
                    <p className="mt-1 font-display text-lg font-bold">{current.records?.toLocaleString('es-ES') ?? '—'}</p>
                  </div>
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Estado</p>
                    <p className="mt-1 font-display text-lg font-bold">{current.status}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Creado</p>
                    <p className="mt-1 text-xs font-medium">{formatDateTime(current.createdAt)}</p>
                  </div>
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Completado</p>
                    <p className="mt-1 text-xs font-medium">{formatDateTime(current.completedAt)}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export default function MaskingPage() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const sourcesQuery = useListSources();
  const previewMutation = usePreviewMasking();
  const createMutation = useCreateMaskingJob();
  const [sourceId, setSourceId] = useState('');
  const [fields, setFields] = useState(['email', 'phone', 'national_id']);
  const [preview, setPreview] = useState<MaskingPreview | null>(null);
  const [createError, setCreateError] = useState('');
  const [page, setPage] = useState(1);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  useEffect(() => { if (!sourceId && sourcesQuery.data?.[0]) setSourceId(sourcesQuery.data[0].id); }, [sourceId, sourcesQuery.data]);
  const toggleField = (field: string) => setFields((current) => current.includes(field) ? current.filter((item) => item !== field) : [...current, field]);
  const runPreview = () => { if (!sourceId || fields.length === 0) return; previewMutation.mutate({ data: { sourceId, fields } }, { onSuccess: (result) => setPreview(result) }); };

  const listQuery = useListMaskingJobs(undefined, {
    query: {
      queryKey: getListMaskingJobsQueryKey(),
      refetchInterval: (query) => {
        const data = query.state.data;
        return data && data.some((job) => job.status === 'queued' || job.status === 'running') ? 5_000 : false;
      },
    },
  });

  const jobs = listQuery.data ?? [];
  const totalPages = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const pagedJobs = jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedJob = selectedJobId ? jobs.find((job) => job.id === selectedJobId) : null;
  const sourceName = (sourceId: string) => (sourcesQuery.data ?? []).find((source) => source.id === sourceId)?.name ?? sourceId;

  const handleCreate = () => {
    if (!sourceId || fields.length === 0) return;
    setCreateError('');
    createMutation.mutate(
      { data: { sourceId, fields } },
      {
        onSuccess: () => {
          setPreview(null);
          setPage(1);
          queryClient.invalidateQueries({ queryKey: getListMaskingJobsQueryKey() });
          toast({ title: 'Dataset generado', description: 'El job quedó listo en el historial.' });
        },
        onError: () => setCreateError('No se pudo generar el dataset. Revisa la fuente y reintenta.'),
      },
    );
  };

  const handleInvalidate = () => queryClient.invalidateQueries({ queryKey: getListMaskingJobsQueryKey() });

  return (
    <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow="Entorno de prueba" title="Previsualización de anonimización" description="Comprueba cómo se verán los datos protegidos antes de moverlos a un entorno de test." action={<div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck size={16} className="text-primary" /> Nunca modifica producción</div>} />
    <div className="grid gap-6 xl:grid-cols-[310px_1fr]">
      <div className="h-fit rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><div className="flex items-center gap-2"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#e4f2ef] text-[#237b6c]"><Fingerprint size={18} /></div><div><p className="font-display text-sm font-bold">Configura una vista</p><p className="text-[11px] text-muted-foreground">Selecciona qué proteger</p></div></div><label className="mt-7 block label-caps">Fuente de datos</label><select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setPreview(null); }} disabled={sourcesQuery.isLoading} className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="select-masking-source"><option value="">Selecciona una fuente</option>{(sourcesQuery.data ?? []).map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select><label className="mt-6 block label-caps">Campos a anonimizar</label><div className="mt-3 space-y-2">{fieldOptions.map((field) => <button key={field} onClick={() => toggleField(field)} className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${fields.includes(field) ? 'border-primary/40 bg-[#edf8f4] text-[#256f65]' : 'border-border bg-background text-muted-foreground hover:border-primary/30'}`} data-testid={`button-toggle-field-${field}`}><span className={`grid h-4 w-4 place-items-center rounded border ${fields.includes(field) ? 'border-primary bg-primary text-white' : 'border-border'}`}>{fields.includes(field) && <Check size={11} />}</span><span className="font-mono text-[11px]">{labels[field]}</span></button>)}</div><div className="mt-6 rounded-xl bg-[#f7f3e9] p-3.5 text-xs leading-5 text-[#7c6844]"><Info size={14} className="mb-1.5 text-[#a17c35]" /><span>Los valores se sustituyen con tokens consistentes, preservando el formato útil para QA.</span></div><button disabled={!sourceId || fields.length === 0 || previewMutation.isPending} onClick={runPreview} className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#173d45] text-xs font-bold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60" data-testid="button-run-masking-preview">{previewMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={14} />} Generar preview <ArrowRight size={14} /></button>{isAdmin && <button disabled={!sourceId || fields.length === 0 || createMutation.isPending} onClick={handleCreate} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#173d45] bg-white text-xs font-bold text-[#173d45] transition-colors hover:bg-[#edf8f4] disabled:cursor-not-allowed disabled:opacity-60" data-testid="button-submit-masking-job">{createMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={14} />} Generar dataset</button>}{createError && <p className="mt-3 text-xs font-semibold text-[#b14e43]" data-testid="error-masking-job">{createError}</p>}</div>
      <div className="min-h-[520px] rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"><div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="label-caps">Resultado seguro</p><h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">{preview ? `${preview.records.toLocaleString('es-ES')} registros preparados` : 'Tu previsualización aparecerá aquí'}</h2></div>{preview && <button onClick={() => setPreview(null)} className="inline-flex items-center gap-1.5 self-start text-xs font-bold text-muted-foreground hover:text-foreground" data-testid="button-reset-masking-preview"><RotateCcw size={13} /> Limpiar</button>}</div>{previewMutation.isError ? <div className="flex h-[410px] items-center justify-center p-8 text-center"><div><EyeOff className="mx-auto mb-3 text-[#bf5a4e]" size={28} /><p className="font-display font-bold">No pudimos generar la preview</p><p className="mt-1 text-sm text-muted-foreground">Revisa la fuente y vuelve a intentarlo.</p></div></div> : preview ? <div className="overflow-x-auto p-5"><div className="mb-4 flex items-center gap-2 text-xs text-primary"><span className="h-2 w-2 rounded-full bg-primary" /> Campos anonimizados: {preview.maskedFields.join(', ')}</div><table className="w-full min-w-[560px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-border text-left"><thead><tr className="bg-[#f5f8f8]">{Object.keys(preview.rows[0] ?? {}).map((key) => <th className="border-b border-border px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground" key={key}>{key}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr className="group" key={index}>{Object.entries(row).map(([key, value]) => <td className={`border-b border-border/70 px-4 py-3 font-mono text-xs last:border-0 ${preview.maskedFields.includes(key) ? 'text-[#247c6c]' : 'text-muted-foreground'}`} key={key}>{preview.maskedFields.includes(key) && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#5db69f] align-middle" />}{value}</td>)}</tr>)}</tbody></table></div> : <div className="flex h-[410px] items-center justify-center p-8 text-center"><div className="max-w-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#edf8f4] text-[#237b6c]"><Braces size={25} /></div><p className="mt-5 font-display text-lg font-bold">Datos reales, riesgo cero</p><p className="mt-2 text-sm leading-6 text-muted-foreground">Elige una fuente y los campos sensibles. Verás una muestra enmascarada lista para validar tus pruebas.</p></div></div>}</div>
    </div>

    <div className="mt-12 rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]" data-testid="masking-history">
      <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="label-caps">Historial de jobs</p>
          <h2 className="mt-1 font-display text-lg font-bold tracking-[-0.03em]">{jobs.length} datasets generados</h2>
        </div>
        <button onClick={handleInvalidate} disabled={listQuery.isRefetching} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-60" data-testid="button-refresh-masking-jobs">
          <RefreshCw size={14} className={listQuery.isRefetching ? 'animate-spin' : ''} />
          Actualizar
        </button>
      </div>
      {listQuery.isLoading ? (
        <div className="border-t border-border p-5">
          {[1, 2, 3].map((row) => (
            <div className="flex gap-3 border-b border-border py-5 last:border-0" key={row}>
              <div className="skeleton h-10 w-10 rounded-xl" />
              <div className="flex-1">
                <div className="skeleton h-4 w-1/3 rounded" />
                <div className="mt-2 skeleton h-3 w-1/4 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : listQuery.isError ? (
        <div className="rounded-xl border border-[#edc5bd] bg-[#fff8f6] mt-5 p-10 text-center">
          <p className="font-display font-bold">No pudimos cargar el historial de jobs.</p>
          <button onClick={() => listQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-masking-jobs">
            Reintentar
          </button>
        </div>
      ) : jobs.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Fingerprint className="mx-auto mb-3 text-muted-foreground/50" size={30} />
          <p className="font-display text-lg font-bold">Tu historial empieza aquí</p>
          <p className="mt-1 text-sm text-muted-foreground">Genera un dataset desde el panel de configuración para preparar datos de prueba anonimizados.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border-t border-border">
            <div className="hidden grid-cols-[1.3fr_1fr_1.2fr_1fr_1.3fr_.9fr] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid">
              <span>ID</span>
              <span>Estado</span>
              <span>Campos</span>
              <span>Registros</span>
              <span>Creado</span>
              <span />
            </div>
            {pagedJobs.map((job) => (
              <div
                key={job.id}
                className="group grid gap-4 border-b border-border/70 px-5 py-5 last:border-0 md:grid-cols-[1.3fr_1fr_1.2fr_1fr_1.3fr_.9fr] md:items-center"
                data-testid={`row-masking-job-${job.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium" title={job.id}>{job.id}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{sourceName(job.sourceId)}</p>
                </div>
                <StatusBadge value={job.status} kind="scan" />
                <div>
                  <p className="font-mono text-[11px]">{job.fields.map((field) => labels[field] ?? field).join(', ')}</p>
                </div>
                <div>
                  <p className="font-mono text-xs font-medium">{job.records?.toLocaleString('es-ES') ?? '—'}</p>
                </div>
                <div>
                  <p className="font-mono text-xs font-medium">{formatDateTime(job.createdAt)}</p>
                </div>
                <div className="text-right">
                  <button
                    onClick={() => setSelectedJobId(job.id)}
                    className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                    data-testid={`button-view-masking-job-${job.id}`}
                  >
                    Ver detalle <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Página {page} de {totalPages} · {jobs.length} jobs</p>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-prev-page"
                >
                  Anterior
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-next-page"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>

    {selectedJob && <JobDetailDrawer job={selectedJob} onClose={() => setSelectedJobId(null)} />}
  </section>
  );
}