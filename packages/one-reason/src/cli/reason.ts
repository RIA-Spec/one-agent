#!/usr/bin/env node
import { runReasonCli } from "../run-cli.js";

runReasonCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
