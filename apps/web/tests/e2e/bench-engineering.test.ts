import { expect, type Page, type TestInfo, test } from "@playwright/test";

const CHAT_URL_REGEX = /\/chat\/[\w-]+/;
const RESPONSE_TIMEOUT_MS = 300_000;
const FIRST_RESPONSE_TIMEOUT_MS = 60_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const FINAL_TEXT_TIMEOUT_MS = 30_000;

async function runBenchPrompt(page: Page, testInfo: TestInfo, prompt: string) {
  await page.goto("/");

  const input = page.getByTestId("multimodal-input");
  const sendButton = page.getByTestId("send-button");
  const stopButton = page.getByTestId("stop-button");
  const assistantLoading = page.getByTestId("message-assistant-loading");

  await input.fill(prompt);
  await sendButton.click();

  await expect(page).toHaveURL(CHAT_URL_REGEX, {
    timeout: RESPONSE_TIMEOUT_MS,
  });

  const assistantMessage = page
    .locator("[data-testid='message-assistant']")
    .last();
  const assistantContent = assistantMessage
    .locator("[data-testid='message-content']")
    .last();

  await Promise.race([
    expect(assistantContent).toContainText(/\S/, {
      timeout: FIRST_RESPONSE_TIMEOUT_MS,
    }),
    expect(stopButton).toBeVisible({ timeout: 20_000 }),
    expect(assistantLoading).toBeVisible({ timeout: 20_000 }),
  ]).catch(() => {
    throw new Error(
      `No visible model response within ${FIRST_RESPONSE_TIMEOUT_MS / 1000}s. ` +
        "Check model/API availability or prompt execution state."
    );
  });

  await expect(assistantLoading).toBeHidden({
    timeout: COMPLETION_TIMEOUT_MS,
  });
  await expect(stopButton).toBeHidden({
    timeout: COMPLETION_TIMEOUT_MS,
  });

  await expect(sendButton).toBeVisible({ timeout: COMPLETION_TIMEOUT_MS });
  await input.fill("_");
  await expect(sendButton).toBeEnabled({ timeout: COMPLETION_TIMEOUT_MS });
  await input.fill("");

  await expect(assistantContent).toContainText(/\S/, {
    timeout: FINAL_TEXT_TIMEOUT_MS,
  });

  const output = ((await assistantContent.textContent()) ?? "").toLowerCase();

  await testInfo.attach("prompt.txt", {
    body: prompt,
    contentType: "text/plain",
  });

  await testInfo.attach("output.txt", {
    body: output,
    contentType: "text/plain",
  });

  return output;
}

function expectAny(text: string, candidates: string[], label: string) {
  expect(
    candidates.some((item) => text.includes(item)),
    `Missing expected signal: ${label} (${candidates.join(" | ")})`
  ).toBe(true);
}

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
