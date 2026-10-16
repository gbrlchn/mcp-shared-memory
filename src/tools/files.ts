import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../types.js";
import { defineTool, ok, fail, ToolError, sha256 } from "./helpers.js";
import { backupFile, gateWrites, writeAtomic } from "./fsutil.js";

/** Top-level folders the file tools may read but never modify. */
const PROTECTED = new Set([".backups", ".git", "handoff"]);
const HIDDEN_IN_LISTING = new Set([".git", "node_modules"]);

export function assertWritable(rel: string): void {
  if (rel === ".") throw new ToolError("Cannot modify the workspace root.");
  const first = rel.split("/")[0].toLowerCase();
  if (PROTECTED.has(first)) {
    const hint = first === "handoff" ? " Use handoff_append / handoff_update_state instead." : "";
    throw new ToolError(`'${first}/' is server-managed and cannot be modified with file tools.${hint}`);
  }
}

async function resolveRel(ctx: Ctx, p: string): Promise<{ abs: string; rel: string }> {
  const abs = await ctx.sandbox.resolve(p);
  return { abs, rel: ctx.sandbox.rel(abs) };
}

async function readText(ctx: Ctx, abs: string): Promise<{ text: string; buf: Buffer }> {
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new ToolError("That path is a directory. Use list_files to browse it.");
  if (st.size > ctx.config.maxFileBytes) {
    throw new ToolError(`File is ${st.size} bytes; the limit is ${ctx.config.maxFileBytes}.`);
  }
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new ToolError("File looks binary; only text files are supported.");
  return { text: buf.toString("utf8"), buf };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Shared by write_file and str_replace: size check -> backup -> atomic write -> audit. */
async function commitWrite(ctx: Ctx, tool: string, rel: string, abs: string, content: string) {
  const bytes = Buffer.byteLength(content);
  if (bytes > ctx.config.maxFileBytes) {
    throw new ToolError(`Content is ${bytes} bytes; the limit is ${ctx.config.maxFileBytes}.`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const existing = await fs.readFile(abs).catch(() => null);
  const backup = existing ? await backupFile(ctx, rel, existing) : undefined;
  await writeAtomic(abs, content);
  const digest = sha256(content);
  await ctx.audit.log({ tool, action: "write", path: rel, bytes, sha256: digest, backup });
  return { bytes, digest, backup };
}

export function registerFileTools(server: McpServer, ctx: Ctx): void {
  const pathArg = (d: string) => z.string().min(1, "path is required").max(500).describe(d);

  defineTool(
    server,
    "list_files",
    {
      title: "List files",
      description:
        "List files and folders under a workspace-relative directory. Returned paths are workspace-relative and can be passed straight to other tools.",
      inputSchema: {
        path: z.string().max(500).default(".").describe("Directory to list (default: workspace root)"),
        recursive: z.boolean().default(false).describe("Descend into subdirectories"),
        max_entries: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p, recursive, max_entries }) => {
      const { abs } = await resolveRel(ctx, p);
      const lines: string[] = [];
      let truncated = false;

      const visit = async (dir: string): Promise<void> => {
        const dirents = (await fs.readdir(dir, { withFileTypes: true })).filter(
          (d) => !HIDDEN_IN_LISTING.has(d.name),
        );
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        // Batch: stat every file in this directory concurrently.
        const sizes = await Promise.all(
          dirents.map((d) => (d.isFile() ? fs.stat(path.join(dir, d.name)).catch(() => null) : null)),
        );
        for (let i = 0; i < dirents.length; i++) {
          if (lines.length >= max_entries) {
            truncated = true;
            return;
          }
          const d = dirents[i];
          const full = path.join(dir, d.name);
          const rel = ctx.sandbox.rel(full);
          if (d.isDirectory()) {
            lines.push(`d ${rel}/`);
            if (recursive) await visit(full); // symlinked dirs are never followed
          } else if (d.isSymbolicLink()) {
            lines.push(`l ${rel}`);
          } else {
            lines.push(`f ${rel}  (${sizes[i]?.size ?? "?"} B)`);
          }
        }
      };

      await visit(abs);
      if (lines.length === 0) return ok("(empty directory)");
      return ok(lines.join("\n") + (truncated ? `\n… truncated at ${max_entries} entries` : ""));
    },
  );

  defineTool(
    server,
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file, optionally a 1-based inclusive line range. The header includes the sha256 of the WHOLE file, which you can pass as expected_sha256 to write_file.",
      inputSchema: {
        path: pathArg("Workspace-relative file path"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p, start_line, end_line }) => {
      const { abs } = await resolveRel(ctx, p);
      const { text } = await readText(ctx, abs);
      const lines = splitLines(text);
      const s = start_line ?? 1;
      const e = Math.min(end_line ?? lines.length, lines.length);
      if (lines.length > 0 && s > lines.length) {
        throw new ToolError(`start_line ${s} is past the end of the file (${lines.length} lines).`);
      }
      if (end_line !== undefined && end_line < s) throw new ToolError("end_line must be >= start_line.");
      const body = lines.slice(s - 1, e).join("\n");
      return ok(`sha256: ${sha256(text)}\nlines: ${lines.length === 0 ? 0 : s}-${e} of ${lines.length}\n---\n${body}`);
    },
  );

  defineTool(
    server,
    "read_many_files",
    {
      title: "Read many files",
      description:
        "Read up to 20 files in ONE call (reads run in parallel). Prefer this over repeated read_file calls.",
      inputSchema: { paths: z.array(pathArg("Workspace-relative file path")).min(1).max(20) },
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) => {
      const results = await Promise.all(
        paths.map(async (p) => {
          try {
            const { abs, rel } = await resolveRel(ctx, p);
            const { text } = await readText(ctx, abs);
            return { ok: true, block: `===== ${rel} (sha256 ${sha256(text)}) =====\n${text}` };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, block: `===== ${p} =====\nError: ${msg}` };
          }
        }),
      );
      const text = results.map((r) => r.block).join("\n\n");
      return results.every((r) => !r.ok) ? fail(text) : ok(text);
    },
  );

  defineTool(
    server,
    "file_info",
    {
      title: "File info",
      description: "Stat a path: type, size, modified time, and (for text files) sha256 + line count.",
      inputSchema: { path: pathArg("Workspace-relative path") },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p }) => {
      const { abs, rel } = await resolveRel(ctx, p);
      const st = await fs.stat(abs);
      const info: Record<string, unknown> = {
        path: rel,
        type: st.isDirectory() ? "directory" : "file",
        size: st.size,
        modified: st.mtime.toISOString(),
      };
      if (st.isFile() && st.size <= ctx.config.maxFileBytes) {
        const buf = await fs.readFile(abs);
        info.sha256 = sha256(buf);
        if (!buf.includes(0)) info.lines = splitLines(buf.toString("utf8")).length;
      }
      return ok(JSON.stringify(info, null, 2));
    },
  );

  defineTool(
    server,
    "write_file",
    {
      title: "Write file",
      description:
        "Create a file, or replace one when overwrite=true. Parent folders are created. Existing files are backed up to .backups/ first; every write is audit-logged. Cannot touch handoff/, .backups/ or .git/.",
      inputSchema: {
        path: pathArg("Workspace-relative file path"),
        content: z.string().describe("Full file contents (UTF-8)"),
        overwrite: z.boolean().default(false).describe("Required to replace an existing file"),
        expected_sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/, "expected_sha256 must be a 64-char lowercase hex digest")
          .optional()
          .describe("Reject the write if the file on disk no longer has this hash (from read_file)"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ path: p, content, overwrite, expected_sha256 }) => {
      const { abs, rel } = await resolveRel(ctx, p);
      assertWritable(rel);
      await gateWrites(ctx, "write_file", rel);

      const existing = await fs.readFile(abs).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (existing) {
        const current = sha256(existing);
        if (!overwrite) {
          throw new ToolError(
            `'${rel}' already exists (sha256 ${current}). Set overwrite=true to replace it, or use str_replace for small edits.`,
          );
        }
        if (expected_sha256 && expected_sha256 !== current) {
          throw new ToolError(
            `Stale write rejected: '${rel}' changed since you read it (current sha256 ${current}). Re-read the file and retry.`,
          );
        }
      } else if (expected_sha256) {
        throw new ToolError(`expected_sha256 was given but '${rel}' does not exist.`);
      }

      const r = await commitWrite(ctx, "write_file", rel, abs, content);
      return ok(`Wrote ${r.bytes} bytes to ${rel} (sha256 ${r.digest})${r.backup ? `\nPrevious version: ${r.backup}` : ""}`);
    },
  );

  defineTool(
    server,
    "str_replace",
    {
      title: "Replace text in file",
      description:
        "Replace an exact string in a file. old_str must match exactly once unless replace_all=true. Prefer this to rewriting whole files.",
      inputSchema: {
        path: pathArg("Workspace-relative file path"),
        old_str: z.string().min(1, "old_str must not be empty"),
        new_str: z.string(),
        replace_all: z.boolean().default(false),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: p, old_str, new_str, replace_all }) => {
      const { abs, rel } = await resolveRel(ctx, p);
      assertWritable(rel);
      await gateWrites(ctx, "str_replace", rel);
      if (old_str === new_str) throw new ToolError("old_str and new_str are identical; nothing to do.");

      const { text } = await readText(ctx, abs);
      const count = text.split(old_str).length - 1;
      if (count === 0) {
        throw new ToolError(`old_str was not found in '${rel}'. Re-read the file; whitespace must match exactly.`);
      }
      if (count > 1 && !replace_all) {
        throw new ToolError(
          `old_str matches ${count} times in '${rel}'. Add surrounding context to make it unique, or set replace_all=true.`,
        );
      }
      const updated = replace_all ? text.split(old_str).join(new_str) : text.replace(old_str, () => new_str);
      const r = await commitWrite(ctx, "str_replace", rel, abs, updated);
      return ok(`Replaced ${count} occurrence(s) in ${rel} (sha256 ${r.digest})\nPrevious version: ${r.backup}`);
    },
  );

  defineTool(
    server,
    "delete_file",
    {
      title: "Delete file",
      description:
        "Delete a single file (never directories). Requires confirm=true. The file is copied to .backups/ first and the deletion is audit-logged.",
      inputSchema: {
        path: pathArg("Workspace-relative file path"),
        confirm: z.boolean().default(false).describe("Must be true to actually delete"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: p, confirm }) => {
      const { abs, rel } = await resolveRel(ctx, p);
      assertWritable(rel);
      await gateWrites(ctx, "delete_file", rel);
      if (!confirm) {
        await ctx.audit.log({ tool: "delete_file", action: "denied", path: rel, reason: "confirm not set" });
        throw new ToolError(`Deletion not confirmed. Call again with confirm=true to delete '${rel}'.`);
      }
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new ToolError("delete_file only deletes regular files, not directories.");
      const backup = await backupFile(ctx, rel, await fs.readFile(abs));
      await fs.unlink(abs);
      await ctx.audit.log({ tool: "delete_file", action: "delete", path: rel, backup });
      return ok(`Deleted ${rel}. Recoverable copy: ${backup}`);
    },
  );
}
