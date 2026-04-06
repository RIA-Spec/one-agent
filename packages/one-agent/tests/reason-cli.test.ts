import { describe, expect, it } from "vitest";
import { buildReasonRequestInput, parseReasonRequestArgs } from "../../one-reason/src/run-cli.ts";

describe("reason cli parsing", () => {
  it("combines --prompt text with positional stdin prompt", async () => {
    const parsed = parseReasonRequestArgs(["--prompt", "foo", "-", '{"failed":false,"reason":""}']);

    const request = await buildReasonRequestInput(parsed, {
      stdinIsTTY: false,
      readStdin: async () => "boo",
    });

    expect(request.prompt).toBe("foo\nboo");
    expect(request.example).toEqual({ failed: false, reason: "" });
  });

  it("combines repeated --prompt values and stdin", async () => {
    const parsed = parseReasonRequestArgs([
      "--prompt",
      "goal: detect failures",
      "--prompt",
      "constraints: ignore warnings",
      "--prompt",
      "-",
      "--structure",
      '{"failed":false}',
    ]);

    const request = await buildReasonRequestInput(parsed, {
      stdinIsTTY: false,
      readStdin: async () => "build output",
    });

    expect(request.prompt).toBe(
      "goal: detect failures\nconstraints: ignore warnings\nbuild output",
    );
    expect(request.example).toEqual({ failed: false });
  });

  it("accepts positional structure alongside --structure form", async () => {
    const parsed = parseReasonRequestArgs([
      "--prompt",
      "foo",
      "-",
      "--structure",
      '{"failed":false,"reason":""}',
    ]);

    const request = await buildReasonRequestInput(parsed, {
      stdinIsTTY: false,
      readStdin: async () => "boo",
    });

    expect(request.prompt).toBe("foo\nboo");
    expect(request.example).toEqual({ failed: false, reason: "" });
  });
});
