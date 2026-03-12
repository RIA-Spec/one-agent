/**
 * Code-to-AST: TypeScript-side extraction of code structure + act()/reason() calls.
 *
 * Parses code strings to extract structured step plans (tree) for flow visualization.
 * Supports both Python and Bash AER modes with mode-specific block-aware parsers.
 *
 * Detects:
 * - act() / reason() calls (trackable steps with runtime progress)
 * - for / while loops
 * - if / elif / else conditions
 * - try / except / finally error handling
 * - Nested structures (children)
 */

import type { ASTStep } from "../progress.js";

export type AERMode = "python" | "bash";

/**
 * Extract structured AST tree from code based on AER mode.
 * Returns a tree of steps for flow visualization and progress tracking.
 */
export function codeToAST(code: string, mode: AERMode): ASTStep[] {
  if (!code || code.trim().length === 0) return [];

  switch (mode) {
    case "python":
      return parsePythonAST(code);
    case "bash":
      return parseBashAST(code);
    default:
      return [];
  }
}

/**
 * Count trackable (act/reason) steps in an AST tree.
 * These map 1:1 to runtime step counter indices.
 */
export function countTrackableSteps(steps: ASTStep[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.type === "act" || step.type === "reason") count++;
    if (step.children) count += countTrackableSteps(step.children);
  }
  return count;
}

/**
 * Flatten an AST tree into a display-order list.
 * Each entry carries its depth and (for act/reason) its trackable index.
 */
export interface FlatDisplayNode {
  step: ASTStep;
  depth: number;
  /** Runtime step counter index. Only set for act/reason nodes. */
  trackableIndex?: number;
}

