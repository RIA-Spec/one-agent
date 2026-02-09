"use client";

import type React from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ASTStep, ExecutionStepEvent } from "@/lib/types";

export interface StepState {
  status: "pending" | "running" | "completed" | "error";
  error?: string;
}

export interface ExecutionProgress {
  /** AST-extracted step plan (may be a tree with children) */
  steps: ASTStep[];
  /** Per-step execution state (indexed by trackable step order: act/reason only) */
  stepStates: StepState[];
}

/**
 * Count only trackable (act/reason) nodes in a potentially nested AST tree.
 * These map 1:1 to runtime step counter indices.
 */
function countTrackable(steps: ASTStep[]): number {
  let count = 0;
  for (const s of steps) {
    if (s.type === "act" || s.type === "reason") count++;
    if (s.children) count += countTrackable(s.children);
  }
  return count;
}

interface ExecutionProgressContextValue {
  /** Current execution progress (latest) */
  progress: ExecutionProgress | null;
  /** Process an incoming execution-step event */
  handleEvent: (event: ExecutionStepEvent) => void;
  /** Reset progress state */
  reset: () => void;
}

const ExecutionProgressContext = createContext<ExecutionProgressContextValue | null>(null);

export function ExecutionProgressProvider({ children }: { children: React.ReactNode }) {
  const [progress, setProgress] = useState<ExecutionProgress | null>(null);
  // Use ref to avoid stale closures in handleEvent
  const progressRef = useRef<ExecutionProgress | null>(null);

  const handleEvent = useCallback((event: ExecutionStepEvent) => {
    switch (event.type) {
      case "plan": {
        const trackableCount = countTrackable(event.steps);
        const newProgress: ExecutionProgress = {
          steps: event.steps,
          stepStates: Array.from({ length: trackableCount }, () => ({ status: "pending" as const })),
        };
        progressRef.current = newProgress;
        setProgress(newProgress);
        break;
      }
      case "step-start": {
        const current = progressRef.current;
        if (!current) return;
        const newStates = [...current.stepStates];
        if (event.stepIndex < newStates.length) {
          newStates[event.stepIndex] = { status: "running" };
        }
        const updated = { ...current, stepStates: newStates };
        progressRef.current = updated;
        setProgress(updated);
        break;
      }
      case "step-end": {
        const current = progressRef.current;
        if (!current) return;
        const newStates = [...current.stepStates];
        if (event.stepIndex < newStates.length) {
          newStates[event.stepIndex] = {
            status: event.status === "ok" ? "completed" : "error",
            error: event.error,
          };
        }
        const updated = { ...current, stepStates: newStates };
        progressRef.current = updated;
        setProgress(updated);
        break;
      }
    }
  }, []);

  const reset = useCallback(() => {
    progressRef.current = null;
    setProgress(null);
  }, []);

  const value = useMemo(() => ({ progress, handleEvent, reset }), [progress, handleEvent, reset]);

  return (
    <ExecutionProgressContext.Provider value={value}>
      {children}
    </ExecutionProgressContext.Provider>
  );
}

export function useExecutionProgress() {
  const context = useContext(ExecutionProgressContext);
  if (!context) {
    throw new Error("useExecutionProgress must be used within an ExecutionProgressProvider");
  }
  return context;
}
