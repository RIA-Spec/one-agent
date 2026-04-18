#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getServer } from "./tools.js";
import { startTracing } from "./tracing.js";

// Initialize OpenTelemetry tracing
await startTracing();

const server = await getServer();
const transport = new StdioServerTransport();
await server.connect(transport);
