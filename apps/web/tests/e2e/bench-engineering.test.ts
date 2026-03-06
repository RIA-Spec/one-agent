import { expect, test } from "@playwright/test";

import { expectAny, RESPONSE_TIMEOUT_MS, runBenchPrompt } from "./bench-utils";

test.describe("Benchmark E2E - Engineering", () => {
  test.describe.configure({ mode: "serial", timeout: RESPONSE_TIMEOUT_MS });

  test("SWE-bench case: debug median bug and verify outputs", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: SWE-bench Verified
Task:
You are given buggy code:

def median(nums):
    nums = sorted(nums)
    return nums[len(nums)//2]

Find and fix the bug for even-length inputs, then verify with tests.

Required test cases:
- median([1,2,3,4]) == 2.5
- median([1,2,3]) == 2

Return exactly these fields:
- fix_summary:
- even_case:
- odd_case:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.trim().length).toBeGreaterThan(0);
    expectAny(output, ["fix", "median", "2.5", "5/2"], "swe-bench signal");
  });

  test("CORE-Bench case: run scientific calculation with dependencies", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: CORE-Bench Hard
Task:
Run Python code using numpy to compute:
- mean of [2,4,6,8]
- standard deviation of [2,4,6,8]

Return exactly these fields:
- mean:
- std:
- success:true|false

Use numeric values in decimal format.
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.trim().length).toBeGreaterThan(0);
    expectAny(
      output,
      ["mean", "average", "std", "standard deviation", "5", "5.0"],
      "core-bench signal"
    );
  });
});
