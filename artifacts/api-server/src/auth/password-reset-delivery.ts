import { spawn } from "node:child_process";
import pino from "pino";

/**
 * M30.0 — Seam de entrega del enlace de recuperación de contraseña.
 *
 * El enlace NO se envía por correo: este repositorio no integra SMTP ni
 * proveedores externos. En su lugar hay un seam con el mismo enfoque que
 * `scripts/ops/lib/alert.sh` (M29.2): un COMANDO definido por el entorno que
 * recibe el enlace por stdin.
 *
 * - Sin `PASSWORD_RESET_DELIVERY_CMD` definido no hay entrega (silencioso).
 * - Si el comando falla, el fallo se registra y NO se propaga: un canal roto
 *   nunca puede convertir un reset válido en un error 500.
 * - En desarrollo basta `PASSWORD_RESET_DELIVERY_CMD=cat` para leer el enlace.
 *
 * El enlace viaja por stdin y NUNCA como argumento, para que no quede
 * expuesto en la tabla de procesos del servidor.
 */

const DELIVERY_CMD = process.env.PASSWORD_RESET_DELIVERY_CMD ?? "";
const logger = pino({ name: "password-reset-delivery" });

/**
 * Entrega el enlace. Nunca lanza y nunca propaga un fallo del canal: el
 * resultado del reset depende del token, no del transporte.
 *
 * Devuelve `true` si el enlace salió por el seam, `false` si no había canal
 * configurado o si el comando falló.
 */
export async function deliverResetLink(input: {
  email: string;
  resetUrl: string;
  expiresAt: Date;
}): Promise<boolean> {
  if (DELIVERY_CMD === "") return false;

  const payload = JSON.stringify({
    to: input.email,
    url: input.resetUrl,
    expiresAt: input.expiresAt.toISOString(),
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const child = spawn(DELIVERY_CMD, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {
        logger.error({ email: input.email }, "password reset: delivery command could not start");
        finish(false);
      });
      child.on("close", (code) => {
        if (code === 0) finish(true);
        else {
          logger.error(
            { email: input.email, exitCode: code },
            "password reset: delivery command failed; the link was NOT delivered",
          );
          finish(false);
        }
      });
      // El hijo puede cerrar su stdin antes de que terminemos de escribir (por
      // ejemplo, si el comando no consume la entrada). Sin este listener, Node
      // emite un `Unhandled 'error' event` y MATA el proceso: el cliente recibiría
      // un 5xx en lugar del 202 uniforme, lo que además rompería la garantía
      // anti-enumeración de `/password/forgot`. El error de escritura se ignora a
      // propósito; el resultado del reset depende del token, no del transporte, y
      // el `close` de más abajo ya determina el desenlace.
      child.stdin?.on("error", () => {});
      child.stdin?.end(payload);
    } catch {
      finish(false);
    }
  });
}