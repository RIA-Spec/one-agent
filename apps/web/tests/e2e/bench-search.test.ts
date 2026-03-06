import { expect, test } from "@playwright/test";

import {
  expectAny,
  expectKeywordScore,
  RESPONSE_TIMEOUT_MS,
  runBenchPrompt,
} from "./bench-utils";

test.describe("Benchmark E2E - Search", () => {
  test.describe.configure({ mode: "serial", timeout: RESPONSE_TIMEOUT_MS });

  test("BrowseComp-style case: resolve RFC title from reserved domains trail", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: BrowseComp-style
Task:
1) Open https://www.iana.org/domains/reserved
2) Find the RFC cited for reserved top level DNS names
3) Open that RFC page
4) Extract the RFC title as a short exact answer

Return exactly these fields:
- explanation:
- exact_answer:
- confidence:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(60);
    expectAny(
      output,
      ["reserved top level dns names", "rfc 2606"],
      "browsecomp exact answer"
    );
    expectAny(output, ["confidence", "%"], "browsecomp confidence signal");
  });

  test("DeepSearchQA-style case: trace destination site to organization HQ", async ({
    page,
  }, testInfo) => {
    const prompt = `
You are solving a concrete benchmark task for One Agent.
Respond in English only.

Benchmark type: DeepSearchQA-style
Task:
1) Open https://example.com
2) Click the "Learn more" link
3) Identify the organization acronym operating the destination site
4) Find that organization's headquarters city
5) Return a short evidence summary grounded in the pages you used

Return exactly these fields:
- organization:
- headquarters_city:
- evidence_summary:
- success:true|false
`.trim();

    const output = await runBenchPrompt(page, testInfo, prompt);

    expect(output.length).toBeGreaterThan(80);
    expectKeywordScore(
      output,
      [
        ["organization", "icann"],
        ["headquarters_city", "los angeles"],
        ["evidence_summary", "iana", "icann"],
        ["success:true", "success: true"],
      ],
      3
    );
  });
});
