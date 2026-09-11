import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getGetDashboardQueryKey,
  getGetSourceQueryKey,
  getListScansQueryKey,
  getListSourcesQueryKey,
  useCreateSource,
  useDeleteSource,
  useGetSource,
  useListSources,
  useStartScan,
  useUpdateSource,
} from '@workspace/api-client-react';
import type { DataSource, SourceCreate, SourceDetail, SourceUpdate } from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { useAuth } from '@/auth/auth-context';
import SourcesPage from './sources';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useListSources: vi.fn(),
    useGetSource: vi.fn(),
    useCreateSource: vi.fn(),
    useUpdateSource: vi.fn(),
    useDeleteSource: vi.fn(),
    useStartScan: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/auth-context')>();
  return { ...actual, useAuth: vi.fn(() => authMockValue) };
});

const mockedUseListSources = vi.mocked(useListSources);
const mockedUseGetSource = vi.mocked(useGetSource);
const mockedUseCreateSource = vi.mocked(useCreateSource);
const mockedUseUpdateSource = vi.mocked(useUpdateSource);
const mockedUseDeleteSource = vi.mocked(useDeleteSource);
const mockedUseStartScan = vi.mocked(useStartScan);

let authMockValue: { isAdmin: boolean };

const buildMutation = <TVariables, TResult>(options: {
  mutate: (variables: TVariables, callbacks?: { onSuccess: (data: TResult) => void; onError: (error: unknown) => void }) => void;
  isPending?: boolean;
}) =>
  ({
    isPending: options.isPending ?? false,
    isError: false,
    isSuccess: false,
    error: null,
    mutate: options.mutate,
  }) as never;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Construye un ApiError igual al que produce customFetch ante un fallo del servidor. */
const serverError = (status: number, statusText: string, message: string, method: string) =>
  new ApiError(new Response(null, { status, statusText }), { message }, { method, url: '/api/sources' });


const sourcesFixture: DataSource[] = [
  { id: 'src-1', name: 'crm-usuarios', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 34, records: 120000, findings: 12, lastScanAt: '2026-11-09T10:00:00.000Z' },
  { id: 'src-2', name: 'erp-finanzas', kind: 'mysql', environment: 'staging', status: 'offline', tables: 18, records: 8000, findings: 0, lastScanAt: '2026-11-01T08:00:00.000Z' },
];

const sourceDetailFixture: SourceDetail = {
  id: 'src-1',
  name: 'crm-usuarios',
  kind: 'postgresql',
  environment: 'production',
  status: 'healthy',
  tables: 34,
  records: 120000,
  findings: 12,
  lastScanAt: '2026-11-09T10:00:00.000Z',
  scannable: true,
};

const createSuccessBody: SourceCreate = {
  name: 'crm-usuarios',
  kind: 'postgresql',
  environment: 'production',
  connection: { host: 'db.interno', port: 5432, database: 'crm', user: 'auditor', password: 's3cret-pass' },
};


/** Configura los mocks de queries/mutaciones y renderiza la página con el Toaster. */
function arrange({ isAdmin = true, sources = sourcesFixture, listState = 'success' }: { isAdmin?: boolean; sources?: DataSource[]; listState?: 'loading' | 'error' | 'success' } = {}) {
  authMockValue = { isAdmin };
  const listQuery = listState === 'error'
    ? { isLoading: false, isError: true, error: new Error('boom'), refetch: vi.fn() }
    : listState === 'loading'
      ? { isLoading: true, isError: false, error: null, refetch: vi.fn() }
      : { isLoading: false, isError: false, error: null, refetch: vi.fn() };
  mockedUseListSources.mockReturnValue({ data: listState === 'success' ? sources : undefined, ...listQuery } as never);
  mockedUseGetSource.mockReturnValue({ data: sourceDetailFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() } as never);
  mockedUseCreateSource.mockReturnValue(
    buildMutation<{ data: SourceCreate }, SourceDetail>({
      mutate: (variables, callbacks) => callbacks?.onSuccess({ ...sourceDetailFixture, name: variables.data.name }),
    }),
  );
  mockedUseUpdateSource.mockReturnValue(
    buildMutation<{ id: string; data: SourceUpdate }, SourceDetail>({
      mutate: (variables, callbacks) => callbacks?.onSuccess({ ...sourceDetailFixture, ...variables.data }),
    }),
  );
  mockedUseDeleteSource.mockReturnValue(buildMutation<string, void>({ mutate: (_id, callbacks) => callbacks?.onSuccess(undefined) }));
  mockedUseStartScan.mockReturnValue(buildMutation<{ sourceId: string }, { scanId: string }>({ mutate: (_data, callbacks) => callbacks?.onSuccess({ scanId: 'scan-new' }) }));
  render(
    <QueryClientProvider client={queryClient}>
      <SourcesPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

const openCreateForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('button-new-source'));
  return screen.getByTestId('panel-create-source');
};

