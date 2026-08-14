"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { motion } from "framer-motion";
import { memo } from "react";
import type { ChatMessage } from "@/lib/types";
import { Suggestion } from "./elements/suggestion";
import type { VisibilityType } from "./visibility-selector";

type SuggestedActionsProps = {
  chatId: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  selectedVisibilityType: VisibilityType;
};

const SUGGESTED_ACTIONS = [
  {
    badge: "read",
    title: "Read a file and summarize what it does",
    detail:
      "Use a known built-in directly; discover schemas only when unsure.",
    suggestion:
      "Read package.json with the read tool and summarize its scripts, dependencies, and purpose in a few bullets.",
  },
  {
    badge: "bash + edit",
    title: "Run `npm run test` and patch minimally",
    detail:
      "Use one explicit command, find the first actionable error, fix only that, then rerun.",
    suggestion:
      "Run `npm run test` with bash. If it fails, identify the first actionable error, update only the minimum lines needed with edit/write, then rerun `npm run test` and report pass/fail plus the changed file.",
  },
  {
    badge: "websearch + webfetch",
    title: "Research one topic and return a cited recommendation",
    detail:
      "Use fixed source count and produce a short answer with citations.",
    suggestion:
      "Use websearch to find 5 sources about 'MCP server security best practices', fetch the top 3 with webfetch, then provide a 6-bullet recommendation with inline source links.",
  },
  {
    badge: "riff",
    title: "Create and run a concrete reusable riff",
    detail:
      "Define one named workflow with explicit params and run it with sample input.",
    suggestion:
      "Create a riff named `weekly-status-summary` with parameters `raw_updates` and `tone`, save docs plus script, then run it once with sample updates and tone='concise'.",
  },
];

function PureSuggestedActions({ chatId, sendMessage }: SuggestedActionsProps) {
  return (
    <div
      className="grid w-full gap-2 sm:grid-cols-2"
      data-testid="suggested-actions"
    >
      {SUGGESTED_ACTIONS.map((suggestedAction, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 20 }}
          key={suggestedAction.title}
          transition={{ delay: 0.05 * index }}
        >
          <Suggestion
            className="h-auto w-full whitespace-normal border-border/70 bg-background/90 px-4 py-4 shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-background"
            onClick={(suggestion) => {
              window.history.pushState({}, "", `/chat/${chatId}`);
              sendMessage({
                role: "user",
                parts: [{ type: "text", text: suggestion }],
              });
            }}
            suggestion={suggestedAction.suggestion}
          >
            <div className="flex min-h-[86px] flex-col items-start gap-2 text-left">
              <span className="rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {suggestedAction.badge}
              </span>
              <div className="text-pretty font-medium text-[15px] leading-snug text-foreground">
                {suggestedAction.title}
              </div>
              <div className="text-pretty text-left text-sm leading-snug text-muted-foreground">
                {suggestedAction.detail}
              </div>
            </div>
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(
  PureSuggestedActions,
  (prevProps, nextProps) => {
    if (prevProps.chatId !== nextProps.chatId) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }

    return true;
  }
);
