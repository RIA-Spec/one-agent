import chalk from "chalk";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { trace } from "@opentelemetry/api";

const serviceName = process.env.OTEL_SERVICE_NAME || "one-agent";
const sigNozEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";

function isDebugEnabled(): boolean {
  const value = process.env.ONE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Configure the trace exporter for SigNoz
const traceExporter = new OTLPTraceExporter({
  url: sigNozEndpoint,
});

// Create OpenTelemetry SDK with SigNoz configuration
const sdk = new NodeSDK({
  serviceName,
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable some instrumentations if needed
      "@opentelemetry/instrumentation-fs": {
        enabled: false,
      },
    }),
  ],
});

let tracingStarted = false;
let tracingShutdownPromise: Promise<void> | null = null;

function isConnRefusedError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "");
  if (msg.includes("ECONNREFUSED")) return true;
  const nested = (error as { errors?: Array<{ code?: string }> })?.errors;
  return Array.isArray(nested) && nested.some((entry) => entry?.code === "ECONNREFUSED");
}

// Start the SDK
export function startTracing() {
  if (!isDebugEnabled()) {
    return;
  }

  try {
    sdk.start();
    tracingStarted = true;
    console.log(chalk.cyan(`OpenTelemetry tracing started for service: ${serviceName}`));
    console.log(chalk.cyan(`Exporting traces to SigNoz: ${sigNozEndpoint}`));
  } catch (error) {
    console.error(chalk.red("Error starting OpenTelemetry SDK:"), error);
  }
}

export async function shutdownTracing() {
  if (!tracingStarted) return;
  if (tracingShutdownPromise) return tracingShutdownPromise;

  tracingShutdownPromise = sdk
    .shutdown()
    .catch((error) => {
      if (!isConnRefusedError(error)) {
        console.error(chalk.red("Error shutting down OpenTelemetry SDK:"), error);
      }
    })
    .finally(() => {
      tracingStarted = false;
    });

  await tracingShutdownPromise;
}

// Gracefully shutdown on process exit
process.on("SIGTERM", () => {
  shutdownTracing()
    .then(() => console.log(chalk.green("OpenTelemetry SDK shut down successfully")))
    .finally(() => process.exit(0));
});

// Get a tracer for manual instrumentation
export function getTracer(name = "ai-sdk") {
  return trace.getTracer(name);
}