const fillCreateForm = async (user: ReturnType<typeof userEvent.setup>, overrides: Record<string, string> = {}) => {
  const values: Record<string, string> = {
    'input-source-name': 'crm-usuarios',
    'input-source-host': 'db.interno',
    'input-source-port': '5432',
    'input-source-database': 'crm',
    'input-source-user': 'auditor',
    'input-source-password': 's3cret-pass',
    ...overrides,
  };
  for (const [testId, value] of Object.entries(values)) {
    if (value === '') await user.clear(screen.getByTestId(testId));
    else await user.type(screen.getByTestId(testId), value);
  }
};

const openEditForm = async (user: ReturnType<typeof userEvent.setup>, sourceId = 'src-1') => {
  await user.click(screen.getByTestId(`button-edit-source-${sourceId}`));
  await screen.findByTestId('panel-edit-source');
  return screen.getByTestId('panel-edit-source');
};

const openDeleteDialog = async (user: ReturnType<typeof userEvent.setup>, sourceId = 'src-1') => {
  await user.click(screen.getByTestId(`button-delete-source-${sourceId}`));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByTestId('dialog-delete-title')).toHaveTextContent('crm-usuarios');
  return dialog;
};

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  authMockValue = { isAdmin: true };
});

describe('SourcesPage — listado', () => {
  it('1. muestra skeletons mientras el listado carga', () => {
    arrange({ listState: 'loading' });
    expect(screen.getByTestId('sources-loading')).toBeInTheDocument();
  });

  it('2. error del listado + retry', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    authMockValue = { isAdmin: true };
    mockedUseListSources.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch } as never);
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('list-error')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-retry-sources'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('3. empty state cuando no hay fuentes', () => {
    arrange({ sources: [] });
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText('Aún no hay fuentes conectadas')).toBeInTheDocument();
  });

  it('4. listado de fuentes', () => {
    arrange();
    expect(screen.getByTestId('row-source-src-1')).toHaveTextContent('crm-usuarios');
    expect(screen.getByTestId('row-source-src-2')).toHaveTextContent('erp-finanzas');
  });

  it('5. admin ve "Nueva fuente" y las acciones administrativas', () => {
    arrange({ isAdmin: true });
    expect(screen.getByTestId('button-new-source')).toBeInTheDocument();
    expect(screen.getByTestId('button-edit-source-src-1')).toBeInTheDocument();
    expect(screen.getByTestId('button-delete-source-src-1')).toBeInTheDocument();
  });

  it('6. no-admin NO ve acciones administrativas', () => {
    arrange({ isAdmin: false });
    expect(screen.queryByTestId('button-new-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-edit-source-src-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-delete-source-src-1')).not.toBeInTheDocument();
    expect(screen.getAllByText('solo lectura').length).toBeGreaterThan(0);
  });
});

