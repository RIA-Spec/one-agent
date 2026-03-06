import { expect, test } from "@playwright/test";

import {
  expectKeywordScore,
  RESPONSE_TIMEOUT_MS,
  runBenchPrompt,
} from "./bench-utils";

test.describe("Benchmark E2E - Long Horizon", () => {
  test.describe.configure({ mode: "serial", timeout: RESPONSE_TIMEOUT_MS });

  test("AssistantBench case: multi-phase plan with recall token", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: AssistantBench
Task:
1) Create a 6-phase migration plan from local scripts to CI/CD.
2) Use this memory token exactly: ALPHA-7391.
3) At the end, provide a final summary that explicitly reuses the token.

Return exactly these fields:
- phases_count:
- token_recalled:
- final_summary:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(100);
    expectKeywordScore(
      output,
      [
        ["phases_count", "6"],
        ["token_recalled", "alpha-7391"],
        ["final_summary", "alpha-7391"],
        ["success:true", "success: true"],
      ],
      3
    );
  });

  test("AssistantBench case: retrieval after multi-step web + calc workflow", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Task sequence:
1) Open https://example.com and read the heading.
2) Compute 17 * 19.
3) Remember checkpoint code: BETA-2048.
4) Return all final answers in one response.

Return exactly these fields:
- heading:
- product:
- checkpoint:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(60);
    expectKeywordScore(
      output,
      [
        ["heading", "example domain"],
        ["product", "323"],
        ["checkpoint", "beta-2048"],
        ["success:true", "success: true"],
      ],
      3
    );
  });
});
