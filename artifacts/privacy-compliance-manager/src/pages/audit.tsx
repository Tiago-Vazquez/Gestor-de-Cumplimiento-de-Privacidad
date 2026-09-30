import { CircleHelp, History } from 'lucide-react';
import { useState } from 'react';
import { getListAuditEventsQueryKey, useListAuditEvents } from '@workspace/api-client-react';
import type { AuditEvent } from '@workspace/api-client-react';
import { PageHeading } from '@/components/app-shell';
import { useAuth } from '@/auth/auth-context';

const ACTION_OPTIONS = [
  'login_success', 'login_failure', 'logout', 'logout_all', 'session_revoked',
  'password_changed', 'user_updated', 'user_roles_updated', 'source_created',
  'source_updated', 'source_deleted', 'schedule_created', 'schedule_updated',
  'schedule_enabled', 'schedule_disabled', 'scan_started', 'scan_cancelled',
  'scan_failed', 'report_created', 'report_downloaded', 'masking_job_created',
  'dataset_downloaded', 'rule_enabled', 'rule_disabled',
];

const RESOURCE_OPTIONS = [
  'session', 'user', 'source', 'schedule', 'scan', 'report', 'masking_job', 'rule',
];

const PAGE_SIZE = 25;

const formatDateTime = (value: string) => {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '—';
  }
};

/** Guardia de UI: la protección real la aplica el backend (requireRole admin). */
function AdminGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user?.roles.includes('admin')) {
    return (
      <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
        <PageHeading eyebrow="Administración" title="Auditoría" />
        <div className="rounded-2xl border border-card-border bg-card p-12 text-center shadow-[var(--shadow-card)]">
          <CircleHelp className="mx-auto mb-3 text-[#bf5a4e]" />
          <p className="font-display font-bold">No tienes permisos de administración.</p>
          <p className="mt-1 text-sm text-muted-foreground">Esta sección requiere el rol admin.</p>
        </div>
      </section>
    );
  }
  return children;
}

