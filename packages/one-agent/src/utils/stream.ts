import type { StreamTextResult } from "ai";
import { createStreamLogger } from "./stream-log.js";

export async function processStream(result: StreamTextResult<any, any>, prefix?: string) {
  const streamLogger = createStreamLogger();
  const linePrefix = prefix ? `[${prefix.toUpperCase()}] ` : "";

  for await (const chunk of result.fullStream) {
    for (const line of streamLogger.logChunk(chunk)) {
      console.log(linePrefix + line);
    }
  }

  for (const line of streamLogger.flush()) {
    console.log(linePrefix + line);
  }
  console.log("");
}
