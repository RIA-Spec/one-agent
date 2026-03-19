import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

const generateTextMock = vi.fn<(...args: any[]) => Promise<{ text: string }>>();

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  return {
    ...actual,
    generateText: generateTextMock,
  };
});

function createAssistantToolCallMessage(toolCallId: string, text: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      { type: "reasoning", text },
      {
        type: "tool-call",
        toolCallId,
        toolName: "one",
        input: { code: "print('hi')" },
      },
    ],
  } as ModelMessage;
}

function createToolResultMessage(toolCallId: string, text: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "one",
        output: { type: "text", value: text },
      },
    ],
  } as ModelMessage;
}

function createUserMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

function createAssistantMessage(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function expectNoOrphanToolMessages(messages: ModelMessage[]) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "tool") {
      continue;
    }

    expect(index).toBeGreaterThan(0);

    const previous = messages[index - 1];
    expect(previous.role).toBe("assistant");

    const assistantToolCallIds = new Set(
      Array.isArray(previous.content)
        ? previous.content
            .filter(
              (part): part is { type: string; toolCallId: string } =>
                !!part && typeof part === "object" && part.type === "tool-call",
            )
            .map((part) => part.toolCallId)
        : [],
    );

    const toolResultIds = Array.isArray(message.content)
      ? message.content
          .filter(
            (part): part is { type: string; toolCallId: string } =>
              !!part && typeof part === "object" && part.type === "tool-result",
          )
          .map((part) => part.toolCallId)
      : [];

    expect(assistantToolCallIds.size).toBeGreaterThan(0);
    expect(toolResultIds.length).toBeGreaterThan(0);
    expect(toolResultIds.every((toolCallId) => assistantToolCallIds.has(toolCallId))).toBe(true);
  }
}

afterEach(() => {
  generateTextMock.mockReset();
  delete process.env.ONE_AUTO_COMPACT_TOKEN_LIMIT;
  delete process.env.ONE_MODEL_CONTEXT_WINDOW;
});

describe("autoCompactMessages", () => {
  it("keeps tool results paired when retaining the recent tail", async () => {
    generateTextMock.mockResolvedValue({ text: "## Summary\n- keep going" });

    const { autoCompactMessages } = await import("../src/compaction.js");

    const messages: ModelMessage[] = [
      createUserMessage("first question"),
      createAssistantToolCallMessage("call-a", "searching"),
      createToolResultMessage("call-a", "tool result a"),
      createAssistantMessage("intermediate response"),
      createUserMessage("follow-up"),
      createAssistantToolCallMessage("call-b", "checking files"),
      createToolResultMessage("call-b", "tool result b"),
      createAssistantMessage("second response"),
      createUserMessage("latest question"),
    ];

    const compacted = await autoCompactMessages({
      model: {} as any,
      system: "system",
      messages,
      force: true,
    });

    expect(compacted[0]?.role).toBe("assistant");
    expectNoOrphanToolMessages(compacted);
    expect(compacted.some((message) => message.role === "tool")).toBe(true);
  });

  it("keeps fallback compaction from starting with an orphaned tool result", async () => {
    generateTextMock.mockResolvedValue({ text: "   " });

    const { autoCompactMessages } = await import("../src/compaction.js");

    const messages: ModelMessage[] = [
      createUserMessage("first question"),
      createAssistantToolCallMessage("call-a", "searching"),
      createToolResultMessage("call-a", "tool result a"),
      createAssistantMessage("intermediate response"),
      createUserMessage("follow-up"),
      createAssistantToolCallMessage("call-b", "checking files"),
      createToolResultMessage("call-b", "tool result b"),
      createAssistantMessage("second response"),
      createUserMessage("latest question"),
    ];

    const compacted = await autoCompactMessages({
      model: {} as any,
      system: "system",
      messages,
      force: true,
    });

    expect(compacted[0]?.role).not.toBe("tool");
    expectNoOrphanToolMessages(compacted);
  });

  it("drops a leading assistant/tool pair together under a tight token budget", async () => {
    process.env.ONE_AUTO_COMPACT_TOKEN_LIMIT = "3000";
    generateTextMock.mockResolvedValue({ text: "summary" });

    const { autoCompactMessages } = await import("../src/compaction.js");
    const largeText = "x".repeat(500);

    const messages: ModelMessage[] = [
      createAssistantToolCallMessage("call-a", largeText),
      createToolResultMessage("call-a", largeText),
      createUserMessage(largeText),
    ];

    const compacted = await autoCompactMessages({
      model: {} as any,
      system: "system",
      messages,
      force: true,
    });

    expect(compacted[0]?.role).not.toBe("tool");
    expectNoOrphanToolMessages(compacted);
    expect(compacted.every((message) => message.role !== "tool")).toBe(true);
  });

  it("does not keep an oversized summarization history floor under a small context window", async () => {
    process.env.ONE_MODEL_CONTEXT_WINDOW = "5000";
    generateTextMock.mockResolvedValue({ text: "summary" });

    const { autoCompactMessages } = await import("../src/compaction.js");
    const largeText = "x".repeat(3000);

    await autoCompactMessages({
      model: {} as any,
      system: "system",
      messages: [
        createAssistantMessage(largeText),
        createUserMessage(largeText),
        createAssistantMessage(largeText),
        createUserMessage("latest question"),
      ],
      force: true,
    });

    const generateCall = generateTextMock.mock.calls.at(0)?.[0] as
      | { messages?: ModelMessage[] }
      | undefined;

    expect(generateCall?.messages).toHaveLength(2);
    expect(generateCall?.messages?.[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("context checkpoint compaction"),
    });
  });
});
