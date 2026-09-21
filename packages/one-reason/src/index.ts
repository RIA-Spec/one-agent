export { reason } from "./reason.js";
export type { ReasonMode, ReasonOptions } from "./reason.js";
// Exported from run-cli.ts (not cli/reason.ts) to avoid auto-execution side effects on import
export { runReasonCli } from "./run-cli.js";
export { getOneConfigDir, getOneConfigPath } from "./config-path.js";
export {
  resolveInterfaceModel,
  resolveJevBackend,
  resolveLlmFallbackModel,
  resolveReasonLlmModel,
  isJevEnabled,
  isJevProvider,
  type InterfaceProvider,
} from "./model.js";
export type {
  JevChoiceCriteria,
  JevChoiceMarker,
  JevChoiceOption,
  JevExampleMarker,
  JevNoulMarker,
  JevProvider,
  JevQuestion,
  JevQuestions,
  ResolvedJevBackend,
  ScoreRange,
  JevScoreMarker,
} from "./jev/types.js";
export {
  mapExampleToQuestions,
  classifyExampleForJev,
  isJevDecisionExample,
} from "./jev/map-example.js";
export type { AIResult } from "./utils/schema.js";
