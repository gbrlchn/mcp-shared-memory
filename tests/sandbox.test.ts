import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Sandbox, SandboxError } from "../src/sandbox.js";

let tmp: string;
let root: string;
let sb: Sandbox;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-"));
  root = path.join(tmp, "workspace");
  const evil = path.join(tmp, "workspace-evil"); // sibling sharing the "workspace" prefix
  await fs.mkdir(evil, { recursive: true });
  await fs.writeFile(path.join(evil, "secret.txt"), "top secret");
  sb = await Sandbox.create(root);
  await fs.symlink(evil, path.join(root, "linkdir"));
  await fs.symlink(path.join(evil, "secret.txt"), path.join(root, "linkfile"));
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe("path-escape protection: all of these MUST be rejected", () => {
  const escapes = [
    "../secret.txt",
    "../workspace-evil/secret.txt", // prefix-sibling trick
    "a/../../x",
    "a/b/../../../x",
    "..",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "bad\0name",
    "linkdir/secret.txt", // symlinked directory
    "linkdir/new/file.txt", // not-yet-existing path beneath a symlink
    "linkfile", // symlinked file
  ];
  it.each(escapes)("rejects %j", async (p) => {
    await expect(sb.resolve(p)).rejects.toBeInstanceOf(SandboxError);
  });
});

describe("legitimate paths are allowed", () => {
  it.each([".", "", "a.txt", "deep/new/dir/file.txt", "./x/../y.txt", "..hidden-but-fine"])("accepts %j", async (p) => {
    const abs = await sb.resolve(p);
    expect(abs.startsWith(root)).toBe(true);
  });
});
