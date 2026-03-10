#!/usr/bin/env node
import { runReasonCli } from "@one/reason";
import { startTracing } from "./tracing.js";

startTracing();

runReasonCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
