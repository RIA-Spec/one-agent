import Ajv from "ajv";

export type AIResult = {
  data: any;
  error?: string | null;
};

const ajv = new Ajv({ allErrors: true, strict: false });

export function compileAiResultValidator(example: any) {
  const dataSchema = exampleToJsonSchema(example);
  const outputSchema = {
    type: "object",
    properties: {
      data: dataSchema,
      error: { type: ["string", "null"] },
    },
    required: ["data"],
    additionalProperties: true,
  };

  const validate = ajv.compile(outputSchema);
  return { validate, outputSchema };
}

export function exampleToJsonSchema(example: any): any {
  if (example === undefined) return {};
  if (example === null) return { type: "null" };

  const t = typeof example;
  if (t === "boolean") return { type: "boolean" };
  if (t === "number") return { type: "number" };
  if (t === "string") return { type: "string" };

  if (Array.isArray(example)) {
    if (example.length === 0) return { type: "array", items: {} };
    return { type: "array", items: exampleToJsonSchema(example[0]) };
  }

  if (t === "object") {
    const props: Record<string, any> = {};
    const req: string[] = [];
    for (const [key, value] of Object.entries(example)) {
      props[key] = exampleToJsonSchema(value);
      req.push(key);
    }
    return {
      type: "object",
      properties: props,
      required: req,
      additionalProperties: true,
    };
  }

  return {};
}

export function buildPrompt(userPrompt: string, example: any, schema: any) {
  if (example === "") {
    return userPrompt;
  }

  return `${userPrompt}

Expected output format - Your data should match this example:
${JSON.stringify(example, null, 2)}

Schema: ${JSON.stringify(schema, null, 2)}`;
}

export function errorsTextFromAjv(validateErrors: any) {
  return ajv.errorsText(validateErrors, { separator: "; " });
}
