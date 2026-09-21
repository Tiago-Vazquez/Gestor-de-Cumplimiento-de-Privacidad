import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import {
  ApiError,
  getGetSourceScheduleQueryKey,
  useDeleteSource,
  useGetSourceSchedule,
  useListSources,
  useStartScan,
  useUpdateSourceSchedule,
} from '@workspace/api-client-react';
import type { DataSource, SourceSchedule, SourceScheduleUpdate } from '@workspace/api-client-react';
import { SourceScheduleDialog, INTERVAL_OPTIONS, MAX_INTERVAL, MIN_INTERVAL, SCAN_SCHEDULE_DEFAULT_MINUTES } from '@/components/SourceScheduleDialog';
import { Toaster } from '@/components/ui/toaster';
import { useAuth } from '@/auth/auth-context';
import SourcesPage from './sources';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useListSources: vi.fn(),
    useGetSourceSchedule: vi.fn(),
    useUpdateSourceSchedule: vi.fn(),
    useDeleteSource: vi.fn(),
    useStartScan: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/auth-context')>();
  return { ...actual, useAuth: vi.fn(() => authMockValue) };
});

const mockedUseListSources = vi.mocked(useListSources);
const mockedUseGetSourceSchedule = vi.mocked(useGetSourceSchedule);
const mockedUseUpdateSourceSchedule = vi.mocked(useUpdateSourceSchedule);
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
  new ApiError(new Response(null, { status, statusText }), { message }, { method, url: '/api/sources/src-1/schedule' });

const sourcesFixture: DataSource[] = [
  { id: 'src-1', name: 'crm-usuarios', kind: 'postgresql', environment: 'production', status: 'healthy', tables: 34, records: 120000, findings: 12, lastScanAt: '2026-11-09T10:00:00.000Z' },
  { id: 'src-2', name: 'erp-finanzas', kind: 'mysql', environment: 'staging', status: 'offline', tables: 18, records: 8000, findings: 0, lastScanAt: '2026-11-01T08:00:00.000Z' },
];

/** Programación según el contrato M10.1: por defecto deshabilitada con el intervalo diario del backend. */
const scheduleFixture = (overrides: Partial<SourceSchedule> = {}): SourceSchedule => ({
  sourceId: 'src-1',
  enabled: false,
  intervalMinutes: 1440,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  ...overrides,
});

/** Mockea useUpdateSourceSchedule invocando las callbacks del hook, como hace React Query real. */
function mockUpdateSuccess() {
  mockedUseUpdateSourceSchedule.mockImplementation(((options?: { mutation?: { onSuccess?: (data: SourceSchedule) => void } }) => ({
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    mutate: (variables: { id: string; data: SourceScheduleUpdate }) =>
      options?.mutation?.onSuccess?.(
        scheduleFixture({ sourceId: variables.id, enabled: variables.data.enabled, intervalMinutes: variables.data.intervalMinutes ?? 1440 }),
      ),
  })) as never);
}

/** Mockea useUpdateSourceSchedule propagando un fallo del servidor a la callback del hook. */
function mockUpdateError(error: unknown) {
  mockedUseUpdateSourceSchedule.mockImplementation(((options?: { mutation?: { onError?: (error: unknown) => void } }) => ({
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    mutate: () => options?.mutation?.onError?.(error),
  })) as never);
}

