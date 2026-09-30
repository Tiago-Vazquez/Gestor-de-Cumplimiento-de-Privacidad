import { defineConfig } from "drizzle-kit";

// M22 (P0-1) — las migraciones y el provisioning usan la conexión de
// SUPERUSUARIO (`privacy`), separada de la conexión de aplicación (`DATABASE_URL`
// → app_role) y de la de background (`BG_DATABASE_URL` → bg_role). Así `privacy`
// nunca llega al entorno de runtime de la API (least privilege).
if (!process.env.ADMIN_DATABASE_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL (superuser/privacy) is required for migrations and provisioning",
  );
}

// Relative paths resolve against this package directory (pnpm sets the script
// cwd to lib/db), which keeps the config portable across workspaces/OSes.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.ADMIN_DATABASE_URL,
  },
});
