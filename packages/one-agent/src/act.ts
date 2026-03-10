#!/usr/bin/env node
import { runActCli } from "@one/act";
import { getServer } from "./tools.js";
import { startTracing } from "./tracing.js";

startTracing();

runActCli({ getServer }).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