/** Configura los mocks y renderiza la página; `schedules` mapea sourceId → programación (o null). */
function arrange({ isAdmin = true, sources = sourcesFixture, schedules = {} as Record<string, SourceSchedule | null> } = {}) {
  authMockValue = { isAdmin };
  mockedUseListSources.mockReturnValue({ data: sources, isLoading: false, isError: false, error: null, refetch: vi.fn() } as never);
  mockedUseGetSourceSchedule.mockImplementation((((id: string) => ({
    data: schedules[id] ?? null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })) as never));
  mockUpdateSuccess();
  mockedUseDeleteSource.mockReturnValue(buildMutation<string, void>({ mutate: (_id, callbacks) => callbacks?.onSuccess(undefined) }));
  mockedUseStartScan.mockReturnValue(buildMutation<{ sourceId: string }, { scanId: string }>({ mutate: (_data, callbacks) => callbacks?.onSuccess({ scanId: 'scan-new' }) }));
  render(
    <QueryClientProvider client={queryClient}>
      <SourcesPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Configura la mutación de guardado y renderiza el diálogo aislado con una programación dada. */
function renderDialog({
  schedule = scheduleFixture(),
  onOpenChange = vi.fn(),
}: { schedule?: SourceSchedule | null; onOpenChange?: ComponentProps<typeof SourceScheduleDialog>['onOpenChange'] } = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <SourceScheduleDialog sourceId="src-1" schedule={schedule} open onOpenChange={onOpenChange} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const openScheduleDialog = async (user: ReturnType<typeof userEvent.setup>, sourceId = 'src-1') => {
  await user.click(screen.getByTestId(`button-schedule-${sourceId}`));
  return screen.findByRole('dialog');
};

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  authMockValue = { isAdmin: true };
});

describe('SourcesPage — chip de programación (M10.6)', () => {
  it('1. sin programación muestra «Manual» y no expone tooltip', () => {
    arrange();
    const chip = screen.getByTestId('chip-schedule-src-1');
    expect(chip).toHaveTextContent('Manual');
    expect(chip).not.toHaveAttribute('title');
  });

  it('2. programación habilitada muestra «Programado · cada 6 h»', () => {
    arrange({ schedules: { 'src-1': scheduleFixture({ enabled: true, intervalMinutes: 360 }) } });
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveTextContent('Programado · cada 6 h');
  });

  it('3. formatea el intervalo en minutos, horas y días', () => {
    arrange({
      sources: [
        { ...sourcesFixture[0], id: 'src-min', name: 'minutos' },
        { ...sourcesFixture[0], id: 'src-horas', name: 'horas' },
        { ...sourcesFixture[0], id: 'src-dia', name: 'dia' },
        { ...sourcesFixture[0], id: 'src-semana', name: 'semana' },
      ],
      schedules: {
        'src-min': scheduleFixture({ sourceId: 'src-min', enabled: true, intervalMinutes: 45 }),
        'src-horas': scheduleFixture({ sourceId: 'src-horas', enabled: true, intervalMinutes: 360 }),
        'src-dia': scheduleFixture({ sourceId: 'src-dia', enabled: true, intervalMinutes: 1440 }),
        'src-semana': scheduleFixture({ sourceId: 'src-semana', enabled: true, intervalMinutes: 10080 }),
      },
    });
    expect(screen.getByTestId('chip-schedule-src-min')).toHaveTextContent('cada 45 min');
    expect(screen.getByTestId('chip-schedule-src-horas')).toHaveTextContent('cada 6 h');
    expect(screen.getByTestId('chip-schedule-src-dia')).toHaveTextContent('cada 1 d');
    expect(screen.getByTestId('chip-schedule-src-semana')).toHaveTextContent('cada 7 d');
  });

  it('4. muestra la próxima ejecución en el tooltip cuando nextRunAt existe', () => {
    const nextRunAt = '2026-12-01T09:30:00.000Z';
    arrange({ schedules: { 'src-1': scheduleFixture({ enabled: true, intervalMinutes: 360, nextRunAt }) } });
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveAttribute(
      'title',
      `Próxima ejecución: ${new Date(nextRunAt).toLocaleString('es-ES')}`,
    );
  });

  it('4b. programación deshabilitada con historial muestra «Pausado» y tooltip con última ejecución y último resultado', () => {
    arrange({
      schedules: {
        'src-1': scheduleFixture({
          enabled: false,
          intervalMinutes: 360,
          lastRunAt: '2026-11-30T08:00:00.000Z',
          lastStatus: 'ok',
        }),
      },
    });
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveTextContent('Pausado');
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveAttribute(
      'title',
      expect.stringContaining(`Última ejecución: ${new Date('2026-11-30T08:00:00.000Z').toLocaleString('es-ES')}`),
    );
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveAttribute('title', expect.stringContaining('Último resultado: OK'));
  });

  it('4c. fila pausada recién creada (sin historial, intervalo por defecto) se muestra «Manual»', () => {
    // Limitación del contrato: GET no distingue «sin fila» de una fila pausada
    // con defaults; ambas muestran «Manual» (comportamiento efectivo).
    arrange({ schedules: { 'src-1': scheduleFixture({ enabled: false }) } });
    expect(screen.getByTestId('chip-schedule-src-1')).toHaveTextContent('Manual');
  });
});

describe('SourcesPage — rol y diálogo de programación (M10.6)', () => {
  it('5. el admin ve «Configurar» y abre el diálogo con la programación de esa fuente', async () => {
    const user = userEvent.setup();
    arrange({ schedules: { 'src-2': scheduleFixture({ sourceId: 'src-2', enabled: true, intervalMinutes: 720 }) } });
    const dialog = await openScheduleDialog(user, 'src-2');
    expect(within(dialog).getByText('Programación de escaneos')).toBeInTheDocument();
    expect(within(dialog).getByTestId('switch-enabled')).toBeChecked();
    expect(within(dialog).getByTestId('select-interval')).toHaveTextContent('12 horas');
  });

  it('6. el auditor no ve «Configurar» y no puede abrir el diálogo', () => {
    arrange({ isAdmin: false });
    expect(screen.queryByTestId('button-schedule-src-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('7. «Cancelar» cierra y desmonta el diálogo', async () => {
    const user = userEvent.setup();
    arrange();
    const dialog = await openScheduleDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('SourceScheduleDialog — guardado (M10.6)', () => {
  it('8. programación deshabilitada: oculta el selector y guarda enabled=false con su intervalo', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedUseUpdateSourceSchedule.mockReturnValue(buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate }));
    renderDialog({ schedule: scheduleFixture({ enabled: false, intervalMinutes: 720 }) });
    expect(screen.getByTestId('switch-enabled')).not.toBeChecked();
    expect(screen.queryByTestId('select-interval')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('button-save'));
    expect(mutate).toHaveBeenCalledWith({ id: 'src-1', data: { enabled: false, intervalMinutes: 720 } });
  });

  it('9. activar el switch envía enabled=true con el intervalo diario por defecto', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedUseUpdateSourceSchedule.mockReturnValue(buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate }));
    renderDialog({ schedule: scheduleFixture({ enabled: false }) });
    await user.click(screen.getByTestId('switch-enabled'));
    expect(screen.getByTestId('select-interval')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-save'));
    expect(mutate).toHaveBeenCalledWith({ id: 'src-1', data: { enabled: true, intervalMinutes: 1440 } });
  });

  it('10. programación habilitada: prellena el intervalo y lo envía al guardar', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedUseUpdateSourceSchedule.mockReturnValue(buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate }));
    renderDialog({ schedule: scheduleFixture({ enabled: true, intervalMinutes: 360 }) });
    expect(screen.getByTestId('switch-enabled')).toBeChecked();
    expect(screen.getByTestId('select-interval')).toHaveTextContent('6 horas');
    await user.click(screen.getByTestId('button-save'));
    expect(mutate).toHaveBeenCalledWith({ id: 'src-1', data: { enabled: true, intervalMinutes: 360 } });
  });

  it('11. el diálogo respeta los límites y el default del contrato (15 / 10080 / 1440)', () => {
    expect([MIN_INTERVAL, MAX_INTERVAL]).toEqual([15, 10080]);
    expect(SCAN_SCHEDULE_DEFAULT_MINUTES).toBe(1440);
    expect(INTERVAL_OPTIONS.map((option) => option.value)).toEqual([15, 30, 60, 360, 720, 1440, 10080]);
  });
});

