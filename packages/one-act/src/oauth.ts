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

const OAUTH_STATE_PATH = getOneConfigPath("oauth-state.json");

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
  mkdirSync(dirname(OAUTH_STATE_PATH), { recursive: true });
  writeFileSync(OAUTH_STATE_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
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
  #browserOpened = false;

  constructor(serverName: string, redirectUrl: string) {
    this.#serverName = serverName;
    this.#redirectUrl = redirectUrl;
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
    return readServerState(this.#serverName)?.clientInfo ?? undefined;
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
          `<html><body><h1>Authorization failed: ${error}</h1><p>You may close this tab.</p></body></html>`,
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
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stdin fallback: wait for user to paste redirect URL or bare code
// ---------------------------------------------------------------------------

function waitForCodeFromStdin(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    rl.once("line", (line) => {
      rl.close();
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
      reject(new Error("stdin closed without input"));
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full interactive OAuth 2.1 PKCE login flow for the given server.
 * Persists tokens to disk when complete.
 */
export async function runOAuthLogin(serverName: string, serverUrl: string): Promise<void> {
  const callbackServer = await runOAuthCallbackServer();
  const redirectUrl = `http://127.0.0.1:${callbackServer.port}/callback`;
  const provider = new ActOAuthProvider(serverName, redirectUrl);

  let code: string;
  try {
    const result = await auth(provider, { serverUrl });
    if (result === "AUTHORIZED") {
      process.stderr.write("Already authorized.\n");
      return;
    }

    // result === "REDIRECT": race callback server vs. manual paste (headless fallback).
    // If stdin closes (non-interactive), gracefully fall back to callback-only.
    const stdinPrompt = provider.browserOpened
      ? `If the browser didn't redirect automatically, paste the full redirect URL here and press Enter:\n> `
      : `Paste the full redirect URL (or just the code=… value) after authorizing, then press Enter:\n> `;

    const stdinRace = waitForCodeFromStdin(stdinPrompt).catch(() => new Promise<string>(() => {}));
    code = await Promise.race([callbackServer.waitForCode(), stdinRace]);
  } finally {
    callbackServer.close();
  }

  const finalResult = await auth(provider, { serverUrl, authorizationCode: code });
  if (finalResult !== "AUTHORIZED") {
    throw new Error("OAuth authorization did not complete successfully");
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
  if (!state.tokens.refresh_token || !state.clientInfo) return null;

  try {
    const { authorizationServerUrl, authorizationServerMetadata } =
      await discoverOAuthServerInfo(serverUrl);

    const newTokens = await refreshAuthorization(authorizationServerUrl, {
      metadata: authorizationServerMetadata,
      clientInformation: state.clientInfo,
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
