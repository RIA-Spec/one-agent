export type RASMode = "python" | "typescript" | "bash";

export type BuiltinRASTool = {
  name: "bash" | "read" | "write" | "edit" | "websearch" | "webfetch" | "riff";
  summary: string;
};

export const BUILTIN_RAS_TOOLS: readonly BuiltinRASTool[] = [
  {
    name: "bash",
    summary: "Run host shell commands for repository-wide search, git, tests, and scripts.",
  },
  {
    name: "read",
    summary: "Read a bounded range from one file.",
  },
  {
    name: "write",
    summary: "Create or replace a complete file.",
  },
  {
    name: "edit",
    summary: "Replace one unique text span and return a diff.",
  },
  {
    name: "websearch",
    summary: "Search the current web when external facts are required.",
  },
  {
    name: "webfetch",
    summary: "Fetch a known URL as markdown, text, or HTML.",
  },
  {
    name: "riff",
    summary: "Save, inspect, and rerun a stable recurring RAS workflow.",
  },
] as const;

export function renderBuiltinToolCatalog(): string {
  return BUILTIN_RAS_TOOLS.map(({ name, summary }) => `- ${name}: ${summary}`).join("\n");
}
