import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  entry: ["src/index.ts", "src/run-cli.ts", "src/bin.ts"],
});