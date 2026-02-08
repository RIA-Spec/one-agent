import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  entry: ["src/index.ts", "src/repl.ts", "src/stdio.ts"],
});
