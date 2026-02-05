import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    execArgv: ["--experimental-wasm-stack-switching"],
    testTimeout: 60000,
  },
});
