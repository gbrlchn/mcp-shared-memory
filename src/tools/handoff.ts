import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../types.js";
import { defineTool, ok, ToolError } from "./helpers.js";
import { backupFile, gateWrites, writeAtomic } from "./fsutil.js";

export const HANDOFF_DIR = "handoff";
const FILES = {
  PROJECT_STATE: "PROJECT_STATE.md",
  PLAN_LOG: "PLAN_LOG.md",
  CHECKPOINTS: "CHECKPOINTS.md",
  DECISIONS: "DECISIONS.md",
} as const;
type LogName = "PLAN_LOG" | "CHECKPOINTS" | "DECISIONS";

const TEMPLATES: Record<keyof typeof FILES, string> = {
  PROJECT_STATE: `<!-- revision: 0 -->
# PROJECT_STATE
Current source of truth. OVERWRITTEN each time via handoff_update_state (never appended).

## Goal
(not set)

## Current status
(nothing done yet)

## Next steps
1. (none)

## Blockers / open questions
(none)
`,
  PLAN_LOG: "# PLAN_LOG\nAppend-only. What each session intends to do, before doing it.\n",
  CHECKPOINTS: "# CHECKPOINTS\nAppend-only. What was actually completed, with file paths, so the next session can verify.\n",
  DECISIONS: "# DECISIONS\nAppend-only. Choices made and WHY, so later sessions do not relitigate them.\n",
};

const revisionRe = /^<!-- revision: (\d+) -->/;
const handoffPath = (ctx: Ctx, name: keyof typeof FILES) =>
  path.join(ctx.sandbox.root, HANDOFF_DIR, FILES[name]);

/** Create the four handoff files if missing (never overwrites). Called once at boot. */
export async function initHandoff(ctx: Ctx): Promise<void> {
  await fs.mkdir(path.join(ctx.sandbox.root, HANDOFF_DIR), { recursive: true });
  await Promise.all(
    (Object.keys(FILES) as (keyof typeof FILES)[]).map((name) =>
      fs.writeFile(handoffPath(ctx, name), TEMPLATES[name], { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      }),
    ),
  );
}

/** Keep the file header plus the last n "## [" entries. */
function tailEntries(text: string, n: number, file: string): string {
  const parts = text.split(/\n(?=## \[)/);
  const head = parts[0].startsWith("## [") ? "" : parts.shift()!;
  const kept = parts.slice(-n);
  const omitted = parts.length - kept.length;
  const note = omitted > 0 ? `\n(… ${omitted} older entries omitted; read_file handoff/${file} for all)\n` : "";
  return `${head}${note}\n${kept.join("\n")}`.trimEnd();
}

export function registerHandoffTools(server: McpServer, ctx: Ctx): void {
  const sessionId = z
    .string()
    .regex(/^[A-Za-z0-9_.-]{3,64}$/, "session_id must be 3-64 chars of letters, digits, _ . -")
    .describe("Identifier for THIS agent session, e.g. 'claude-2026-10-16-a'");

  defineTool(
    server,
    "handoff_read",
    {
      title: "Read handoff context",
      description:
        "CALL THIS FIRST in every session. Returns PROJECT_STATE (with its revision number), plus the recent entries of PLAN_LOG, CHECKPOINTS and DECISIONS, in one call.",
      inputSchema: {
        log_tail: z.number().int().min(1).max(100).default(10).describe("How many recent entries per log"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ log_tail }) => {
      // Batch: all four files are independent -> read in parallel.
      const [state, plan, checks, decisions] = await Promise.all(
        (Object.keys(FILES) as (keyof typeof FILES)[]).map((n) => fs.readFile(handoffPath(ctx, n), "utf8")),
      );
      const revision = Number(state.match(revisionRe)?.[1] ?? 0);
      return ok(
        [
          `# HANDOFF (PROJECT_STATE revision = ${revision}; pass this as expected_revision to handoff_update_state)`,
          `\n----- PROJECT_STATE.md -----\n${state}`,
          `\n----- PLAN_LOG.md (last ${log_tail}) -----\n${tailEntries(plan, log_tail, FILES.PLAN_LOG)}`,
          `\n----- CHECKPOINTS.md (last ${log_tail}) -----\n${tailEntries(checks, log_tail, FILES.CHECKPOINTS)}`,
          `\n----- DECISIONS.md (last ${log_tail}) -----\n${tailEntries(decisions, log_tail, FILES.DECISIONS)}`,
        ].join("\n"),
      );
    },
  );

  defineTool(
    server,
    "handoff_append",
    {
      title: "Append to a handoff log",
      description:
        "Append a timestamped entry to PLAN_LOG (intentions), CHECKPOINTS (completed work) or DECISIONS (choices + reasons). Append-only: earlier entries can never be altered.",
      inputSchema: {
        file: z.enum(["PLAN_LOG", "CHECKPOINTS", "DECISIONS"]),
        session_id: sessionId,
        title: z.string().min(3).max(120),
        body: z.string().min(1).max(5000),
      },
      annotations: { destructiveHint: false },
    },
    async ({ file, session_id, title, body }) => {
      await gateWrites(ctx, "handoff_append", file);
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      const safeBody = body.replace(/^## \[/gm, "\\## ["); // keep entry delimiters unforgeable
      const entry = `\n## [${new Date().toISOString()}] ${session_id} — ${cleanTitle}\n\n${safeBody.trimEnd()}\n`;
      await fs.appendFile(handoffPath(ctx, file as LogName), entry, "utf8");
      await ctx.audit.log({ tool: "handoff_append", action: "append", file, session_id, bytes: Buffer.byteLength(entry) });
      return ok(`Appended to ${FILES[file as LogName]}: "${cleanTitle}"`);
    },
  );

  defineTool(
    server,
    "handoff_update_state",
    {
      title: "Replace PROJECT_STATE",
      description:
        "Overwrite PROJECT_STATE.md with the new current state (goal, status, next steps, blockers). Uses optimistic locking: expected_revision must equal the revision shown by handoff_read, otherwise the write is rejected so you cannot clobber a newer session's state. The old version is backed up.",
      inputSchema: {
        session_id: sessionId,
        expected_revision: z.number().int().min(0).describe("Revision from your last handoff_read"),
        content: z.string().min(20).max(20000).describe("Complete new markdown body (no revision header needed)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ session_id, expected_revision, content }) => {
      await gateWrites(ctx, "handoff_update_state", "PROJECT_STATE");
      const file = handoffPath(ctx, "PROJECT_STATE");
      const old = await fs.readFile(file);
      const current = Number(old.toString("utf8").match(revisionRe)?.[1] ?? 0);
      if (current !== expected_revision) {
        throw new ToolError(
          `Stale PROJECT_STATE: you expected revision ${expected_revision} but it is now ${current}. Call handoff_read, merge the newer state, and retry with expected_revision=${current}.`,
        );
      }
      const next = current + 1;
      const body = content.replace(revisionRe, "").replace(/^<!-- updated:.*-->\n?/, "").trimStart();
      const backup = await backupFile(ctx, `${HANDOFF_DIR}/${FILES.PROJECT_STATE}`, old);
      await writeAtomic(file, `<!-- revision: ${next} -->\n<!-- updated: ${new Date().toISOString()} by ${session_id} -->\n${body}\n`);
      await ctx.audit.log({ tool: "handoff_update_state", action: "write", session_id, revision: next, backup });
      return ok(`PROJECT_STATE updated to revision ${next}. Previous version: ${backup}`);
    },
  );
}
