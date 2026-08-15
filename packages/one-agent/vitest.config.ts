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
    // Deno/Pyodide cold starts are slow on CI; retry once before failing.
    retry: 1,
    setupFiles: ["./tests/setup.ts"],
  },
});
