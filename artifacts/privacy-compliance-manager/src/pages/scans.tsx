import { ArrowRight, History, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Drawer } from 'vaul';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListScansQueryKey,
  getGetScanQueryKey,
  useCancelScan,
  useGetScan,
  useListScans,
} from '@workspace/api-client-react';
import type { ListScansStatus, Scan } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { toast } from '@/hooks/use-toast';

const STATUS_OPTIONS: { value: ListScansStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'queued', label: 'En cola' },
  { value: 'running', label: 'En curso' },
  { value: 'completed', label: 'Completados' },
  { value: 'failed', label: 'Fallidos' },
];

const PAGE_SIZE = 10;

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '\u2014';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '\u2014';
  }
};

const formatDuration = (startedAt: string, completedAt?: string | null) => {
  try {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } catch {
    return '\u2014';
  }
};

function ScanDetailDrawer({ scanId, onClose }: { scanId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const detailQuery = useGetScan(scanId, {
    query: {
      queryKey: getGetScanQueryKey(scanId),
      refetchInterval: (query) => {
        const data = query.state.data;
        return data && (data.status === 'running' || data.status === 'queued') ? 5_000 : false;
      },
    },
  });
  const cancelMutation = useCancelScan({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Cancelaci�n solicitada', description: 'El escaneo se detendr� en el pr�ximo punto de control.' });
        queryClient.invalidateQueries({ queryKey: getGetScanQueryKey(scanId) });
        queryClient.invalidateQueries({ queryKey: getListScansQueryKey() });
      },
    },
  });

  const scan = detailQuery.data;
  const canCancel = isAdmin && scan?.status === 'running';

  return (
    <Drawer.Root open={true} onClose={onClose}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40" />
        <Drawer.Content className="fixed bottom-0 right-0 top-0 flex w-full max-w-md flex-col border-l border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <History size={18} className="text-primary" />
              <Drawer.Title className="font-display text-lg font-bold">Detalle del escaneo</Drawer.Title>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Cerrar"
              data-testid="button-close-drawer"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {detailQuery.isLoading ? (
              <div className="flex items-center justify-center py-10">
                <LoaderCircle size={24} className="animate-spin text-primary" />
              </div>
            ) : detailQuery.isError || !scan ? (
              <div className="rounded-xl border border-[#edc5bd] bg-[#fff8f6] p-6 text-center">
                <p className="font-display font-bold">No se pudo cargar el detalle</p>
                <button
                  onClick={() => detailQuery.refetch()}
                  className="mt-3 text-xs font-bold text-primary underline"
                  data-testid="button-retry-detail"
                >
                  Reintentar
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <StatusBadge value={scan.status} kind="scan" />
                  {canCancel && (
                    <button
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate({ id: scan.id })}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#edc5bd] bg-[#fff8f6] px-3 py-1.5 text-xs font-bold text-[#bf5a4e] transition-colors hover:bg-[#f8e8e5] disabled:cursor-wait disabled:opacity-60"
                      data-testid="button-cancel-scan"
                    >
                      {cancelMutation.isPending ? (
                        <LoaderCircle size={13} className="animate-spin" />
                      ) : (
                        <X size={13} />
                      )}
                      Cancelar escaneo
                    </button>
                  )}
                </div>
                {cancelMutation.isError && (
                  <div className="rounded-lg border border-[#edc5bd] bg-[#fff8f6] p-3 text-xs text-[#bf5a4e]" data-testid="error-cancel">
                    No se pudo solicitar la cancelaci\u00f3n. Reintenta en unos instantes.
                  </div>
                )}
                <div className="rounded-xl border border-card-border bg-card p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">ID</p>
                  <p className="mt-1 font-mono text-xs text-foreground break-all" data-testid="detail-scan-id">{scan.id}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Inicio</p>
                    <p className="mt-1 text-xs font-medium">{formatDateTime(scan.startedAt)}</p>
                  </div>
                  <div className="rounded-xl border border-card-border bg-card p-4">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Fin</p>
                    <p className="mt-1 text-xs font-medium">{formatDateTime(scan.completedAt)}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-card-border bg-card p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Duraci\u00f3n</p>
                  <p className="mt-1 text-xs font-medium">{formatDuration(scan.startedAt, scan.completedAt)}</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-card-border bg-card p-4 text-center">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Tablas</p>
                    <p className="mt-1 font-display text-lg font-bold">{scan.tablesScanned.toLocaleString('es-ES')}</p>
                  </div>
                  <div className="rounded-xl border border-card-border bg-card p-4 text-center">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Registros</p>
                    <p className="mt-1 font-display text-lg font-bold">{scan.recordsRead.toLocaleString('es-ES')}</p>
                  </div>
                  <div className="rounded-xl border border-card-border bg-card p-4 text-center">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Hallazgos</p>
                    <p className="mt-1 font-display text-lg font-bold">{(scan.findingsCreated ?? 0).toLocaleString('es-ES')}</p>
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

export default function ScansPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ListScansStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);

  const limit = PAGE_SIZE;
  const offset = (page - 1) * PAGE_SIZE;
  const params = {
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
    limit,
    offset,
  };

  const listQuery = useListScans(params, {
    query: {
      queryKey: getListScansQueryKey(params),
      refetchInterval: 5_000,
    },
  });

  const scans = listQuery.data ?? [];
  const totalPages = Math.max(1, Math.ceil(scans.length / PAGE_SIZE));
  const pagedScans = scans.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleFilterChange = (newStatus: ListScansStatus | 'all') => {
    setStatusFilter(newStatus);
    setPage(1);
  };

  const handleInvalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListScansQueryKey(params) });
    if (selectedScanId) {
      queryClient.invalidateQueries({ queryKey: getGetScanQueryKey(selectedScanId) });
    }
  };

  return (
    <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
      <PageHeading
        eyebrow="Historial de ejecuciones"
        title="Escaneos"
        description="Registro completo de ejecuciones del motor de escaneo, con detalle y cancelaci\u00f3n cooperativa."
        action={
          <button
            onClick={handleInvalidate}
            disabled={listQuery.isRefetching}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-60"
            data-testid="button-refresh-scans"
          >
            <RefreshCw size={14} className={listQuery.isRefetching ? 'animate-spin' : ''} />
            Actualizar
          </button>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2" data-testid="filter-status">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => handleFilterChange(option.value)}
            className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
              statusFilter === option.value
                ? 'bg-foreground text-background'
                : 'border border-border bg-card text-muted-foreground hover:border-primary hover:text-primary'
            }`}
            data-testid={`filter-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {listQuery.isLoading ? (
        <div className="rounded-2xl border border-card-border bg-card p-5">
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
        <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-10 text-center">
          <p className="font-display font-bold">No pudimos cargar el historial de escaneos.</p>
          <button
            onClick={() => listQuery.refetch()}
            className="mt-4 text-xs font-bold text-primary underline"
            data-testid="button-retry-scans"
          >
            Reintentar
          </button>
        </div>
      ) : scans.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <History className="mx-auto mb-3 text-muted-foreground/50" size={30} />
          <p className="font-display text-lg font-bold">Sin escaneos registrados</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {statusFilter !== 'all'
              ? 'No hay escaneos con el filtro seleccionado.'
              : 'Cuando el motor ejecute escaneos aparecer\u00e1n aqu\u00ed.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]">
            <div className="hidden grid-cols-[1.4fr_1fr_1fr_1fr_.8fr] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid">
              <span>ID</span>
              <span>Estado</span>
              <span>Inicio</span>
              <span>Duraci\u00f3n</span>
              <span />
            </div>
            {pagedScans.map((scan) => (
              <div
                key={scan.id}
                className="group grid gap-4 border-b border-border/70 px-5 py-5 last:border-0 md:grid-cols-[1.4fr_1fr_1fr_1fr_.8fr] md:items-center"
                data-testid={`row-scan-${scan.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium" title={scan.id}>{scan.id}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {scan.tablesScanned} tablas \u00b7 {scan.recordsRead.toLocaleString('es-ES')} registros \u00b7 {scan.findingsCreated ?? 0} hallazgos
                  </p>
                </div>
                <StatusBadge value={scan.status} kind="scan" />
                <div>
                  <p className="font-mono text-xs font-medium">{formatDateTime(scan.startedAt)}</p>
                </div>
                <div>
                  <p className="font-mono text-xs font-medium">{formatDuration(scan.startedAt, scan.completedAt)}</p>
                </div>
                <div className="text-right">
                  <button
                    onClick={() => setSelectedScanId(scan.id)}
                    className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                    data-testid={`button-view-scan-${scan.id}`}
                  >
                    Ver detalle <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                P\u00e1gina {page} de {totalPages} \u00b7 {scans.length} escaneos
              </p>
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

      {selectedScanId && (
        <ScanDetailDrawer scanId={selectedScanId} onClose={() => setSelectedScanId(null)} />
      )}
    </section>
  );
}
