import chalk from "chalk";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { trace } from "@opentelemetry/api";

const serviceName = process.env.OTEL_SERVICE_NAME || "one-agent";
const sigNozEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";

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

// Start the SDK
export function startTracing() {
  try {
    sdk.start();
    console.log(chalk.cyan(`OpenTelemetry tracing started for service: ${serviceName}`));
    console.log(chalk.cyan(`Exporting traces to SigNoz: ${sigNozEndpoint}`));
  } catch (error) {
    console.error(chalk.red("Error starting OpenTelemetry SDK:"), error);
  }
}

// Gracefully shutdown on process exit
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log(chalk.green("OpenTelemetry SDK shut down successfully")))
    .catch((error) => console.error(chalk.red("Error shutting down OpenTelemetry SDK:"), error))
    .finally(() => process.exit(0));
});

// Get a tracer for manual instrumentation
export function getTracer(name = "ai-sdk") {
  return trace.getTracer(name);
}
