export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function preview(value: unknown, maxLen = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function previewHeadTail(value: unknown, headLen = 600, tailLen = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  if (text.length <= headLen + tailLen + 5) {
    return text;
  }
  return `${text.slice(0, headLen)} ... ${text.slice(-tailLen)}`;
}

function renderRunCodeBlock(input: unknown): string[] | null {
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
  ];
}

export function createStreamLogger() {
  let reasoningBuffer = "";
  let textBuffer = "";
  let reasoningOpen = false;
  let textOpen = false;

  const flushReasoning = (): string[] => {
    if (!reasoningOpen) {
      reasoningBuffer = "";
      return [];
    }

    const lines: string[] = [];
    const text = oneLine(reasoningBuffer);
    if (text) {
      lines.push(`[stream:reasoning] ${previewHeadTail(text)}`);
    }
    lines.push("[stream:reasoning] ---- END ----");

    reasoningBuffer = "";
    reasoningOpen = false;
    return lines;
  };

  const flushText = (): string[] => {
    if (!textOpen) {
      textBuffer = "";
      return [];
    }

    const lines: string[] = [];
    const text = oneLine(textBuffer);
    if (text) {
      lines.push(`[stream:text] ${previewHeadTail(text)}`);
    }
    lines.push("[stream:text] ---- END ----");

    textBuffer = "";
    textOpen = false;
    return lines;
  };

  const logChunk = (chunk: any): string[] => {
    switch (chunk.type) {
      case "reasoning-start":
        reasoningBuffer = "";
        reasoningOpen = true;
        return [...flushText(), "[stream:reasoning] --- BEGIN ---"];
      case "reasoning-delta":
        reasoningBuffer += (chunk as any).text || (chunk as any).delta || "";
        reasoningOpen = true;
        return [];
      case "reasoning-end":
        return flushReasoning();
      case "text-delta": {
        if (!textOpen) {
          textBuffer = "";
          textOpen = true;
          textBuffer += chunk.text || "";
          return ["[stream:text] --- BEGIN ---"];
        }
        textBuffer += chunk.text || "";
        return [];
      }
      case "tool-call": {
        const lines = [...flushText(), ...flushReasoning()];
        if (chunk.toolName === "one") {
          const codeBlock = renderRunCodeBlock(chunk.input);
          if (codeBlock) {
            return [...lines, ...codeBlock];
          }
        }
        return [
          ...lines,
          `[stream:tool-call] ${chunk.toolName} args=${preview(chunk.input ?? {}, 300)}`,
        ];
      }
      case "tool-result":
        return [
          ...flushText(),
          ...flushReasoning(),
          `[stream:tool-result] ${preview((chunk as any).result ?? (chunk as any).output)}`,
        ];
      case "error":
        return [
          ...flushText(),
          ...flushReasoning(),
          `[stream:error] ${preview(chunk.error instanceof Error ? chunk.error.message : String(chunk.error))}`,
        ];
      case "finish":
        return [...flushText(), ...flushReasoning()];
      default:
        return [...flushText(), ...flushReasoning()];
    }
  };

  return {
    logChunk,
    flush: (): string[] => [...flushText(), ...flushReasoning()],
  };
}
