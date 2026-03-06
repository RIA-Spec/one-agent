import { expect, test } from "@playwright/test";

import { expectAny, RESPONSE_TIMEOUT_MS, runBenchPrompt } from "./bench-utils";

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
