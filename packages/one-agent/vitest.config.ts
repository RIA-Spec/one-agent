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
    setupFiles: ["./tests/setup.ts"],
  },
});
