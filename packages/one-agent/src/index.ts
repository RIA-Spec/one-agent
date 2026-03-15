// Core agent functions
export { agent, agentStream, type AgentStreamOptions } from "./agent";

// Tools and server
export { getServer, getOneTools } from "./tools";
export { reason } from "./interfaces/reason";
export { getToolFn } from "./interfaces/act";

// Progress tracking
export { setProgressCallback, type ProgressEvent, type ASTStep } from "./progress";

// Code-to-AST extraction
export {
  codeToAST,
  countTrackableSteps,
  flattenAST,
  type AERMode,
  type FlatDisplayNode,
} from "./aer/code-to-ast";

// Prompts and models
export { AGENT_SYSTEM_PROMPT } from "./prompts";
export { openaiCompatible, vercel } from "./model";
export { autoCompactMessages } from "./compaction";

// Re-export commonly used types from dependencies for convenience
export type { LanguageModel, ModelMessage, StreamTextResult } from "ai";
