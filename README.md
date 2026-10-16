# mcp-shared-memory — a sandboxed MCP file server for cross-session agent memory

> **Course:** BSCS 3B – Web Dev · **Midterms PT 1**
> **Author:** Gabriel Israel R. Chan · **Date:** October 16, 2026
> **Built on:** Windows 11 · VS Code · PowerShell · Node 24

AI agents forget everything when a chat ends. This project is a custom
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) connector that gives agents a
**shared, persistent workspace**. Any agent session can read and write files in it, and a four-file
**handoff protocol** lets the next session pick up exactly where the last one stopped.

**Live deployment:** `https://unmolded-strum-strum.ngrok-free.dev/mcp` (Bearer token required)
**Health check (public, no auth):** <https://unmolded-strum-strum.ngrok-free.dev/health> → `{"ok":true}`

| Requirement | Where it lives |
|---|---|
| Node + TypeScript MCP SDK, **Streamable HTTP** | `src/index.ts`, `src/server.ts` |
| Strict **zod** schema on every tool | `src/tools/*.ts` (`inputSchema`) |
| `isError` with helpful messages | `src/tools/helpers.ts` (`defineTool`, `describeError`) |
| 8+ single-purpose tools | 11 tools (table below) |
| Workspace sandbox + traversal tests | `src/sandbox.ts`, `tests/sandbox.test.ts` |
| Auth on the public endpoint | `src/auth.ts` (Bearer token, constant-time compare) |
| Destructive actions gated + logged | `src/tools/fsutil.ts`, `src/audit.ts`, `logs/audit.jsonl` |
| Handoff protocol | `src/tools/handoff.ts`, `workspace/handoff/*.md` |
| HTTPS via ngrok static domain, kept alive by pm2 | `ecosystem.config.cjs` |
| Secrets in env vars | `.env` (git-ignored), `src/config.ts` |

## Tools

| Tool | Purpose |
|---|---|
| `list_files` | Browse a directory (optionally recursive) |
| `read_file` | Read a file or line range; returns sha256 |
| `read_many_files` | **Batch** read up to 20 files in one call |
| `file_info` | Type, size, mtime, sha256, line count |
| `write_file` | Create (or `overwrite=true`) a file; backup + audit |
| `str_replace` | Exact-match edit; fails if 0 or more than 1 match |
| `delete_file` | Delete a file; needs `confirm=true`; backup + audit |
| `search_files` | Grep (text/regex) across the workspace |
| `handoff_read` | **Session start:** state + recent logs in one call |
| `handoff_append` | Append to `PLAN_LOG` / `CHECKPOINTS` / `DECISIONS` |
| `handoff_update_state` | Replace `PROJECT_STATE` (optimistic locking) |

## Architecture

```
src/
  index.ts        Express app: /health, auth gate, POST /mcp (Streamable HTTP, stateless)
  server.ts       Builds McpServer + registers tools (+ agent instructions)
  config.ts       Env vars validated with zod (secrets never hard-coded)
  auth.ts         Bearer / path-token check, timing-safe
  sandbox.ts      Path resolution + traversal + symlink protection
  audit.ts        Append-only JSONL audit log
  tools/          files.ts · search.ts · handoff.ts · fsutil.ts · helpers.ts
tests/            sandbox.test.ts (escapes) · tools.test.ts (end-to-end + 2-session handoff)
ecosystem.config.cjs   pm2: mcp-server + ngrok
```

The transport is stateless: a fresh `McpServer` handles each request, and **all state lives on disk**.
That means a pm2 restart never loses memory, and two sessions can never leak into each other.

**Batching:** `read_many_files`, parallel `stat` in `list_files`, parallel file scans in
`search_files`, and parallel reads of all four handoff files in `handoff_read`.

## Security model

1. **Sandbox.** Every path is resolved against `WORKSPACE_ROOT`. Absolute paths, `..`, null bytes,
   drive letters, prefix-sibling tricks (`../workspace-evil`) and **symlink escapes** are rejected.
2. **Auth.** Every `/mcp` request needs the secret (`Authorization: Bearer …` or `/mcp/<token>`).
   Failures are audit-logged. The server binds to `127.0.0.1`; only ngrok exposes it publicly.
3. **Destructive actions.** `delete_file` needs `confirm=true`. `write_file` won't replace a file without
   `overwrite=true` (plus optional `expected_sha256`). Previous versions go to `workspace/.backups/`.
   Every write, delete and denial is recorded in `logs/audit.jsonl`. `ALLOW_WRITES=false` makes the
   server read-only.
