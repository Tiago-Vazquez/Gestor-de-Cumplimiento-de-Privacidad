import type { ReactNode } from 'react';
import { Redirect, useLocation } from 'wouter';
import { useAuth } from './auth-context';

export function FullScreenSpinner() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background">
      <div className="skeleton h-10 w-10 rounded-full" data-testid="spinner-auth" />
    </div>
  );
}

/**
 * Envuelve rutas que requieren sesión activa. Si no está autenticado
 * redirige a /login conservando la ruta solicitada en el hash.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, isUnauthorized } = useAuth();
  const [location] = useLocation();

  if (isLoading) return <FullScreenSpinner />;

  if (isUnauthorized || !isAuthenticated) {
    if (location !== '/login') {
      return <Redirect to="/login" />;
    }
    return null;
  }

  return children;
}