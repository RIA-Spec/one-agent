import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getServer } from "../src/tools.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TextContent, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Unit tests for the run tool that executes Python code in Pyodide.
 *
 * Note: Tests using ai() function (which requires asyncio) are skipped because
 * WebAssembly stack switching is not supported in vitest worker threads.
 * These tests work fine when running the tool directly with:
 * node --experimental-wasm-stack-switching dist/repl.mjs
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const examplesDir = resolve(projectRoot, "examples");

function getTextOutput(result: unknown): string {
  const toolResult = result as CallToolResult;
  return (toolResult.content[0] as TextContent).text;
}

describe("run tool", () => {
  let client: Client;
  let server: Awaited<ReturnType<typeof getServer>>;

  beforeAll(async () => {
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
    await client.close();
  });

  it("executes simple Python calculation", async () => {
    const code = readFileSync(resolve(examplesDir, "simple_calc.py"), "utf-8");

    const result = await client.callTool({
      name: "run",
      arguments: { code },
    });

    expect(result.content).toBeDefined();
    expect((result as CallToolResult).content[0].type).toBe("text");
    const output = getTextOutput(result);
    expect(output).toContain("Result: 4");
  }, 30000);

  it("executes Python with pandas and numpy", async () => {
    const code = readFileSync(resolve(examplesDir, "pandas_demo.py"), "utf-8");

    const result = await client.callTool({
      name: "run",
      arguments: {
        code,
        packages: { pandas: "pandas", numpy: "numpy" },
      },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    expect(output).toContain("Rows: 3");
    expect(output).toContain("Avg age: 30.0");
    expect(output).toContain("Avg score: 90.0");
  }, 60000);

  // Skip: WebAssembly stack switching not supported in vitest worker threads
  it.skip("executes Python with ai() function - simple text", async () => {
    const code = readFileSync(resolve(examplesDir, "use_ai.py"), "utf-8");

    const result = await client.callTool({
      name: "run",
      arguments: { code },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    // Should contain some summary text about Python
    expect(output.length).toBeGreaterThan(10);
    expect(output.toLowerCase()).toContain("python");
  }, 30000);

  // Skip: WebAssembly stack switching not supported in vitest worker threads
  it.skip("executes Python with ai() function - boolean decision", async () => {
    const code = readFileSync(resolve(examplesDir, "ai_boolean.py"), "utf-8");

    const result = await client.callTool({
      name: "run",
      arguments: { code },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    // Since errors > threshold, should alert
    expect(output).toContain("Alert: Too many errors!");
  }, 30000);

  // Skip: WebAssembly stack switching not supported in vitest worker threads
  it.skip("executes Python with ai() function - structured array", async () => {
    const code = readFileSync(resolve(examplesDir, "ai_array.py"), "utf-8");

    const result = await client.callTool({
      name: "run",
      arguments: { code },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    // Should categorize fruits and vegetables
    expect(output).toContain("Fruits:");
    expect(output).toContain("Vegetables:");
    expect(output.toLowerCase()).toContain("apple");
    expect(output.toLowerCase()).toContain("banana");
  }, 30000);

  it("handles Python errors gracefully", async () => {
    const code = readFileSync(resolve(examplesDir, "error_example.py"), "utf-8");

    try {
      await client.callTool({
        name: "run",
        arguments: { code },
      });
      // Should not reach here
      expect.fail("Expected error to be thrown");
    } catch (error: any) {
      // Should contain error information about division by zero
      const errorMsg = error.message.toLowerCase();
      expect(errorMsg).toContain("zerodivisionerror");
      expect(errorMsg).toContain("division");
    }
  }, 30000);

  // Skip: WebAssembly stack switching not supported in vitest worker threads
  it.skip("executes inline Python code without file", async () => {
    const code = `
import asyncio

async def main():
    nums = [1, 2, 3, 4, 5]
    result = await ai('Calculate the sum: ' + str(nums), 15)
    print(f"AI calculated sum: {result['data']}")

asyncio.run(main())
    `.trim();

    const result = await client.callTool({
      name: "run",
      arguments: { code },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    expect(output).toContain("AI calculated sum:");
    // AI should return something close to 15
    expect(output).toMatch(/\d+/);
  }, 30000);

  it("handles custom package mappings", async () => {
    const code = `
from sklearn.datasets import make_classification
X, y = make_classification(n_samples=10, n_features=4, random_state=42)
print(f"Generated {len(X)} samples with {X.shape[1]} features")
    `.trim();

    const result = await client.callTool({
      name: "run",
      arguments: {
        code,
        packages: { sklearn: "scikit-learn" },
      },
    });

    expect(result.content).toBeDefined();
    const output = getTextOutput(result);
    expect(output).toContain("Generated 10 samples with 4 features");
  }, 60000);
});
