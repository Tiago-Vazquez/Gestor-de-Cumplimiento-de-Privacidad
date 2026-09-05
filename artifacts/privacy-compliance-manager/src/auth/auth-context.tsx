import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAuthMeQueryKey,
  useAuthLogin,
  useAuthLogout,
  useAuthMe,
} from '@workspace/api-client-react';
import type { AuthLoginMutationError, AuthUser } from '@workspace/api-client-react';
import { onSessionExpired } from './session-events';

/** Callbacks opcionales para la mutación de login. */
export interface LoginCallbacks {
  /** Se invoca cuando POST /api/auth/login responde 2xx (cookie seteada). */
  onSuccess?: () => void;
  /** Se invoca si el servidor rechaza el token (400/401) o falla la red. */
  onError?: (error: AuthLoginMutationError) => void;
}

interface AuthContextValue {
  /** Identidad del usuario autenticado (null si no lo está). */
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** True cuando /api/auth/me respondió 401 (sesión inexistente o expirada). */
  isUnauthorized: boolean;
  /** True cuando /api/auth/me falló por una razón distinta a 401. */
  hasSystemError: boolean;
  /**
   * Dispara POST /api/auth/login con email + password (login local). La
   * mutación generada por Orval espera la variable `{ data: AuthLoginInput }`.
   * El bootstrap token sigue soportado por el backend como mecanismo legacy
   * temporal, pero la UI ya no lo utiliza ni lo solicita.
   */
  login: (email: string, password: string, callbacks?: LoginCallbacks) => void;
  /** Roles del usuario autenticado (p.ej. ['admin']) o lista vacía. */
  roles: string[];
  /** true cuando el usuario autenticado tiene el rol admin. */
  isAdmin: boolean;
  /** Dispara POST /api/auth/logout y limpia el estado cacheado. */
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // Suscripción al bus de eventos: cuando cualquier query reciba 401,
  // invalidamos /api/auth/me para que el router redirija a /login.
  useEffect(() => {
    return onSessionExpired(() => {
      queryClient.invalidateQueries({ queryKey: getAuthMeQueryKey() });
    });
  }, [queryClient]);

  // Sin reintentos: un 401 (sesión ausente/expirada) se resuelve de inmediato
  // hacia /login en vez de acumular el backoff por defecto de React Query.
  const meQuery = useAuthMe({
    query: {
      queryKey: getAuthMeQueryKey(),
      retry: false,
    },
  });

  // Un 401 significa "no autenticado" (flujo normal), no un error del sistema.
  const meError = meQuery.error as { status?: number } | null;
  const isUnauthorized = meQuery.isError && meError?.status === 401;
  const hasSystemError = meQuery.isError && !isUnauthorized;

  const loginMutation = useAuthLogin({
    mutation: {
      onSuccess: () => {
        // El JWT llegó (cookie httpOnly seteada); refrescar identidad.
        queryClient.invalidateQueries({ queryKey: getAuthMeQueryKey() });
      },
    },
  });

  const logoutMutation = useAuthLogout({
    mutation: {
      onSuccess: () => {
        // Limpiar todo el caché: los datos de la sesión anterior no deben
        // sobrevivir al cierre de sesión.
        queryClient.clear();
      },
    },
  });

  const value: AuthContextValue = {
    user: meQuery.data ?? null,
    isAuthenticated: meQuery.isSuccess,
    isLoading: meQuery.isLoading,
    isUnauthorized,
    hasSystemError,
    roles: meQuery.data?.roles ?? [],
    isAdmin: (meQuery.data?.roles ?? []).includes('admin'),
    login: (email: string, password: string, callbacks?: LoginCallbacks) => {
      loginMutation.mutate({ data: { email, password } }, callbacks);
    },
    logout: () => logoutMutation.mutate(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}