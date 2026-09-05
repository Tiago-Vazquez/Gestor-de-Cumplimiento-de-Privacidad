import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { CheckCircle2, ShieldCheck, UserPlus } from 'lucide-react';
import { ApiError, useAuthRegister } from '@workspace/api-client-react';

/** Política de contraseñas del backend, espejada en el cliente. */
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mensajes genéricos: no revelan detalles internos del backend. */
function registerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'Datos inválidos. La contraseña debe tener al menos 12 caracteres.';
    if (error.status === 409) return 'Ese email ya está registrado. Inicia sesión con tu cuenta.';
    if (error.status === 429) return 'Demasiados intentos. Espera unos minutos antes de reintentar.';
  }
  return 'No se pudo completar el registro. Intenta de nuevo.';
}

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
}

export default function RegisterPage() {
  const registerMutation = useAuthRegister();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  /** Email de la cuenta creada: al setearse se muestra la confirmación. */
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (name.length > 120) errors.name = 'El nombre es demasiado largo.';
    if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Introduce un email válido.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    }
    if (confirm !== password) errors.confirm = 'Las contraseñas no coinciden.';
    return errors;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Previene doble submit.
    if (registerMutation.isPending) return;
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setMessage('');
    // El rol lo decide el backend (auditor); el cliente no envía privilegios.
    // Sin auto-login: el registro no abre sesión, solo confirma la creación.
    registerMutation.mutate(
      {
        data: {
          email: email.trim().toLowerCase(),
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
        },
      },
      {
        onSuccess: (user) => setCreatedEmail(user.email ?? ''),
        onError: (error) => setMessage(registerErrorMessage(error)),
      },
    );
  };

  // Confirmación post-registro: sin sesión activa, solo acceso a /login.
  if (createdEmail !== null) {
    return (
      <div className="app-noise flex min-h-[100dvh] items-center justify-center bg-background px-5">
        <div className="w-full max-w-[420px]">
          <div
            className="rounded-2xl border border-card-border bg-card p-7 text-center shadow-[var(--shadow-card)]"
            data-testid="card-register-success"
          >
            <CheckCircle2 size={36} strokeWidth={2} className="mx-auto text-primary" />
            <h1 className="mt-4 font-display text-[22px] font-bold tracking-[-0.03em] text-foreground">Cuenta creada</h1>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              La cuenta para <span className="font-semibold text-foreground" data-testid="text-created-email">{createdEmail}</span> fue
              creada correctamente. Ya puedes iniciar sesión con tus credenciales.
            </p>
            <Link
              href="/login"
              className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-foreground text-xs font-bold text-background transition-transform hover:-translate-y-0.5"
              data-testid="link-go-login"
            >
              Iniciar sesión
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
          noValidate
          className="rounded-2xl border border-card-border bg-card p-7 shadow-[var(--shadow-card)]"
          data-testid="form-register"
        >
          <h1 className="font-display text-[22px] font-bold tracking-[-0.03em] text-foreground">Crear cuenta</h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">Regístrate para acceder a la consola de cumplimiento.</p>

          <label htmlFor="register-name" className="label-caps mt-6 block">Nombre (opcional)</label>
          <input
            id="register-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tu nombre"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-register-name"
            autoFocus
          />
          {fieldErrors.name && <p className="mt-1.5 text-xs font-semibold text-[#b14e43]">{fieldErrors.name}</p>}

          <label htmlFor="register-email" className="label-caps mt-4 block">Email</label>
          <input
            id="register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="tu@empresa.com"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-register-email"
          />
          {fieldErrors.email && <p className="mt-1.5 text-xs font-semibold text-[#b14e43]">{fieldErrors.email}</p>}

          <label htmlFor="register-password" className="label-caps mt-4 block">Contraseña</label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-register-password"
          />
          {fieldErrors.password && <p className="mt-1.5 text-xs font-semibold text-[#b14e43]">{fieldErrors.password}</p>}

          <label htmlFor="register-confirm" className="label-caps mt-4 block">Confirmar contraseña</label>
          <input
            id="register-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="Repite la contraseña"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
            data-testid="input-register-confirm"
          />
          {fieldErrors.confirm && <p className="mt-1.5 text-xs font-semibold text-[#b14e43]">{fieldErrors.confirm}</p>}

          {message && (
            <p className="mt-3 rounded-lg border border-[#edc5bd] bg-[#fff8f6] px-3 py-2 text-xs font-semibold text-[#b14e43]" data-testid="text-register-error">
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={registerMutation.isPending}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-foreground text-xs font-bold text-background transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-45"
            data-testid="button-register"
          >
            {registerMutation.isPending ? 'Creando cuenta…' : 'Crear cuenta'}
            {registerMutation.isPending ? <span className="skeleton h-4 w-4 rounded-full" /> : <UserPlus size={15} />}
          </button>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            ¿Ya tienes cuenta?{' '}
            <Link href="/login" className="font-semibold text-primary hover:underline" data-testid="link-login">
              Inicia sesión
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