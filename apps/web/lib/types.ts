import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/artifact";
import type { createDocument } from "./ai/tools/create-document";
import type { getWeather } from "./ai/tools/get-weather";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { updateDocument } from "./ai/tools/update-document";
import type { Suggestion } from "./db/schema";

export type DataPart = { type: "append-message"; message: string };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
  one?: any; // ONE Agent Python AER tool
  bash?: any; // ONE Agent Bash AER tool
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": string;
  "execution-step": ExecutionStepEvent;
  compact: {
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    tokenLimit: number;
    messagesBefore: number;
    messagesAfter: number;
  };
};

/** AST-extracted step from code (Python or Bash) */
export interface ASTStep {
  type: "act" | "reason" | "loop" | "condition" | "error-handling";
  name: string;
  args: string[];
  line: number;
  children?: ASTStep[];
}

/** Real-time execution progress events */
export type ExecutionStepEvent =
  | { type: "plan"; steps: ASTStep[] }
  | { type: "step-start"; stepIndex: number }
  | {
      type: "step-end";
      stepIndex: number;
      status: "ok" | "error";
      error?: string;
    };

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
