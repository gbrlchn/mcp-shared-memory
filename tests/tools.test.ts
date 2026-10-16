import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { Sandbox } from "../src/sandbox.js";
import { Audit } from "../src/audit.js";
import { initHandoff } from "../src/tools/handoff.js";
import type { Ctx } from "../src/types.js";

type Res = { content: { type: string; text: string }[]; isError?: boolean };
let tmp: string;
let ctx: Ctx;

async function makeCtx(allowWrites = true): Promise<Ctx> {
  const root = path.join(tmp, "workspace");
  return {
    config: {
      port: 0, host: "127.0.0.1", workspaceRoot: root, authToken: "x".repeat(32),
      allowWrites, maxFileBytes: 100_000, auditLog: path.join(tmp, "audit.jsonl"),
    },
    sandbox: await Sandbox.create(root),
    audit: new Audit(path.join(tmp, "audit.jsonl")),
  };
}

/** Each call = a brand-new server + client, i.e. a brand-new "agent session". */
async function session(c: Ctx = ctx) {
  const server = buildServer(c);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Res> => {
    try {
      return (await client.callTool({ name, arguments: args })) as Res;
    } catch (e) {
      // schema validation failures may surface as protocol errors; treat as errors either way
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  };
  return { client, call };
}
const text = (r: Res) => r.content[0].text;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-"));
  ctx = await makeCtx();
  await initHandoff(ctx);
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe("tool surface", () => {
  it("exposes 8+ tools including the required ones", async () => {
    const { client } = await session();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of ["list_files", "read_file", "write_file", "str_replace", "delete_file", "search_files"]) {
      expect(names).toContain(n);
    }
  });
});

describe("file tools", () => {
  it("write -> read -> str_replace -> search -> delete (with backups + audit)", async () => {
    const { call } = await session();
    expect((await call("write_file", { path: "notes/a.md", content: "hello world\nline2\n" })).isError).toBeFalsy();
    expect(text(await call("read_file", { path: "notes/a.md" }))).toContain("hello world");

    const rep = await call("str_replace", { path: "notes/a.md", old_str: "hello", new_str: "goodbye" });
    expect(rep.isError).toBeFalsy();
    expect(text(await call("read_file", { path: "notes/a.md" }))).toContain("goodbye world");
    expect(text(await call("search_files", { query: "GOODBYE" }))).toContain("notes/a.md:1");
    expect(text(await call("list_files", { recursive: true }))).toContain("notes/a.md");

    const noConfirm = await call("delete_file", { path: "notes/a.md" });
    expect(noConfirm.isError).toBe(true);
    expect((await call("delete_file", { path: "notes/a.md", confirm: true })).isError).toBeFalsy();
    expect((await call("read_file", { path: "notes/a.md" })).isError).toBe(true);

    expect((await fs.readdir(path.join(ctx.sandbox.root, ".backups"))).length).toBeGreaterThanOrEqual(2);
    const audit = await fs.readFile(ctx.config.auditLog, "utf8");
    expect(audit).toContain('"action":"delete"');
    expect(audit).toContain('"action":"denied"');
  });

  it("protects against bad writes", async () => {
    const { call } = await session();
    await call("write_file", { path: "b.txt", content: "v1" });
    expect((await call("write_file", { path: "b.txt", content: "v2" })).isError).toBe(true); // no overwrite flag
    const stale = await call("write_file", { path: "b.txt", content: "v2", overwrite: true, expected_sha256: "0".repeat(64) });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/Stale write/);
    expect((await call("str_replace", { path: "b.txt", old_str: "nope", new_str: "x" })).isError).toBe(true);
    expect((await call("write_file", { path: "big.txt", content: "x".repeat(200_000) })).isError).toBe(true);
  });

  it("rejects bad input via zod and path traversal via the sandbox", async () => {
    const { call } = await session();
    expect((await call("write_file", { path: "c.txt" })).isError).toBe(true); // missing content
    expect((await call("list_files", { max_entries: 99999 })).isError).toBe(true); // out of range
    for (const tool of ["read_file", "write_file", "delete_file", "str_replace"]) {
      const r = await call(tool, { path: "../../etc/passwd", content: "x", old_str: "a", new_str: "b", confirm: true });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/outside the workspace/);
    }
    await expect(fs.access(path.join(tmp, "x"))).rejects.toThrow();
  });

  it("refuses direct edits to handoff/ and .backups/", async () => {
    const { call } = await session();
    const r = await call("write_file", { path: "handoff/PROJECT_STATE.md", content: "pwned", overwrite: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/handoff_append/);
    expect((await call("delete_file", { path: ".backups/x", confirm: true })).isError).toBe(true);
  });

  it("read-only mode blocks every mutation", async () => {
    const ro = await makeCtx(false);
    const { call } = await session(ro);
    expect((await call("write_file", { path: "z.txt", content: "x" })).isError).toBe(true);
    expect((await call("handoff_append", { file: "CHECKPOINTS", session_id: "ro-test", title: "nope", body: "x" })).isError).toBe(true);
  });
});

describe("handoff protocol across sessions", () => {
  it("session B inherits what session A recorded, and stale updates are rejected", async () => {
    // ---- Session A ----
    const A = await session();
    const first = text(await A.call("handoff_read", {}));
    expect(first).toContain("revision = 0");
    await A.call("handoff_append", { file: "PLAN_LOG", session_id: "session-A", title: "Plan", body: "Build parser then tests" });
    await A.call("handoff_append", { file: "DECISIONS", session_id: "session-A", title: "Use TOML", body: "Because comments are allowed" });
    await A.call("handoff_append", { file: "CHECKPOINTS", session_id: "session-A", title: "Parser done", body: "src/parser.ts written" });
    const upd = await A.call("handoff_update_state", {
      session_id: "session-A", expected_revision: 0,
      content: "## Goal\nBuild config parser\n## Status\nParser done\n## Next\nWrite tests",
    });
    expect(upd.isError).toBeFalsy();

    // ---- Session B: brand-new server + client instance, same workspace on disk ----
    const B = await session();
    const ctxB = text(await B.call("handoff_read", {}));
    expect(ctxB).toContain("revision = 1");
    expect(ctxB).toContain("Parser done");
    expect(ctxB).toContain("Use TOML");
    expect(ctxB).toContain("Write tests");

    const stale = await B.call("handoff_update_state", {
      session_id: "session-B", expected_revision: 0, content: "## Goal\nstale overwrite attempt!!",
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/Stale PROJECT_STATE/);

    const good = await B.call("handoff_update_state", {
      session_id: "session-B", expected_revision: 1, content: "## Goal\nBuild config parser\n## Status\nTests written",
    });
    expect(good.isError).toBeFalsy();
    expect(text(await B.call("handoff_read", {}))).toContain("revision = 2");
  });
});
