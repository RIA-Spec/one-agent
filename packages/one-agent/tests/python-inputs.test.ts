import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { getServer } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TextContent, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function getTextOutput(result: unknown): string {
  const toolResult = result as CallToolResult;
  return (toolResult.content[0] as TextContent).text;
}

describe("Python RAS structured inputs", () => {
  let client: Client;
  let server: Awaited<ReturnType<typeof getServer>>;

  beforeAll(async () => {
    vi.stubEnv("RAS_MODE", "python");
    server = await getServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    await client.connect(clientTransport);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client.close();
  });

  it("exposes structured inputs to real Pyodide execution", async () => {
    const source = "quotes: ''' \"\"\"; escapes: \\n \\u1234; shell: $HOME `cmd` $(cmd); 中文";

    const result = await client.callTool({
      name: "one",
      arguments: {
        code: 'print(inputs["source"])\nprint(inputs["nested"]["value"])',
        inputs: {
          source,
          nested: { value: 42 },
        },
      },
    });

    expect((result as CallToolResult).isError).not.toBe(true);
    const output = getTextOutput(result);
    expect(output).toContain(source);
    expect(output).toContain("42");
  }, 30000);
});
