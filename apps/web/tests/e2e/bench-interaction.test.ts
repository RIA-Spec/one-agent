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

test.describe("Benchmark E2E - Interaction", () => {
  test.describe.configure({ mode: "serial", timeout: RESPONSE_TIMEOUT_MS });

  test("Mind2Web case: navigate and extract from Example Domain", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: Online Mind2Web
Task:
1) Open https://example.com
2) Read the main heading text
3) Click the "More information..." link
4) Confirm which domain you reached

Return exactly these fields:
- heading:
- destination_domain:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(40);
    expectAny(output, ["example domain", "heading"], "example heading");
    expectAny(output, ["iana.org", "www.iana.org"], "destination domain");
  });

  test("Mind2Web case: fill and submit web form", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: Online Mind2Web
Task:
1) Open https://httpbin.org/forms/post
2) Fill customer name with ONE_AGENT_BENCH
3) Fill comments with PLAYWRIGHT_DEBUG_FLOW
4) Submit the form
5) Extract echoed values from the result page

Return exactly these fields:
- custname:
- comments:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(40);
    expectAny(
      output,
      ["one_agent_bench", "custname"],
      "submitted customer name"
    );
    expectAny(
      output,
      ["playwright_debug_flow", "comments"],
      "submitted comments"
    );
  });
});
