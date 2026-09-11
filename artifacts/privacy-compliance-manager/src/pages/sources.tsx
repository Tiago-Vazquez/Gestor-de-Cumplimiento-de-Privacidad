import { useState, type FormEvent } from 'react';
import { CloudCog, Database, HardDrive, LoaderCircle, Pencil, Play, Plus, RefreshCw, Server, ShieldCheck, Table2, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  getGetDashboardQueryKey,
  getGetSourceQueryKey,
  getListScansQueryKey,
  getListSourcesQueryKey,
  SourceCreateEnvironment,
  SourceCreateKind,
  useCreateSource,
  useDeleteSource,
  useGetSource,
  useListSources,
  useStartScan,
  useUpdateSource,
} from '@workspace/api-client-react';
import type { DataSource, SourceConnectionInput, SourceCreate, SourceDetail, SourceUpdate } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import { PageHeading } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

const sourceIcons: Record<string, typeof Database> = { postgresql: Database, mysql: Server, mongodb: CloudCog, snowflake: HardDrive, bigquery: Table2 };
const sourceNames: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', snowflake: 'Snowflake', bigquery: 'BigQuery' };
const relative = (value: string) => { const hours = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 3600000)); return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`; };
const describeError = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) {
    const data = error.data as { message?: string; detail?: string } | null;
    const detail = data && typeof data === 'object' ? (data.detail ?? data.message) : undefined;
    if (typeof detail === 'string' && detail !== '') return detail;
    return `${fallback} (HTTP ${error.status} ${error.statusText}).`;
  }
  return error instanceof Error && error.message ? error.message : fallback;
};

/** Límites copiados del contrato (SourceCreate / SourceConnectionInput / SourceUpdate). */
const MAX_LENGTHS = { name: 256, host: 253, database: 128, user: 128, password: 256, schema: 128 } as const;

interface ConnectionDraft {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  schema: string;
}

interface SourceFormValues {
  name: string;
  kind: string;
  environment: string;
  connection: ConnectionDraft;
}

/**
 * El password es WRITE-ONLY: el estado local nace siempre vacío y nunca se
 * rellena con datos del servidor (el detalle de la fuente no expone la
 * conexión). Un password vacío significa "no enviar el campo".
 */
const emptyConnection = (): ConnectionDraft => ({ host: '', port: '', database: '', user: '', password: '', schema: '' });
const emptyForm = (): SourceFormValues => ({ name: '', kind: 'postgresql', environment: 'production', connection: emptyConnection() });

const hasConnectionInput = (connection: ConnectionDraft) => Object.values(connection).some((value) => value.trim() !== '');

const buildConnectionError = (connection: ConnectionDraft): string | null => {
  const host = connection.host.trim();
  const database = connection.database.trim();
  const user = connection.user.trim();
  const password = connection.password;
  if (host.length > MAX_LENGTHS.host) return `El host no puede superar ${MAX_LENGTHS.host} caracteres.`;
  if (database.length > MAX_LENGTHS.database) return `La base de datos no puede superar ${MAX_LENGTHS.database} caracteres.`;
  if (user.length > MAX_LENGTHS.user) return `El usuario no puede superar ${MAX_LENGTHS.user} caracteres.`;
  if (password.length > MAX_LENGTHS.password) return `La contraseña no puede superar ${MAX_LENGTHS.password} caracteres.`;
  if (connection.schema.trim().length > MAX_LENGTHS.schema) return `El esquema no puede superar ${MAX_LENGTHS.schema} caracteres.`;
  if (connection.port.trim() !== '') {
    const port = Number(connection.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'El puerto debe ser un número entero entre 1 y 65535.';
  }
  if (!host || connection.port.trim() === '' || !database || !user || !password) {
    return 'Para configurar la conexión completá host, puerto, base de datos, usuario y contraseña. La contraseña actual nunca se muestra: ingresá la nueva.';
  }
  return null;
};

const buildConnection = (connection: ConnectionDraft): SourceConnectionInput => {
  const built: SourceConnectionInput = {
    host: connection.host.trim(),
    port: Number(connection.port),
    database: connection.database.trim(),
    user: connection.user.trim(),
    password: connection.password,
  };
  const schema = connection.schema.trim();
  if (schema) built.schema = schema;
  return built;
};

const buildSourceCreate = (values: SourceFormValues): { source: SourceCreate; error: null } | { source: null; error: string } => {
  const name = values.name.trim();
  if (!name) return { source: null, error: 'El nombre es obligatorio.' };
  if (name.length > MAX_LENGTHS.name) return { source: null, error: `El nombre no puede superar ${MAX_LENGTHS.name} caracteres.` };
  const base = { name, kind: values.kind as SourceCreate['kind'], environment: values.environment as SourceCreate['environment'] };
  if (!hasConnectionInput(values.connection)) {
    // Sin credenciales: la fuente se crea como no escaneable (contrato).
    return { source: base, error: null };
  }
  const connectionError = buildConnectionError(values.connection);
  if (connectionError) return { source: null, error: connectionError };
  return { source: { ...base, connection: buildConnection(values.connection) }, error: null };
};

const buildSourceUpdate = (values: SourceFormValues): { source: SourceUpdate; error: null } | { source: null; error: string } => {
  const name = values.name.trim();
  if (!name) return { source: null, error: 'El nombre es obligatorio.' };
  if (name.length > MAX_LENGTHS.name) return { source: null, error: `El nombre no puede superar ${MAX_LENGTHS.name} caracteres.` };
  const update: SourceUpdate = { name, kind: values.kind as SourceUpdate['kind'], environment: values.environment as SourceUpdate['environment'] };
  // Regla crítica: solo se envía `connection` (y con ella el password) si el
  // usuario cargó datos nuevos. Si todos los campos quedan vacíos, el campo no
  // se envía y el backend conserva la configuración existente.
  if (hasConnectionInput(values.connection)) {
    const connectionError = buildConnectionError(values.connection);
    if (connectionError) return { source: null, error: connectionError };
    update.connection = buildConnection(values.connection);
  }
  return { source: update, error: null };
};

const rowActionsGrid = 'group grid gap-4 border-b border-border/70 px-5 py-5 last:border-0 md:grid-cols-[1.55fr_.8fr_.75fr_.72fr_.8fr_190px] md:items-center';
const rowActionButton = 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-60';

function SourceFields({ values, onChange, mode }: { values: SourceFormValues; onChange: (next: SourceFormValues) => void; mode: 'create' | 'edit' }) {
  const setConnection = (patch: Partial<ConnectionDraft>) => onChange({ ...values, connection: { ...values.connection, ...patch } });
  const selectClass = 'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="source-name">Nombre</Label>
          <Input id="source-name" data-testid="input-source-name" value={values.name} onChange={(event) => onChange({ ...values, name: event.target.value })} placeholder="crm-usuarios" maxLength={MAX_LENGTHS.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="source-kind">Motor</Label>
          <select id="source-kind" data-testid="select-source-kind" className={selectClass} value={values.kind} onChange={(event) => onChange({ ...values, kind: event.target.value })}>
            {Object.values(SourceCreateKind).map((kind) => <option key={kind} value={kind}>{sourceNames[kind] ?? kind}</option>)}
          </select>
        </div>
      </div>
      <div className="grid gap-1.5 md:w-1/2">
        <Label htmlFor="source-environment">Entorno</Label>
        <select id="source-environment" data-testid="select-source-environment" className={selectClass} value={values.environment} onChange={(event) => onChange({ ...values, environment: event.target.value })}>
          {Object.values(SourceCreateEnvironment).map((environment) => <option key={environment} value={environment}>{environment}</option>)}
        </select>
      </div>
      <div className="grid gap-3 rounded-xl border border-border bg-[#f8fafb] p-4">
        <div>
          <p className="label-caps">Conexión (opcional)</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'edit'
              ? 'Dejá todos los campos vacíos para conservar la configuración actual. La contraseña guardada nunca se muestra: para rotarla completá la conexión completa con la nueva contraseña.'
              : 'Omitila para crear la fuente sin credenciales (no será escaneable hasta configurarla).'}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="source-host">Host</Label>
            <Input id="source-host" data-testid="input-source-host" value={values.connection.host} onChange={(event) => setConnection({ host: event.target.value })} placeholder="db.interno" maxLength={MAX_LENGTHS.host} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source-port">Puerto</Label>
            <Input id="source-port" data-testid="input-source-port" inputMode="numeric" value={values.connection.port} onChange={(event) => setConnection({ port: event.target.value })} placeholder="5432" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source-database">Base de datos</Label>
            <Input id="source-database" data-testid="input-source-database" value={values.connection.database} onChange={(event) => setConnection({ database: event.target.value })} placeholder="crm" maxLength={MAX_LENGTHS.database} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source-user">Usuario</Label>
            <Input id="source-user" data-testid="input-source-user" value={values.connection.user} onChange={(event) => setConnection({ user: event.target.value })} autoComplete="off" placeholder="auditor" maxLength={MAX_LENGTHS.user} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source-password">Contraseña</Label>
            <Input
              id="source-password"
              data-testid="input-source-password"
              type="password"
              value={values.connection.password}
              onChange={(event) => setConnection({ password: event.target.value })}
              autoComplete="new-password"
              placeholder={mode === 'edit' ? 'vacío = sin cambios' : 'requerida si completás la conexión'}
              maxLength={MAX_LENGTHS.password}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source-schema">Esquema (opcional)</Label>
            <Input id="source-schema" data-testid="input-source-schema" value={values.connection.schema} onChange={(event) => setConnection({ schema: event.target.value })} placeholder="public" maxLength={MAX_LENGTHS.schema} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceCreatePanel({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateSource();
  const [values, setValues] = useState<SourceFormValues>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { source, error: validationError } = buildSourceCreate(values);
    if (validationError || !source) {
      setError(validationError ?? 'Revisá los datos ingresados.');
      return;
    }
    setError(null);
    create.mutate(
      { data: source },
      {
        onSuccess: (created) => {
          toast({ title: 'Fuente creada', description: `«${created.name}» ya aparece en el listado.` });
          queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
          setValues(emptyForm());
          onDone();
        },
        onError: (mutationError) => {
          const message = describeError(mutationError, 'No se pudo crear la fuente. Intentá de nuevo.');
          setError(message);
          toast({ title: 'No se pudo crear la fuente', description: message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className="mb-6 rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]" data-testid="panel-create-source">
      <div className="mb-4">
        <p className="label-caps">Alta de fuente</p>
        <h3 className="mt-1 font-display text-lg font-bold">Conectá una nueva fuente de datos</h3>
        <p className="mt-1 text-xs text-muted-foreground">La contraseña se guarda cifrada y nunca se vuelve a mostrar.</p>
      </div>
      <form onSubmit={handleSubmit} noValidate>
        <SourceFields values={values} onChange={setValues} mode="create" />
        {error && <p role="alert" data-testid="form-error" className="mt-4 text-xs font-bold text-[#bb624c]">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={create.isPending} data-testid="button-cancel-create">Cancelar</Button>
          <Button type="submit" size="sm" disabled={create.isPending} aria-busy={create.isPending} data-testid="button-submit-source">
            {create.isPending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : null} Crear fuente
          </Button>
        </div>
      </form>
    </div>
  );
}

function SourceEditPanel({ sourceId, onDone }: { sourceId: string; onDone: () => void }) {
  const detailQuery = useGetSource(sourceId);
  if (detailQuery.isLoading) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-2xl border border-card-border bg-card p-6 text-sm text-muted-foreground" data-testid="source-edit-loading">
        <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> Cargando la fuente…
      </div>
    );
  }
  if (detailQuery.isError) {
    return (
      <div className="mb-6 rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-6 text-center" data-testid="source-edit-error">
        <p className="text-sm font-bold">No pudimos cargar la fuente.</p>
        <button type="button" onClick={() => detailQuery.refetch()} className="mt-3 text-xs font-bold text-primary underline" data-testid="button-retry-source-detail">Reintentar</button>
      </div>
    );
  }
  if (!detailQuery.data) return null;
  // key={sourceId}: cada fuente monta un formulario fresco, prellenado desde el
  // detalle (que nunca incluye la conexión). El password nace siempre vacío.
  return <SourceEditForm key={sourceId} source={detailQuery.data} onDone={onDone} />;
}

function SourceEditForm({ source, onDone }: { source: SourceDetail; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateSource();
  const [values, setValues] = useState<SourceFormValues>(() => ({
    name: source.name,
    kind: source.kind,
    environment: source.environment,
    connection: emptyConnection(),
  }));
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { source: patch, error: validationError } = buildSourceUpdate(values);
    if (validationError || !patch) {
      setError(validationError ?? 'Revisá los datos ingresados.');
      return;
    }
    setError(null);
    update.mutate(
      { id: source.id, data: patch },
      {
        onSuccess: (updated) => {
          toast({ title: 'Cambios guardados', description: `«${updated.name}» se actualizó correctamente.` });
          queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetSourceQueryKey(source.id) });
          onDone();
        },
        onError: (mutationError) => {
          const message = describeError(mutationError, 'No se pudieron guardar los cambios. Intentá de nuevo.');
          setError(message);
          toast({ title: 'No se pudieron guardar los cambios', description: message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className="mb-6 rounded-2xl border border-card-border bg-card p-6 shadow-[var(--shadow-card)]" data-testid="panel-edit-source">
      <div className="mb-4">
        <p className="label-caps">Editar fuente</p>
        <h3 className="mt-1 font-display text-lg font-bold">{source.name}</h3>
        <p className="mt-1 text-xs text-muted-foreground">La conexión guardada no se muestra; dejándola vacía se conserva tal cual está en el backend.</p>
      </div>
      <form onSubmit={handleSubmit} noValidate>
        <SourceFields values={values} onChange={setValues} mode="edit" />
        {error && <p role="alert" data-testid="form-error" className="mt-4 text-xs font-bold text-[#bb624c]">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={update.isPending} data-testid="button-cancel-edit">Cancelar</Button>
          <Button type="submit" size="sm" disabled={update.isPending} aria-busy={update.isPending} data-testid="button-submit-source">
            {update.isPending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : null} Guardar cambios
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Confirmación de borrado. El backend define el comportamiento en cascada
 * (elimina los escaneos de la fuente; los hallazgos conservan su histórico con
 * la fuente como atribución). El frontend solo informa y confirma.
 */
function DeleteSourceDialog({ source }: { source: DataSource }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const del = useDeleteSource();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirmDelete = () => {
    setServerError(null);
    del.mutate(
      { id: source.id },
      {
        onSuccess: () => {
          toast({ title: 'Fuente eliminada', description: `«${source.name}» se eliminó junto con sus escaneos.` });
          queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
          // Los escaneos de la fuente se eliminan en cascada: refrescar el listado.
          queryClient.invalidateQueries({ queryKey: getListScansQueryKey() });
          setOpen(false);
        },
        onError: (mutationError) => {
          const message = describeError(mutationError, 'No se pudo eliminar la fuente. Intentá de nuevo.');
          setServerError(message);
          toast({ title: 'No se pudo eliminar la fuente', description: message, variant: 'destructive' });
        },
      },
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (del.isPending) return;
        setOpen(next);
        if (!next) setServerError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className={`${rowActionButton} hover:border-[#bb624c] hover:text-[#bb624c]`}
          disabled={del.isPending}
          data-testid={`button-delete-source-${source.id}`}
          aria-haspopup="dialog"
        >
          <Trash2 size={13} aria-hidden="true" /> Eliminar
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle data-testid="dialog-delete-title">¿Eliminar la fuente «{source.name}»?</AlertDialogTitle>
          <AlertDialogDescription data-testid="dialog-delete-description">
            Esta acción no se puede deshacer. Eliminar una fuente puede eliminar datos relacionados según el comportamiento del backend: se borran sus escaneos y los hallazgos asociados pierden la atribución a la fuente.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {serverError && <p role="alert" data-testid="dialog-delete-error" className="text-xs font-bold text-[#bb624c]">{serverError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete">Cancelar</AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-delete"
            disabled={del.isPending}
            aria-busy={del.isPending}
            onClick={(event) => {
              // preventDefault: el diálogo solo se cierra cuando el backend confirma.
              event.preventDefault();
              confirmDelete();
            }}
          >
            {del.isPending ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : null} Sí, eliminar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SourceRow({ source, canAdmin, onEdit }: { source: DataSource; canAdmin: boolean; onEdit: (sourceId: string) => void }) {
  const queryClient = useQueryClient();
  const scan = useStartScan();
  const Icon = sourceIcons[source.kind] ?? Database;
  const scanSource = () => scan.mutate({ data: { sourceId: source.id } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListSourcesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } });
  return <div className={rowActionsGrid} data-testid={`row-source-${source.id}`}>
    <div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e9eef5] text-[#45617d]"><Icon size={19} /></div><div className="min-w-0"><p className="truncate text-sm font-bold">{source.name}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span>{sourceNames[source.kind] ?? source.kind}</span><span>·</span><span>{source.tables} tablas</span></p></div></div>
    <StatusBadge value={source.environment} kind="generic" />
    <StatusBadge value={source.status} kind="status" />
    <div><p className="font-mono text-xs font-medium">{source.records.toLocaleString('es-ES')}</p><p className="mt-1 text-[10px] text-muted-foreground">registros</p></div>
    <div><p className={`font-mono text-xs font-medium ${source.findings > 0 ? 'text-[#bb624c]' : 'text-primary'}`}>{source.findings}</p><p className="mt-1 text-[10px] text-muted-foreground">hallazgos · {relative(source.lastScanAt)}</p></div>
    {canAdmin ? <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
      <button disabled={scan.isPending} onClick={scanSource} className={rowActionButton} data-testid={`button-scan-source-${source.id}`}>{scan.isPending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} Escanear</button>
      <button type="button" onClick={() => onEdit(source.id)} className={rowActionButton} data-testid={`button-edit-source-${source.id}`} aria-haspopup="dialog"><Pencil size={13} aria-hidden="true" /> Editar</button>
      <DeleteSourceDialog source={source} />
    </div> : <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">solo lectura</span>}
  </div>;
}

export default function SourcesPage() {
  const sourcesQuery = useListSources();
  const { isAdmin } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
    <PageHeading eyebrow="Superficie de datos" title="Fuentes monitorizadas" description="Conexiones bajo vigilancia continua, con una acción de escaneo a un clic." action={<div className="flex flex-wrap items-center gap-2">
      {isAdmin && <Button size="sm" onClick={() => { setCreateOpen(true); setEditingId(null); }} data-testid="button-new-source" aria-haspopup="dialog"><Plus size={14} aria-hidden="true" /> Nueva fuente</Button>}
      <div className="flex items-center gap-2 rounded-xl border border-[#c9ded9] bg-[#edf8f4] px-3 py-2.5 text-xs font-bold text-[#267a6d]"><span className="h-2 w-2 rounded-full bg-[#31a886]" /> {sourcesQuery.data?.length ?? 0} conectadas</div>
    </div>} />
    {createOpen && isAdmin && <SourceCreatePanel onDone={() => setCreateOpen(false)} />}
    {editingId !== null && isAdmin && <SourceEditPanel sourceId={editingId} onDone={() => setEditingId(null)} />}
    <div className="mb-6 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Cobertura total</p><p className="mt-2 font-display text-2xl font-bold">{coverage === null ? '—' : `${coverage}%`}</p><p className="mt-1 text-xs text-muted-foreground">{coverage === null ? 'sin fuentes conectadas' : `${scannedRecently} de ${sources.length} fuentes con escaneo en los últimos 7 días`}</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Registros bajo control</p><p className="mt-2 font-display text-2xl font-bold">{sources.reduce((sum, source) => sum + source.records, 0).toLocaleString('es-ES')}</p><p className="mt-1 text-xs text-muted-foreground">entre todos los entornos</p></div><div className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-card)]"><p className="label-caps">Última actualización</p><p className="mt-2 font-display text-2xl font-bold">{lastScanAt ? relative(lastScanAt) : '—'}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-primary"><RefreshCw size={12} /> último scan registrado en la conexión</p></div></div>
    {sourcesQuery.isLoading ? <div className="rounded-2xl border border-card-border bg-card p-5" data-testid="sources-loading">{[1, 2, 3].map((row) => <div className="flex gap-3 border-b border-border py-5" key={row}><div className="skeleton h-10 w-10 rounded-xl" /><div className="flex-1"><div className="skeleton h-4 w-1/3 rounded" /><div className="mt-2 skeleton h-3 w-1/4 rounded" /></div></div>)}</div> : sourcesQuery.isError ? <div className="rounded-2xl border border-[#edc5bd] bg-[#fff8f6] p-10 text-center" data-testid="list-error" role="alert"><p className="font-display font-bold">No pudimos conectar con las fuentes.</p><button onClick={() => sourcesQuery.refetch()} className="mt-4 text-xs font-bold text-primary underline" data-testid="button-retry-sources">Reintentar</button></div> : sourcesQuery.data?.length ? <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--shadow-card)]"><div className="hidden grid-cols-[1.55fr_.8fr_.75fr_.72fr_.8fr_190px] gap-4 border-b border-border bg-[#f8fafb] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>Fuente</span><span>Entorno</span><span>Estado</span><span>Registros</span><span>Hallazgos</span><span /></div>{sourcesQuery.data.map((source) => <SourceRow key={source.id} source={source} canAdmin={isAdmin} onEdit={setEditingId} />)}</div> : <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center" data-testid="empty-state"><ShieldCheck className="mx-auto mb-3 text-muted-foreground/50" size={30} /><p className="font-display text-lg font-bold">Aún no hay fuentes conectadas</p><p className="mt-1 text-sm text-muted-foreground">Cuando añadas una conexión aparecerá aquí su cobertura.</p></div>}
  </section>;
}