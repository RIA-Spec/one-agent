#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { agentStream } from "../src/agent";
import { openaiCompatible } from "../src/model";
import { reason } from "../src/interfaces/reason";

type Benchmark = "browsecomp" | "deepsearchqa" | "custom";
type JudgeMode = "exact" | "reason";

type Sample = {
  id: string;
  question: string;
  answers: string[];
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

function parseArgs(argv: string[]): { mode: CliMode; evalArgs?: EvalArgs; downloadArgs?: DownloadArgs } {
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

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderRunCodeBlock(input: unknown): string | null {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : null;
  if (!code) return null;

  const maxLines = 80;
  const lines = code.split("\n");
  const shown = lines.slice(0, maxLines);
  const width = String(shown.length).length;
  const numbered = shown.map((line, idx) => `${String(idx + 1).padStart(width, " ")} | ${line}`);

  if (lines.length > maxLines) {
    numbered.push(`... | (${lines.length - maxLines} more lines omitted)`);
  }

  return [
    "[stream:tool-call] one",
    "[stream:one-code] --- BEGIN ---",
    ...numbered.map((line) => `[stream:one-code] ${line}`),
    "[stream:one-code] ---- END ----",
  ].join("\n");
}

function logChunk(chunk: any): void {
  switch (chunk.type) {
    case "text-delta":
      console.log(`[stream:text] ${preview(chunk.text)}`);
      return;
    case "reasoning-delta":
      console.log(`[stream:reasoning] ${preview((chunk as any).text || (chunk as any).delta || "")}`);
      return;
    case "tool-call":
      if (chunk.toolName === "one") {
        const codeBlock = renderRunCodeBlock(chunk.input);
        if (codeBlock) {
          console.log(codeBlock);
          return;
        }
      }
      console.log(`[stream:tool-call] ${chunk.toolName} args=${preview(chunk.input ?? {}, 300)}`);
      return;
    case "tool-result":
      console.log(`[stream:tool-result] ${preview((chunk as any).result ?? (chunk as any).output)}`);
      return;
    case "error":
      console.log(`[stream:error] ${preview(chunk.error instanceof Error ? chunk.error.message : String(chunk.error))}`);
      return;
    default:
      return;
  }
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
  await runCommand("kaggle", ["datasets", "download", "-d", kaggleDataset, "--unzip", "-p", resolve(outDir)], process.cwd());
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
        const answers = toStringArray(pickFirst(row, ["answers", "answer", "ideal", "ground_truth", "targets"]));
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
        const answers = toStringArray(pickFirst(row, ["answers", "answer", "ideal", "ground_truth", "targets"]));
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

async function runOneAgent(
  question: string,
  model: string,
  maxSteps: number,
  streamLog: boolean,
): Promise<string> {
  const result = await agentStream({
    messages: [
      {
        role: "user",
        content: `${question}\n\nReturn only the final answer with no extra commentary.`,
      },
    ],
    model: openaiCompatible(model),
    maxSteps,
  });

  let output = "";
  for await (const chunk of result.fullStream) {
    if (streamLog) logChunk(chunk);
    if (chunk.type === "text-delta") {
      output += chunk.text;
    }
  }

  return output.trim();
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
    `Candidate answer: ${prediction}`,
    `Reference answers: ${JSON.stringify(answers)}`,
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
  const candidate = files.find((name) => /deepsearchqa/i.test(name) && /\.(jsonl|json)$/i.test(name));
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

    try {
      prediction = await runOneAgent(s.question, args.model, args.maxSteps, args.streamLog);
      verdict = args.judge === "reason"
        ? await judgeWithReason(s.question, prediction, s.answers)
        : await judgeWithReason(s.question, prediction, s.answers, { exactFirst: true });
    } catch (error) {
      verdict = {
        correct: false,
        reason: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (verdict.correct) correct += 1;

    console.log(`[case:prediction] ${preview(oneLine(prediction), 800)}`);
    console.log(`[case:verdict] correct=${verdict.correct} reason=${preview(verdict.reason, 300)}`);

    rows.push({
      id: s.id,
      question: s.question,
      answers: s.answers,
      prediction,
      correct: verdict.correct,
      reason: verdict.reason,
      latency_s: Number(((Date.now() - started) / 1000).toFixed(3)),
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