export function flattenAST(steps: ASTStep[], depth = 0, counter = { value: 0 }): FlatDisplayNode[] {
  const result: FlatDisplayNode[] = [];
  for (const step of steps) {
    if (step.type === "act" || step.type === "reason") {
      result.push({ step, depth, trackableIndex: counter.value++ });
    } else {
      result.push({ step, depth });
      if (step.children) {
        result.push(...flattenAST(step.children, depth + 1, counter));
      }
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Python Parser — indentation-based block-aware recursive descent
// ═══════════════════════════════════════════════════════════════════════════

function parsePythonAST(code: string): ASTStep[] {
  const lines = code.split("\n");
  return parsePyBlock(lines, 0, -1).steps;
}

function pyIndent(line: string): number {
  return line.match(/^(\s*)/)?.[1]?.length ?? 0;
}

/**
 * Parse lines[startIdx..] as a block whose parent indent is `parentIndent`.
 * Returns all steps found and the index of the first un-consumed line.
 */
function parsePyBlock(
  lines: string[],
  startIdx: number,
  parentIndent: number,
): { steps: ASTStep[]; endIdx: number } {
  const steps: ASTStep[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip blanks / comments
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = pyIndent(raw);

    // Exited current block (dedented back to parent or further)
    if (parentIndent >= 0 && indent <= parentIndent) break;

    // ── for loop ────────────────────────────────────────────────
    if (/^for\s+.+\s+in\s+/.test(trimmed) && trimmed.endsWith(":")) {
      const { steps: children, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "loop",
        name: trimmed.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(children.length > 0 && { children }),
      });
      i = endIdx;
      continue;
    }

    // ── while loop ──────────────────────────────────────────────
    if (/^while\s+/.test(trimmed) && trimmed.endsWith(":")) {
      const { steps: children, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "loop",
        name: trimmed.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(children.length > 0 && { children }),
      });
      i = endIdx;
      continue;
    }

    // ── if / elif / else ────────────────────────────────────────
    if (/^(?:if|elif)\s+.+:|^else\s*:/.test(trimmed)) {
      const { steps: children, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "condition",
        name: trimmed.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(children.length > 0 && { children }),
      });
      i = endIdx;
      continue;
    }

    // ── try / except / finally ──────────────────────────────────
    if (
      /^try\s*:/.test(trimmed) ||
      /^except(\s+.+)?\s*:/.test(trimmed) ||
      /^finally\s*:/.test(trimmed)
    ) {
      const { steps: children, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "error-handling",
        name: trimmed.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(children.length > 0 && { children }),
      });
      i = endIdx;
      continue;
    }

    // ── async with / with ───────────────────────────────────────
    if (/^(?:async\s+)?with\s+.+:/.test(trimmed)) {
      const { steps: children, endIdx } = parsePyBlock(lines, i + 1, indent);
      if (children.length > 0) {
        steps.push({
          type: "loop",
          name: trimmed.slice(0, -1).trim(),
          args: [],
          line: i + 1,
          children,
        });
      }
      i = endIdx;
      continue;
    }

    // ── async def / def — transparent, hoist body ───────────────
    if (/^(?:async\s+)?def\s+\w+/.test(trimmed) && trimmed.endsWith(":")) {
      const { steps: bodySteps, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push(...bodySteps);
      i = endIdx;
      continue;
    }

    // ── class — transparent, hoist body ─────────────────────────
    if (/^class\s+\w+/.test(trimmed) && trimmed.endsWith(":")) {
      const { steps: bodySteps, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push(...bodySteps);
      i = endIdx;
      continue;
    }

    // ── act() / reason() (await optional for AST planning) ──────
    if (/(?:\bawait\s+)?\b(act|reason)\s*\(/.test(trimmed)) {
      const fnType = trimmed.match(/(?:\bawait\s+)?\b(act|reason)/)?.[1] as "act" | "reason";
      const { text: callText, endLine } = collectPyCall(lines, i);

      // Find the opening paren
      const callMatch = callText.match(/(?:\bawait\s+)?\b(?:act|reason)\s*\(/);
      if (callMatch) {
        const parenStart = callText.indexOf("(", callMatch.index!) + 1;
        const argsStr = extractBalancedParens(callText, parenStart);

        if (fnType === "act") {
          steps.push(parseActCall(argsStr || "", i + 1));
        } else {
          steps.push(parseReasonCall(argsStr || "", i + 1));
        }
      }
      i = endLine + 1;
      continue;
    }

    i++;
  }

  return { steps, endIdx: i };
}

/**
 * Collect a multi-line Python call starting at `idx` until parens balance.
 */
function collectPyCall(lines: string[], idx: number): { text: string; endLine: number } {
  let text = "";
  let depth = 0;
  let started = false;
  let inStr: string | null = null;

  for (let i = idx; i < lines.length; i++) {
    text += (i === idx ? "" : "\n") + lines[i];

    for (let c = 0; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (inStr) {
        if (ch === "\\" && inStr !== "'") {
          c++;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === "(") {
        depth++;
        started = true;
      }
      if (ch === ")") depth--;
    }

    if (started && depth <= 0) return { text, endLine: i };
  }

  return { text, endLine: lines.length - 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Python call argument helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract balanced content inside parentheses, respecting string literals.
 */
function extractBalancedParens(code: string, start: number): string | null {
  let depth = 1;
  let i = start;
  let inSQ = false;
  let inDQ = false;
  let inTSQ = false;
  let inTDQ = false;

  while (i < code.length && depth > 0) {
    const next3 = code.substring(i, i + 3);

    if (!inSQ && !inDQ) {
      if (next3 === '"""') {
        inTDQ = !inTDQ;
        i += 3;
        continue;
      }
      if (next3 === "'''") {
        inTSQ = !inTSQ;
        i += 3;
        continue;
      }
    }
    if (inTSQ || inTDQ) {
      i++;
      continue;
    }
    if (code[i] === "\\" && (inSQ || inDQ)) {
      i += 2;
      continue;
    }
    if (code[i] === "'" && !inDQ) {
      inSQ = !inSQ;
      i++;
      continue;
    }
    if (code[i] === '"' && !inSQ) {
      inDQ = !inDQ;
      i++;
      continue;
    }

    if (!inSQ && !inDQ) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    if (depth > 0) i++;
    else break;
  }

  return depth === 0 ? code.substring(start, i).trim() : null;
}

function parseActCall(argsStr: string, line: number): ASTStep {
  const nameMatch = argsStr.match(/^[f]?['"]([^'"]{0,80})['"]/);
  const name = nameMatch ? nameMatch[1] : "tool";
  const rest = argsStr
    .substring(nameMatch ? nameMatch[0].length : 0)
    .replace(/^\s*,\s*/, "")
    .trim();
  const argPreview = rest
    .replace(/\s+/g, " ")
    .replace(/^['"]|['"]$/g, "")
    .substring(0, 60);

  return { type: "act", name, args: argPreview ? [argPreview] : [], line };
}

function parseReasonCall(argsStr: string, line: number): ASTStep {
  const prompt = extractFirstStringArg(argsStr);
  return { type: "reason", name: prompt || "Analyze", args: [], line };
}

function extractFirstStringArg(argsStr: string): string {
  const fstringMatch = argsStr.match(/^f['"](.{0,80}?)['"]/);
  if (fstringMatch) {
    return (
      'f"' +
      fstringMatch[1]
        .replace(/\{[^}]*\}/g, "{...}")
        .replace(/\s+/g, " ")
        .trim() +
      '"'
    );
  }

  const strMatch = argsStr.match(/^['"](.{0,80}?)['"]/);
  if (strMatch) return strMatch[1].replace(/\s+/g, " ").trim();

  const tripleMatch = argsStr.match(/^(?:f)?(?:"""(.{0,80}?)"""|'''(.{0,80}?)''')/s);
  if (tripleMatch) {
    return (tripleMatch[1] || tripleMatch[2] || "").replace(/\s+/g, " ").trim().substring(0, 60);
  }

  const varMatch = argsStr.match(/^([a-zA-Z_]\w*)/);
  if (varMatch) return varMatch[1];
  return "";
}

// ═══════════════════════════════════════════════════════════════════════════
// Bash Parser — keyword/delimiter-based block-aware parsing
// ═══════════════════════════════════════════════════════════════════════════

function parseBashAST(code: string): ASTStep[] {
  const normalized = code.replace(/\\\n\s*/g, " ");
  const lines = normalized.split("\n");

  type Frame = { node: ASTStep; closeRe: RegExp };
  const root: ASTStep[] = [];
  const stack: Frame[] = [];
  /** Where new steps should be pushed */
  const target = (): ASTStep[] =>
    stack.length > 0 ? (stack[stack.length - 1].node.children ??= []) : root;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const trimmed = lines[lineIdx].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lineNum = lineIdx + 1;

    // ── elif / else — close previous condition branch, open new one ─
    // (must be checked BEFORE generic close-keyword handler)
    if (/^elif\s+/.test(trimmed) || trimmed === "else") {
      // Pop previous condition branch if on stack
      if (stack.length > 0 && stack[stack.length - 1].node.type === "condition") {
        stack.pop();
      }
      const name =
        trimmed === "else"
          ? "else"
          : trimmed
              .replace(/;\s*then\s*$/, "")
              .replace(/\s+then\s*$/, "")
              .trim();
      const node: ASTStep = { type: "condition", name, args: [], line: lineNum, children: [] };
      target().push(node);
      stack.push({ node, closeRe: /^(?:elif|else|fi)\b/ });
      continue;
    }

    // ── close keywords (done, fi) ──────────────────────────────
    if (stack.length > 0 && stack[stack.length - 1].closeRe.test(trimmed)) {
      stack.pop();
      continue;
    }

    // ── for loop ───────────────────────────────────────────────
    if (/^for\s+/.test(trimmed)) {
      const name = trimmed
        .replace(/;\s*do\s*$/, "")
        .replace(/\s+do\s*$/, "")
        .trim();
      const node: ASTStep = { type: "loop", name, args: [], line: lineNum, children: [] };
      target().push(node);
      if (/;\s*do\s*$/.test(trimmed) || /\bdo\s*$/.test(trimmed)) {
        stack.push({ node, closeRe: /^done\b/ });
      }
      // else "do" comes on a later line — handled below
      continue;
    }

    // ── while loop ─────────────────────────────────────────────
    if (/^while\s+/.test(trimmed)) {
      const name = trimmed
        .replace(/;\s*do\s*$/, "")
        .replace(/\s+do\s*$/, "")
        .trim();
      const node: ASTStep = { type: "loop", name, args: [], line: lineNum, children: [] };
      target().push(node);
      if (/;\s*do\s*$/.test(trimmed) || /\bdo\s*$/.test(trimmed)) {
        stack.push({ node, closeRe: /^done\b/ });
      }
      continue;
    }

    // ── bare "do" (after for/while on previous line) ───────────
    if (trimmed === "do" || trimmed.startsWith("do;") || trimmed.startsWith("do ")) {
      // Find last loop node that's not yet on the stack
      const lastLoop = [...target()].reverse().find((s) => s.type === "loop");
      if (lastLoop && !stack.some((f) => f.node === lastLoop)) {
        if (!lastLoop.children) lastLoop.children = [];
        stack.push({ node: lastLoop, closeRe: /^done\b/ });
      }
      continue;
    }

    // ── if statement ───────────────────────────────────────────
    if (/^if\s+/.test(trimmed)) {
      const name = trimmed
        .replace(/;\s*then\s*$/, "")
        .replace(/\s+then\s*$/, "")
        .trim();
      const node: ASTStep = { type: "condition", name, args: [], line: lineNum, children: [] };
      target().push(node);
      if (/;\s*then\s*$/.test(trimmed) || /\bthen\s*$/.test(trimmed)) {
        stack.push({ node, closeRe: /^(?:elif|else|fi)\b/ });
      }
      continue;
    }

    // ── bare "then" ────────────────────────────────────────────
    if (trimmed === "then") {
      const lastCond = [...target()].reverse().find((s) => s.type === "condition");
      if (lastCond && !stack.some((f) => f.node === lastCond)) {
        if (!lastCond.children) lastCond.children = [];
        stack.push({ node: lastCond, closeRe: /^(?:elif|else|fi)\b/ });
      }
      continue;
    }

    // ── act / reason commands ──────────────────────────────────
    const cmdRe = /(?:^|[|;&]|\$\()\s*(act|reason)\b/g;
    let cmdMatch: RegExpExecArray | null;

    while ((cmdMatch = cmdRe.exec(trimmed)) !== null) {
      const cmdType = cmdMatch[1] as "act" | "reason";
      const cmdStart = cmdMatch.index + cmdMatch[0].length - cmdType.length;
      const cmdStr = extractBashCommand(trimmed, cmdStart);

      if (cmdType === "act") {
        target().push(parseBashActCommand(cmdStr, lineNum));
      } else {
        target().push(parseBashReasonCommand(cmdStr, lineNum));
      }
    }
  }

  return root;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bash helpers
// ═══════════════════════════════════════════════════════════════════════════

function extractBashCommand(line: string, start: number): string {
  let i = start;
  let inSQ = false;
  let inDQ = false;
  let depth = 0;

  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && inDQ) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDQ) {
      inSQ = !inSQ;
      i++;
      continue;
    }
    if (ch === '"' && !inSQ) {
      inDQ = !inDQ;
      i++;
      continue;
    }
    if (!inSQ && !inDQ) {
      if (ch === "$" && line[i + 1] === "(") {
        depth++;
        i += 2;
        continue;
      }
      if (ch === ")" && depth > 0) {
        depth--;
        i++;
        continue;
      }
      if (depth === 0) {
        if (ch === "|" || ch === ";" || ch === ")") break;
        if (ch === "&" && line[i + 1] === "&") break;
      }
    }
    i++;
  }
  return line.substring(start, i).trim();
}

function parseBashActCommand(cmdStr: string, line: number): ASTStep {
  const name = extractBashFlag(cmdStr, "--name") || "tool";
  const prompts = extractAllBashFlags(cmdStr, "--prompt");
  const preview = prompts
    .filter((p) => p !== "-")
    .join(" ")
    .substring(0, 60);
  return { type: "act", name, args: preview ? [preview] : [], line };
}

function parseBashReasonCommand(cmdStr: string, line: number): ASTStep {
  const prompts = extractAllBashFlags(cmdStr, "--prompt");
  const positional = extractBashPositionalArgs(cmdStr);
  const promptFromFlags = prompts
    .filter((p) => p !== "-")
    .join(" ")
    .substring(0, 60);
  const text = promptFromFlags || positional[0] || "Analyze";
  const structure = extractBashFlag(cmdStr, "--structure") || positional[1] || null;
  return {
    type: "reason",
    name: text,
    args: structure ? [structure.substring(0, 40)] : [],
    line,
  };
}

function extractBashFlag(cmdStr: string, flag: string): string | null {
  const results = extractAllBashFlags(cmdStr, flag);
  return results.length > 0 ? results[0] : null;
}

function extractAllBashFlags(cmdStr: string, flag: string): string[] {
  const results: string[] = [];
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}\\s+`, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(cmdStr)) !== null) {
    const vStart = m.index + m[0].length;
    const value = extractBashValue(cmdStr, vStart);
    if (value !== null) results.push(value);
  }
  return results;
}

function extractBashValue(cmdStr: string, start: number): string | null {
  if (start >= cmdStr.length) return null;
  const ch = cmdStr[start];

  if (ch === '"' || ch === "'") {
    const q = ch;
    let i = start + 1;
    let val = "";
    while (i < cmdStr.length) {
      if (cmdStr[i] === "\\" && q === '"') {
        val += cmdStr[i + 1] || "";
        i += 2;
        continue;
      }
      if (cmdStr[i] === q) break;
      val += cmdStr[i];
      i++;
    }
    return val;
  }

  const word = cmdStr.substring(start).match(/^(\S+)/);
  return word ? word[1] : null;
}

function extractBashPositionalArgs(cmdStr: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < cmdStr.length) {
    while (i < cmdStr.length && /\s/.test(cmdStr[i])) i++;
    if (i >= cmdStr.length) break;

    const ch = cmdStr[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      let value = "";
      while (i < cmdStr.length) {
        if (cmdStr[i] === "\\" && q === '"' && i + 1 < cmdStr.length) {
          value += cmdStr[i + 1];
          i += 2;
          continue;
        }
        if (cmdStr[i] === q) {
          i++;
          break;
        }
        value += cmdStr[i++];
      }
      tokens.push(value);
      continue;
    }

    const start = i;
    while (i < cmdStr.length && !/\s/.test(cmdStr[i])) i++;
    tokens.push(cmdStr.slice(start, i));
  }

  // Drop command name and flags/flag-values, keep only positional args.
  const positional: string[] = [];
  for (let idx = 1; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (token.startsWith("--")) {
      if (idx + 1 < tokens.length && !tokens[idx + 1].startsWith("--")) idx++;
      continue;
    }
    positional.push(token);
  }
  return positional;
}
