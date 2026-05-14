import chalk from "chalk";
import { trace } from "@opentelemetry/api";

const serviceName = process.env.OTEL_SERVICE_NAME || "one-agent";
const sigNozEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";

function isDebugEnabled(): boolean {
  const value = process.env.ONE_AGENT_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

type TracingSdk = {
  start(): void | Promise<void>;
  shutdown(): Promise<void>;
};

let tracingStarted = false;
let tracingStartPromise: Promise<void> | null = null;
let tracingShutdownPromise: Promise<void> | null = null;
let sdkPromise: Promise<TracingSdk> | null = null;

async function getSdk(): Promise<TracingSdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [{ NodeSDK }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }] =
        await Promise.all([
          import("@opentelemetry/sdk-node"),
          import("@opentelemetry/exporter-trace-otlp-http"),
          import("@opentelemetry/auto-instrumentations-node"),
        ]);

      const traceExporter = new OTLPTraceExporter({
        url: sigNozEndpoint,
      });

      return new NodeSDK({
        serviceName,
        traceExporter,
        instrumentations: [
          getNodeAutoInstrumentations({
            "@opentelemetry/instrumentation-fs": {
              enabled: false,
            },
          }),
        ],
      }) as TracingSdk;
    })();
  }

  return sdkPromise;
}

function isConnRefusedError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "");
  if (msg.includes("ECONNREFUSED")) return true;
  const nested = (error as { errors?: Array<{ code?: string }> })?.errors;
  return Array.isArray(nested) && nested.some((entry) => entry?.code === "ECONNREFUSED");
}

// Start the SDK
export async function startTracing() {
  if (!isDebugEnabled()) {
    return;
  }

  if (tracingStarted) {
    return;
  }

  if (tracingStartPromise) {
    return tracingStartPromise;
  }

  tracingStartPromise = (async () => {
    try {
      const sdk = await getSdk();
      await sdk.start();
      tracingStarted = true;
    } catch (error) {
      console.error(chalk.red("Error starting OpenTelemetry SDK:"), error);
    } finally {
      tracingStartPromise = null;
    }
  })();

  return tracingStartPromise;
}

export async function shutdownTracing() {
  if (!tracingStarted) return;
  if (tracingShutdownPromise) return tracingShutdownPromise;

  const sdk = await getSdk();
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
