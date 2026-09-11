import { Activity, CircleHelp, Filter, Layers3, LoaderCircle, LockKeyhole, Search, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, getListRulesQueryKey, useListRules, useUpdateRule } from '@workspace/api-client-react';
import type { Rule } from '@workspace/api-client-react';
import { PageHeading } from '@/components/app-shell';
import { useAuth } from '@/auth/auth-context';
import { useToast } from '@/hooks/use-toast';

const timeAgo = (value: string) => { const hours = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 3600000)); return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`; };
const describeError = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) {
    const data = error.data as { message?: string; detail?: string } | null;
    const detail = data && typeof data === 'object' ? (data.detail ?? data.message) : undefined;
    if (typeof detail === 'string' && detail !== '') return detail;
    return `${fallback} (HTTP ${error.status} ${error.statusText}).`;
  }
  return error instanceof Error && error.message ? error.message : fallback;
};

/**
 * M7.a — Gobernanza de reglas: el toggle invoca PATCH /rules/{id} con
 * `RuleInput { enabled }` (FASE 7.0.5: `enabled` es el único campo gobernable).
 * El estado mostrado SIEMPRE proviene del backend (`rule.enabled` del listado
 * refrescado tras la mutación), nunca de un estado local permanente.
 */
function RuleRow({ rule, canAdmin }: { rule: Rule; canAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateRule();
  const [rowError, setRowError] = useState<string | null>(null);
  const isToggling = update.isPending;

  const toggle = () => {
    setRowError(null);
    update.mutate(
      { id: rule.id, data: { enabled: !rule.enabled } },
      {
        onSuccess: (updated) => {
          toast({
            title: 'Regla actualizada',
            description: `«${updated.name}» ${updated.enabled ? 'habilitada' : 'deshabilitada'}. El cambio es efectivo en el próximo escaneo.`,
          });
          // El nuevo estado llega del backend vía refetch del listado.
          queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
        },
        onError: (mutationError) => {
          const message = describeError(mutationError, 'No se pudo actualizar la regla. Intentá de nuevo.');
          setRowError(message);
          toast({ title: 'No se pudo actualizar la regla', description: message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4 border-b border-border/70 p-5 last:border-0 md:flex-row md:items-center" data-testid={`row-rule-${rule.id}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${rule.enabled ? 'bg-[#e4f2ef] text-[#237b6c]' : 'bg-muted text-muted-foreground'}`}><Layers3 size={18} /></div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{rule.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{rule.category}</span><span>·</span><span className="font-mono">{rule.regulation}</span></div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6 md:w-[270px] md:grid-cols-2">
        <div><p className="label-caps">Detecciones</p><p className="mt-1 font-mono text-sm font-bold">{rule.detections.toLocaleString('es-ES')}</p></div>
        <div><p className="label-caps">Último disparo</p><p className="mt-1 font-mono text-[11px] font-medium">{timeAgo(rule.lastTriggered)}</p></div>
      </div>
      {canAdmin ? (
        <div className="flex flex-col items-stretch gap-1.5 md:w-[168px] md:items-end">
          <button
            type="button"
            role="switch"
            aria-checked={rule.enabled}
            aria-label={`${rule.enabled ? 'Deshabilitar' : 'Habilitar'} la regla ${rule.name}`}
            aria-busy={isToggling}
            disabled={isToggling}
            onClick={toggle}
            data-testid={`button-toggle-rule-${rule.id}`}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-bold transition-colors disabled:cursor-wait disabled:opacity-60 ${rule.enabled ? 'border-[#bfe0d6] bg-[#e4f2ef] text-[#1d6a5c] hover:border-[#237b6c]' : 'border-border bg-muted text-muted-foreground hover:border-primary/50 hover:text-primary'}`}
          >
            {isToggling ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <span aria-hidden="true" className={`h-2 w-2 rounded-full ${rule.enabled ? 'bg-[#31a886]' : 'bg-muted-foreground/50'}`} />}
            {rule.enabled ? 'Habilitada' : 'Deshabilitada'}
          </button>
          {rowError && <p role="alert" data-testid={`rule-error-${rule.id}`} className="text-right text-[10px] font-bold leading-4 text-[#bb624c]">{rowError}</p>}
        </div>
      ) : (
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60 md:w-[168px] md:text-right" data-testid={`rule-readonly-${rule.id}`}>{rule.enabled ? 'activa · solo lectura' : 'inactiva · solo lectura'}</span>
      )}
    </div>
  );
}

