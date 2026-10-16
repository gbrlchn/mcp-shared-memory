import { createHash } from "node:crypto";
import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { SandboxError } from "../sandbox.js";

export class ToolError extends Error {}

export const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
export const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  isError: true,
});
export const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export function describeError(e: unknown): string {
  if (e instanceof SandboxError || e instanceof ToolError) return e.message;
  switch ((e as NodeJS.ErrnoException)?.code) {
    case "ENOENT":
      return "Path does not exist. Use list_files to see what is available.";
    case "EISDIR":
      return "That path is a directory, not a file. Use list_files to browse it.";
    case "ENOTDIR":
      return "A parent in that path is a file, not a directory.";
    case "EACCES":
    case "EPERM":
      return "Permission denied by the operating system.";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/** Registers a tool whose handler errors are always converted into `isError: true` results. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: S; annotations?: ToolAnnotations },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const wrapped = async (args: unknown): Promise<CallToolResult> => {
    try {
      return await handler(args as z.infer<z.ZodObject<S>>);
    } catch (e) {
      return fail(describeError(e));
    }
  };
  server.registerTool(name, meta, wrapped as never);
}
