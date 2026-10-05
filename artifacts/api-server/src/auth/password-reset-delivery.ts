import { logger } from "../lib/logger";

/**
 * M31.0 — Entrega real del enlace de recuperación de contraseña vía Resend.
 *
 * Sustituye el seam por comando shell de M30.0 por un adapter HTTP que usa
 * `fetch` nativo de Node 22. Sin dependencias nuevas.
 *
 * Contrato público preservado: `deliverResetLink(input): Promise<boolean>`.
 * El handler de `POST /auth/password/forgot` NO conoce a Resend: solo pide
 * "entregar este enlace a este email" y recibe `true`/`false`.
 *
 * Semántica de fallo (idéntica al seam anterior):
 * - configuración ausente (`RESEND_API_KEY` o `PASSWORD_RESET_FROM`) → `false`;
 * - HTTP 2xx → `true`;
 * - HTTP no-2xx → `false`;
 * - error de red/fetch → `false`.
 *
 * El fallo de entrega NUNCA cambia la respuesta del endpoint (202 indistinguible):
 * el handler ignora el booleano. No hay enumeración de cuentas por esta vía.
 *
 * Seguridad:
 * - la API key viaja solo en la cabecera `Authorization` y nunca se registra;
 * - el `resetUrl` (que contiene el token) nunca se registra;
 * - solo se registra el `email` destinatario y, en su caso, el status HTTP.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

/** Configuración de Resend leída en tiempo de llamada (nunca en la imagen). */
function resendDeliveryConfig(): { apiKey: string; from: string } {
  return {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.PASSWORD_RESET_FROM ?? "",
  };
}

/**
 * Entrega el enlace de recuperación a través de Resend.
 *
 * Devuelve `true` solo cuando Resend acepta el correo (HTTP 2xx). Cualquier
 * otra condición devuelve `false`; nunca lanza.
 */
export async function deliverResetLink(input: {
  email: string;
  resetUrl: string;
  expiresAt: Date;
}): Promise<boolean> {
  const { apiKey, from } = resendDeliveryConfig();
  if (apiKey === "" || from === "") return false;

  const body = JSON.stringify({
    from,
    to: [input.email],
    subject: "Recupera tu contrasena",
    html:
      `<p>Hemos recibido una solicitud para restablecer tu contrasena.</p>` +
      `<p><a href="${input.resetUrl}">Restablecer contrasena</a></p>` +
      `<p>Si no la solicitaste, ignora este correo.</p>`,
    text:
      `Hemos recibido una solicitud para restablecer tu contrasena. ` +
      `Abre este enlace para continuar:\n\n${input.resetUrl}\n\n` +
      `Si no la solicitaste, ignora este correo.`,
  });

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (response.ok) return true;

    logger.error(
      { email: input.email, status: response.status },
      "password reset: email provider rejected the delivery",
    );
    return false;
  } catch {
    logger.error({ email: input.email }, "password reset: email delivery failed");
    return false;
  }
}