import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  MCP_AUTH_TOKEN: z
    .string()
    .min(24, "MCP_AUTH_TOKEN must be at least 24 characters (run: npm run gen-token)"),
  ALLOW_WRITES: z.enum(["true", "false"]).default("true"),
  MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(10_000_000).default(1_000_000),
  AUDIT_LOG: z.string().min(1).default("./logs/audit.jsonl"),
});

export interface Config {
  port: number;
  host: string;
  workspaceRoot: string;
  authToken: string;
  allowWrites: boolean;
  maxFileBytes: number;
  auditLog: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    workspaceRoot: path.resolve(e.WORKSPACE_ROOT),
    authToken: e.MCP_AUTH_TOKEN,
    allowWrites: e.ALLOW_WRITES === "true",
    maxFileBytes: e.MAX_FILE_BYTES,
    auditLog: path.resolve(e.AUDIT_LOG),
  };
}
