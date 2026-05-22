import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { getOneConfigPath } from "./config-path.js";

// ---------------------------------------------------------------------------
// Servers that use GitHub Device Flow instead of PKCE web flow.
// GitHub OAuth Apps require client_secret in the PKCE token exchange, but
// the Device Flow works without one.  We key by hostname.
// ---------------------------------------------------------------------------

const DEVICE_FLOW_HOSTS = new Set(["api.githubcopilot.com"]);

function isDeviceFlowServer(serverUrl: string): boolean {
  try {
    return DEVICE_FLOW_HOSTS.has(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
}

// GitHub Device Flow endpoint (not in their OAuth server metadata).
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const OAUTH_STATE_PATH = getOneConfigPath("oauth-state.json");

// ---------------------------------------------------------------------------
// Built-in client IDs for known servers (keyed by hostname).
// These servers do not support Dynamic Client Registration, so one-act ships
// a pre-registered client_id for each of them.
// ---------------------------------------------------------------------------

const KNOWN_CLIENT_IDS: Record<string, string> = {
  "api.githubcopilot.com": "Ov23li0hx3Ph6WI4G1nt",
};

export function getKnownClientId(serverUrl: string): string | undefined {
  try {
    return KNOWN_CLIENT_IDS[new URL(serverUrl).hostname];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// State file types
// ---------------------------------------------------------------------------

type PerServerState = {
  tokens?: OAuthTokens;
  /** Absolute ms timestamp after which access_token should be considered expired. */
  expiresAt?: number;
  clientInfo?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

type OAuthStateFile = Record<string, PerServerState>;

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

function readOAuthStateFile(): OAuthStateFile {
  if (!existsSync(OAUTH_STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OAUTH_STATE_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as OAuthStateFile) : {};
  } catch {
    return {};
  }
}

function writeOAuthStateFile(file: OAuthStateFile) {
  mkdirSync(dirname(OAUTH_STATE_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(OAUTH_STATE_PATH, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function readServerState(serverName: string): PerServerState | null {
  return readOAuthStateFile()[serverName] ?? null;
}

function writeServerState(serverName: string, state: PerServerState) {
  const file = readOAuthStateFile();
  file[serverName] = state;
  writeOAuthStateFile(file);
}

function deleteServerState(serverName: string) {
  const file = readOAuthStateFile();
  delete file[serverName];
  writeOAuthStateFile(file);
}

// ---------------------------------------------------------------------------
// OAuthClientProvider implementation (disk-backed, browser-opening)
// ---------------------------------------------------------------------------

class ActOAuthProvider implements OAuthClientProvider {
  readonly #serverName: string;
  readonly #redirectUrl: string;
  readonly #clientId: string | undefined;
  #browserOpened = false;

  constructor(serverName: string, redirectUrl: string, clientId?: string) {
    this.#serverName = serverName;
    this.#redirectUrl = redirectUrl;
    this.#clientId = clientId;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get browserOpened(): boolean {
    return this.#browserOpened;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "one-act",
      redirect_uris: [this.#redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const saved = readServerState(this.#serverName)?.clientInfo;
    if (saved) return saved;
    // Pre-configured client_id: returned directly so DCR is skipped entirely.
    if (this.#clientId) return { client_id: this.#clientId };
    return undefined;
  }

  saveClientInformation(clientInfo: OAuthClientInformationMixed): void {
    const state = readServerState(this.#serverName) ?? {};
    writeServerState(this.#serverName, { ...state, clientInfo });
  }

  tokens(): OAuthTokens | undefined {
    return readServerState(this.#serverName)?.tokens ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const state = readServerState(this.#serverName) ?? {};
    const expiresAt =
      typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
    writeServerState(this.#serverName, { ...state, tokens, expiresAt });
  }

  redirectToAuthorization(url: URL): void {
    this.#browserOpened = openBrowser(url.toString());
    const urlStr = url.toString();
    if (this.#browserOpened) {
      process.stderr.write(`\nOpening browser for OAuth authorization:\n${urlStr}\n\n`);
    } else {
      process.stderr.write(
        `\nCould not open browser. Open this URL manually to authorize:\n${urlStr}\n\n`,
      );
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    const state = readServerState(this.#serverName) ?? {};
    writeServerState(this.#serverName, { ...state, codeVerifier });
  }

  codeVerifier(): string {
    const cv = readServerState(this.#serverName)?.codeVerifier;
    if (!cv) throw new Error(`No code verifier saved for server "${this.#serverName}"`);
    return cv;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const state = readServerState(this.#serverName);
    if (!state) return;

    if (scope === "all") {
      deleteServerState(this.#serverName);
      return;
    }

    const updated = { ...state };
    if (scope === "client") delete updated.clientInfo;
    if (scope === "tokens") {
      delete updated.tokens;
      delete updated.expiresAt;
    }
    if (scope === "verifier") delete updated.codeVerifier;
    if (scope === "discovery") delete updated.discoveryState;
    writeServerState(this.#serverName, updated);
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    const state = readServerState(this.#serverName) ?? {};
    writeServerState(this.#serverName, { ...state, discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readServerState(this.#serverName)?.discoveryState ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// OAuth callback HTTP server
// ---------------------------------------------------------------------------

async function runOAuthCallbackServer(): Promise<{
  port: number;
  waitForCode(): Promise<string>;
  close(): void;
}> {
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body><h1>Authorization failed: ${escapeHtml(error)}</h1><p>You may close this tab.</p></body></html>`,
        );
        rejectCode?.(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body><h1>Authorization successful!</h1><p>You may close this tab.</p></body></html>`,
        );
        resolveCode?.(code);
        return;
      }

      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body><h1>Bad request</h1></body></html>`);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to start OAuth callback server");
  }

  return {
    port: address.port,
    waitForCode: () => codePromise,
    close: () => {
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-platform browser opener
// ---------------------------------------------------------------------------

function openBrowser(url: string): boolean {
  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === "win32") {
      // "start" is a cmd.exe built-in, not a standalone binary
      child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {}); // suppress unhandled async spawn errors
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stdin fallback: wait for user to paste redirect URL or bare code
// ---------------------------------------------------------------------------

function waitForCodeFromStdin(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    process.stderr.write(prompt);

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    if (signal) signal.addEventListener("abort", onAbort);

    rl.once("line", (line) => {
      cleanup();
      const trimmed = line.trim();
      if (!trimmed) {
        reject(new Error("No input provided"));
        return;
      }
      // Accept full redirect URL (http://127.0.0.1:PORT/callback?code=...) or bare code
      try {
        const parsed = new URL(trimmed);
        const code = parsed.searchParams.get("code");
        if (code) {
          resolve(code);
          return;
        }
      } catch {
        // Not a URL — treat as bare code
      }
      resolve(trimmed);
    });

    rl.once("close", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("stdin closed without input"));
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub Device Flow implementation
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGitHubDeviceFlow(
  serverName: string,
  serverUrl: string,
  clientId: string,
): Promise<void> {
  // Fetch scopes from Protected Resource Metadata.
  let scope = "repo read:org read:user user:email"; // safe default
  try {
    const prMetaUrl = new URL("/.well-known/oauth-protected-resource", serverUrl).href;
    const prResp = await fetch(prMetaUrl, { headers: { accept: "application/json" } });
    if (prResp.ok) {
      const prMeta = (await prResp.json()) as { scopes_supported?: string[] };
      if (Array.isArray(prMeta.scopes_supported) && prMeta.scopes_supported.length > 0) {
        scope = prMeta.scopes_supported.join(" ");
      }
    }
  } catch {
    // ignore — use default scope
  }

  // Step 1: request device code.
  const deviceResp = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });

  const deviceData = (await deviceResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    error?: string;
    error_description?: string;
  };

  if (!deviceResp.ok || deviceData.error) {
    const msg = deviceData.error_description ?? deviceData.error ?? `HTTP ${deviceResp.status}`;
    const hint =
      deviceData.error === "device_flow_disabled"
        ? '\n→ Open your GitHub OAuth App settings and check "Enable Device Flow":\n  https://github.com/settings/developers'
        : "";
    throw new Error(`GitHub device flow error: ${msg}${hint}`);
  }

  // Step 2: show code to user and try to open browser.
  const verifyUrl = deviceData.verification_uri;
  openBrowser(verifyUrl);
  process.stderr.write(
    `\nOpen: ${verifyUrl}\nEnter code: ${deviceData.user_code}\n\n(Waiting for authorization…)\n`,
  );

  // Step 3: poll for token.
  const { authorizationServerMetadata } = await discoverOAuthServerInfo(serverUrl).catch(() => ({
    authorizationServerMetadata: undefined,
    authorizationServerUrl: new URL("https://github.com"),
  }));
  const tokenEndpoint =
    authorizationServerMetadata?.token_endpoint ?? "https://github.com/login/oauth/access_token";

  const deadline = Date.now() + deviceData.expires_in * 1000;
  const pollMs = Math.max((deviceData.interval + 1) * 1000, 5_000);

  while (Date.now() < deadline) {
    await delay(pollMs);

    const tokenResp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceData.device_code,
        grant_type: GITHUB_DEVICE_GRANT,
      }).toString(),
    });

    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (tokenData.access_token) {
      const expiresAt =
        typeof tokenData.expires_in === "number"
          ? Date.now() + tokenData.expires_in * 1000
          : undefined;
      const tokens: OAuthTokens = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type ?? "bearer",
        ...(tokenData.scope !== undefined ? { scope: tokenData.scope } : {}),
        ...(tokenData.refresh_token !== undefined
          ? { refresh_token: tokenData.refresh_token }
          : {}),
        ...(tokenData.expires_in !== undefined ? { expires_in: tokenData.expires_in } : {}),
      };
      writeServerState(serverName, {
        tokens,
        expiresAt,
        clientInfo: { client_id: clientId },
      });
      process.stderr.write("\nSuccessfully authorized!\n");
      return;
    }

    if (tokenData.error === "authorization_pending") continue;
    if (tokenData.error === "slow_down") {
      await delay(5_000);
      continue;
    }

    throw new Error(
      `GitHub authorization failed: ${tokenData.error_description ?? tokenData.error ?? "unknown error"}`,
    );
  }

  throw new Error("GitHub device flow authorization timed out. Please try again.");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full interactive OAuth login flow for the given server.
 * Uses GitHub Device Flow for GitHub Copilot (no client_secret needed).
 * Falls back to OAuth 2.1 PKCE web flow for other servers.
 * Persists tokens to disk when complete.
 */
export async function runOAuthLogin(
  serverName: string,
  serverUrl: string,
  clientId?: string,
): Promise<void> {
  const effectiveClientId = clientId ?? getKnownClientId(serverUrl);

  // GitHub OAuth Apps require client_secret in the PKCE token exchange but
  // NOT in the Device Flow — use Device Flow for GitHub servers.
  if (effectiveClientId && isDeviceFlowServer(serverUrl)) {
    return runGitHubDeviceFlow(serverName, serverUrl, effectiveClientId);
  }

  const callbackServer = await runOAuthCallbackServer();
  const redirectUrl = `http://127.0.0.1:${callbackServer.port}/callback`;
  const provider = new ActOAuthProvider(serverName, redirectUrl, effectiveClientId);

  let code: string;
  try {
    const result = await auth(provider, { serverUrl });
    if (result === "AUTHORIZED") {
      process.stderr.write("Already authorized.\n");
      return;
    }

    // result === "REDIRECT": race callback server vs. manual paste (headless fallback).
    const stdinPrompt = provider.browserOpened
      ? `If the browser didn't redirect automatically, paste the full redirect URL here and press Enter:\n> `
      : `Paste the full redirect URL (or just the code=… value) after authorizing, then press Enter:\n> `;

    const abortController = new AbortController();
    const stdinRace = waitForCodeFromStdin(stdinPrompt, abortController.signal).catch(
      () => new Promise<string>(() => {}),
    );
    try {
      code = await Promise.race([callbackServer.waitForCode(), stdinRace]);
    } finally {
      abortController.abort();
    }
  } finally {
    callbackServer.close();
  }

  const finalResult = await auth(provider, { serverUrl, authorizationCode: code });
  if (finalResult !== "AUTHORIZED") {
    throw new Error("OAuth authorization did not complete successfully");
  }

  // When DCR was skipped (pre-configured clientId), saveClientInformation is never
  // called by the SDK. Persist clientInfo manually so token refresh works later.
  if (effectiveClientId && !readServerState(serverName)?.clientInfo) {
    const state = readServerState(serverName) ?? {};
    writeServerState(serverName, { ...state, clientInfo: { client_id: effectiveClientId } });
  }
}

/**
 * Return a valid access token for the given server, refreshing automatically
 * if the stored token is within 60 seconds of expiry. Returns null when no
 * token is stored or refresh fails — caller should prompt the user to re-login.
 */
export async function ensureOAuthToken(
  serverName: string,
  serverUrl: string,
): Promise<string | null> {
  const state = readServerState(serverName);
  if (!state?.tokens?.access_token) return null;

  // No expiry info — assume still valid
  if (!state.expiresAt) return state.tokens.access_token;

  // Still valid with 60 s buffer
  if (Date.now() < state.expiresAt - 60_000) return state.tokens.access_token;

  // Expired — try to refresh
  const clientInfo =
    state.clientInfo ??
    // Fallback: built-in client_id for servers that don't support DCR
    (getKnownClientId(serverUrl) ? { client_id: getKnownClientId(serverUrl)! } : undefined);
  if (!state.tokens.refresh_token || !clientInfo) return null;

  try {
    const { authorizationServerUrl, authorizationServerMetadata } =
      await discoverOAuthServerInfo(serverUrl);

    const newTokens = await refreshAuthorization(authorizationServerUrl, {
      metadata: authorizationServerMetadata,
      clientInformation: clientInfo,
      refreshToken: state.tokens.refresh_token,
    });

    const expiresAt =
      typeof newTokens.expires_in === "number"
        ? Date.now() + newTokens.expires_in * 1000
        : undefined;

    writeServerState(serverName, { ...state, tokens: newTokens, expiresAt });
    return newTokens.access_token;
  } catch {
    return null;
  }
}

/** Remove all stored OAuth state for the given server. */
export function clearOAuthState(serverName: string): void {
  deleteServerState(serverName);
}

/** Return a summary of every server that has stored OAuth state. */
export function listOAuthStates(): Record<string, { hasToken: boolean; expiresAt?: number }> {
  const file = readOAuthStateFile();
  return Object.fromEntries(
    Object.entries(file).map(([name, state]) => [
      name,
      {
        hasToken: Boolean(state.tokens?.access_token),
        expiresAt: state.expiresAt,
      },
    ]),
  );
}
