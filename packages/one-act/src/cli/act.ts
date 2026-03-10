#!/usr/bin/env node
import { runActCli } from "../act.js";

runActCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
