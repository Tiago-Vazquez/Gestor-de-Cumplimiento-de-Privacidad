import { useState, type FormEvent } from "react";
import { Link } from "wouter";

/**
 * M30.0 — Recuperación de contraseña, paso 2: fijar la nueva contraseña.
 *
 * El token viaja en la query (`?token=`) y NO se guarda en storage: un enlace
 * de recuperación es de un solo uso y no debe sobrevivir a la pestaña.
 *
 * El backend responde 400 con el MISMO texto para token inexistente, expirado
 * o ya usado. No se distingue aquí a propósito: hacerlo convertiría la pantalla
 * en un oráculo sobre tokens ya filtrados.
 */
export default function ResetPasswordPage() {
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirm) {
      setError("Las contrasenas no coinciden");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!res.ok) throw new Error("reset failed");
      setMessage("Contrasena actualizada. Todas tus sesiones se cerraron.");
      setPassword("");
      setConfirm("");
    } catch {
      setError("El enlace no es valido o ha caducado");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-noise flex min-h-[100dvh] items-center justify-center bg-background px-5">
      <div className="w-full max-w-[420px]">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-card-border bg-card p-7 shadow-[var(--shadow-card)]"
          data-testid="form-reset-password"
        >
          <h1 className="font-display text-[22px] font-bold tracking-[-0.03em] text-foreground">
            Nueva contrasena
          </h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            Al cambiarla se cierran todas tus sesiones abiertas.
          </p>

          {message ? (
            <p className="mt-6 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground" data-testid="reset-success">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground" data-testid="reset-error">
              {error}
            </p>
          ) : null}

          <label htmlFor="reset-token" className="label-caps mt-6 block">Token</label>
          <input
            id="reset-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="field-input mt-2"
            autoComplete="one-time-code"
            required
          />

          <label htmlFor="reset-password" className="label-caps mt-5 block">Nueva contrasena</label>
          <input
            id="reset-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input mt-2"
            autoComplete="new-password"
            minLength={12}
            required
          />

          <label htmlFor="reset-confirm" className="label-caps mt-5 block">Repetir contrasena</label>
          <input
            id="reset-confirm"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="field-input mt-2"
            autoComplete="new-password"
            minLength={12}
            required
          />

          <button type="submit" disabled={loading} className="btn-primary mt-7 w-full" data-testid="button-reset-password">
            {loading ? "Guardando…" : "Guardar contrasena"}
          </button>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link href="/login" className="underline">Volver a acceso</Link>
          </p>
        </form>
      </div>
    </div>
  );
}