describe('SourceScheduleDialog — estado de ejecución (M15)', () => {
  it('muestra próxima ejecución, última ejecución y último resultado cuando existen', () => {
    renderDialog({
      schedule: scheduleFixture({
        enabled: true,
        intervalMinutes: 360,
        nextRunAt: '2026-12-01T09:30:00.000Z',
        lastRunAt: '2026-11-30T08:00:00.000Z',
        lastStatus: 'error',
      }),
    });
    expect(screen.getByTestId('schedule-info')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-next-run')).toHaveTextContent(
      `Próxima ejecución: ${new Date('2026-12-01T09:30:00.000Z').toLocaleString('es-ES')}`,
    );
    expect(screen.getByTestId('schedule-last-run')).toHaveTextContent(
      `Última ejecución: ${new Date('2026-11-30T08:00:00.000Z').toLocaleString('es-ES')}`,
    );
    expect(screen.getByTestId('schedule-last-status')).toHaveTextContent('Último resultado: Error');
  });

  it('no muestra el bloque de estado cuando el schedule no tiene historial', () => {
    renderDialog();
    expect(screen.queryByTestId('schedule-info')).not.toBeInTheDocument();
  });
});

describe('SourceScheduleDialog — validación de intervalo (M10.6)', () => {
  it('12. intervalo 14 (bajo el mínimo): muestra el error y no llama a la API', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedUseUpdateSourceSchedule.mockReturnValue(buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate }));
    renderDialog({ schedule: scheduleFixture({ enabled: true, intervalMinutes: 14 }) });
    await user.click(screen.getByTestId('button-save'));
    expect(screen.getByTestId('error-message')).toHaveTextContent('El intervalo debe estar entre 15 y 10080 minutos');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('13. intervalo 10081 (sobre el máximo): muestra el error y no llama a la API', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedUseUpdateSourceSchedule.mockReturnValue(buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate }));
    renderDialog({ schedule: scheduleFixture({ enabled: true, intervalMinutes: 10081 }) });
    await user.click(screen.getByTestId('button-save'));
    expect(screen.getByTestId('error-message')).toHaveTextContent('El intervalo debe estar entre 15 y 10080 minutos');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('SourceScheduleDialog — error, loading e invalidación (M10.6)', () => {
  it('14. muestra el error del servidor dentro del diálogo', async () => {
    const user = userEvent.setup();
    mockUpdateError(serverError(500, 'Internal Server Error', 'No se pudo guardar la programación', 'PUT'));
    renderDialog();
    await user.click(screen.getByTestId('button-save'));
    expect(screen.getByTestId('error-message')).toHaveTextContent(/No se pudo guardar la programación/);
  });

  it('15. mientras guarda, el botón de guardado queda deshabilitado', () => {
    mockedUseUpdateSourceSchedule.mockReturnValue(
      buildMutation<{ id: string; data: SourceScheduleUpdate }, SourceSchedule>({ mutate: vi.fn(), isPending: true }),
    );
    renderDialog();
    const save = screen.getByTestId('button-save');
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Guardando...');
  });

  it('16. tras guardar invalida getGetSourceScheduleQueryKey(id), avisa y cierra el diálogo', async () => {
    const user = userEvent.setup();
    arrange();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const dialog = await openScheduleDialog(user);
    await user.click(within(dialog).getByTestId('button-save'));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetSourceScheduleQueryKey('src-1') }));
    expect(screen.getByText('Programación actualizada')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});