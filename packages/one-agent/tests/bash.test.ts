import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getServer } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TextContent, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Unit tests for the bash tool that executes shell commands.
 *
 * Based on the implementation from:
 * https://github.com/badlogic/pi-mono/tree/main/packages/mom/src/tools
 *
 * Note: These tests only cover pure bash command execution.
 * Tests involving ai() function integration are not included.
 */

function getTextOutput(result: unknown): string {
  const toolResult = result as CallToolResult;
  return (toolResult.content[0] as TextContent).text;
}

describe("bash tool", () => {
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

  it("executes simple echo command", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { command: 'echo "Hello, Bash!"' },
    });

    expect(result.content).toBeDefined();
    expect((result as CallToolResult).content[0].type).toBe("text");
    const output = getTextOutput(result);
    expect(output).toContain("Hello, Bash!");
  });

  it("executes pwd command", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { command: "pwd" },
    });

    const output = getTextOutput(result);
    expect(output).toContain("/");
    expect(output.length).toBeGreaterThan(0);
  });

  it("executes command with pipes", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "hello world" | tr "[:lower:]" "[:upper:]"',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("HELLO WORLD");
  });

  it("executes command with multiple statements", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "line1" && echo "line2" && echo "line3"',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("line1");
    expect(output).toContain("line2");
    expect(output).toContain("line3");
  });

  it("handles file operations", async () => {
    // Create, read, and delete a test file
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command:
          'echo "test content" > test_bash_temp.txt && cat test_bash_temp.txt && rm test_bash_temp.txt',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("test content");
  });

  it("handles stderr output", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "stdout" && echo "stderr" >&2',
      },
    });

    const output = getTextOutput(result);
    // Both stdout and stderr should be in the output
    expect(output).toContain("stdout");
    expect(output).toContain("stderr");
  });

  it("handles command with no output", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: { command: "true" },
    });

    const output = getTextOutput(result);
    expect(output).toBe("(no output)");
  });

  it("handles non-zero exit codes as errors", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: "ls /nonexistent_directory_12345",
      },
    });

    const output = getTextOutput(result);
    expect(output.toLowerCase()).toContain("command exited with code");
  });

  it("handles command not found errors", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: "nonexistent_command_xyz",
      },
    });

    const output = getTextOutput(result);
    expect(output.toLowerCase()).toContain("command not found");
  });

  it("supports timeout parameter for quick commands", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "quick"',
        timeout: 5,
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("quick");
  });

  it("handles timeout for long-running commands", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: "sleep 10",
        timeout: 1,
      },
    });

    const output = getTextOutput(result);
    expect(output.toLowerCase()).toContain("timed out");
  }, 15000);

  it("handles environment variables", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'TEST_VAR="hello" && echo $TEST_VAR',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("hello");
  });

  it("handles multi-line output", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'printf "line1\\nline2\\nline3\\nline4\\nline5"',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("line1");
    expect(output).toContain("line5");
    const lines = output.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it("handles output truncation for many lines", async () => {
    // Generate more than 50 lines (default truncation limit)
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'for i in {1..100}; do echo "Line $i"; done',
      },
    });

    const output = getTextOutput(result);
    // Should contain truncation notice if output exceeds limits
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length < 100) {
      // Output was truncated
      expect(output).toMatch(/Showing (lines|last)/);
    } else {
      // All lines included
      expect(lines.length).toBeGreaterThanOrEqual(100);
    }
  });

  it("executes commands in working directory", async () => {
    // Test that commands execute in the expected working directory
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: "ls -a | head -5",
      },
    });

    const output = getTextOutput(result);
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it("handles complex command chains", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "test" | wc -c | tr -d " "',
      },
    });

    const output = getTextOutput(result);
    // "test" + newline = 5 characters
    expect(output.trim()).toBe("5");
  });

  it("handles commands with quotes and special characters", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: 'echo "Single quote: \'" && echo "Double quote: \\""',
      },
    });

    const output = getTextOutput(result);
    expect(output).toContain("Single quote: '");
    expect(output).toContain('Double quote: "');
  });

  it("handles commands with glob patterns", async () => {
    const result = await client.callTool({
      name: "bash",
      arguments: {
        command: "ls *.json 2>/dev/null | head -3",
      },
    });

    const output = getTextOutput(result);
    // Should either list json files or return no output (if no json files)
    expect(output).toBeDefined();
  });
});
