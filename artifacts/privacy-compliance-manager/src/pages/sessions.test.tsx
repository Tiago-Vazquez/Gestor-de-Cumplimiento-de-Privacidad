import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthListSessionsQueryKey,
  useAuthListSessions,
  useAuthLogoutAll,
  useAuthRevokeSession,
} from '@workspace/api-client-react';
import type { SessionSummary } from '@workspace/api-client-react';
import SessionsPage from './sessions';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useAuthListSessions: vi.fn(),
    useAuthRevokeSession: vi.fn(),
    useAuthLogoutAll: vi.fn(),
  };
});

const mockedList = vi.mocked(useAuthListSessions);
const mockedRevoke = vi.mocked(useAuthRevokeSession);
const mockedLogoutAll = vi.mocked(useAuthLogoutAll);

const CURRENT = 'jti-current';
const OTHER = 'jti-other';

const sessionFixture = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    jti: 'jti-1',
    createdAt: '2026-09-01T10:00:00.000Z',
    expiresAt: '2026-09-02T10:00:00.000Z',
    current: false,
    ...overrides,
  }) as SessionSummary;

function arrange({
  sessions,
  isLoading,
  isError,
}: {
  sessions?: SessionSummary[];
  isLoading?: boolean;
  isError?: boolean;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  mockedList.mockReturnValue({
    data: sessions !== undefined ? { sessions } : undefined,
    isLoading: isLoading ?? false,
    isError: isError ?? false,
    error: null,
    refetch: vi.fn(),
  } as never);
  mockedRevoke.mockReturnValue({
    isPending: false,
    mutate: (v: { jti: string }, cb?: { onSuccess: (d: unknown) => void }) => cb?.onSuccess(undefined),
  } as never);
  mockedLogoutAll.mockReturnValue({
    isPending: false,
    mutate: (_v: undefined, cb?: { onSuccess: (d: { revoked: number }) => void }) =>
      cb?.onSuccess({ revoked: 1 }),
  } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <SessionsPage />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessions page', () => {
  it('1. muestra la sesion actual', () => {
    arrange({ sessions: [sessionFixture({ jti: CURRENT, current: true })] });
    expect(screen.getByTestId('sessions-title')).toHaveTextContent('Sesiones');
    expect(screen.getByTestId(`session-card-${CURRENT}`)).toBeInTheDocument();
    expect(screen.getByTestId(`session-current-${CURRENT}`)).toHaveTextContent('Actual');
  });

  it('2. muestra otras sesiones', () => {
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    expect(screen.getByTestId('sessions-list')).toBeInTheDocument();
    expect(screen.getByTestId(`session-card-${OTHER}`)).toBeInTheDocument();
  });

  it('3. estado loading', () => {
    arrange({ isLoading: true });
    expect(screen.getByTestId('sessions-loading')).toHaveTextContent('Cargando sesiones');
  });

  it('4. estado error', () => {
    arrange({ isError: true });
    expect(screen.getByTestId('sessions-error')).toBeInTheDocument();
    expect(screen.getByTestId('button-retry-sessions')).toBeInTheDocument();
  });

  it('5. estado vacio', () => {
    arrange({ sessions: [] });
    expect(screen.getByTestId('sessions-empty')).toHaveTextContent('No hay sesiones activas');
  });

  it('6. sesiones no actuales muestran boton de revocacion', () => {
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    expect(screen.getByTestId(`button-revoke-${OTHER}`)).toBeInTheDocument();
  });

  it('7. aparece confirmacion antes de revocar', async () => {
    const user = userEvent.setup();
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId(`button-revoke-${OTHER}`));
    expect(screen.getByTestId(`confirm-revoke-${OTHER}`)).toBeInTheDocument();
    expect(screen.getByText('¿Revocar esta sesión?')).toBeInTheDocument();
  });

  it('8. se ejecuta useAuthRevokeSession', async () => {
    const user = userEvent.setup();
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId(`button-revoke-${OTHER}`));
    await user.click(screen.getByTestId(`button-confirm-revoke-${OTHER}`));
    expect(mockedRevoke).toHaveBeenCalled();
  });

  it('9. despues de revocar se invalida la consulta', async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId(`button-revoke-${OTHER}`));
    await user.click(screen.getByTestId(`button-confirm-revoke-${OTHER}`));
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getAuthListSessionsQueryKey() });
    });
  });

  it('10. aparece la accion de cerrar todas las demas sesiones', () => {
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    expect(screen.getByTestId('button-logout-all')).toHaveTextContent('Cerrar todas las demás sesiones');
  });

  it('11. aparece confirmacion antes de logout-all', async () => {
    const user = userEvent.setup();
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId('button-logout-all'));
    expect(screen.getByTestId('confirm-logout-all')).toBeInTheDocument();
    expect(screen.getByText('¿Cerrar todas las demás sesiones?')).toBeInTheDocument();
  });

  it('12. se ejecuta useAuthLogoutAll', async () => {
    const user = userEvent.setup();
    arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId('button-logout-all'));
    await user.click(screen.getByTestId('button-confirm-logout-all'));
    expect(mockedLogoutAll).toHaveBeenCalled();
  });

  it('13. despues de logout-all se invalida la consulta', async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = arrange({
      sessions: [sessionFixture({ jti: CURRENT, current: true }), sessionFixture({ jti: OTHER, current: false })],
    });
    await user.click(screen.getByTestId('button-logout-all'));
    await user.click(screen.getByTestId('button-confirm-logout-all'));
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getAuthListSessionsQueryKey() });
    });
  });

  it('14. la sesion actual NO tiene boton de revocacion individual', () => {
    arrange({ sessions: [sessionFixture({ jti: CURRENT, current: true })] });
    expect(screen.queryByTestId(`button-revoke-${CURRENT}`)).not.toBeInTheDocument();
  });
});
