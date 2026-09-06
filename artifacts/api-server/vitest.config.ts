import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Hardening 6.3B.23 (F23-01): las suites inyectan X-Forwarded-For para
    // aislar buckets por IP de test. Eso solo funciona si el server confía
    // explícitamente en el proxy de borde. En produccion el default es
    // `TRUST_PROXY=false` (fail-closed, ver app.ts:resolveTrustProxy); aqui
    // habilitamos el modo "detras de proxy de confianza", que es la topologia
    // realista para la que está dimensionado el rate limiting.
    env: {
      TRUST_PROXY: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});