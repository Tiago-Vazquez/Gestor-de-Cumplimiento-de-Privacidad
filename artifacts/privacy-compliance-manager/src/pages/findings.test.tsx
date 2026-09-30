import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getListFindingsQueryKey, useListFindings, useUpdateFinding } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';
import FindingsPage from './findings';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useListFindings: vi.fn(),
    useUpdateFinding: vi.fn(),
  };
});

vi.mock('@/auth/auth-context', () => ({ useAuth: vi.fn() }));

const buildMutation = <TVariables, TResult>(options: {
  mutate: (variables: TVariables, callbacks?: { onSuccess?: (data: TResult) => void; onError?: (error: unknown) => void }) => void;
  isPending?: boolean;
}) => ({ isPending: options.isPending ?? false, isError: false, isSuccess: false, error: null, mutate: options.mutate }) as never;

const findingsFixture = [
  { id: 'f-1', title: 'Email expuesto', dataType: 'email', source: 'crm', location: 'users.email', severity: 'critical', status: 'open', records: 240, detectedAt: '2026-11-09T10:00:00.000Z', regulation: 'GDPR', recommendation: 'Enmascarar', sample: 'j***@***.com' },
  { id: 'f-2', title: 'Tarjeta en texto plano', dataType: 'credit_card', source: 'erp', location: 'payments.num', severity: 'high', status: 'in_review', records: 12, detectedAt: '2026-11-08T08:00:00.000Z', regulation: 'PCI-DSS', recommendation: 'Cifrar', sample: null },
];

const serverError = (status: number, type: string, title: string) => ({ status, type, title, detail: title });
const mockedUseListFindings = useListFindings as unknown as ReturnType<typeof vi.fn>;
const mockedUseUpdateFinding = useUpdateFinding as unknown as ReturnType<typeof vi.fn>;
const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const user = userEvent.setup();

function renderFindings(overrides: { isAdmin?: boolean } = {}) {
  mockedUseAuth.mockReturnValue({ isAdmin: overrides.isAdmin ?? true });
  render(
    <QueryClientProvider client={queryClient}>
      <FindingsPage />
    </QueryClientProvider>,
  );
}

describe('Findings — listado, filtros, drawer y ciclo de vida (M8)', () => {
  beforeEach(() => { mockedUseUpdateFinding.mockReturnValue(buildMutation({ mutate: () => {} })); });
  afterEach(() => cleanup());

  it('1. loading del listado', () => {
    mockedUseListFindings.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    expect(screen.getByTestId('findings-loading')).toBeInTheDocument();
  });

  it('2. error + retry', () => {
    const refetch = vi.fn();
    mockedUseListFindings.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('fail'), refetch });
    renderFindings();
    expect(screen.getByTestId('list-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('button-retry-findings'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('3. empty state', () => {
    mockedUseListFindings.mockReturnValue({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('4. listado correcto', () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    expect(screen.getByText('Email expuesto')).toBeInTheDocument();
    expect(screen.getByText('Tarjeta en texto plano')).toBeInTheDocument();
    expect(screen.getAllByTestId(/row-finding-/).length).toBe(2);
  });

  it('5. apertura del drawer', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const resolvedButton = await screen.findByTestId('button-status-resolved');
    expect(resolvedButton).toBeInTheDocument();
    expect(screen.getByText('Muestra detectada')).toBeInTheDocument();
    expect(screen.getByText('j***@***.com')).toBeInTheDocument();
  });

  it('6. cierre del drawer', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    await screen.findByTestId('button-status-resolved');
    const closeButton = screen.getByTestId('button-close-finding-drawer');
    expect(closeButton).toBeInTheDocument();
    await user.click(closeButton);
    const drawerClosed = screen.queryByTestId('button-status-resolved');
    expect(drawerClosed).not.toBeInTheDocument();
  });

  it('7. actualización de estado exitosa: mensaje inline', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    mockedUseUpdateFinding.mockReturnValue(
      buildMutation({ mutate: (_vars, callbacks) => callbacks?.onSuccess?.({ id: 'f-1', status: 'resolved' }) }),
    );
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const resolvedButton = await screen.findByTestId('button-status-resolved');
    await user.click(resolvedButton);
    expect(await screen.findByText('Estado actualizado')).toBeInTheDocument();
  });

  it('8. error de actualización: mensaje inline de error', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    mockedUseUpdateFinding.mockReturnValue(
      buildMutation({ mutate: (_vars, callbacks) => callbacks?.onError?.(serverError(500, 'about:blank', 'Error del servidor')) }),
    );
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const resolvedButton = await screen.findByTestId('button-status-resolved');
    await user.click(resolvedButton);
    expect(await screen.findByText('No se pudo actualizar. Intenta de nuevo.')).toBeInTheDocument();
  });

  it('9. invalidación de listado tras mutación', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    mockedUseUpdateFinding.mockReturnValue(
      buildMutation({ mutate: (_vars, callbacks) => callbacks?.onSuccess?.({ id: 'f-1', status: 'resolved' }) }),
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const resolvedButton = await screen.findByTestId('button-status-resolved');
    await user.click(resolvedButton);
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getListFindingsQueryKey() }));
  });

  it('10. loading durante mutación deshabilita botón', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    mockedUseUpdateFinding.mockReturnValue(buildMutation({ mutate: () => {}, isPending: true }));
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const resolvedButton = await screen.findByTestId('button-status-resolved');
    expect(resolvedButton).toBeDisabled();
  });

  it('11. accesibilidad del drawer (close button aria-label + título visible)', async () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    await user.click(screen.getByTestId('row-finding-f-1'));
    const closeButton = await screen.findByTestId('button-close-finding-drawer');
    expect(closeButton).toHaveAttribute('aria-label', expect.stringContaining('Cerrar'));
    // El título aparece en la fila y también como encabezado del drawer abierto.
    expect(screen.getAllByText('Email expuesto').length).toBeGreaterThanOrEqual(2);
  });

  it('12. filtros: cambio de severidad', () => {
    mockedUseListFindings.mockReturnValue({ data: findingsFixture, isLoading: false, isError: false, error: null, refetch: vi.fn() });
    renderFindings();
    fireEvent.change(screen.getByTestId('select-severity'), { target: { value: 'critical' } });
    expect(screen.getByText('Email expuesto')).toBeInTheDocument();
  });
});
