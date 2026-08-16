#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { agentStream } from "../src/agent";
import { openaiCompatible } from "../src/model";
import { reason } from "../src/interfaces/reason";
import { createStreamLogger, oneLine } from "../src/utils/stream-log.js";

type Benchmark = "browsecomp" | "deepsearchqa" | "custom" | "ras-control-node" | "directanswer";
type JudgeMode = "exact" | "reason";

type Sample = {
  id: string;
  question: string;
  answers: string[];
  expectReason?: boolean;
  expectBatched?: boolean;
  expectToolCall?: boolean;
  schemaHint?: string;
  kind?: string;
  expected?: Record<string, unknown>;
};

type AgentRun = {
  output: string;
  codes: string[];
};

type EvalArgs = {
  benchmark: Benchmark;
  datasetPath?: string;
  outDir: string;
  maxSamples?: number;
  model: string;
  judge: JudgeMode;
  maxSteps: number;
  streamLog: boolean;
};

type DownloadArgs = {
  dataset: "browsecomp" | "deepsearchqa";
  outDir: string;
  kaggleDataset: string;
};

type CliMode = "run" | "download";

const BROWSECOMP_URL =
  "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv";

function normalizeText(value: string): string {
  return value
    .replace(/<\|[^|>]+\|>/g, " ")
    .replace(/[–—−]/g, "-")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 .:%/_-]/g, "");
}

function parseArgs(argv: string[]): {
  mode: CliMode;
  evalArgs?: EvalArgs;
  downloadArgs?: DownloadArgs;
} {
  const mode = (argv[2] || "run") as CliMode;
  const arg = new Map<string, string>();

  for (let i = 3; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    arg.set(key, value);
    if (value !== "true") i += 1;
  }

  if (mode === "download") {
    return {
      mode,
      downloadArgs: {
        dataset: (arg.get("dataset") || "browsecomp") as "browsecomp" | "deepsearchqa",
        outDir: arg.get("out-dir") || "./evals/datasets",
        kaggleDataset: arg.get("kaggle-dataset") || "deepmind/deepsearchqa",
      },
    };
  }

  const judgeArg = (arg.get("judge") || "exact").toLowerCase();
  const judge: JudgeMode = judgeArg === "exact" ? "exact" : "reason";

  return {
    mode: "run",
    evalArgs: {
      benchmark: (arg.get("benchmark") || "browsecomp") as Benchmark,
      datasetPath: arg.get("dataset-path"),
      outDir: arg.get("out-dir") || "./evals/results",
      maxSamples: Number(arg.get("max-samples") || 0) || undefined,
      model:
        arg.get("model") ||
        process.env.ONE_MODEL ||
        process.env.ONE_CHAT_MODEL ||
        process.env.NEXT_PUBLIC_CHAT_MODEL ||
        "gemini-3.1-pro",
      judge,
      maxSteps: Number(arg.get("max-steps") || 80),
      streamLog: (arg.get("stream-log") || "true") !== "false",
    },
  };
}

