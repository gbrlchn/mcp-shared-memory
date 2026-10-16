import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../types.js";
import { defineTool, ok, ToolError } from "./helpers.js";

const SKIP_DIRS = new Set([".git", "node_modules", ".backups"]);
const MAX_FILES = 5000;
const CHUNK = 16;

async function collectFiles(dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const subdirs: string[] = [];
  for (const d of dirents) {
    if (SKIP_DIRS.has(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) subdirs.push(full);
    else if (d.isFile()) acc.push(full);
  }
  await Promise.all(subdirs.map((s) => collectFiles(s, acc))); // walk sibling dirs concurrently
}

export function registerSearchTools(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    "search_files",
    {
      title: "Search files",
      description:
        "Grep-like search across text files in the workspace. Returns 'path:line: text'. Skips .git, node_modules, .backups, binary and oversized files.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Text to find (or a regex when is_regex=true)"),
        path: z.string().max(500).default(".").describe("Directory to search under"),
        is_regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(false),
        max_results: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, path: p, is_regex, case_sensitive, max_results }) => {
      const base = await ctx.sandbox.resolve(p);
      let re: RegExp;
      try {
        const source = is_regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        re = new RegExp(source, case_sensitive ? "" : "i");
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }

      const files: string[] = [];
      await collectFiles(base, files);
      files.sort();

      const hits: string[] = [];
      for (let i = 0; i < files.length && hits.length < max_results; i += CHUNK) {
        // Batch: scan CHUNK files concurrently, then merge in order.
        const chunk = await Promise.all(
          files.slice(i, i + CHUNK).map(async (file) => {
            const out: string[] = [];
            try {
              const st = await fs.stat(file);
              if (st.size > ctx.config.maxFileBytes) return out;
              const buf = await fs.readFile(file);
              if (buf.includes(0)) return out;
              const rel = ctx.sandbox.rel(file);
              buf
                .toString("utf8")
                .split("\n")
                .forEach((line, idx) => {
                  if (re.test(line)) out.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 200)}`);
                });
            } catch {
              /* unreadable file: skip */
            }
            return out;
          }),
        );
        for (const c of chunk) hits.push(...c);
      }

      if (hits.length === 0) return ok(`No matches for '${query}' (searched ${files.length} files).`);
      const shown = hits.slice(0, max_results);
      const more = hits.length > max_results ? `\n… more matches not shown (limit ${max_results})` : "";
      return ok(`${shown.length} match(es):\n${shown.join("\n")}${more}`);
    },
  );
}
