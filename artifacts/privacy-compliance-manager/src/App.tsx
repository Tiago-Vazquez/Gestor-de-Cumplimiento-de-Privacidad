import { type ReactNode, useMemo } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/app-shell';
import { AuthProvider, useAuth } from '@/auth/auth-context';
import { FullScreenSpinner, ProtectedRoute } from '@/auth/protected-route';
import LoginPage from '@/pages/login';
import RegisterPage from '@/pages/register';
import DashboardPage from '@/pages/dashboard';
import FindingsPage from '@/pages/findings';
import SourcesPage from '@/pages/sources';
import RulesPage from '@/pages/rules';
import MaskingPage from '@/pages/masking';
import ReportsPage from '@/pages/reports';
import UsersPage from '@/pages/users';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Redirect,
  Router as WouterRouter,
} from 'wouter';
import { ApiError } from '@workspace/api-client-react';
import { notifySessionExpired } from '@/auth/session-events';
import { getAuthMeQueryKey } from '@workspace/api-client-react';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Un 401 nunca se reintenta: la sesión está rota, no es un fallo transitorio.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status === 401) return false;
          return failureCount < 3;
        },
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!(error instanceof ApiError) || error.status !== 401) return;
        // /api/auth/me ya maneja su propio 401 en AuthProvider; no notificamos
        // aquí para evitar un loop de invalidaciones.
        const key = query.queryKey;
        const isAuthMe = Array.isArray(key)
          ? key.some(
              (k) =>
                k === '/api/auth/me' ||
                (typeof k === 'object' && k !== null && 'me' in k),
            )
          : false;
        if (!isAuthMe) notifySessionExpired();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          notifySessionExpired();
        }
      },
    }),
  });
}

const queryClient = createQueryClient();

function Router() {
  const { isLoading, isUnauthorized, hasSystemError, isAuthenticated } = useAuth();
  const [location] = useLocation();

  // Esperando respuesta de /api/auth/me: pantalla de carga global.
  if (isLoading) return <FullScreenSpinner />;

  // Error del sistema (no 401): algo distinto a "no autenticado".
  if (hasSystemError) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="font-display text-lg font-bold text-foreground">No se pudo verificar la sesión.</p>
        <p className="text-sm text-muted-foreground">Recarga la página para intentarlo de nuevo.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-foreground px-4 py-2 text-xs font-bold text-background hover:-translate-y-0.5 transition-transform"
          data-testid="button-reload-auth"
        >
          Recargar
        </button>
      </div>
    );
  }

  // Sin sesión activa: solo /login es accesible; el resto redirige.
  if (isUnauthorized || !isAuthenticated) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/register" component={RegisterPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }

  // Autenticado: shell completo con rutas protegidas.
  // /login y /register no tienen sentido con sesión activa: redirigir al shell.
  const onAuthPage = location === '/login' || location === '/register';
  return (
    <AppShell>
      {onAuthPage && <Redirect to="/" />}
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/findings" component={FindingsPage} />
        <Route path="/sources" component={SourcesPage} />
        <Route path="/rules" component={RulesPage} />
        <Route path="/masking" component={MaskingPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/users" component={UsersPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <AuthGate>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <RoutedErrorBoundary>
                <Router />
              </RoutedErrorBoundary>
            </WouterRouter>
            <Toaster />
          </AuthGate>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Espera a que /api/auth/me se resuelva antes de renderizar el router. Esto
 * evita parpadeos de /login mientras se determina la sesión.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading } = useAuth();
  if (isLoading) return <FullScreenSpinner />;
  return children;
}

export default App;
