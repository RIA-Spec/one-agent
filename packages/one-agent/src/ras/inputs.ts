export type OneInputs = Record<string, unknown>;

export type PreparedOneInputs = {
  value: OneInputs;
  encoded: string;
};

export const MAX_ONE_INPUTS_BYTES = 1024 * 1024;

export function prepareOneInputs(inputs?: OneInputs): PreparedOneInputs {
  if (inputs === undefined) {
    return { value: {}, encoded: Buffer.from("{}", "utf-8").toString("base64") };
  }
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("inputs must be a JSON object");
  }

  let json: string;
  try {
    json = JSON.stringify(inputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`inputs must be JSON-serializable: ${message}`);
  }

  const size = Buffer.byteLength(json, "utf-8");
  if (size > MAX_ONE_INPUTS_BYTES) {
    throw new Error(
      `inputs exceed the ${MAX_ONE_INPUTS_BYTES}-byte limit (received ${size} bytes)`,
    );
  }

  return {
    value: JSON.parse(json) as OneInputs,
    encoded: Buffer.from(json, "utf-8").toString("base64"),
  };
}
