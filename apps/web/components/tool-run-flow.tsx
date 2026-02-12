"use client";

import {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import "@xyflow/react/dist/style.css";
import {
  Brain,
  CheckCircle,
  CheckCircle2,
  Circle,
  FileSearch,
  GitBranch,
  Loader2,
  Play,
  Repeat2,
  Shield,
  Terminal,
  XCircle,
  Zap,
} from "lucide-react";
import {
  type StepState,
  useExecutionProgress,
} from "@/hooks/use-execution-progress";
import type { ASTStep } from "@/lib/types";

type ExecutionState = "pending" | "streaming" | "available" | "error";
type AERMode = "python" | "bash";

interface ToolRunFlowProps {
  state: ExecutionState;
  mode?: AERMode;
  code?: string;
  output?: string;
  isError?: boolean;
}

interface NodeData {
  [key: string]: unknown;
  label: string;
  status: "pending" | "running" | "completed" | "error";
  type: "start" | "act" | "reason" | "end";
  details?: string;
  /** Control flow ancestry breadcrumb, e.g. [{type:'loop',label:'for topic in topics'}, ...] */
  context?: { type: ASTStep["type"]; label: string }[];
}

function FlowNode({ data }: { data: NodeData }) {
  const getStatusIcon = () => {
    switch (data.status) {
      case "pending":
        return <Circle className="h-3.5 w-3.5 text-gray-400" />;
      case "running":
        return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
      case "completed":
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
      case "error":
        return <XCircle className="h-3.5 w-3.5 text-red-500" />;
      default:
        return <Circle className="h-3.5 w-3.5 text-gray-400" />;
    }
  };

  const getTypeIcon = () => {
    switch (data.type) {
      case "start":
        return <Play className="h-3.5 w-3.5 text-indigo-500" />;
      case "act":
        return <Terminal className="h-3.5 w-3.5 text-blue-600" />;
      case "reason":
        return <Brain className="h-3.5 w-3.5 text-orange-500" />;
      case "end":
        return <CheckCircle className="h-3.5 w-3.5 text-green-600" />;
      default:
        return <Circle className="h-3.5 w-3.5 text-gray-400" />;
    }
  };

  const getBgColor = () => {
    if (data.status === "error") {
      return "bg-red-50 border-red-300";
    }
    if (data.status === "running") {
      return "bg-blue-50 border-blue-300 shadow-md";
    }
    if (data.status === "completed") {
      switch (data.type) {
        case "act":
          return "bg-blue-50 border-blue-300";
        case "reason":
          return "bg-orange-50 border-orange-300";
        case "end":
          return "bg-green-50 border-green-300";
        default:
          return "bg-gray-50 border-gray-200";
      }
    }
    return "bg-gray-50 border-gray-200";
  };

  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border px-3 py-2 transition-all ${getBgColor()} min-w-[140px] max-w-[200px]`}
    >
      <Handle
        className="!h-1.5 !w-1.5 !bg-transparent !border-transparent"
        position={Position.Left}
        type="target"
      />

      <div className="flex items-center gap-2">
        {getTypeIcon()}
        <span className="text-xs font-semibold text-gray-800 flex-1 truncate">
          {data.label}
        </span>
        {getStatusIcon()}
      </div>

      {data.details && (
        <div className="text-[10px] text-gray-600 font-mono leading-tight mt-0.5 break-words line-clamp-2">
          {data.details}
        </div>
      )}

      {data.context && data.context.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5 mt-0.5">
          {data.context.map((ctx) => {
            const icon =
              ctx.type === "loop" ? (
                <Repeat2 className="h-2.5 w-2.5 text-violet-500" />
              ) : ctx.type === "condition" ? (
                <GitBranch className="h-2.5 w-2.5 text-amber-500" />
              ) : (
                <Shield className="h-2.5 w-2.5 text-rose-400" />
              );
            const color =
              ctx.type === "loop"
                ? "bg-violet-50 text-violet-600 border-violet-200"
                : ctx.type === "condition"
                  ? "bg-amber-50 text-amber-600 border-amber-200"
                  : "bg-rose-50 text-rose-500 border-rose-200";
            return (
              <span
                className={`inline-flex items-center gap-0.5 px-1 py-px rounded border text-[8px] font-medium leading-tight ${color}`}
                key={`${ctx.type}-${ctx.label}`}
              >
                {icon}
                <span className="truncate max-w-[80px]">{ctx.label}</span>
              </span>
            );
          })}
        </div>
      )}

      <Handle
        className="!h-1.5 !w-1.5 !bg-transparent !border-transparent"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

const nodeTypes = {
  flow: FlowNode,
};

/**
 * Parse code to AST steps tree based on AER mode.
 * Produces a tree with control flow (loop/condition/error-handling) nodes.
 */
function parseCodeToSteps(code: string, mode: AERMode = "python"): ASTStep[] {
  if (!code || code.trim().length === 0) {
    return [];
  }

  switch (mode) {
    case "python":
      return parsePythonTree(code);
    case "bash":
      return parseBashTree(code);
    default:
      return [];
  }
}

// ─── Flatten Utility ────────────────────────────────────────────────────────

interface ContextCrumb {
  type: ASTStep["type"];
  label: string;
}

interface FlatNode {
  step: ASTStep;
  /** Runtime step counter index for act/reason nodes */
  trackableIndex: number;
  /** Control flow ancestry path */
  context: ContextCrumb[];
}

/**
 * Shorten a control flow name for display as a breadcrumb tag.
 * e.g. "for topic in topics" → "for topic in topics"
 *      "if not topics" → "if not topics"
 *      "except ImportError as e" → "except ImportError"
 */
function shortenContext(name: string): string {
  return name.length > 28 ? `${name.substring(0, 25)}...` : name;
}

/**
 * Flatten a tree of ASTStep, extracting only act/reason nodes in execution order.
 * Each node carries its control flow ancestry as context breadcrumbs.
 */
function flattenTree(
  steps: ASTStep[],
  ancestors: ContextCrumb[] = [],
  counter = { value: 0 }
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const step of steps) {
    if (step.type === "act" || step.type === "reason") {
      result.push({
        step,
        trackableIndex: counter.value++,
        context: ancestors,
      });
    } else if (step.children) {
      const crumb: ContextCrumb = {
        type: step.type,
        label: shortenContext(step.name),
      };
      result.push(
        ...flattenTree(step.children, [...ancestors, crumb], counter)
      );
    }
  }
  return result;
}

/**
 * Count trackable (act/reason) steps in a tree.
 */
function countTrackable(steps: ASTStep[]): number {
  let c = 0;
  for (const s of steps) {
    if (s.type === "act" || s.type === "reason") {
      c++;
    }
    if (s.children) {
      c += countTrackable(s.children);
    }
  }
  return c;
}

// ─── Python Tree Parser ─────────────────────────────────────────────────────

function parsePythonTree(code: string): ASTStep[] {
  const lines = code.split("\n");
  return parsePyBlock(lines, 0, -1).steps;
}

function pyIndent(line: string): number {
  return line.match(/^(\s*)/)?.[1]?.length ?? 0;
}

function parsePyBlock(
  lines: string[],
  startIdx: number,
  parentIndent: number
): { steps: ASTStep[]; endIdx: number } {
  const steps: ASTStep[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#")) {
      i++;
      continue;
    }

    const indent = pyIndent(raw);
    if (parentIndent >= 0 && indent <= parentIndent) {
      break;
    }

    // for / while loop
    if (
      (/^for\s+.+\s+in\s+/.test(t) || /^while\s+/.test(t)) &&
      t.endsWith(":")
    ) {
      const { steps: ch, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "loop",
        name: t.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(ch.length > 0 && { children: ch }),
      });
      i = endIdx;
      continue;
    }

    // if / elif / else
    if (/^(?:if|elif)\s+.+:|^else\s*:/.test(t)) {
      const { steps: ch, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "condition",
        name: t.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(ch.length > 0 && { children: ch }),
      });
      i = endIdx;
      continue;
    }

    // try / except / finally
    if (/^try\s*:|^except.*:|^finally\s*:/.test(t)) {
      const { steps: ch, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push({
        type: "error-handling",
        name: t.slice(0, -1).trim(),
        args: [],
        line: i + 1,
        ...(ch.length > 0 && { children: ch }),
      });
      i = endIdx;
      continue;
    }

    // async def / def / class — transparent
    if (
      (/^(?:async\s+)?def\s+/.test(t) || /^class\s+/.test(t)) &&
      t.endsWith(":")
    ) {
      const { steps: body, endIdx } = parsePyBlock(lines, i + 1, indent);
      steps.push(...body);
      i = endIdx;
      continue;
    }

    // await act() / await reason()
    if (/await\s+(act|reason)\s*\(/.test(t)) {
      const fnType = t.match(/await\s+(act|reason)/)?.[1] as "act" | "reason";
      const { text: callText, endLine } = collectPyCallText(lines, i);
      const argsStr = extractCallArgs(callText);

      if (fnType === "act") {
        const nameMatch = argsStr?.match(/^[f]?['"]([^'"]{0,80})['"]/);
        const name = nameMatch ? nameMatch[1] : "tool";
        const rest = (argsStr || "")
          .substring(nameMatch ? nameMatch[0].length : 0)
          .replace(/^\s*,\s*/, "")
          .trim();
        const preview = rest
          .replace(/\s+/g, " ")
          .replace(/^['"]|['"]$/g, "")
          .substring(0, 60);
        steps.push({
          type: "act",
          name,
          args: preview ? [preview] : [],
          line: i + 1,
        });
      } else {
        const fstr = argsStr?.match(/^f['"](.{0,60}?)['"]/);
        const str = argsStr?.match(/^['"](.{0,60}?)['"]/);
        let prompt = "Analyze";
        if (fstr) {
          prompt = `f"${fstr[1].replace(/\{[^}]*\}/g, "{...}").trim()}"`;
        } else if (str) {
          prompt = str[1].trim();
        }
        steps.push({ type: "reason", name: prompt, args: [], line: i + 1 });
      }
      i = endLine + 1;
      continue;
    }

    i++;
  }
  return { steps, endIdx: i };
}

function collectPyCallText(
  lines: string[],
  idx: number
): { text: string; endLine: number } {
  let text = "",
    depth = 0,
    started = false,
    inStr: string | null = null;
  for (let i = idx; i < lines.length; i++) {
    text += (i === idx ? "" : "\n") + lines[i];
    for (let c = 0; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (inStr) {
        if (ch === "\\") {
          c++;
          continue;
        }
        if (ch === inStr) {
          inStr = null;
        }
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
      if (ch === ")") {
        depth--;
      }
    }
    if (started && depth <= 0) {
      return { text, endLine: i };
    }
  }
  return { text, endLine: lines.length - 1 };
}

function extractCallArgs(callText: string): string | null {
  const m = callText.match(/await\s+(?:act|reason)\s*\(/);
  if (!m) {
    return null;
  }
  const matchIndex = m.index ?? 0;
  const start = callText.indexOf("(", matchIndex) + 1;
  let depth = 1,
    i = start,
    inSQ = false,
    inDQ = false;
  while (i < callText.length && depth > 0) {
    if (callText[i] === "\\" && (inSQ || inDQ)) {
      i += 2;
      continue;
    }
    if (callText[i] === "'" && !inDQ) {
      inSQ = !inSQ;
      i++;
      continue;
    }
    if (callText[i] === '"' && !inSQ) {
      inDQ = !inDQ;
      i++;
      continue;
    }
    if (!inSQ && !inDQ) {
      if (callText[i] === "(") {
        depth++;
      } else if (callText[i] === ")") {
        depth--;
      }
    }
    if (depth > 0) {
      i++;
    } else {
      break;
    }
  }
  return depth === 0 ? callText.substring(start, i).trim() : null;
}

// ─── Bash Tree Parser ───────────────────────────────────────────────────────

function parseBashTree(code: string): ASTStep[] {
  const normalized = code.replace(/\\\n\s*/g, " ");
  const lines = normalized.split("\n");

  type Frame = { node: ASTStep; closeRe: RegExp };
  const root: ASTStep[] = [];
  const stack: Frame[] = [];
  const target = (): ASTStep[] => {
    if (stack.length === 0) {
      return root;
    }

    const frame = stack.at(-1);
    if (!frame) {
      return root;
    }

    if (!frame.node.children) {
      frame.node.children = [];
    }

    return frame.node.children;
  };

  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim();
    if (!t || t.startsWith("#")) {
      continue;
    }
    const ln = li + 1;

    // elif / else (must check BEFORE generic close keywords)
    if (/^elif\s+/.test(t) || t === "else") {
      const lastFrame = stack.at(-1);
      if (lastFrame && lastFrame.node.type === "condition") {
        stack.pop();
      }
      const name =
        t === "else"
          ? "else"
          : t
              .replace(/;\s*then\s*$/, "")
              .replace(/\s+then\s*$/, "")
              .trim();
      const node: ASTStep = {
        type: "condition",
        name,
        args: [],
        line: ln,
        children: [],
      };
      target().push(node);
      stack.push({ node, closeRe: /^(?:elif|else|fi)\b/ });
      continue;
    }

    // Close keywords (done, fi)
    const currentFrame = stack.at(-1);
    if (currentFrame && currentFrame.closeRe.test(t)) {
      stack.pop();
      continue;
    }

    // for / while
    if (/^(?:for|while)\s+/.test(t)) {
      const name = t
        .replace(/;\s*do\s*$/, "")
        .replace(/\s+do\s*$/, "")
        .trim();
      const node: ASTStep = {
        type: "loop",
        name,
        args: [],
        line: ln,
        children: [],
      };
      target().push(node);
      if (/\bdo\s*$/.test(t)) {
        stack.push({ node, closeRe: /^done\b/ });
      }
      continue;
    }

    // bare do
    if (t === "do") {
      const last = [...target()].reverse().find((s) => s.type === "loop");
      if (last && !stack.some((f) => f.node === last)) {
        if (!last.children) {
          last.children = [];
        }
        stack.push({ node: last, closeRe: /^done\b/ });
      }
      continue;
    }

    // if
    if (/^if\s+/.test(t)) {
      const name = t
        .replace(/;\s*then\s*$/, "")
        .replace(/\s+then\s*$/, "")
        .trim();
      const node: ASTStep = {
        type: "condition",
        name,
        args: [],
        line: ln,
        children: [],
      };
      target().push(node);
      if (/\bthen\s*$/.test(t)) {
        stack.push({ node, closeRe: /^(?:elif|else|fi)\b/ });
      }
      continue;
    }

    // bare then
    if (t === "then") {
      const last = [...target()].reverse().find((s) => s.type === "condition");
      if (last && !stack.some((f) => f.node === last)) {
        if (!last.children) {
          last.children = [];
        }
        stack.push({ node: last, closeRe: /^(?:elif|else|fi)\b/ });
      }
      continue;
    }

    // act / reason commands
    const cmdRe = /(?:^|[|;&]|\$\()\s*(act|reason)\b/g;
    let cm: RegExpExecArray | null;
    while (true) {
      cm = cmdRe.exec(t);
      if (!cm) {
        break;
      }

      const cmdType = cm[1] as "act" | "reason";
      const cs = cm.index + cm[0].length - cmdType.length;
      const cmdStr = extractBashCmd(t, cs);
      if (cmdType === "act") {
        const name = bashFlag(cmdStr, "--name") || "tool";
        const p = bashFlags(cmdStr, "--prompt")
          .filter((x) => x !== "-")
          .join(" ")
          .substring(0, 60);
        target().push({ type: "act", name, args: p ? [p] : [], line: ln });
      } else {
        const p = bashFlags(cmdStr, "--prompt")
          .filter((x) => x !== "-")
          .join(" ")
          .substring(0, 60);
        target().push({
          type: "reason",
          name: p || "Analyze",
          args: [],
          line: ln,
        });
      }
    }
  }
  return root;
}

function extractBashCmd(line: string, start: number): string {
  let i = start,
    inSQ = false,
    inDQ = false,
    depth = 0;
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
      if (
        depth === 0 &&
        (ch === "|" ||
          ch === ";" ||
          ch === ")" ||
          (ch === "&" && line[i + 1] === "&"))
      ) {
        break;
      }
    }
    i++;
  }
  return line.substring(start, i).trim();
}

function bashFlag(cmd: string, flag: string): string | null {
  const r = bashFlags(cmd, flag);
  return r.length > 0 ? r[0] : null;
}

function bashFlags(cmd: string, flag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(
    `${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s+`,
    "g"
  );
  let m: RegExpExecArray | null;
  while (true) {
    m = re.exec(cmd);
    if (!m) {
      break;
    }

    const vs = m.index + m[0].length;
    if (vs >= cmd.length) {
      continue;
    }
    const ch = cmd[vs];
    if (ch === '"' || ch === "'") {
      let j = vs + 1,
        v = "";
      while (j < cmd.length && cmd[j] !== ch) {
        if (cmd[j] === "\\" && ch === '"') {
          v += cmd[j + 1] || "";
          j += 2;
          continue;
        }
        v += cmd[j];
        j++;
      }
      results.push(v);
    } else {
      const w = cmd.substring(vs).match(/^(\S+)/);
      if (w) {
        results.push(w[1]);
      }
    }
  }
  return results;
}

/**
 * Derive step states from overall execution state when no real-time data is available.
 */
function deriveStepStates(
  trackableCount: number,
  overallState: ExecutionState,
  isError?: boolean
): StepState[] {
  return Array.from({ length: trackableCount }, () => {
    if (overallState === "available") {
      return { status: isError ? ("error" as const) : ("completed" as const) };
    }
    if (overallState === "streaming") {
      return { status: "running" as const };
    }
    return { status: "pending" as const };
  });
}

/**
 * Get display label for a node in the flow.
 */
function getNodeLabel(step: ASTStep): string {
  switch (step.type) {
    case "act":
      return `act('${step.name}')`;
    case "reason":
      return "reason()";
    default:
      return step.name;
  }
}

/**
 * Build flow nodes from flattened AST + step states.
 */
function buildNodesFromFlat(
  flatNodes: FlatNode[],
  stepStates: StepState[],
  overallState: ExecutionState,
  isError?: boolean
): Node<NodeData>[] {
  const result: Node<NodeData>[] = [];
  const xSpacing = 240;
  let xPos = 0;

  // Start node
  result.push({
    id: "start",
    type: "flow",
    position: { x: xPos, y: 0 },
    data: {
      label: "Start",
      status: overallState === "pending" ? "running" : "completed",
      type: "start",
    },
  });

  flatNodes.forEach((fn, idx) => {
    xPos += xSpacing;

    const nodeStatus = stepStates[fn.trackableIndex]?.status ?? "pending";
    const label = getNodeLabel(fn.step);
    const details =
      fn.step.type === "act"
        ? fn.step.args.length > 0
          ? fn.step.args.join(", ").substring(0, 50)
          : ""
        : fn.step.type === "reason"
          ? fn.step.name
            ? fn.step.name.substring(0, 50)
            : ""
          : "";

    result.push({
      id: `node-${idx}`,
      type: "flow",
      position: { x: xPos, y: 0 },
      data: {
        label,
        status: nodeStatus,
        type: fn.step.type as NodeData["type"],
        details,
        context: fn.context.length > 0 ? fn.context : undefined,
      },
    });
  });

  // End node
  xPos += xSpacing;
  const allCompleted =
    flatNodes.length > 0 &&
    flatNodes.every((fn) => {
      const s = stepStates[fn.trackableIndex];
      return s?.status === "completed" || s?.status === "error";
    });
  const anyError = flatNodes.some(
    (fn) => stepStates[fn.trackableIndex]?.status === "error"
  );

  let endStatus: NodeData["status"] = "pending";
  if (overallState === "available") {
    endStatus = isError || anyError ? "error" : "completed";
  } else if (allCompleted && flatNodes.length > 0) {
    endStatus = anyError ? "error" : "completed";
  }

  result.push({
    id: "end",
    type: "flow",
    position: { x: xPos, y: 0 },
    data: {
      label: endStatus === "error" ? "Error" : "Complete",
      status: endStatus,
      type: "end",
    },
  });

  return result;
}

function buildEdgesFromFlat(
  flatNodes: FlatNode[],
  stepStates: StepState[],
  overallState: ExecutionState,
  isError?: boolean
): Edge[] {
  const result: Edge[] = [];
  const nodeCount = flatNodes.length;
  if (nodeCount === 0) {
    return result;
  }

  const getNodeStatus = (idx: number): StepState["status"] => {
    if (idx < 0 || idx >= flatNodes.length) {
      return "pending";
    }
    return stepStates[flatNodes[idx].trackableIndex]?.status ?? "pending";
  };

  const edgeColor = (status: StepState["status"]) => {
    switch (status) {
      case "completed":
        return "#22c55e";
      case "error":
        return "#ef4444";
      case "running":
        return "#3b82f6";
      default:
        return "#94a3b8";
    }
  };

  // start → first node
  result.push({
    id: "e-start-0",
    source: "start",
    target: "node-0",
    animated: getNodeStatus(0) === "running",
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    style: { stroke: edgeColor(getNodeStatus(0)), strokeWidth: 2 },
  });

  // node → node
  for (let i = 0; i < nodeCount - 1; i++) {
    const nextStatus = getNodeStatus(i + 1);
    result.push({
      id: `e-${i}-${i + 1}`,
      source: `node-${i}`,
      target: `node-${i + 1}`,
      animated: nextStatus === "running",
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      style: { stroke: edgeColor(nextStatus), strokeWidth: 2 },
    });
  }

  // last node → end
  const endColor =
    overallState === "available"
      ? isError
        ? "#ef4444"
        : "#22c55e"
      : "#94a3b8";
  result.push({
    id: `e-${nodeCount - 1}-end`,
    source: `node-${nodeCount - 1}`,
    target: "end",
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    style: { stroke: endColor, strokeWidth: 2 },
  });

  return result;
}

export function ToolRunFlow({
  state,
  mode = "python",
  code = "",
  output: _output,
  isError,
}: ToolRunFlowProps) {
  const { progress } = useExecutionProgress();

  // Get tree-structured steps: prefer progress data, fallback to code parsing
  const steps = useMemo(() => {
    if (progress?.steps && progress.steps.length > 0) {
      return progress.steps;
    }
    return parseCodeToSteps(code, mode);
  }, [progress?.steps, code, mode]);

  // Flatten tree for display
  const flatNodes = useMemo(() => flattenTree(steps), [steps]);

  // Count trackable (act/reason) steps
  const trackableCount = useMemo(() => countTrackable(steps), [steps]);

  // Use real-time step states when available, otherwise derive from overall state
  const stepStates = useMemo(() => {
    if (
      progress &&
      progress.stepStates.length === trackableCount &&
      trackableCount > 0
    ) {
      return progress.stepStates;
    }
    return deriveStepStates(trackableCount, state, isError);
  }, [progress, trackableCount, state, isError]);

  const nodes = useMemo(() => {
    if (flatNodes.length === 0) {
      return [];
    }
    return buildNodesFromFlat(flatNodes, stepStates, state, isError);
  }, [flatNodes, stepStates, state, isError]);

  const edges = useMemo(() => {
    if (flatNodes.length === 0) {
      return [];
    }
    return buildEdgesFromFlat(flatNodes, stepStates, state, isError);
  }, [flatNodes, stepStates, state, isError]);

  const [displayNodes, setNodes, onNodesChange] = useNodesState(nodes);
  const [displayEdges, setEdges, onEdgesChange] = useEdgesState(edges);

  useEffect(() => {
    setNodes(nodes);
    setEdges(edges);
  }, [nodes, edges, setNodes, setEdges]);

  // No steps found — show simple inline progress
  if (flatNodes.length === 0) {
    return (
      <div className="flex items-center justify-center gap-3 p-4 bg-gradient-to-r from-slate-50 via-white to-blue-50/20 rounded-md">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border bg-gray-50 border-gray-200">
          <FileSearch className="h-3.5 w-3.5 text-indigo-500" />
          <span className="text-[10px] font-medium text-gray-700">Parsing</span>
          {state === "pending" ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-green-500" />
          )}
        </div>
        <span className="text-gray-400">→</span>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border bg-gray-50 border-gray-200">
          <Zap className="h-3.5 w-3.5 text-orange-500" />
          <span className="text-[10px] font-medium text-gray-700">Running</span>
          {state === "streaming" ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
          ) : state === "available" ? (
            <CheckCircle2 className="h-3 w-3 text-green-500" />
          ) : (
            <Circle className="h-3 w-3 text-gray-400" />
          )}
        </div>
      </div>
    );
  }

  const containerHeight = 160;

  return (
    <div
      className="w-full rounded-md bg-gradient-to-br from-slate-50 via-white to-blue-50/20 overflow-x-auto"
      style={{ height: `${containerHeight}px` }}
    >
      <ReactFlow
        edges={displayEdges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        maxZoom={2}
        minZoom={0.3}
        nodes={displayNodes}
        nodesConnectable={false}
        nodeTypes={nodeTypes}
        onEdgesChange={onEdgesChange}
        onNodesChange={onNodesChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background className="opacity-20" gap={16} size={0.5} />
      </ReactFlow>
    </div>
  );
}
