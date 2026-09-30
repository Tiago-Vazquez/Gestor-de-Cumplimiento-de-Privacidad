import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCancelScan, useGetScan, useListScans } from '@workspace/api-client-react';
import type { Scan } from '@workspace/api-client-react';
import ScansPage from './scans';

// useAuth decide si aparece el boton de cancelar (canCancel exige isAdmin).
// Se mockea para verificar ambos caminos sin montar el provider real.
vi.mock('@/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return { ...actual, useListScans: vi.fn(), useGetScan: vi.fn(), useCancelScan: vi.fn() };
});

const { useAuth } = await import('@/auth/auth-context');
const mockedList = vi.mocked(useListScans);
const mockedDetail = vi.mocked(useGetScan);
const mockedCancel = vi.mocked(useCancelScan);
const mockedAuth = vi.mocked(useAuth);

const scanFixture = (overrides: Partial<Scan> = {}): Scan =>
  ({
    id: 'scan-1',
    sourceId: 'src-1',
    status: 'completed',
    tablesScanned: 4,
    recordsRead: 150,
    findingsCreated: 2,
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: '2026-09-01T10:00:30.000Z',
    ...overrides,
  }) as Scan;

function arrange({
  scans,
  isLoading,
  isError,
  detail,
  isAdmin = true,
}: {
  scans?: Scan[];
  isLoading?: boolean;
  isError?: boolean;
  detail?: Scan;
  isAdmin?: boolean;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const refetch = vi.fn();

  mockedAuth.mockReturnValue({
    user: { sub: 'me', roles: isAdmin ? ['admin'] : ['auditor'] },
    isAdmin,
    isLoading: false,
    roles: isAdmin ? ['admin'] : ['auditor'],
    logout: vi.fn(),
  } as never);

  mockedList.mockReturnValue({
    // listScans devuelve Scan[] directamente (api.ts:2347), no un objeto con scans.
    data: scans,
    isLoading: isLoading ?? false,
    isError: isError ?? false,
    error: null,
    isRefetching: false,
    refetch,
  } as never);

  mockedDetail.mockReturnValue({
    data: detail,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as never);

  mockedCancel.mockReturnValue({ isPending: false, isError: false, mutate: vi.fn() } as never);

  render(
    <QueryClientProvider client={queryClient}>
      <ScansPage />
    </QueryClientProvider>,
  );
  return { queryClient, refetch };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scans page', () => {
  it('1. renderiza la cabecera y la lista de escaneos', () => {
    arrange({ scans: [scanFixture(), scanFixture({ id: 'scan-2' })] });
    expect(screen.getByText('Escaneos')).toBeInTheDocument();
    expect(screen.getByTestId('row-scan-scan-1')).toBeInTheDocument();
    expect(screen.getByTestId('row-scan-scan-2')).toBeInTheDocument();
  });

  it('2. estado loading no muestra resultados', () => {
    arrange({ isLoading: true });
    expect(screen.queryByTestId('row-scan-scan-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-retry-scans')).not.toBeInTheDocument();
  });

  it('3. estado error muestra mensaje y reintenta al pulsar', async () => {
    const { refetch } = arrange({ isError: true });
    expect(screen.getByText('No pudimos cargar el historial de escaneos.')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('button-retry-scans'));
    expect(refetch).toHaveBeenCalled();
  });

  it('4. estado vacio informa que no hay escaneos', () => {
    arrange({ scans: [] });
    expect(screen.getByText('Sin escaneos registrados')).toBeInTheDocument();
  });

  it('5. el filtro por estado se envia al backend y reinicia la pagina', async () => {
    arrange({ scans: [scanFixture()] });
    expect(mockedList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 0 }),
      expect.anything(),
    );
    await userEvent.click(screen.getByTestId('filter-failed'));
    await waitFor(() => {
      expect(mockedList).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', offset: 0 }),
        expect.anything(),
      );
    });
  });

  it('6. abrir el detalle muestra el drawer y se puede cerrar', async () => {
    arrange({ scans: [scanFixture()], detail: scanFixture() });
    await userEvent.click(screen.getByTestId('button-view-scan-scan-1'));
    expect(await screen.findByTestId('button-close-drawer')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('button-close-drawer'));
    await waitFor(() => {
      expect(screen.queryByTestId('button-close-drawer')).not.toBeInTheDocument();
    });
  });

  it('7. un admin puede cancelar un escaneo en curso', async () => {
    const running = scanFixture({ id: 'run-1', status: 'running' });
    arrange({ scans: [running], detail: running, isAdmin: true });
    await userEvent.click(screen.getByTestId('button-view-scan-run-1'));
    expect(await screen.findByTestId('button-cancel-scan')).toBeInTheDocument();
  });

  it('8. un escaneo completado no ofrece cancelacion', async () => {
    const done = scanFixture({ id: 'done-1', status: 'completed' });
    arrange({ scans: [done], detail: done });
    await userEvent.click(screen.getByTestId('button-view-scan-done-1'));
    await screen.findByTestId('button-close-drawer');
    expect(screen.queryByTestId('button-cancel-scan')).not.toBeInTheDocument();
  });

  it('9. un usuario sin rol admin no puede cancelar', async () => {
    const running = scanFixture({ id: 'run-2', status: 'running' });
    arrange({ scans: [running], detail: running, isAdmin: false });
    await userEvent.click(screen.getByTestId('button-view-scan-run-2'));
    await screen.findByTestId('button-close-drawer');
    expect(screen.queryByTestId('button-cancel-scan')).not.toBeInTheDocument();
  });

  it('10. la paginacion limita la tabla a PAGE_SIZE filas', () => {
    const many = Array.from({ length: 25 }, (_, i) => scanFixture({ id: `s-${i}` }));
    arrange({ scans: many });
    expect(screen.getByTestId('row-scan-s-0')).toBeInTheDocument();
    expect(screen.queryByTestId('row-scan-s-10')).not.toBeInTheDocument();
  });
});