import type { McpServerConfig } from "@mcpc-tech/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { getOneConfigPath } from "./config-path.js";

const ACT_DAEMON_HOST = "127.0.0.1";
const ACT_DAEMON_STATE_PATH = getOneConfigPath("act-daemon.json");
export const ACT_DAEMON_LOG_PATH = getOneConfigPath("act-daemon.log");
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_STOP_TIMEOUT_MS = 5_000;
const DAEMON_POLL_INTERVAL_MS = 100;
const DAEMON_HEALTH_TIMEOUT_MS = 3_000;
const DAEMON_CONTROL_TIMEOUT_MS = 5_000;
const DAEMON_INVOKE_TIMEOUT_MS = 300_000;

type ActDaemonState = {
  version: 1;
  pid: number;
  port: number;
  token: string;
  configHash: string;
  startedAt: string;
};

type ActDaemonHealth = {
  pid: number;
  port: number;
  configHash: string;
  startedAt: string;
};

type ActDaemonInvokePayload =
  | {
      kind: "manual-list";
      forceJson: boolean;
    }
  | {
      kind: "manual-tool";
      name: string;
    }
  | {
      kind: "call-tool";
      name: string;
      args: unknown;
    };

export type OneActMcpServerConfig = McpServerConfig & {
  daemon?: boolean;
  /** Set to "oauth" to enable OAuth 2.1 PKCE authentication for this server. */
  auth?: "oauth";
};

export type McpServersConfig = Record<string, OneActMcpServerConfig>;

export type PlainMcpServersConfig = Record<string, McpServerConfig>;

export type ActDaemonSpawnOptions = {
  execPath: string;
  execArgv: string[];
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
};

export type ActDaemonStatus = {
  running: boolean;
  healthy: boolean;
  reason: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  configHash?: string;
};

export type ActDaemonClient = {
  formatManualList: (forceJson: boolean) => Promise<string>;
  formatManualTool: (name: string) => Promise<string>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
};

export type ActDaemonHandlers = {
  formatManualList: (forceJson: boolean) => string;
  formatManualTool: (name: string) => string;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, sortValue(value[key])]),
    );
  }

  return value;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isActDaemonState(value: unknown): value is ActDaemonState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    typeof value.token === "string" &&
    Boolean(value.token) &&
    typeof value.configHash === "string" &&
    Boolean(value.configHash) &&
    typeof value.startedAt === "string" &&
    Boolean(value.startedAt)
  );
}

