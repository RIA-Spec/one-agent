import { expect, type Page, type TestInfo } from "@playwright/test";

export const CHAT_URL_REGEX = /\/chat\/[\w-]+/;
export const RESPONSE_TIMEOUT_MS = 420_000;

const FIRST_RESPONSE_TIMEOUT_MS = 90_000;
const COMPLETION_TIMEOUT_MS = 240_000;
const FINAL_TEXT_TIMEOUT_MS = 120_000;

export async function runBenchPrompt(
  page: Page,
  testInfo: TestInfo,
  prompt: string
) {
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

export function expectAny(text: string, candidates: string[], label: string) {
  expect(
    candidates.some((item) => text.includes(item)),
    `Missing expected signal: ${label} (${candidates.join(" | ")})`
  ).toBe(true);
}

export function expectKeywordScore(
  text: string,
  keywordGroups: string[][],
  minHit: number
) {
  const hitCount = keywordGroups.reduce((count, group) => {
    return count + (group.some((keyword) => text.includes(keyword)) ? 1 : 0);
  }, 0);

  expect(hitCount).toBeGreaterThanOrEqual(minHit);
}
