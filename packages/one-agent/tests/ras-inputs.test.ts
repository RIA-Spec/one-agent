import { describe, expect, it } from "vitest";
import { MAX_ONE_INPUTS_BYTES, prepareOneInputs } from "../src/ras/inputs.js";

describe("one structured inputs", () => {
  it("round-trips JSON data through the runtime-safe encoding", () => {
    const inputs = {
      source: "quotes: ''' \\\"\\\"\\\"; escapes: \\\\n \\\\u1234; shell: $HOME `cmd` $(cmd)",
      nested: { enabled: true, value: null },
    };

    const prepared = prepareOneInputs(inputs);
    const decoded = JSON.parse(Buffer.from(prepared.encoded, "base64").toString("utf-8"));

    expect(prepared.value).toEqual(inputs);
    expect(decoded).toEqual(inputs);
  });

  it("rejects non-object and oversized inputs", () => {
    expect(() => prepareOneInputs([] as unknown as Record<string, unknown>)).toThrow(
      "inputs must be a JSON object",
    );
    expect(() => prepareOneInputs({ value: "x".repeat(MAX_ONE_INPUTS_BYTES) })).toThrow(
      "inputs exceed",
    );
  });
});
