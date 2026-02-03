import Ajv from 'ajv';

export type AIResult = {
  data: any;
  text: string;
};

const ajv = new Ajv({ allErrors: true, strict: false });

export function compileAiResultValidator(example: any) {
  const dataSchema = exampleToJsonSchema(example);
  const outputSchema = {
    type: 'object',
    properties: {
      data: dataSchema,
      text: { type: 'string' },
    },
    required: ['data', 'text'],
    additionalProperties: true,
  };

  const validate = ajv.compile(outputSchema);
  return { validate, outputSchema };
}

export function exampleToJsonSchema(example: any): any {
  if (example === undefined) return {};
  if (example === null) return { type: 'null' };

  const t = typeof example;
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'number') return { type: 'number' };
  if (t === 'string') return { type: 'string' };

  if (Array.isArray(example)) {
    if (example.length === 0) return { type: 'array', items: {} };
    return { type: 'array', items: exampleToJsonSchema(example[0]) };
  }

  if (t === 'object') {
    const props: Record<string, any> = {};
    const req: string[] = [];
    for (const [k, v] of Object.entries(example)) {
      props[k] = exampleToJsonSchema(v);
      req.push(k);
    }
    return {
      type: 'object',
      properties: props,
      required: req,
      additionalProperties: true,
    };
  }

  return {};
}

export function buildPrompt(userPrompt: string, example: any, schema: any) {
  return `${userPrompt}

Expected output format - your data.value should match this example:
${JSON.stringify(example, null, 2)}`;
}

export function errorsTextFromAjv(validateErrors: any) {
  return ajv.errorsText(validateErrors, { separator: '; ' });
}
