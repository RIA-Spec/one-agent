import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { normalizeChatModelId } from "@/lib/ai/models";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

// Force Node.js runtime for one-agent's native dependencies
export const runtime = "nodejs";
export const maxDuration = 60;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const configuredChatModel = process.env.ONE_CHAT_MODEL?.trim();

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const resolvedChatModel = configuredChatModel
      ? configuredChatModel
      : normalizeChatModelId(selectedChatModel);

    console.log(
      `[Chat API] Selected model: ${selectedChatModel ?? "(none)"}, configured model: ${configuredChatModel ?? "(none)"}, resolved: ${resolvedChatModel}`
    );

    const modelMessages = await convertToModelMessages(uiMessages);

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        console.log(
          `[Chat API] Using ONE Agent with model: ${resolvedChatModel}`
        );

        const {
          agentStream,
          openaiCompatible,
          setProgressCallback,
          autoCompactMessages,
          AGENT_SYSTEM_PROMPT,
        } = await import("@one/agent");

        const model = openaiCompatible(resolvedChatModel);

        setProgressCallback((event) => {
          dataStream.write({
            type: "data-execution-step" as const,
            data: event,
          } as any);
        });
        const cleanupProgress = () => setProgressCallback(null);

        const baseOptions = {
          model,
          maxSteps: 101,
          abortSignal: request.signal,
          onCompaction: (event: {
            estimatedTokensBefore: number;
            estimatedTokensAfter: number;
            tokenLimit: number;
            messagesBefore: number;
            messagesAfter: number;
          }) => {
            console.log(
              `[Chat API] Context compact triggered: est ${event.estimatedTokensBefore} -> ${event.estimatedTokensAfter}, limit ${event.tokenLimit}, messages ${event.messagesBefore} -> ${event.messagesAfter}`
            );
            dataStream.write({
              type: "data-compact" as const,
              data: event,
            } as any);
          },
          telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text-one-agent",
            metadata: {
              selectedChatModel:
                selectedChatModel ?? configuredChatModel ?? "(none)",
              resolvedChatModel,
            },
          },
        };

        let result;
        try {
          result = await agentStream({
            ...baseOptions,
            messages: modelMessages,
          });
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : JSON.stringify(error);
          const isContextOverflow =
            /maximum context length|Requested token count exceeds|context length/i.test(
              errorText
            );

          if (!isContextOverflow) {
            throw error;
          }

          console.warn(
            `[Chat API] Context overflow detected, forcing compaction retry: ${errorText}`
          );

          const forcedCompactedMessages = await autoCompactMessages({
            model,
            system: AGENT_SYSTEM_PROMPT,
            messages: modelMessages,
            abortSignal: request.signal,
            force: true,
          });

          result = await agentStream({
            ...baseOptions,
            enableAutoCompact: false,
            messages: forcedCompactedMessages,
          });
        }

        // Keep progress callback active for the whole stream lifecycle.
        result.finishReason.then(cleanupProgress, cleanupProgress);

        dataStream.merge(
          result.toUIMessageStream({ sendReasoning: true }) as any
        );

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ type: "data-chat-title", data: title });
            updateChatTitleById({ chatId: id, title });
          } catch (err) {
            console.error("[Chat API] Title generation failed:", err);
            // Don't crash the stream — title is non-critical
          }
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    attachments: [],
                    chatId: id,
                  },
                ],
              });
            }
          }
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },
      onError: (error) => {
        console.error("[Chat API] Stream error:", error);
        if (error instanceof Error) {
          return error.message || "Oops, an error occurred!";
        }

        if (typeof error === "string") {
          return error;
        }

        return "Oops, an error occurred!";
      },
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatSDKError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatSDKError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
