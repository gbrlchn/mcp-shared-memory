import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Sandbox } from "./sandbox.js";
import { Audit } from "./audit.js";
import { buildServer } from "./server.js";
import { initHandoff } from "./tools/handoff.js";
import { isAuthorized } from "./auth.js";
import type { Ctx } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx: Ctx = { config, sandbox: await Sandbox.create(config.workspaceRoot), audit: new Audit(config.auditLog) };
  await initHandoff(ctx);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
       app.use((req, res, next) => {
       res.setHeader("Access-Control-Allow-Origin", "*");
       res.setHeader(
         "Access-Control-Allow-Headers",
         "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, ngrok-skip-browser-warning",
       );
       res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
       res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
       if (req.method === "OPTIONS") {
         res.sendStatus(204);
         return;
       }
       next();
     });

  // Unauthenticated liveness probe (reveals nothing).
  app.get("/health", (_req, res) => void res.json({ ok: true }));

  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    if (!isAuthorized(req, config.authToken)) {
      await ctx.audit.log({
        action: "auth_failed",
        ip: req.header("x-forwarded-for") ?? req.ip,
        ua: req.header("user-agent"),
      });
      res.status(401).set("WWW-Authenticate", "Bearer").json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid token." },
        id: null,
      });
      return;
    }
    try {
      const server = buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP request failed:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  app.post(["/mcp", "/mcp/:token"], mcpHandler);
  app.all(["/mcp", "/mcp/:token"], (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  const http = app.listen(config.port, config.host, () => {
    console.log(`MCP server listening on http://${config.host}:${config.port}/mcp`);
    console.log(`Workspace: ${config.workspaceRoot} | writes ${config.allowWrites ? "ENABLED" : "DISABLED"}`);
  });

  const shutdown = () => http.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
