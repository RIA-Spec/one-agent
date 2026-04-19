import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  skipNodeModulesBundle: true,
  entry: [
    "src/index.ts",
    "src/model.ts",
    "src/tools.ts",
    "src/repl.ts",
    "src/stdio.ts",
    "src/reason.ts",
    "src/act.ts",
    "src/one-agent.ts",
  ],
});
