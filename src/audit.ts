import fs from "node:fs/promises";
import path from "node:path";

/** Append-only JSONL audit trail. Every write/delete/denied/auth failure lands here. */
export class Audit {
  constructor(private readonly file: string) {}

  async log(entry: Record<string, unknown>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch (e) {
      console.error("AUDIT WRITE FAILED", e); // never crash a tool call because logging failed
    }
  }
}