describe('SourcesPage — creación (M6.a)', () => {
  it('7. creación exitosa: envía el payload y muestra toast', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let sentCreate: SourceCreate | undefined;
    mockedUseCreateSource.mockReturnValue(
      buildMutation<{ data: SourceCreate }, SourceDetail>({
        mutate: (variables, callbacks) => {
          sentCreate = variables.data;
          callbacks?.onSuccess({ ...sourceDetailFixture, name: variables.data.name });
        },
      }),
    );
    await openCreateForm(user);
    await fillCreateForm(user);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByTestId('button-submit-source'));
    expect(sentCreate).toEqual(createSuccessBody);
    expect(screen.getByText('Fuente creada')).toBeInTheDocument();
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListSourcesQueryKey() }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetDashboardQueryKey() });
  });

  it('8. creación fallida: muestra el error del servidor', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    mockedUseCreateSource.mockReturnValue(
      buildMutation<SourceCreate, SourceDetail>({
        mutate: (_data, callbacks) => callbacks?.onError(serverError(409, 'Conflict', 'Ya existe una fuente con ese nombre', 'POST')),
      }),
    );
    await openCreateForm(user);
    await fillCreateForm(user);
    await user.click(screen.getByTestId('button-submit-source'));
    expect(screen.getByTestId('form-error')).toHaveTextContent('Ya existe una fuente con ese nombre');
    expect(screen.getByText('No se pudo crear la fuente')).toBeInTheDocument();
  });

  it('validación local: sin nombre no llama a la API', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let called = false;
    mockedUseCreateSource.mockReturnValue(buildMutation<SourceCreate, SourceDetail>({ mutate: () => { called = true; } }));
    await openCreateForm(user);
    await fillCreateForm(user, { 'input-source-name': '' });
    await user.click(screen.getByTestId('button-submit-source'));
    expect(screen.getByTestId('form-error')).toHaveTextContent('El nombre es obligatorio');
    expect(called).toBe(false);
  });

  it('validación local: conexión incompleta no llama a la API', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let called = false;
    mockedUseCreateSource.mockReturnValue(buildMutation<SourceCreate, SourceDetail>({ mutate: () => { called = true; } }));
    await openCreateForm(user);
    await fillCreateForm(user, { 'input-source-password': '' });
    await user.click(screen.getByTestId('button-submit-source'));
    expect(screen.getByTestId('form-error')).toBeInTheDocument();
    expect(called).toBe(false);
  });
});

describe('SourcesPage — edición (M6.b)', () => {
  it('9. edición exitosa con password nuevo: envía la conexión completa', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let sentUpdate: SourceUpdate | undefined;
    mockedUseUpdateSource.mockReturnValue(
      buildMutation<{ id: string; data: SourceUpdate }, SourceDetail>({
        mutate: (variables, callbacks) => {
          sentUpdate = variables.data;
          callbacks?.onSuccess({ ...sourceDetailFixture, ...variables.data });
        },
      }),
    );
    await openEditForm(user);
    await user.clear(screen.getByTestId('input-source-name'));
    await user.type(screen.getByTestId('input-source-name'), 'crm-usuarios-v2');
    await user.type(screen.getByTestId('input-source-host'), 'db.interno');
    await user.type(screen.getByTestId('input-source-port'), '5432');
    await user.type(screen.getByTestId('input-source-database'), 'crm');
    await user.type(screen.getByTestId('input-source-user'), 'auditor');
    await user.type(screen.getByTestId('input-source-password'), 'nueva-clave-2026');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByTestId('button-submit-source'));
    expect(sentUpdate).toEqual({
      name: 'crm-usuarios-v2',
      kind: 'postgresql',
      environment: 'production',
      connection: { host: 'db.interno', port: 5432, database: 'crm', user: 'auditor', password: 'nueva-clave-2026' },
    });
    expect(screen.getByText('Cambios guardados')).toBeInTheDocument();
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetSourceQueryKey('src-1') }));
  });

  it('10. edición sin password NO envía password ni conexión', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let sentUpdate: SourceUpdate | undefined;
    mockedUseUpdateSource.mockReturnValue(
      buildMutation<{ id: string; data: SourceUpdate }, SourceDetail>({
        mutate: (variables, callbacks) => {
          sentUpdate = variables.data;
          callbacks?.onSuccess({ ...sourceDetailFixture, ...variables.data });
        },
      }),
    );
    await openEditForm(user);
    await user.clear(screen.getByTestId('input-source-name'));
    await user.type(screen.getByTestId('input-source-name'), 'solo-nombre');
    await user.click(screen.getByTestId('button-submit-source'));
    expect(sentUpdate).toEqual({ name: 'solo-nombre', kind: 'postgresql', environment: 'production' });
    expect(sentUpdate).not.toHaveProperty('connection');
    expect(sentUpdate).not.toHaveProperty('password');
    expect(screen.getByText('Cambios guardados')).toBeInTheDocument();
  });

  it('11. el formulario de edición nunca muestra el password existente', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    await openEditForm(user);
    const passwordInput = screen.getByTestId('input-source-password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');
    expect(passwordInput.value).toBe('');
    // El detalle del backend nunca incluye la conexión: ningún campo la prefill.
    expect(screen.getByTestId('input-source-host')).toHaveValue('');
  });
});