export default function RulesPage() {
  const rulesQuery = useListRules();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const rules = (rulesQuery.data ?? []).filter((rule) => `${rule.name} ${rule.category} ${rule.regulation}`.toLowerCase().includes(search.toLowerCase()));
  const enabledCount = rules.filter((rule) => rule.enabled).length;
  return <section className="page-in mx-auto max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
    <PageHeading eyebrow="Lógica de detección" title="Reglas" description="La capa que traduce señales de datos en decisiones de privacidad." action={<div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-bold text-muted-foreground"><span className="h-2 w-2 rounded-full bg-primary" /> {enabledCount} activas</div>} />
    <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <div className="rounded-2xl border border-[#c9ded9] bg-[#edf8f4] p-6 shadow-[var(--shadow-card)]"><div className="flex items-start justify-between"><div><p className="label-caps text-[#4d7f77]">Motor de protección</p><p className="mt-2 font-display text-[33px] font-bold tracking-[-0.05em] text-[#194b4b]">{(rulesQuery.data ?? []).reduce((sum, rule) => sum + rule.detections, 0).toLocaleString('es-ES')}</p><p className="mt-1 text-sm text-[#4d7f77]">detecciones acumuladas por las reglas activas</p></div><div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#d4eee6] text-[#237b6c]"><Activity size={21} /></div></div><div className="mt-6 flex items-center gap-2 text-xs font-semibold text-[#237b6c]"><ShieldCheck size={14} /> Evaluación continua en cada fuente</div></div>
      <div className="rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]"><p className="label-caps">Alcance regulatorio</p><div className="mt-4 flex flex-wrap gap-2">{['GDPR', 'LOPDGDD', 'PCI DSS', 'HIPAA'].map((item) => <span className="rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-[11px] font-medium" key={item}>{item}</span>)}</div><p className="mt-5 text-xs leading-5 text-muted-foreground">Cada regla conserva su contexto para acelerar la revisión y la evidencia.</p></div>
    </div>
    <div className="mt-6 rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between"><div className="relative w-full max-w-sm"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar regla o regulación" className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-xs outline-none focus:border-primary" data-testid="input-search-rules" /></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><Filter size={14} /> {rules.length} reglas visibles</div></div>
      {rulesQuery.isLoading ? <div className="space-y-4 p-5" data-testid="rules-loading">{[1, 2, 3, 4].map((row) => <div className="flex gap-4 border-b border-border pb-4" key={row}><div className="skeleton h-9 w-9 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-1/2 rounded" /><div className="mt-2 skeleton h-3 w-1/3 rounded" /></div></div>)}</div> : rulesQuery.isError ? <div className="p-12 text-center"><CircleHelp className="mx-auto mb-3 text-[#bf5a4e]" /><p className="font-display font-bold">No pudimos cargar las reglas.</p><button onClick={() => rulesQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-rules">Reintentar</button></div> : (rulesQuery.data ?? []).length === 0 ? <div className="p-12 text-center" data-testid="rules-empty"><CircleHelp className="mx-auto mb-3 text-muted-foreground/50" /><p className="font-display font-bold">El catálogo de reglas está vacío</p><p className="mt-1 text-sm text-muted-foreground">Las reglas de detección aparecerán aquí cuando la plataforma las incorpore.</p></div> : rules.length === 0 ? <div className="p-12 text-center text-sm text-muted-foreground" data-testid="rules-no-match">No hay reglas que coincidan con esa búsqueda.</div> : <div>{rules.map((rule) => <RuleRow key={rule.id} rule={rule} canAdmin={isAdmin} />)}</div>}
    </div>
    <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="rules-footer"><LockKeyhole size={13} /> {isAdmin ? 'Habilitá o deshabilitá reglas desde esta pantalla; el cambio se aplica en el próximo escaneo.' : 'Consultá el estado de las reglas; su habilitación está reservada a los administradores.'}</div>
  </section>;
}