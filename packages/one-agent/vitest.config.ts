import { defineConfig } from "vitest/config";

// Load .env so forked worker processes inherit the env vars
try {
  process.loadEnvFile(".env");
} catch {}

export default defineConfig({
  test: {
    pool: "forks",
    execArgv: ["--experimental-wasm-stack-switching"],
    testTimeout: 60000,
    // Deno/Pyodide cold starts are slow on CI; retry once there, but keep
    // local runs retry-free so flaky regressions surface immediately.
    retry: process.env.CI ? 1 : 0,
    setupFiles: ["./tests/setup.ts"],
  },
});