function AuditAdmin() {
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [result, setResult] = useState<'success' | 'failure' | ''>('');
  const [actor, setActor] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [page, setPage] = useState(1);

  const params = {
    action: action || undefined,
    resourceType: resourceType || undefined,
    result: result || undefined,
    actor: actor || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const auditQuery = useListAuditEvents(params, {
    query: { queryKey: getListAuditEventsQueryKey(params) },
  });

  const applyActor = () => {
    setActor(actorInput.trim());
    setPage(1);
  };

  const resetFilters = () => {
    setAction('');
    setResourceType('');
    setResult('');
    setActor('');
    setActorInput('');
    setPage(1);
  };

  const events = auditQuery.data ?? [];

  return (
    <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
      <PageHeading
        eyebrow="Administración"
        title="Auditoría"
        description="Quién hizo qué, cuándo y sobre qué recurso. Los eventos más recientes aparecen primero."
      />

      <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-card-border bg-card p-3 shadow-[var(--shadow-card)] md:flex-row md:items-center md:flex-wrap">
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setPage(1);
          }}
          className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary"
          data-testid="select-audit-action"
        >
          <option value="">Todas las acciones</option>
          {ACTION_OPTIONS.map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </select>
        <select
          value={resourceType}
          onChange={(event) => {
            setResourceType(event.target.value);
            setPage(1);
          }}
          className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary"
          data-testid="select-audit-resource"
        >
          <option value="">Todos los recursos</option>
          {RESOURCE_OPTIONS.map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </select>
        <select
          value={result}
          onChange={(event) => {
            setResult(event.target.value as typeof result);
            setPage(1);
          }}
          className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:border-primary"
          data-testid="select-audit-result"
        >
          <option value="">Todos los resultados</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
        <div className="flex flex-1 items-center gap-2">
          <input
            value={actorInput}
            onChange={(event) => setActorInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyActor();
            }}
            placeholder="Actor (sub del usuario)"
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            data-testid="input-audit-actor"
          />
          <button
            onClick={applyActor}
            className="h-10 shrink-0 rounded-lg border border-border px-4 text-xs font-bold hover:border-primary"
            data-testid="button-apply-audit-filters"
          >
            Aplicar
          </button>
        </div>
        <button
          onClick={resetFilters}
          className="text-xs font-bold text-primary underline"
          data-testid="button-clear-audit-filters"
        >
          Limpiar filtros
        </button>
      </div>

      {auditQuery.isLoading ? (
        <div className="rounded-2xl border border-card-border bg-card p-5" data-testid="audit-loading">
          {[1, 2, 3].map((row) => (
            <div className="flex gap-4 border-b border-border py-5 last:border-0" key={row}>
              <div className="skeleton h-4 w-1/3 rounded" />
              <div className="skeleton h-4 w-1/4 rounded" />
            </div>
          ))}
        </div>
      ) : auditQuery.isError ? (
        <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-10 text-center" data-testid="audit-error">
          <History className="mx-auto mb-3 text-[#bf5a4e]" />
          <p className="font-display font-bold">No pudimos cargar los eventos de auditoría.</p>
          <button
            onClick={() => auditQuery.refetch()}
            className="mt-4 text-xs font-bold text-primary underline"
            data-testid="button-retry-audit"
          >
            Reintentar
          </button>
        </div>
      ) : events.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center"
          data-testid="audit-empty"
        >
          <History className="mx-auto mb-3 text-muted-foreground/45" size={30} />
          <p className="font-display text-lg font-bold">Sin eventos para estos filtros</p>
          <p className="mt-1 text-sm text-muted-foreground">Prueba con otra combinación o limpia los filtros.</p>
        </div>
      ) : (
        <>
          <div
            className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"
            data-testid="audit-list"
          >
            <div className="hidden grid-cols-[1.2fr_1fr_.7fr_.9fr_.8fr] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid">
              <span>Acción</span>
              <span>Recurso</span>
              <span>Resultado</span>
              <span>Actor</span>
              <span>Fecha</span>
            </div>
            {events.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-muted-foreground" data-testid="audit-page-info">
              Página {page}
              {events.length === PAGE_SIZE ? '' : ' · fin de resultados'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
                className="rounded-lg border border-border px-4 py-2 text-xs font-bold disabled:opacity-50"
                data-testid="button-audit-prev"
              >
                Anterior
              </button>
              <button
                onClick={() => setPage((current) => current + 1)}
                disabled={events.length < PAGE_SIZE}
                className="rounded-lg border border-border px-4 py-2 text-xs font-bold disabled:opacity-50"
                data-testid="button-audit-next"
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const metadataEntries = Object.entries(event.metadata ?? {});
  return (
    <div
      className="grid grid-cols-1 gap-2 border-b border-border/70 px-5 py-4 text-left last:border-0 md:grid-cols-[1.2fr_1fr_.7fr_.9fr_.8fr] md:items-center md:gap-4"
      data-testid={`row-audit-${event.id}`}
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-xs font-bold" data-testid={`audit-action-${event.id}`}>
          {event.action}
        </p>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" data-testid={`audit-id-${event.id}`}>
          {event.id}
        </p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold" data-testid={`audit-resource-${event.id}`}>
          {event.resourceType}
          {event.resourceId ? ` / ${event.resourceId}` : ''}
        </p>
        {event.requestId && (
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" data-testid={`audit-request-${event.id}`}>
            {event.requestId}
          </p>
        )}
      </div>
      <div>
        <span
          className={`inline-flex rounded-lg border px-2.5 py-1.5 font-mono text-[11px] font-bold ${event.result === 'success' ? 'border-[#bfe0d6] bg-[#e4f2ef] text-[#1d6a5c]' : 'border-[#edc5bd] bg-[#fdf0ee] text-[#a3453a]'}`}
          data-testid={`audit-result-${event.id}`}
        >
          {event.result}
        </span>
      </div>
      <div className="min-w-0">
        <p className="truncate font-mono text-[11px]" data-testid={`audit-actor-${event.id}`}>
          {event.actorUserId ?? 'sistema'}
        </p>
        {metadataEntries.length > 0 && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground" data-testid={`audit-metadata-${event.id}`}>
            {metadataEntries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}
          </p>
        )}
      </div>
      <div>
        <p className="text-xs font-medium" data-testid={`audit-date-${event.id}`}>
          {formatDateTime(event.createdAt)}
        </p>
      </div>
    </div>
  );
}

export default function AuditPage() {
  return (
    <AdminGate>
      <AuditAdmin />
    </AdminGate>
  );
}