function readActDaemonState(): ActDaemonState | null {
  if (!existsSync(ACT_DAEMON_STATE_PATH)) return null;

  try {
    const parsed = JSON.parse(readFileSync(ACT_DAEMON_STATE_PATH, "utf-8"));
    return isActDaemonState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeActDaemonState(state: ActDaemonState) {
  mkdirSync(dirname(ACT_DAEMON_STATE_PATH), { recursive: true });
  writeFileSync(ACT_DAEMON_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function removeActDaemonState(ownerPid?: number) {
  if (!existsSync(ACT_DAEMON_STATE_PATH)) return;

  if (typeof ownerPid === "number") {
    const currentState = readActDaemonState();
    if (currentState && currentState.pid !== ownerPid) {
      return;
    }
  }

  try {
    unlinkSync(ACT_DAEMON_STATE_PATH);
  } catch {
    // Ignore state cleanup failures.
  }
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function requestDaemon<T>(
  state: ActDaemonState,
  path: string,
  init?: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    "x-one-act-token": state.token,
    ...(init?.headers ?? {}),
  };

  const { timeoutMs, ...requestInit } = init ?? {};

  const response = await fetch(`http://${ACT_DAEMON_HOST}:${state.port}${path}`, {
    ...requestInit,
    headers,
    signal:
      requestInit.signal ??
      (typeof timeoutMs === "number" ? AbortSignal.timeout(timeoutMs) : undefined),
  });

  const bodyText = await response.text();
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : null;

  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : bodyText || `Daemon request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed as T;
}

async function readDaemonHealth(state: ActDaemonState): Promise<ActDaemonHealth> {
  return requestDaemon<ActDaemonHealth>(state, "/health", {
    method: "GET",
    timeoutMs: DAEMON_HEALTH_TIMEOUT_MS,
  });
}

async function waitForDaemonStatus(configHash: string): Promise<ActDaemonStatus> {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = await getActDaemonStatus(configHash);
    if (status.running && status.healthy) {
      return status;
    }

    await delay(DAEMON_POLL_INTERVAL_MS);
  }

  return getActDaemonStatus(configHash);
}

function spawnActDaemonProcess(options: ActDaemonSpawnOptions) {
  mkdirSync(dirname(ACT_DAEMON_LOG_PATH), { recursive: true });
  const logFd = openSync(ACT_DAEMON_LOG_PATH, "a");

  try {
    const child = spawn(
      options.execPath,
      [...options.execArgv, options.scriptPath, "daemon", "serve"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          ...(options.env ?? {}),
          ONE_ACT_DAEMON_CHILD: "1",
        },
      },
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

export function normalizeMcpServersForRuntime(mcpServers: McpServersConfig): PlainMcpServersConfig {
  return Object.fromEntries(
    Object.entries(selectEnabledMcpServers(mcpServers)).map(([name, config]) => {
      const { daemon: _daemon, auth: _auth, ...runtimeConfig } = config;
      return [name, runtimeConfig as McpServerConfig];
    }),
  );
}

export function selectEnabledMcpServers(mcpServers: McpServersConfig): McpServersConfig {
  return Object.fromEntries(
    Object.entries(mcpServers).filter(([, config]) =>
      Boolean(config && typeof config === "object" && config.disabled !== true),
    ),
  ) as McpServersConfig;
}

export function selectDaemonMcpServers(mcpServers: McpServersConfig): McpServersConfig {
  return Object.fromEntries(
    Object.entries(selectEnabledMcpServers(mcpServers)).filter(([, config]) =>
      Boolean(config && typeof config === "object" && config.daemon === true),
    ),
  ) as McpServersConfig;
}

export function computeDaemonConfigHash(mcpServers: McpServersConfig): string {
  const normalized = normalizeMcpServersForRuntime(selectDaemonMcpServers(mcpServers));
  return createHash("sha256")
    .update(JSON.stringify(sortValue(normalized)))
    .digest("hex");
}

export function isDaemonRuntimeEnabled(
  _actConfig: Record<string, unknown>,
  mcpServers: McpServersConfig,
): boolean {
  return Object.values(selectEnabledMcpServers(mcpServers)).some(
    (config) => config?.daemon === true,
  );
}

export async function getActDaemonStatus(configHash?: string): Promise<ActDaemonStatus> {
  const state = readActDaemonState();
  if (!state) {
    return { running: false, healthy: false, reason: "not-running" };
  }

  if (!isProcessRunning(state.pid)) {
    removeActDaemonState(state.pid);
    return { running: false, healthy: false, reason: "stale-state" };
  }

  try {
    const health = await readDaemonHealth(state);
    const healthy = configHash ? health.configHash === configHash : true;
    return {
      running: true,
      healthy,
      reason: healthy ? "running" : "config-mismatch",
      pid: health.pid,
      port: health.port,
      startedAt: health.startedAt,
      configHash: health.configHash,
    };
  } catch {
    return {
      running: false,
      healthy: false,
      reason: "unreachable",
      pid: state.pid,
      port: state.port,
      startedAt: state.startedAt,
      configHash: state.configHash,
    };
  }
}

export async function startActDaemon(
  spawnOptions: ActDaemonSpawnOptions,
  configHash: string,
): Promise<ActDaemonStatus> {
  const currentStatus = await getActDaemonStatus(configHash);
  if (currentStatus.running && currentStatus.healthy) {
    return currentStatus;
  }

  const existingState = readActDaemonState();
  if (existingState) {
    await stopActDaemon();
  }

  spawnActDaemonProcess(spawnOptions);

  const status = await waitForDaemonStatus(configHash);
  if (!status.running || !status.healthy) {
    throw new Error(
      `Failed to start one-act daemon${status.reason ? ` (${status.reason})` : ""}. See ${ACT_DAEMON_LOG_PATH}`,
    );
  }

  return status;
}

export async function ensureActDaemonClient(
  spawnOptions: ActDaemonSpawnOptions,
  configHash: string,
): Promise<ActDaemonClient> {
  const status = await getActDaemonStatus(configHash);
  if (!status.running || !status.healthy) {
    await startActDaemon(spawnOptions, configHash);
  }

  const state = readActDaemonState();
  if (!state) {
    throw new Error(`one-act daemon state missing after startup. See ${ACT_DAEMON_LOG_PATH}`);
  }

  return {
    formatManualList: async (forceJson: boolean) => {
      const response = await requestDaemon<{ value: string }>(state, "/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: DAEMON_INVOKE_TIMEOUT_MS,
        body: JSON.stringify({ kind: "manual-list", forceJson } satisfies ActDaemonInvokePayload),
      });
      return response.value;
    },
    formatManualTool: async (name: string) => {
      const response = await requestDaemon<{ value: string }>(state, "/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: DAEMON_INVOKE_TIMEOUT_MS,
        body: JSON.stringify({ kind: "manual-tool", name } satisfies ActDaemonInvokePayload),
      });
      return response.value;
    },
    callTool: async (name: string, args: unknown) => {
      const response = await requestDaemon<{ value: CallToolResult }>(state, "/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: DAEMON_INVOKE_TIMEOUT_MS,
        body: JSON.stringify({ kind: "call-tool", name, args } satisfies ActDaemonInvokePayload),
      });
      return response.value;
    },
  };
}

export async function stopActDaemon(): Promise<boolean> {
  const state = readActDaemonState();
  if (!state) return false;

  if (isProcessRunning(state.pid)) {
    try {
      await requestDaemon<{ stopping: boolean }>(state, "/shutdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        timeoutMs: DAEMON_CONTROL_TIMEOUT_MS,
      });
    } catch {
      // Fall back to process signals below.
    }

    const gracefulDeadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
    while (Date.now() < gracefulDeadline) {
      if (!isProcessRunning(state.pid)) {
        removeActDaemonState(state.pid);
        return true;
      }

      await delay(DAEMON_POLL_INTERVAL_MS);
    }

    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Ignore signal delivery errors.
    }

    const termDeadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
    while (Date.now() < termDeadline) {
      if (!isProcessRunning(state.pid)) {
        removeActDaemonState(state.pid);
        return true;
      }

      await delay(DAEMON_POLL_INTERVAL_MS);
    }

    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      // Ignore signal delivery errors.
    }
  }

  removeActDaemonState(state.pid);
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return {};
  return JSON.parse(text);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function authorizeRequest(request: IncomingMessage, token: string) {
  return request.headers["x-one-act-token"] === token;
}

export async function runActDaemonServer(options: {
  configHash: string;
  handlers: ActDaemonHandlers;
}) {
  const token = randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  let shuttingDown = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removeActDaemonState(process.pid);
  };

  const server = createServer(async (request, response) => {
    try {
      if (!authorizeRequest(request, token)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const url = request.url ?? "/";
      if (request.method === "GET" && url === "/health") {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Daemon server address unavailable");
        }

        writeJson(response, 200, {
          pid: process.pid,
          port: address.port,
          configHash: options.configHash,
          startedAt,
        } satisfies ActDaemonHealth);
        return;
      }

      if (request.method === "POST" && url === "/invoke") {
        const payload = await readJsonBody(request);
        if (!isRecord(payload) || typeof payload.kind !== "string") {
          writeJson(response, 400, { error: "Invalid daemon request payload" });
          return;
        }

        let value: unknown;
        switch (payload.kind) {
          case "manual-list":
            value = options.handlers.formatManualList(Boolean(payload.forceJson));
            break;
          case "manual-tool":
            if (typeof payload.name !== "string" || !payload.name.trim()) {
              writeJson(response, 400, { error: "manual-tool requires a tool name" });
              return;
            }
            value = options.handlers.formatManualTool(payload.name);
            break;
          case "call-tool":
            if (typeof payload.name !== "string" || !payload.name.trim()) {
              writeJson(response, 400, { error: "call-tool requires a tool name" });
              return;
            }
            value = await options.handlers.callTool(payload.name, payload.args);
            break;
          default:
            writeJson(response, 400, { error: `Unknown daemon request kind: ${payload.kind}` });
            return;
        }

        writeJson(response, 200, { value });
        return;
      }

      if (request.method === "POST" && url === "/shutdown") {
        writeJson(response, 200, { stopping: true });
        setImmediate(() => {
          void shutdown();
        });
        return;
      }

      writeJson(response, 404, { error: `Unknown daemon endpoint: ${url}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: message });
    }
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await options.handlers.close();
    } catch {
      // Keep shutdown moving even if MCP cleanup fails.
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("exit", cleanup);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, ACT_DAEMON_HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    cleanup();
    throw new Error("Daemon server address unavailable");
  }

  writeActDaemonState({
    version: 1,
    pid: process.pid,
    port: address.port,
    token,
    configHash: options.configHash,
    startedAt,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("close", () => {
      cleanup();
      resolve();
    });
    server.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
