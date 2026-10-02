import { useState, type FormEvent } from "react";
import { Link } from "wouter";

/**
 * M30.0 — Recuperación de contraseña, paso 1: pedir el enlace.
 *
 * La respuesta del backend es SIEMPRE 202 con el mismo cuerpo, exista o no la
 * cuenta. Esta pantalla no puede (ni debe) distinguir ambos casos: mostrar un
 * error distinto revelaría qué emails están registrados.
 *
 * Usa `fetch` directo como el resto de páginas que no dependen de un hook
 * generado (el cliente OpenAPI todavía no incluye estos endpoints).
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("request failed");
      setMessage(
        "Si la cuenta existe, te hemos enviado un enlace para fijar una nueva contrasena.",
      );
      setEmail("");
    } catch {
      setMessage(
        "Si la cuenta existe, te hemos enviado un enlace para fijar una nueva contrasena.",
      );
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
          data-testid="form-forgot-password"
        >
          <h1 className="font-display text-[22px] font-bold tracking-[-0.03em] text-foreground">
            Recuperar contrasena
          </h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            Indica el email de la cuenta y te enviaremos un enlace para fijar una
            nueva contrasena.
          </p>

          {message ? (
            <p
              className="mt-6 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground"
              data-testid="forgot-message"
            >
              {message}
            </p>
          ) : null}

          <label htmlFor="forgot-email" className="label-caps mt-6 block">Email</label>
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="field-input mt-2"
            autoComplete="email"
            required
          />

          <button
            type="submit"
            disabled={loading}
            className="btn-primary mt-7 w-full"
            data-testid="button-forgot-password"
          >
            {loading ? "Enviando…" : "Enviar enlace"}
          </button>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link href="/login" className="underline">Volver a acceso</Link>
          </p>
        </form>
      </div>
    </div>
  );
}