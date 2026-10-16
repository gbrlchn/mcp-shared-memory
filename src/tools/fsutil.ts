import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Ctx } from "../types.js";
import { ToolError } from "./helpers.js";

/** Copy the previous version into <workspace>/.backups before it is overwritten or deleted. */
export async function backupFile(ctx: Ctx, rel: string, data: Buffer): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const flat = rel.replace(/\//g, "__").slice(-120);
  const name = `${stamp}_${randomBytes(2).toString("hex")}__${flat}`;
  const dir = path.join(ctx.sandbox.root, ".backups");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), data);
  return `.backups/${name}`;
}

/** temp file + rename => readers never see a half-written file. */
export async function writeAtomic(abs: string, content: string | Buffer): Promise<void> {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, { flag: "wx" });
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Global kill switch for anything that mutates the workspace. Denials are audited. */
export async function gateWrites(ctx: Ctx, tool: string, target: string): Promise<void> {
  if (!ctx.config.allowWrites) {
    await ctx.audit.log({ tool, action: "denied", path: target, reason: "ALLOW_WRITES=false" });
    throw new ToolError("Write operations are disabled on this server (ALLOW_WRITES=false).");
  }
}
