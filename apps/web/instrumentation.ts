import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: "one-agent-web" });
}
