import type { ComposableMCPServer } from "@mcpc-tech/core";

export function getToolFn(server: ComposableMCPServer) {
  const tool = (name: string, args: any) => {
    return server.callTool(name, args);
  }
  return tool;
}