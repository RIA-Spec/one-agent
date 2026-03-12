import { describe, it, expect } from "vitest";
import { codeToAST, countTrackableSteps, flattenAST } from "../src/aer/code-to-ast";
import type { ASTStep } from "../src/progress";

describe("codeToAST", () => {
  describe("python mode", () => {
    it("extracts simple act() call", () => {
      const code = `
async def main():
    result = await act('playwright_browser_navigate', 'Go to https://example.com')
    print(result)
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("act");
      expect(steps[0].name).toBe("playwright_browser_navigate");
      expect(steps[0].args[0]).toContain("Go to https://example.com");
    });

    it("extracts simple reason() call", () => {
      const code = `
async def main():
    result = await reason('Summarize the following text', '')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
      expect(steps[0].name).toBe("Summarize the following text");
    });

    it("detects reason() call without await for planning", () => {
      const code = `
async def main():
    result = reason('Summarize quickly', '')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
      expect(steps[0].name).toBe("Summarize quickly");
    });

    it("extracts multiple mixed calls in sequence", () => {
      const code = `
async def main():
    page = await act('playwright_browser_navigate', 'Go to https://example.com')
    content = await act('playwright_browser_snapshot', 'Get page content')
    summary = await reason('Analyze the page content', {"title": "", "links": []})
    await act('playwright_browser_click', 'Click the submit button')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(4);
      expect(steps[0]).toMatchObject({ type: "act", name: "playwright_browser_navigate" });
      expect(steps[1]).toMatchObject({ type: "act", name: "playwright_browser_snapshot" });
      expect(steps[2]).toMatchObject({ type: "reason" });
      expect(steps[3]).toMatchObject({ type: "act", name: "playwright_browser_click" });
    });

    it("handles f-string arguments", () => {
      const code = `
async def main():
    url = "https://example.com"
    result = await act('browser_navigate', f"Go to {url}")
    analysis = await reason(f"Analyze {data} for trends", example)
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe("act");
      expect(steps[1].type).toBe("reason");
      expect(steps[1].name).toContain("{...}");
    });

    it("handles multi-line call arguments", () => {
      const code = `
async def main():
    result = await act(
        'playwright_browser_navigate',
        'Navigate to the search page'
    )
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("playwright_browser_navigate");
    });

    it("handles nested parentheses in arguments", () => {
      const code = `
async def main():
    result = await reason('Process data', {"key": "value", "nested": {"a": 1}})
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
    });

    it("handles strings with quotes inside", () => {
      const code = `
async def main():
    result = await act('tool_name', "Click the 'Submit' button")
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("tool_name");
    });

    it("returns empty for code without act/reason", () => {
      const code = `
import os
print("hello world")
x = 1 + 2
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(0);
    });

    it("returns empty for empty code", () => {
      expect(codeToAST("", "python")).toHaveLength(0);
      expect(codeToAST("  ", "python")).toHaveLength(0);
    });

    it("extracts correct line numbers", () => {
      const code = `async def main():
    a = await act('tool1', 'do something')
    b = await act('tool2', 'do another thing')
    c = await reason('analyze', {})`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(3);
      expect(steps[0].line).toBe(2);
      expect(steps[1].line).toBe(3);
      expect(steps[2].line).toBe(4);
    });

    it("handles variable as first arg to act()", () => {
      const code = `
async def main():
    tool_name = get_tool()
    result = await act(tool_name, 'do it')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("tool"); // fallback when first arg is not a string literal
    });
  });

  describe("bash mode", () => {
    it("extracts simple act command", () => {
      const code = `act --name "playwright_browser_navigate" --prompt "Go to https://example.com"`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("act");
      expect(steps[0].name).toBe("playwright_browser_navigate");
      expect(steps[0].args[0]).toContain("Go to https://example.com");
    });

    it("extracts simple reason command", () => {
      const code = `reason --prompt "Summarize the following text" --structure '{"summary": ""}'`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
      expect(steps[0].name).toBe("Summarize the following text");
    });

    it("extracts positional reason command", () => {
      const code = `reason "Summarize the following text" '{"summary":""}'`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
      expect(steps[0].name).toBe("Summarize the following text");
      expect(steps[0].args[0]).toContain('{"summary":""}');
    });

    it("extracts pipe chain with multiple commands", () => {
      const code = `act --name "browser_snapshot" --prompt "Get content" | reason --prompt "Analyze this" --prompt -`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ type: "act", name: "browser_snapshot" });
      expect(steps[1]).toMatchObject({ type: "reason" });
    });

    it("extracts && chained commands", () => {
      const code = `act --name "tool1" --prompt "step 1" && act --name "tool2" --prompt "step 2"`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(2);
      expect(steps[0].name).toBe("tool1");
      expect(steps[1].name).toBe("tool2");
    });

    it("handles reason with stdin pipe marker", () => {
      const code = `echo "Hello world" | reason --prompt "Translate:" --prompt - --structure '{"t":""}'`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("reason");
      expect(steps[0].name).toBe("Translate:");
    });

    it("handles multi-line script", () => {
      const code = `#!/bin/bash
act --name "browser_navigate" --prompt "Go to google.com"
page=$(act --name "browser_snapshot" --prompt "Get page")
echo "$page" | reason --prompt "Find the search box" --prompt -
act --name "browser_click" --prompt "Click search"`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(4);
      expect(steps[0]).toMatchObject({ type: "act", name: "browser_navigate" });
      expect(steps[1]).toMatchObject({ type: "act", name: "browser_snapshot" });
      expect(steps[2]).toMatchObject({ type: "reason" });
      expect(steps[3]).toMatchObject({ type: "act", name: "browser_click" });
    });

    it("handles single-quoted values", () => {
      const code = `act --name 'my_tool' --prompt 'do something'`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("my_tool");
    });

    it("handles command substitution", () => {
      const code = `result=$(act --name "tool1" --prompt "get data")`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("tool1");
    });

    it("returns empty for bash without act/reason", () => {
      const code = `
echo "hello"
ls -la
cat /etc/hosts
`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(0);
    });

    it("returns empty for empty code", () => {
      expect(codeToAST("", "bash")).toHaveLength(0);
      expect(codeToAST("  ", "bash")).toHaveLength(0);
    });

    it("extracts correct line numbers", () => {
      const code = `act --name "tool1" --prompt "step 1"
act --name "tool2" --prompt "step 2"
reason --prompt "analyze"`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(3);
      expect(steps[0].line).toBe(1);
      expect(steps[1].line).toBe(2);
      expect(steps[2].line).toBe(3);
    });

    it("handles backslash line continuation", () => {
      const code = `act --name "tool1" \\
  --prompt "this is a long prompt"`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("tool1");
    });
  });

  // ─── Python Control Flow ───────────────────────────────────────────────

  describe("python control flow detection", () => {
    it("detects for loop with children", () => {
      const code = `
async def main():
    for url in urls:
        page = await act('navigate', f'Go to {url}')
        content = await act('snapshot', 'Get page')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].name).toContain("for url in urls");
      expect(steps[0].children).toHaveLength(2);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "navigate" });
      expect(steps[0].children![1]).toMatchObject({ type: "act", name: "snapshot" });
    });

    it("detects while loop", () => {
      const code = `
while not done:
    result = await act('check', 'Check status')
    done = result == 'ok'
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].name).toContain("while");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "check" });
    });

    it("detects if/elif/else branches", () => {
      const code = `
async def main():
    if condition:
        await act('tool1', 'do 1')
    elif other:
        await reason('analyze', {})
    else:
        await act('tool2', 'do 2')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(3);
      expect(steps[0].type).toBe("condition");
      expect(steps[0].name).toContain("if");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "tool1" });

      expect(steps[1].type).toBe("condition");
      expect(steps[1].name).toContain("elif");
      expect(steps[1].children).toHaveLength(1);
      expect(steps[1].children![0]).toMatchObject({ type: "reason" });

      expect(steps[2].type).toBe("condition");
      expect(steps[2].name).toBe("else");
      expect(steps[2].children).toHaveLength(1);
      expect(steps[2].children![0]).toMatchObject({ type: "act", name: "tool2" });
    });

    it("detects try/except/finally", () => {
      const code = `
async def main():
    try:
        result = await act('risky', 'do risky thing')
    except Exception as e:
        await act('log', str(e))
    finally:
        await act('cleanup', 'clean up')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(3);
      expect(steps[0]).toMatchObject({ type: "error-handling", name: "try" });
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "risky" });

      expect(steps[1]).toMatchObject({ type: "error-handling" });
      expect(steps[1].name).toContain("except");
      expect(steps[1].children).toHaveLength(1);

      expect(steps[2]).toMatchObject({ type: "error-handling", name: "finally" });
      expect(steps[2].children).toHaveLength(1);
    });

    it("detects nested loops and conditions", () => {
      const code = `
for item in items:
    if item.valid:
        for sub in item.parts:
            await act('process', f'Process {sub}')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0].type).toBe("condition");
      expect(steps[0].children![0].children).toHaveLength(1);
      expect(steps[0].children![0].children![0].type).toBe("loop");
      expect(steps[0].children![0].children![0].children).toHaveLength(1);
      expect(steps[0].children![0].children![0].children![0].type).toBe("act");
    });

    it("handles empty control flow blocks (no act/reason inside)", () => {
      const code = `
for x in items:
    print(x)
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].children).toBeUndefined();
    });

    it("mixes flat act/reason with control flow", () => {
      const code = `
async def main():
    await act('setup', 'Initialize')
    for url in urls:
        await act('navigate', url)
    await reason('Summarize results', {})
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(3);
      expect(steps[0]).toMatchObject({ type: "act", name: "setup" });
      expect(steps[1]).toMatchObject({ type: "loop" });
      expect(steps[1].children).toHaveLength(1);
      expect(steps[1].children![0]).toMatchObject({ type: "act", name: "navigate" });
      expect(steps[2]).toMatchObject({ type: "reason" });
    });

    it("handles for loop followed by sibling code", () => {
      const code = `
for i in range(3):
    await act('step', f'Iteration {i}')
await act('done', 'All done')
`;
      const steps = codeToAST(code, "python");
      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[1]).toMatchObject({ type: "act", name: "done" });
    });
  });

  // ─── Bash Control Flow ─────────────────────────────────────────────────

  describe("bash control flow detection", () => {
    it("detects for loop with do on same line", () => {
      const code = `for url in $URLS; do
    act --name "navigate" --prompt "Go to $url"
done`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].name).toContain("for url in");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "navigate" });
    });

    it("detects while loop", () => {
      const code = `while true; do
    act --name "check" --prompt "Check status"
done`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "check" });
    });

    it("detects if/elif/else/fi", () => {
      const code = `if [ "$status" = "ok" ]; then
    act --name "proceed" --prompt "Go ahead"
elif [ "$status" = "warn" ]; then
    reason --prompt "Analyze warning"
else
    act --name "abort" --prompt "Stop"
fi`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(3);
      expect(steps[0].type).toBe("condition");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "proceed" });

      expect(steps[1].type).toBe("condition");
      expect(steps[1].children).toHaveLength(1);
      expect(steps[1].children![0]).toMatchObject({ type: "reason" });

      expect(steps[2].type).toBe("condition");
      expect(steps[2].name).toBe("else");
      expect(steps[2].children).toHaveLength(1);
      expect(steps[2].children![0]).toMatchObject({ type: "act", name: "abort" });
    });

    it("detects nested for inside if", () => {
      const code = `if [ -n "$URLS" ]; then
    for url in $URLS; do
        act --name "navigate" --prompt "Go to $url"
    done
fi`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("condition");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0].type).toBe("loop");
      expect(steps[0].children![0].children).toHaveLength(1);
      expect(steps[0].children![0].children![0]).toMatchObject({ type: "act", name: "navigate" });
    });

    it("handles for with do on separate line", () => {
      const code = `for f in *.txt
do
    act --name "process" --prompt "Handle $f"
done`;
      const steps = codeToAST(code, "bash");
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe("loop");
      expect(steps[0].children).toHaveLength(1);
      expect(steps[0].children![0]).toMatchObject({ type: "act", name: "process" });
    });
  });

  // ─── countTrackableSteps ───────────────────────────────────────────────

  describe("countTrackableSteps", () => {
    it("counts flat act/reason steps", () => {
      const steps: ASTStep[] = [
        { type: "act", name: "t1", args: [], line: 1 },
        { type: "reason", name: "r1", args: [], line: 2 },
        { type: "act", name: "t2", args: [], line: 3 },
      ];
      expect(countTrackableSteps(steps)).toBe(3);
    });

    it("counts within nested tree", () => {
      const steps: ASTStep[] = [
        { type: "act", name: "setup", args: [], line: 1 },
        {
          type: "loop",
          name: "for items",
          args: [],
          line: 2,
          children: [
            { type: "act", name: "tool", args: [], line: 3 },
            {
              type: "condition",
              name: "if x",
              args: [],
              line: 4,
              children: [{ type: "reason", name: "analyze", args: [], line: 5 }],
            },
          ],
        },
      ];
      expect(countTrackableSteps(steps)).toBe(3);
    });

    it("returns 0 for only structural nodes", () => {
      const steps: ASTStep[] = [{ type: "loop", name: "for x", args: [], line: 1 }];
      expect(countTrackableSteps(steps)).toBe(0);
    });

    it("returns 0 for empty array", () => {
      expect(countTrackableSteps([])).toBe(0);
    });
  });

  // ─── flattenAST ───────────────────────────────────────────────────────

  describe("flattenAST", () => {
    it("flattens simple flat list", () => {
      const steps: ASTStep[] = [
        { type: "act", name: "t1", args: [], line: 1 },
        { type: "reason", name: "r1", args: [], line: 2 },
      ];
      const flat = flattenAST(steps);
      expect(flat).toHaveLength(2);
      expect(flat[0]).toMatchObject({ depth: 0, trackableIndex: 0 });
      expect(flat[1]).toMatchObject({ depth: 0, trackableIndex: 1 });
    });

    it("flattens tree with depth and trackable indices", () => {
      const steps: ASTStep[] = [
        { type: "act", name: "setup", args: [], line: 1 },
        {
          type: "loop",
          name: "for items",
          args: [],
          line: 2,
          children: [
            { type: "act", name: "tool", args: [], line: 3 },
            { type: "reason", name: "analyze", args: [], line: 4 },
          ],
        },
        { type: "act", name: "cleanup", args: [], line: 5 },
      ];
      const flat = flattenAST(steps);
      expect(flat).toHaveLength(5);
      expect(flat[0]).toMatchObject({ depth: 0, trackableIndex: 0 }); // setup
      expect(flat[1]).toMatchObject({ depth: 0 }); // loop
      expect(flat[1].trackableIndex).toBeUndefined();
      expect(flat[2]).toMatchObject({ depth: 1, trackableIndex: 1 }); // tool
      expect(flat[3]).toMatchObject({ depth: 1, trackableIndex: 2 }); // reason
      expect(flat[4]).toMatchObject({ depth: 0, trackableIndex: 3 }); // cleanup
    });

    it("handles deeply nested tree", () => {
      const steps: ASTStep[] = [
        {
          type: "loop",
          name: "outer",
          args: [],
          line: 1,
          children: [
            {
              type: "condition",
              name: "if x",
              args: [],
              line: 2,
              children: [{ type: "act", name: "deep", args: [], line: 3 }],
            },
          ],
        },
      ];
      const flat = flattenAST(steps);
      expect(flat).toHaveLength(3);
      expect(flat[0]).toMatchObject({ depth: 0 }); // outer loop
      expect(flat[1]).toMatchObject({ depth: 1 }); // if x
      expect(flat[2]).toMatchObject({ depth: 2, trackableIndex: 0 }); // deep act
    });
  });
});
