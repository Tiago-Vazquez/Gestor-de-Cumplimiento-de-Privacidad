import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { LogIn, ShieldCheck } from 'lucide-react';
import { ApiError } from '@workspace/api-client-react';
import { useAuth } from '@/auth/auth-context';

/**
 * Mensajes de error genéricos: nunca revelan si el email existe, si el
 * usuario tiene password asignada ni detalles internos del backend.
 */
function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'Datos inválidos. Revisa los campos e intenta de nuevo.';
    if (error.status === 401) return 'Credenciales inválidas. Verifica tu email y contraseña.';
    if (error.status === 429) return 'Demasiados intentos. Espera unos minutos antes de reintentar.';
  }
  return 'No se pudo iniciar sesión. Intenta de nuevo.';
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Previene doble submit y envíos vacíos.
    if (!email.trim() || !password || loading) return;
    setMessage('');
    setLoading(true);
    // La normalización definitiva del email la hace el backend; aquí solo
    // se recortan espacios. La contraseña no se persiste en ningún
    // almacenamiento local (el JWT vive en una cookie httpOnly).
    login(email.trim().toLowerCase(), password, {
      onSuccess: () => {
        // La identidad se refrescó; el Router re-renderiza el shell autenticado.
        setLocation('/');
      },
      onError: (error) => {
        setMessage(loginErrorMessage(error));
        setLoading(false);
      },
    });
  };

  return (
    <div className="app-noise flex min-h-[100dvh] items-center justify-center bg-background px-5">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="relative grid h-11 w-11 place-items-center rounded-[13px] bg-sidebar-primary text-sidebar-primary-foreground shadow-lg shadow-teal-950/20">
            <ShieldCheck size={24} strokeWidth={2.2} />
            <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[#efb34f] ring-2 ring-sidebar" />
          </span>
          <div>
            <span className="block font-display text-[17px] font-bold tracking-[-0.02em] text-white">Sentinel</span>
            <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">privacy control</span>
          </div>
        </div>
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-card-border bg-card p-7 shadow-[var(--shadow-card)]"
          data-testid="form-login"
        >
          <h1 className="font-display text-[22px] font-bold tracking-[-0.03em] text-foreground">Acceso restringido</h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">Introduce tus credenciales para entrar a la consola de cumplimiento.</p>
          <label htmlFor="login-email" className="label-caps mt-6 block">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="tu@empresa.com"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-login-email"
            autoFocus
          />
          <label htmlFor="login-password" className="label-caps mt-4 block">Contraseña</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••••"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-login-password"
          />
          {message && (
            <p className="mt-3 rounded-lg border border-[#edc5bd] bg-[#fff8f6] px-3 py-2 text-xs font-semibold text-[#b14e43]" data-testid="text-login-error">
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={loading || !email.trim() || !password}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-foreground text-xs font-bold text-background transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-45"
            data-testid="button-login"
          >
            {loading ? 'Validando…' : 'Iniciar sesión'}
            {loading ? <span className="skeleton h-4 w-4 rounded-full" /> : <LogIn size={15} />}
          </button>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            ¿No tienes cuenta?{' '}
            <Link href="/register" className="font-semibold text-primary hover:underline" data-testid="link-register">
              Regístrate
            </Link>
          </p>
        </form>
        <p className="mt-5 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/40">
          Acceso administrativo · Sentinel privacy
        </p>
      </div>
    </div>
  );
}