describe('SourcesPage — borrado (M6.c)', () => {
  it('12. la eliminación requiere confirmación (no llama a la API antes del confirm)', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let deleteCalled = false;
    mockedUseDeleteSource.mockReturnValue(buildMutation<{ id: string }, void>({ mutate: () => { deleteCalled = true; } }));
    const dialog = await openDeleteDialog(user);
    expect(within(dialog).getByTestId('dialog-delete-description')).toHaveTextContent(/puede eliminar datos relacionados/i);
    expect(deleteCalled).toBe(false);
  });

  it('13. eliminación exitosa tras confirmar: invalida listado, dashboard y escaneos', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    let deletedId: string | undefined;
    mockedUseDeleteSource.mockReturnValue(
      buildMutation<{ id: string }, void>({
        mutate: (variables, callbacks) => {
          deletedId = variables.id;
          callbacks?.onSuccess(undefined);
        },
      }),
    );
    await openDeleteDialog(user);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(within(screen.getByRole('alertdialog')).getByTestId('button-confirm-delete'));
    expect(deletedId).toBe('src-1');
    expect(screen.getByText('Fuente eliminada')).toBeInTheDocument();
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListSourcesQueryKey() }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetDashboardQueryKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListScansQueryKey() });
  });

  it('14. eliminación fallida: muestra el error del servidor y mantiene el diálogo', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    mockedUseDeleteSource.mockReturnValue(
      buildMutation<{ id: string }, void>({
        mutate: (_variables, callbacks) => callbacks?.onError(serverError(403, 'Forbidden', 'Sólo un admin puede eliminar fuentes', 'DELETE')),
      }),
    );
    await openDeleteDialog(user);
    await user.click(within(screen.getByRole('alertdialog')).getByTestId('button-confirm-delete'));
    expect(within(screen.getByRole('alertdialog')).getByTestId('dialog-delete-error')).toHaveTextContent('Sólo un admin puede eliminar fuentes');
    expect(screen.getByText('No se pudo eliminar la fuente')).toBeInTheDocument();
  });
});

describe('SourcesPage — invalidaciones (M6.d)', () => {
  it('15. invalida las queries relacionadas después de cada mutación', async () => {
    const user = userEvent.setup();
    arrange({ isAdmin: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    // Creación → listado + dashboard.
    await openCreateForm(user);
    await fillCreateForm(user);
    await user.click(screen.getByTestId('button-submit-source'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListSourcesQueryKey() }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetDashboardQueryKey() });
    // Borrado → listado + escaneos (cascada del backend).
    await openDeleteDialog(user);
    await user.click(within(screen.getByRole('alertdialog')).getByTestId('button-confirm-delete'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListScansQueryKey() }));
  });
});





