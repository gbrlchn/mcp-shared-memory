import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "./types.js";
import { registerFileTools } from "./tools/files.js";
import { registerSearchTools } from "./tools/search.js";
import { registerHandoffTools } from "./tools/handoff.js";

const INSTRUCTIONS = `Shared-memory file server. All paths are relative to the workspace root; escapes are rejected.
Handoff protocol for every session:
1. START: call handoff_read (note the revision number).
2. WORK: batch independent reads with read_many_files; make small edits with str_replace.
3. PLAN/PROGRESS: handoff_append to PLAN_LOG before starting, CHECKPOINTS after each completed step, DECISIONS for any choice and its reason.
4. END: call handoff_update_state with expected_revision from handoff_read, describing goal, status, and next steps.`;

/** A fresh McpServer per request (stateless Streamable HTTP). State lives on disk, not in memory. */
export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "shared-memory-mcp", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerFileTools(server, ctx);
  registerSearchTools(server, ctx);
  registerHandoffTools(server, ctx);
  return server;
}
