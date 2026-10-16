// pm2 runs BOTH the MCP server and the ngrok tunnel and restarts either if it dies.
require("dotenv").config();

const domain = process.env.NGROK_DOMAIN;
if (!domain) throw new Error("Set NGROK_DOMAIN in .env (your ngrok static domain)");
const port = process.env.PORT || "3000";

module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      max_memory_restart: "300M",
      time: true,
      out_file: "logs/mcp.out.log",
      error_file: "logs/mcp.err.log",
    },
    {
      name: "ngrok",
      script: process.platform === "win32" ? "cmd" : "ngrok",
      args:
        process.platform === "win32"
          ? `/c ngrok http --url=${domain} ${port}`
          : `http --url=${domain} ${port}`,
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
      time: true,
      out_file: "logs/ngrok.out.log",
      error_file: "logs/ngrok.err.log",
    },
  ],
};
