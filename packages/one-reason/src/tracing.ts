import { trace } from "@opentelemetry/api";

export function getTracer(name = "ai-sdk") {
  return trace.getTracer(name);
}
