import fs from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {}

/** true if `target` is `root` itself or lives underneath it (no ".." escape). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * Every tool resolves user-supplied paths through resolve(). It rejects:
 *  1. null bytes, absolute paths, Windows drive paths
 *  2. lexical escapes ("../", "a/../../x")
 *  3. symlink escapes (realpath of the nearest existing ancestor must stay inside the real root)
 */
export class Sandbox {
  private constructor(
    readonly root: string,
    private readonly realRoot: string,
  ) {}

  static async create(root: string): Promise<Sandbox> {
    const abs = path.resolve(root);
    await fs.mkdir(abs, { recursive: true });
    return new Sandbox(abs, await fs.realpath(abs));
  }

  async resolve(userPath: string): Promise<string> {
    if (userPath.includes("\0")) throw new SandboxError("Path contains a null byte.");
    if (path.isAbsolute(userPath) || /^[a-zA-Z]:/.test(userPath)) {
      throw new SandboxError(
        `Absolute paths are not allowed ('${userPath}'). Use a path relative to the workspace root.`,
      );
    }
    const abs = path.resolve(this.root, userPath);
    if (!isInside(this.root, abs)) {
      throw new SandboxError(`Path '${userPath}' resolves outside the workspace and was rejected.`);
    }

    // Symlink check: walk up to the nearest ancestor that exists and verify its real location.
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!isInside(this.realRoot, real)) {
          throw new SandboxError(
            `Path '${userPath}' escapes the workspace through a symlink and was rejected.`,
          );
        }
        break;
      } catch (e) {
        if (e instanceof SandboxError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        throw e;
      }
    }
    return abs;
  }

  /** Workspace-relative POSIX path for display / policy checks. */
  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/") || ".";
  }
}
