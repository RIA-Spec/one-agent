import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const logDir = process.env.AIYO_LOG_DIR ?? join(homedir(), ".aiyo", "logs");
mkdirSync(logDir, { recursive: true });

const logFile = join(logDir, `aiyo-${new Date().toISOString().slice(0, 10)}.log`);

const quiet = process.env.AIYO_QUIET === "true" || process.argv.includes("launch");

const streams: pino.StreamEntry[] = [
  {
    stream: pino.destination({ dest: logFile, sync: false }),
    level: "debug" as const,
  },
];

if (!quiet) {
  streams.unshift({
    stream: pino.transport({
      target: "pino-pretty",
      options: { colorize: true, sync: true, destination: 2 },
    }),
    level: "info" as const,
  });
}

export const logger = pino(
  {
    level: process.env.AIYO_LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams),
);

export { logFile };
