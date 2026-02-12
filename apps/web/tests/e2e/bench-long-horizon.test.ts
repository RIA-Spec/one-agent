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

function expectKeywordScore(
  text: string,
  keywordGroups: string[][],
  minHit: number
) {
  const hitCount = keywordGroups.reduce((count, group) => {
    return count + (group.some((keyword) => text.includes(keyword)) ? 1 : 0);
  }, 0);

  expect(hitCount).toBeGreaterThanOrEqual(minHit);
}

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
