/**
 * Execution progress event emitter for RAS runtimes.
 *
 * Enables real-time step tracking by forwarding progress events
 * from the runtime to the frontend via dataStream.
 */

export interface ASTStep {
  type: "act" | "reason" | "loop" | "condition" | "error-handling";
  name: string;
  args: string[];
  line: number;
  children?: ASTStep[];
}

export type ProgressEvent =
  | { type: "plan"; steps: ASTStep[] }
  | { type: "step-start"; stepIndex: number }
  | { type: "step-end"; stepIndex: number; status: "ok" | "error"; error?: string };

type ProgressCallback = (event: ProgressEvent) => void;

let progressCallback: ProgressCallback | null = null;

/**
 * Register a callback to receive execution progress events.
 * Call with `null` to unregister.
 */
export function setProgressCallback(cb: ProgressCallback | null) {
  progressCallback = cb;
}

/**
 * Emit a progress event to the registered callback.
 */
export function emitProgress(event: ProgressEvent) {
  progressCallback?.(event);
}