4. **Protected paths.** `handoff/`, `.backups/` and `.git/` can't be modified by the file tools.
5. **Size/binary limits.** `MAX_FILE_BYTES` caps file size, and binary files are refused.
6. **Token hygiene.** The token lives only in `.env`. After it once appeared in a screenshot, I rotated it
   (`npm run gen-token` → update `.env` → `pm2 restart all --update-env` → update the connector URL).
   The old token now returns 401.

## Setup (reproduce from scratch on Windows 11)

**Prerequisites:** Node 20 or newer, VS Code, PowerShell, a free [ngrok](https://ngrok.com) account with the
agent installed, and pm2 (`npm install -g pm2`).

**1. Allow PowerShell scripts** (needed for npm/pm2 to run; one time):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**2. Enable Developer Mode** (Settings → System → For developers → Developer Mode). The sandbox tests create
symlinks, and Windows blocks that with `EPERM` unless Developer Mode is on.

**3. Install and configure:**

```powershell
git clone <your-repo-url> mcp-shared-memory
cd mcp-shared-memory
npm install
Copy-Item .env.example .env
npm run gen-token
```

Paste the generated token into `MCP_AUTH_TOKEN` in `.env`. Then set the rest:

```
PORT=3000
WORKSPACE_ROOT=./workspace
MCP_AUTH_TOKEN=<paste-generated-token>
NGROK_DOMAIN=<your-static-domain>.ngrok-free.dev
```

**4. ngrok:** in the ngrok dashboard open **Domains**, claim your free static domain, and put it in
`NGROK_DOMAIN`. Then register your authtoken once:

```powershell
ngrok config add-authtoken <your-ngrok-authtoken>
```

**5. Verify locally:**

```powershell
npm test                              # 24 tests, including the path-escape suite
npm run build
npm start                             # in a second terminal:
curl.exe http://localhost:3000/health # {"ok":true}
```

> In PowerShell, plain `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` to get real curl.

## Deploy (pm2 + ngrok)

```powershell
npm run build
pm2 start ecosystem.config.cjs
pm2 status        # mcp-server and ngrok should both be "online"
pm2 save
pm2 logs          # live logs
```

**Windows note:** `pm2 startup` isn't supported natively on Windows. After a reboot, run `pm2 resurrect`
to bring both processes back from the saved list.

`ecosystem.config.cjs` launches ngrok as `cmd /c ngrok ...` on Windows. Without that, pm2 can't find the
ngrok script and the process errors out.

**Check the public endpoint** (a request without a token must be rejected):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://unmolded-strum-strum.ngrok-free.dev/mcp `
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{}"
```

Expected: `401`. With a valid token and an invalid body you get `400`, which proves the token was accepted.

## Prove it with the MCP Inspector

```powershell
npx @modelcontextprotocol/inspector
```

- Transport: **Streamable HTTP**
- URL: `http://localhost:3000/mcp` (or the public `https://unmolded-strum-strum.ngrok-free.dev/mcp`)
- Authentication: header `Authorization` = `Bearer <MCP_AUTH_TOKEN>` → **Connect** → **Tools → List**

If the terminal says the port is already in use, an older Inspector is still running. Open the URL it prints
(`http://127.0.0.1:6274`), or stop the old process with `netstat -ano | findstr :6274` and
`taskkill /PID <pid> /F`. Don't kill every `node` process, because pm2's `mcp-server` is one too.

| # | Test | Expected | Screenshot |
|---|---|---|---|
| 1 | List tools | 11 tools with schemas | `proof/01-tools.png` |
| 2 | `list_files {}` | Workspace listing | `proof/02-list.png` |
| 3 | `read_file {"path":"../secret"}` | `isError: true`, "resolves outside the workspace" | `proof/03-traversal.png` |
| 4 | `read_file {"path":"C:\\Windows\\win.ini"}` | `isError: true` (absolute path / drive letter rejected) | `proof/04-absolute.png` |
| 5 | `write_file {"path":"demo/a.txt","content":"hi"}` twice | 2nd call errors (no `overwrite`) | `proof/05-overwrite.png` |
| 6 | `delete_file {"path":"demo/a.txt"}` | Error (no confirm); with `"confirm":true` → ok | `proof/06-delete.png` |
| 7 | Wrong token | 401 | `proof/07-401.png` |
| 8 | `type logs\audit.jsonl` | Writes, deletes and denials all logged | `proof/08-audit.png` |
| 9 | `npm test` | All 24 tests pass | `proof/09-tests.png` |

## Multi-session demo (handoff protocol)

The connector was added to Claude.ai as a custom connector. Each session was a separate, brand-new chat
with no pasted background.

**Session 1.** Prompt:
> Call `handoff_read`. Then `handoff_append` to PLAN_LOG: plan to create `project/todo.md` and
> `project/summary.md`. Create `project/todo.md` with 5 tasks. Record a CHECKPOINT, record a DECISION
> (and why), and finish with `handoff_update_state` (goal, status, next steps).

Claude asked permission before each write, and I approved them with **Allow once**. Result: `todo.md` was
created and `PROJECT_STATE.md` moved to `revision: 1`.

**Session 2** (new chat). Prompt:
> Use the shared-memory connector. Start by calling `handoff_read`, then continue the project from where the
> last session left off. Tell me what you found before you change anything.

**Session 3** (new chat). Same prompt, then: *"What did we decide and why, and what is left?"* The answer
must come only from `handoff_read`.

**Evidence:** `workspace/handoff/PROJECT_STATE.md`, `PLAN_LOG.md`, `CHECKPOINTS.md`, `DECISIONS.md`, the
revision numbers going 1 → 2 → 3, and the tool-call screenshots in `proof/` (connector URL blurred, since it
contains the token).

## Troubleshooting (problems I actually hit)

| Symptom | Fix |
|---|---|
| PowerShell says running scripts is disabled | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `npm test` fails with `EPERM` on the symlink test | Turn on Windows Developer Mode, then open a fresh PowerShell |
| pm2 shows ngrok errored, "script not found" | Use `cmd /c ngrok ...` on `win32` in `ecosystem.config.cjs` |
| Inspector says the port is already in use | An old Inspector is running; open `http://127.0.0.1:6274` or kill that PID |
| `Invalid configuration` on boot | Fill in `.env` (token must be at least 24 characters) |
| ngrok `ERR_NGROK_…` / domain not found | Check `NGROK_DOMAIN`, run `pm2 logs ngrok` |
| 401 from Inspector | Header must be `Authorization: Bearer <token>` (no quotes) |
| Client can't send custom headers | Use `https://<domain>/mcp/<token>` |
| `Stale PROJECT_STATE` | Call `handoff_read` again and retry with the new revision |
| Changed `.env` but nothing changed | `pm2 restart all --update-env` |

## Reflection

**What was hardest?**
The hardest part was getting the deployment to work on Windows. The server code itself built and passed its
tests, but running it for real kept hitting problems that had nothing to do with MCP. PowerShell blocked
scripts until I set the execution policy. pm2 couldn't launch ngrok because it couldn't find the script, and I
only fixed that after I understood that on Windows it has to run as `cmd /c ngrok ...`. The sandbox tests also
failed with `EPERM` because Windows won't create symlinks unless Developer Mode is on. Each error looked
unrelated to the others, so I had to read the logs (`pm2 logs`) instead of guessing. I also learned that
"online" in `pm2 status` doesn't mean "working". I only trusted the deployment after the public `/health`
URL worked and the token tests returned 401 and 400.

**One security risk I mitigated and how I tested it:**
The biggest risk for a file server is path traversal, where an agent (or someone with the URL) asks for
`../../something` and escapes the workspace. The sandbox resolves every path against `WORKSPACE_ROOT` and
rejects `..`, absolute paths, drive letters, null bytes and symlink escapes. I tested it two ways: the
automated suite in `tests/sandbox.test.ts`, and live in the MCP Inspector, where `../secret` and
`C:\Windows\win.ini` come back as `isError` results instead of file contents. A second risk was my own
mistake: my auth token showed up in a screenshot. Because the endpoint is public, I treated that token as
leaked, generated a new one with `npm run gen-token`, restarted with `pm2 restart all --update-env`, and
confirmed the old token now gets 401. Blocked attempts and every write and delete are recorded in
`logs/audit.jsonl`, so I can see what happened afterward.

**What I'd add next:**
First, rate limiting on `/mcp`, since a leaked token currently allows unlimited requests. Second, a
`restore_file` tool that brings back a version from `workspace/.backups/`, because backups exist but only I can
recover them by hand. Third, a separate token for each agent, so the audit log shows which agent did what and
I can revoke one without breaking the others.