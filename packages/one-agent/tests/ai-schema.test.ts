import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { exampleToJsonSchema } from "../src/utils/schema.js";

describe("exampleToJsonSchema", () => {
  it("infers booleans", () => {
    expect(exampleToJsonSchema(true)).toEqual({ type: "boolean" });
  });

  it("infers arrays from first element", () => {
    expect(exampleToJsonSchema([1])).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  it("infers empty arrays as unconstrained items", () => {
    expect(exampleToJsonSchema([])).toEqual({ type: "array", items: {} });
  });

  it("infers objects as required keys, extra allowed", () => {
    const schema = exampleToJsonSchema({ a: [1], b: [2], c: [3] });
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a", "b", "c"]);
    expect(schema.additionalProperties).toBe(true);
  });
});

describe("Ajv validation using inferred schema", () => {
  it("rejects missing required keys but allows extra keys", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const dataSchema = exampleToJsonSchema({ a: [1], b: [2], c: [3] });
    const outputSchema = {
      type: "object",
      properties: { data: dataSchema, text: { type: "string" } },
      required: ["data", "text"],
      additionalProperties: true,
    };

    const validate = ajv.compile(outputSchema);

    expect(validate({ data: { a: [1], b: [2], c: [3], extra: 1 }, text: "ok" })).toBe(true);
    expect(validate({ data: { a: [1], b: [2] }, text: "nope" })).toBe(false);
  });
});
