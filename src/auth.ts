import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison (hashing first makes both buffers equal length). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Accepts the secret either as `Authorization: Bearer <token>` or as a path segment `/mcp/<token>`
 * (for MCP clients, such as some web connector UIs, that cannot send custom headers).
 */
export function isAuthorized(req: Request, token: string): boolean {
  const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const candidate = bearer ?? (typeof req.params.token === "string" ? req.params.token : "");
  return candidate.length > 0 && safeEqual(candidate, token);
}
