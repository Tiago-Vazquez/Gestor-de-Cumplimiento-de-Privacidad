import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useListUsers, useUpdateUserRoles } from '@workspace/api-client-react';
import type { AdminUser } from '@workspace/api-client-react';
import UsersPage from './users';

// La pagina real esta envuelta en AdminGate, que lee useAuth. Se mockea para
// verificar la guardia de rol sin depender del contexto de autenticacion.
vi.mock('@/auth/auth-context', () => ({ useAuth: vi.fn() }));

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return { ...actual, useListUsers: vi.fn(), useUpdateUser: vi.fn(), useUpdateUserRoles: vi.fn() };
});

const { useAuth } = await import('@/auth/auth-context');
const mockedList = vi.mocked(useListUsers);
const mockedRoles = vi.mocked(useUpdateUserRoles);
const mockedAuth = vi.mocked(useAuth);
let rolesConfig: { mutation?: { onError?: (e: unknown) => void; onSuccess?: (d: unknown) => void } } = {};

const ADMIN = 'sub-admin';
const OTHER = 'sub-other';

const userFixture = (overrides: Partial<AdminUser> = {}): AdminUser => ({
  sub: ADMIN,
  email: 'admin@demo.example',
  name: 'Admin Demo',
  roles: ['admin'],
  createdAt: '2026-09-01T10:00:00.000Z',
  lastLoginAt: null,
  ...overrides,
});

function arrange({
  users,
  isLoading,
  isError,
  authLoading = false,
  roles = ['admin'],
  onMutate,
}: {
  users?: AdminUser[];
  isLoading?: boolean;
  isError?: boolean;
  authLoading?: boolean;
  roles?: string[];
  onMutate?: (v: { sub: string; data: { roles: string[] } }) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const refetch = vi.fn();

  mockedAuth.mockReturnValue({
    user: authLoading ? null : { sub: ADMIN, email: 'admin@demo.example', roles },
    isLoading: authLoading,
    isAdmin: roles.includes('admin'),
    roles,
    logout: vi.fn(),
  } as never);

  // listUsers devuelve AdminUser[] directamente (api.ts:777), no un objeto.
  mockedList.mockReturnValue({
    data: users,
    isLoading: isLoading ?? false,
    isError: isError ?? false,
    error: null,
    isRefetching: false,
    refetch,
  } as never);

  // La pagina pasa { mutation: { onSuccess, onError } } al hook. Se captura ESA
  // config para poder disparar los callbacks como haria el cliente real.
  mockedRoles.mockImplementation((config: never) => {
    rolesConfig = config;
    return {
      isPending: false,
      isError: false,
      mutate: (v: { sub: string; data: { roles: string[] } }) => {
        onMutate?.(v);
        (config as { mutation?: { onSuccess?: (d: unknown) => void } }).mutation?.onSuccess?.({
          roles: v.data.roles,
        } as never);
      },
    } as never;
  });

  render(
    <QueryClientProvider client={queryClient}>
      <UsersPage />
    </QueryClientProvider>,
  );
  return { queryClient, refetch };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('users page — guardia de rol', () => {
  it('1. un usuario sin rol admin ve el aviso y no la gestion', () => {
    arrange({ users: [], roles: ['auditor'] });
    expect(screen.getByText('No tienes permisos de administración.')).toBeInTheDocument();
    expect(screen.queryByTestId('row-user-admin@demo.example')).not.toBeInTheDocument();
  });

  it('2. mientras la sesion carga no renderiza gestion ni aviso', () => {
    arrange({ users: [userFixture()], authLoading: true });
    expect(screen.queryByText('No tienes permisos de administración.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('row-user-admin@demo.example')).not.toBeInTheDocument();
  });
});

describe('users page — listado', () => {
  it('3. lista los usuarios con su email', () => {
    arrange({ users: [userFixture(), userFixture({ sub: OTHER, email: 'otro@demo.example', name: 'Otro', roles: ['auditor'] })] });
    expect(screen.getByTestId('row-user-admin@demo.example')).toBeInTheDocument();
    expect(screen.getByTestId('row-user-otro@demo.example')).toBeInTheDocument();
  });

  it('4. estado loading no muestra filas', () => {
    arrange({ isLoading: true });
    expect(screen.queryByTestId('row-user-admin@demo.example')).not.toBeInTheDocument();
  });

  it('5. estado error ofrece reintentar', async () => {
    const { refetch } = arrange({ isError: true });
    expect(screen.getByText('No pudimos cargar los usuarios.')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('button-retry-users'));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('users page — gestion de roles', () => {
  it('6. anadir un rol envia la lista de roles actualizada', async () => {
    const onMutate = vi.fn();
    arrange({ users: [userFixture({ sub: OTHER, email: 'otro@demo.example', roles: [] })], onMutate });
    await userEvent.click(screen.getByTestId('button-role-auditor-otro@demo.example'));
    expect(onMutate).toHaveBeenCalledWith({ sub: OTHER, data: { roles: ['auditor'] } });
  });

  it('7. quitar un rol envia la lista sin ese rol', async () => {
    const onMutate = vi.fn();
    arrange({ users: [userFixture({ sub: OTHER, email: 'otro@demo.example', roles: ['auditor', 'admin'] })], onMutate });
    await userEvent.click(screen.getByTestId('button-role-auditor-otro@demo.example'));
    expect(onMutate).toHaveBeenCalledWith({ sub: OTHER, data: { roles: ['admin'] } });
  });

  it('8. un admin no puede quitarse su propio rol admin (boton deshabilitado)', () => {
    arrange({ users: [userFixture()] });
    expect(screen.getByTestId('button-role-admin-admin@demo.example')).toBeDisabled();
  });

  it('9. la UI recuerda que el servidor impide retirar el rol al ultimo admin', () => {
    arrange({ users: [userFixture()] });
    expect(
      screen.getByText(/No es posible retirar el rol admin al último administrador\./),
    ).toBeInTheDocument();
  });

  it('10. un 403 del backend se muestra como aviso del ultimo admin', async () => {
    arrange({ users: [userFixture({ sub: OTHER, email: 'otro@demo.example', roles: [] })] });
    // onError real de la pagina: mapea 403 al mensaje de ultimo administrador.
    await act(async () => {
      rolesConfig.mutation?.onError?.({ status: 403 });
    });
    await waitFor(() => {
      expect(screen.getByTestId('text-users-error')).toHaveTextContent(
        'No puedes retirar el rol al último administrador.',
      );
    });
  });
});