function preview(value: unknown, maxLen = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function downloadBrowseComp(outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(join(outDir, "browse_comp_test_set.csv"));
  const response = await fetch(BROWSECOMP_URL);
  if (!response.ok) throw new Error(`Failed to download BrowseComp CSV (${response.status})`);
  const text = await response.text();
  await writeFile(outPath, text, "utf8");
  return outPath;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: false,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function downloadDeepSearchQA(outDir: string, kaggleDataset: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  await runCommand(
    "kaggle",
    ["datasets", "download", "-d", kaggleDataset, "--unzip", "-p", resolve(outDir)],
    process.cwd(),
  );
  return resolve(outDir);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = i + 1 < line.length ? line[i + 1] : "";

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function deriveKey(password: string, length: number): Buffer {
  const hash = createHash("sha256").update(password).digest();
  const chunks: number[] = [];
  while (chunks.length < length) {
    for (const byte of hash) {
      chunks.push(byte);
      if (chunks.length >= length) break;
    }
  }
  return Buffer.from(chunks);
}

function decrypt(ciphertextB64: string, password: string): string {
  const encrypted = Buffer.from(ciphertextB64, "base64");
  const key = deriveKey(password, encrypted.length);
  const out = Buffer.alloc(encrypted.length);
  for (let i = 0; i < encrypted.length; i += 1) {
    out[i] = encrypted[i] ^ key[i];
  }
  return out.toString("utf8");
}

async function loadBrowseComp(csvPath: string): Promise<Sample[]> {
  const raw = await readFile(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`BrowseComp CSV appears empty: ${csvPath}`);

  const header = parseCsvLine(lines[0]);
  const idxProblem = header.indexOf("problem");
  const idxAnswer = header.indexOf("answer");
  const idxCanary = header.indexOf("canary");

  if (idxProblem < 0 || idxAnswer < 0 || idxCanary < 0) {
    throw new Error("BrowseComp CSV missing required columns: problem, answer, canary");
  }

  const samples: Sample[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const canary = cols[idxCanary] || "";
    const encryptedProblem = cols[idxProblem] || "";
    const encryptedAnswer = cols[idxAnswer] || "";
    if (!canary || !encryptedProblem || !encryptedAnswer) continue;

    const question = decrypt(encryptedProblem, canary);
    const answer = decrypt(encryptedAnswer, canary);
    samples.push({
      id: `browsecomp-${i}`,
      question,
      answers: [answer],
    });
  }

  return samples;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value == null) return [];
  return [String(value)];
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

async function loadDeepSearchQA(pathInput: string): Promise<Sample[]> {
  const resolved = resolve(pathInput);
  const ext = extname(resolved).toLowerCase();

  if (ext === ".jsonl") {
    const raw = await readFile(resolved, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, i) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        const question = String(pickFirst(row, ["question", "prompt", "query", "input"]) || "");
        const answers = toStringArray(
          pickFirst(row, ["answers", "answer", "ideal", "ground_truth", "targets"]),
        );
        return {
          id: String(pickFirst(row, ["id", "task_id", "sample_id"]) || `dsqa-${i + 1}`),
          question,
          answers,
        };
      })
      .filter((sample) => sample.question.length > 0 && sample.answers.length > 0);
  }

  if (ext === ".json") {
    const raw = await readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows
      .map((entry, i) => {
        const row = (entry || {}) as Record<string, unknown>;
        const question = String(pickFirst(row, ["question", "prompt", "query", "input"]) || "");
        const answers = toStringArray(
          pickFirst(row, ["answers", "answer", "ideal", "ground_truth", "targets"]),
        );
        return {
          id: String(pickFirst(row, ["id", "task_id", "sample_id"]) || `dsqa-${i + 1}`),
          question,
          answers,
        };
      })
      .filter((sample) => sample.question.length > 0 && sample.answers.length > 0);
  }

  throw new Error(`Unsupported DeepSearchQA file type: ${resolved}`);
}

async function loadControlNode(pathInput: string): Promise<Sample[]> {
  const resolved = resolve(pathInput);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [];
  return rows
    .map((entry, i) => {
      const row = (entry || {}) as Record<string, unknown>;
      const question = String(pickFirst(row, ["question", "prompt", "query", "input"]) || "");
      return {
        id: String(pickFirst(row, ["id", "task_id", "sample_id"]) || `cn-${i + 1}`),
        question,
        answers: [],
        expectReason: Boolean(row.expectReason),
        expectBatched: Boolean(row.expectBatched),
        expectToolCall: typeof row.expectToolCall === "boolean" ? row.expectToolCall : true,
        schemaHint: typeof row.schemaHint === "string" ? row.schemaHint : undefined,
        kind: typeof row.kind === "string" ? row.kind : undefined,
        expected:
          row.expected && typeof row.expected === "object"
            ? (row.expected as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((sample) => sample.question.length > 0);
}

async function runOneAgent(
  question: string,
  model: string,
  maxSteps: number,
  streamLog: boolean,
): Promise<AgentRun> {
  const streamLogger = createStreamLogger();
  const result = await agentStream({
    messages: [
      {
        role: "user",
        content: `[Q] ${question}\n\nReturn only the final answer with no extra commentary.`,
      },
    ],
    model: openaiCompatible(model),
    maxSteps,
  });

  let output = "";
  const codes: string[] = [];
  for await (const chunk of result.fullStream) {
    if (streamLog) {
      for (const line of streamLogger.logChunk(chunk)) {
        console.log(line);
      }
    }
    if (chunk.type === "text-delta") {
      output += chunk.text;
    }
    if (chunk.type === "tool-call") {
      const c = chunk as Record<string, unknown>;
      const input =
        c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : null;
      const code =
        (input && typeof input.code === "string" ? input.code : null) ??
        (input && typeof input.command === "string" ? input.command : null);
      if (code) codes.push(code);
    }
  }

  if (streamLog) {
    for (const line of streamLogger.flush()) {
      console.log(line);
    }
  }

  return { output: output.trim(), codes };
}

async function judgeWithReason(
  question: string,
  prediction: string,
  answers: string[],
  options?: { exactFirst?: boolean },
): Promise<{ correct: boolean; reason: string }> {
  if (options?.exactFirst) {
    const exact = exactMatch(prediction, answers);
    if (exact.correct) {
      return { correct: true, reason: `exact: ${exact.reason}` };
    }
  }

  const schema = { correct: false, reason: "" };
  const prompt = [
    "Are the candidate answer and any reference answer equivalent for this question?",
    "Allow formatting differences (spaces, punctuation, year shorthand), but reject different facts.",
    `Question: ${question}`,
    `Candidate answer: <candidate_answer>${prediction}</candidate_answer>`,
    `Reference answers: <reference_answers>${JSON.stringify(answers)}</reference_answers>`,
    "Return JSON exactly matching schema.",
  ].join("\n");

  const verdict = await reason(prompt, schema);
  const data = (verdict as any)?.data || {};
  return {
    correct: Boolean(data.correct),
    reason: `${options?.exactFirst ? "exact->reason" : "reason"}: ${String(data.reason || "fallback")}`,
  };
}

function exactMatch(prediction: string, answers: string[]): { correct: boolean; reason: string } {
  const pred = normalizeText(prediction).replace(/\s*-\s*/g, "-");
  const refs = answers.map((answer) => normalizeText(answer).replace(/\s*-\s*/g, "-"));
  const correct = refs.some((a) => a === pred || pred.includes(a));
  return {
    correct,
    reason: correct ? "normalized exact/inclusion match" : "no match",
  };
}

function containsReasonCall(code: string): boolean {
  return /\breason\s*\(/.test(code) || /\breason\s+--/.test(code);
}

// Strip comments and quoted string literals so only executable code remains.
// This stops `act bash '{"command":"git log"}'` from double counting the act
// call and the command inside its JSON string, and keeps cat/git mentions in
// comments or prompt strings from counting as real evidence streams.
function stripCodeNoise(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "#" && (i === 0 || /\s/.test(code[i - 1]))) {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function countActCalls(code: string): number {
  const clean = stripCodeNoise(code);
  const parenCalls = clean.match(/\bact\s*\(/g) ?? [];
  const commandCalls = clean.match(/\bact\s+(?:--|[\w-]+)/g) ?? [];
  return parenCalls.length + commandCalls.length;
}

// Bash mode gathers evidence with plain shell commands (cat/sed/git/...)
// inside one `one` call, so count evidence streams, not just act() calls.
function countEvidenceStreams(code: string): number {
  const clean = stripCodeNoise(code);
  const actCount = countActCalls(clean);
  const shellReads =
    clean.match(/\b(?:cat|sed|grep|awk|tail|head|ls|find|git|rg)\s+/g) ?? [];
  return actCount + shellReads.length;
}

function isGrounded(code: string): boolean {
  const match = code.match(/\breason\s*\(([\s\S]*?)\)/);
  if (match) {
    return /\b(inputs|stdin|out|result|content|data|log|text|output|response|payload|stat|names)\b/.test(
      match[1],
    );
  }
  // bash: reason fed from stdin (--prompt -) means the observation is runtime data
  return /\breason\s+--prompt\b[\s\S]*?--prompt\s+-/.test(code);
}

function extractJson(value: string): unknown | null {
  const text = value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct !== null) return direct;
  const spans: Array<{ start: number; end: number }> = [];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    spans.push({ start: firstBrace, end: lastBrace });
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    spans.push({ start: firstBracket, end: lastBracket });
  }
  // Prefer the largest candidate span so a JSON array wrapped in prose wins
  // over the object inside it, while a nested array stays inside its object.
  spans.sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const { start, end } of spans) {
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

function containsText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function normalizeEntryName(name: string): string {
  return name
    .replace(/\s*\(dir\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

function semanticOk(sample: Sample, output: string): boolean {
  const kind = sample.kind ?? "";
  const expected = sample.expected ?? {};
  const parsed = extractJson(output);

  switch (kind) {
    case "action-choice": {
      const obj = parsed as Record<string, unknown> | null;
      if (!obj || typeof obj.action !== "string") return false;
      const allow = toStringArray(expected.allow);
      if (!allow.includes(obj.action)) return false;
      const evidence = toStringArray(expected.evidence);
      const reason = String(obj.reason ?? "");
      return evidence.some((e) => containsText(reason, e));
    }
    case "pick-list": {
      if (!Array.isArray(parsed)) return false;
      const want = ((expected.items as unknown[]) ?? []).map(Number);
      const got = parsed.map(Number);
      return want.length === got.length && want.every((n) => got.includes(n));
    }
    case "synthesis": {
      const text = JSON.stringify(parsed ?? output);
      const must = toStringArray(expected.mustContain);
      return must.every((m) => containsText(text, m));
    }
    case "converge": {
      const obj = parsed as Record<string, unknown> | null;
      if (!obj) return false;
      const got = new Set(toStringArray(obj.likelyFiles).map(normalizeEntryName));
      const want = new Set(toStringArray(expected.files).map(normalizeEntryName));
      return (
        got.size === want.size &&
        [...want].every((file) => got.has(file)) &&
        typeof obj.reason === "string" &&
        obj.reason.trim().length > 0
      );
    }
    case "count": {
      const got = typeof parsed === "number" ? parsed : Number(String(parsed ?? "").trim());
      return got === Number(expected.value);
    }
    case "classification": {
      if (!Array.isArray(parsed)) return false;
      const checks = (expected.checks as Array<Record<string, string>>) ?? [];
      const count = Number(expected.count ?? -1);
      if (count >= 0 && parsed.length !== count) return false;
      return checks.every((c) => {
        const item = parsed.find(
          (row) =>
            normalizeEntryName(
              String(
                (row as Record<string, unknown>).file ??
                  (row as Record<string, unknown>).name ??
                  "",
              ),
            ) === normalizeEntryName(c.file),
        );
        if (!item) return false;
        const folder = String(
          (item as Record<string, unknown>).folder ??
            (item as Record<string, unknown>).category ??
            "",
        );
        return folder.toLowerCase() === c.folder.toLowerCase();
      });
    }
    case "rule-classify": {
      if (!Array.isArray(parsed)) return false;
      const images = toStringArray(expected.images).map(normalizeEntryName);
      const notImages = toStringArray(expected.notImages).map(normalizeEntryName);
      if (parsed.length !== images.length + notImages.length) return false;
      const rows = parsed.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          name: normalizeEntryName(String(r.name ?? r.file ?? "")),
          category: String(r.category ?? r.folder ?? "").toLowerCase(),
        };
      });
      const imageNames = new Set(rows.filter((r) => r.category === "images").map((r) => r.name));
      return (
        images.every((name) => imageNames.has(name)) &&
        notImages.every((name) => !imageNames.has(name))
      );
    }
    case "batch-summary": {
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      return parsed.some(
        (row) =>
          Array.isArray((row as Record<string, unknown>).files) &&
          ((row as Record<string, unknown>).files as unknown[]).length > 0 &&
          typeof (row as Record<string, unknown>).scope === "string" &&
          String((row as Record<string, unknown>).scope).length > 0,
      );
    }
    default:
      return true;
  }
}

type ControlNodeVerdict = {
  correct: boolean;
  reason: string;
  usesReason: boolean;
  grounded: boolean;
  structured: boolean;
  semantic: boolean;
  toolCallOk: boolean;
  batched: boolean;
  toolCalls: number;
  code: string;
  codes: string[];
};

function judgeControlNode(sample: Sample, codes: string[], output: string): ControlNodeVerdict {
  const usesReason = codes.some(containsReasonCall);
  const grounded = codes.some(isGrounded);
  const structured = sample.schemaHint ? extractJson(output) !== null : false;
  const evidenceStreams = codes.reduce((sum, code) => sum + countEvidenceStreams(code), 0);
  const batched = codes.length === 1 && evidenceStreams >= 2;
  const expectReason = sample.expectReason ?? false;
  const expectBatched = sample.expectBatched ?? false;
  const expectToolCall = sample.expectToolCall ?? true;
  const toolCallOk = expectToolCall ? codes.length > 0 : codes.length === 0;
  const semantic = semanticOk(sample, output);

  let detail: string;
  if (expectReason) {
    detail = usesReason
      ? grounded
        ? "reason used with grounded observation"
        : "reason used but observation may be a literal"
      : "reason NOT used (expected)";
  } else {
    detail = usesReason
      ? "reason used but task is deterministic"
      : "deterministic, no reason (correct)";
  }
  if (expectBatched) {
    detail += batched ? " · batched in one RAS" : " · NOT batched (round trips)";
  }
  if (!toolCallOk) {
    detail += expectToolCall
      ? " · no tool call (expected one)"
      : " · tool called (expected direct answer)";
  }
  if (!semantic) {
    detail += " · semantic check failed";
  }

  const correct =
    (expectReason ? usesReason && grounded : !usesReason) &&
    (!expectBatched || batched) &&
    toolCallOk &&
    (!sample.schemaHint || structured) &&
    semantic;
  return {
    correct,
    reason: detail,
    usesReason,
    grounded,
    structured,
    semantic,
    toolCallOk,
    batched,
    toolCalls: codes.length,
    code: codes[0] ?? "",
    codes,
  };
}

async function resolveBrowseCompPath(datasetPath?: string): Promise<string> {
  const defaultPath = resolve("./evals/datasets/browse_comp_test_set.csv");
  if (datasetPath) return resolve(datasetPath);

  try {
    await readFile(defaultPath, "utf8");
    return defaultPath;
  } catch {
    return downloadBrowseComp(resolve("./evals/datasets"));
  }
}

async function resolveDeepSearchPath(datasetPath?: string): Promise<string> {
  if (datasetPath) return resolve(datasetPath);

  const dir = resolve("./evals/datasets");
  const files = await readdir(dir).catch(() => [] as string[]);
  const candidate = files.find(
    (name) => /deepsearchqa/i.test(name) && /\.(jsonl|json)$/i.test(name),
  );
  if (candidate) return join(dir, candidate);

  throw new Error(
    "DeepSearchQA dataset not found. Run: pnpm evals:download:deepsearchqa or pass --dataset-path",
  );
}

async function loadSamples(args: EvalArgs): Promise<{ samples: Sample[]; resolvedPath: string }> {
  if (args.benchmark === "browsecomp") {
    const p = await resolveBrowseCompPath(args.datasetPath);
    return { samples: await loadBrowseComp(p), resolvedPath: p };
  }

  if (args.benchmark === "deepsearchqa") {
    const p = await resolveDeepSearchPath(args.datasetPath);
    return { samples: await loadDeepSearchQA(p), resolvedPath: p };
  }

  if (args.benchmark === "ras-control-node" || args.benchmark === "directanswer") {
    if (!args.datasetPath) {
      throw new Error(`--dataset-path is required for --benchmark ${args.benchmark}`);
    }
    const p = resolve(args.datasetPath);
    return { samples: await loadControlNode(p), resolvedPath: p };
  }

  if (!args.datasetPath) {
    throw new Error("--dataset-path is required for --benchmark custom");
  }

  const p = resolve(args.datasetPath);
  return { samples: await loadDeepSearchQA(p), resolvedPath: p };
}

async function runEval(args: EvalArgs): Promise<void> {
  console.log(
    `[eval] benchmark=${args.benchmark} judge=${args.judge} model=${args.model} ` +
      `(ONE_CHAT_MODEL=${process.env.ONE_CHAT_MODEL || ""})`,
  );

  const { samples: loaded, resolvedPath } = await loadSamples(args);
  const samples = args.maxSamples ? loaded.slice(0, args.maxSamples) : loaded;

  const rows: Array<Record<string, unknown>> = [];
  let correct = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const started = Date.now();
    let prediction = "";
    let verdict: { correct: boolean; reason: string } = { correct: false, reason: "not-run" };

    console.log("\n========================================");
    console.log(`[case ${i + 1}/${samples.length}] id=${s.id}`);
    console.log(`[case:question] ${preview(oneLine(s.question), 500)}`);
    console.log(
      `[case:answers] ${s.answers.map((answer) => preview(oneLine(answer), 200)).join(" | ")}`,
    );
    console.log("========================================");

    let signals: Record<string, unknown> | undefined;
    try {
      const run = await runOneAgent(s.question, args.model, args.maxSteps, args.streamLog);
      prediction = run.output;
      if (args.benchmark === "ras-control-node" || args.benchmark === "directanswer") {
        const v = judgeControlNode(s, run.codes, prediction);
        verdict = { correct: v.correct, reason: v.reason };
        signals = {
          uses_reason: v.usesReason,
          grounded: v.grounded,
          structured: v.structured,
          semantic: v.semantic,
          tool_call_ok: v.toolCallOk,
          batched: v.batched,
          tool_calls: v.toolCalls,
          code: preview(v.code, 400),
          codes: v.codes.map((c) => preview(c, 250)),
        };
      } else {
        verdict =
          args.judge === "reason"
            ? await judgeWithReason(s.question, prediction, s.answers)
            : await judgeWithReason(s.question, prediction, s.answers, { exactFirst: true });
      }
    } catch (error) {
      verdict = {
        correct: false,
        reason: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (verdict.correct) correct += 1;

    console.log(`[case:prediction] ${preview(oneLine(prediction), 800)}`);
    console.log(`[case:verdict] correct=${verdict.correct} reason=${preview(verdict.reason, 300)}`);
    if (signals) {
      console.log(
        `[case:signals] uses_reason=${signals.uses_reason} grounded=${signals.grounded} ` +
          `structured=${signals.structured} semantic=${signals.semantic} ` +
          `tool_call_ok=${signals.tool_call_ok} batched=${signals.batched} tool_calls=${signals.tool_calls}`,
      );
    }

    rows.push({
      id: s.id,
      question: s.question,
      answers: s.answers,
      prediction,
      correct: verdict.correct,
      reason: verdict.reason,
      latency_s: Number(((Date.now() - started) / 1000).toFixed(3)),
      ...(signals ?? {}),
    });

    process.stdout.write(`\r${i + 1}/${samples.length} processed`);
  }
  process.stdout.write("\n");

  const total = rows.length;
  const accuracy = total > 0 ? Number((correct / total).toFixed(4)) : 0;
  const now = new Date().toISOString().replace(/[.:]/g, "-");
  const outputDir = resolve(args.outDir);
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, `${now}_${args.benchmark}_${args.judge}.json`);

  const report = {
    meta: {
      benchmark: args.benchmark,
      datasetPath: resolvedPath,
      judge: args.judge,
      model: args.model,
      maxSteps: args.maxSteps,
      generatedAt: new Date().toISOString(),
    },
    summary: { total, correct, accuracy },
    samples: rows,
  };

  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Done. total=${total} correct=${correct} accuracy=${accuracy} report=${outPath}`);
}

async function runDownload(args: DownloadArgs): Promise<void> {
  const outDir = resolve(args.outDir);
  if (args.dataset === "browsecomp") {
    const path = await downloadBrowseComp(outDir);
    console.log(`Downloaded BrowseComp -> ${path}`);
    return;
  }

  const path = await downloadDeepSearchQA(outDir, args.kaggleDataset);
  console.log(`Downloaded DeepSearchQA -> ${path}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (parsed.mode === "download") {
    if (!parsed.downloadArgs) throw new Error("download args missing");
    await runDownload(parsed.downloadArgs);
    return;
  }

  if (!parsed.evalArgs) throw new Error("eval args missing");
  await runEval(parsed.evalArgs);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
