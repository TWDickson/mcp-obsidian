#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./src/createServer.js";
import { parseCliArgs } from "./src/cli.js";
import { PathFilter } from "./src/pathfilter.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const VERSION = packageJson.version;

const cliArgs = process.argv.slice(2);
const firstArg = cliArgs[0];

if (firstArg === "--version" || firstArg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (firstArg === "--help" || firstArg === "-h") {
  console.log(`
mcpvault v${VERSION}

Universal AI bridge for Obsidian vaults - connect any MCP-compatible assistant

Usage:
  npx @bitbonsai/mcpvault [options] [vault-path]

Arguments:
  [vault-path]               Optional path to your Obsidian vault directory
                             Defaults to current working directory when omitted

Options:
  --version, -v              Show version number
  --help, -h                 Show this help message
  --read-only                Expose read tools only and reject all vault mutations
                             May be passed alone, with true/false, or as --read-only=true
  --transport <type>         Transport type: "stdio" (default) or "http"
  --port <number>            Port for HTTP transport (default: 3000)
  --extra-extensions <exts>  Comma-separated extra file extensions to allow
                             (e.g. --extra-extensions .js,.ts,.json)

Examples:
  npx @bitbonsai/mcpvault
  npx @bitbonsai/mcpvault ~/Documents/MyVault
  npx @bitbonsai/mcpvault ./Vault --read-only
  npx @bitbonsai/mcpvault "/path/with spaces/Obsidian Vault"
  npx @bitbonsai/mcpvault --transport http --port 8080 ~/Documents/MyVault
  npx @bitbonsai/mcpvault --extra-extensions .js,.ts ~/Documents/MyVault
`);
  process.exit(0);
}

// Strip the transport options first: parseCliArgs treats every argument it does
// not recognise as part of the vault path, so anything left for it must already
// be free of our flags or the vault path comes out as "--transport http /vault".
let transportType: "stdio" | "http" = "stdio";
let port = 3000;
let extraExtensions: string[] = [];
const restArgs: string[] = [];

for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i] as string;
  if (arg === "--transport" && i + 1 < cliArgs.length) {
    const value = cliArgs[++i] as string;
    if (value !== "stdio" && value !== "http") {
      console.error(`Invalid transport: ${value}. Must be "stdio" or "http".`);
      process.exit(1);
    }
    transportType = value;
  } else if (arg === "--port" && i + 1 < cliArgs.length) {
    port = parseInt(cliArgs[++i] as string, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error("Invalid port number. Must be between 1 and 65535.");
      process.exit(1);
    }
  } else if (arg === "--extra-extensions" && i + 1 < cliArgs.length) {
    extraExtensions = (cliArgs[++i] as string)
      .split(",")
      .map(ext => ext.trim())
      .filter(ext => ext.startsWith("."));
  } else {
    restArgs.push(arg);
  }
}

// Upstream owns --read-only and the vault path, including unquoted paths with
// spaces. Delegate rather than reimplementing either.
const { vaultPathArg, readOnly } = parseCliArgs(restArgs);
const vaultPath = resolve(vaultPathArg || process.cwd());

// PathFilter appends allowedExtensions to its built-in list, so this widens the
// defaults rather than replacing them.
const pathFilter = extraExtensions.length > 0
  ? new PathFilter({ allowedExtensions: extraExtensions })
  : undefined;

const serverOptions = {
  version: VERSION,
  readOnly,
  ...(pathFilter ? { pathFilter } : {}),
};

if (transportType === "http") {
  const { createServer: createHttpServer } = await import("http");

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const health: Record<string, unknown> = { status: "ok", vault: vaultPath, version: VERSION };

      // Include Obsidian Sync config exported by entrypoint if available
      const syncConfig: Record<string, string> = {};
      for (const [envKey, configKey] of [
        ["MCP_VAULT_NAME", "vaultName"],
        ["MCP_CONFLICT_STRATEGY", "conflictStrategy"],
        ["MCP_SYNC_FILE_TYPES", "syncFileTypes"],
        ["MCP_EXCLUDED_FOLDERS", "excludedFolders"],
        ["MCP_SYNC_CONFIGS", "syncConfigs"],
        ["MCP_E2E_ENCRYPTION", "e2eEncryption"],
        ["MCP_DEVICE_NAME", "deviceName"],
      ] as const) {
        const val = process.env[envKey];
        if (val) syncConfig[configKey] = val;
      }
      if (Object.keys(syncConfig).length > 0) health.sync = syncConfig;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Stateless mode: fresh MCP server + transport per request
      const mcpServer = createServer(vaultPath, serverOptions);
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as unknown as (() => string),
      });
      // Cast needed: SDK's exactOptionalPropertyTypes causes Transport type mismatch
      await mcpServer.connect(httpTransport as Parameters<typeof mcpServer.connect>[0]);
      try {
        await httpTransport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`mcpvault v${VERSION} (HTTP transport)`);
    console.log(`Vault: ${vaultPath}`);
    console.log(`Listening on http://0.0.0.0:${port}/mcp`);
  });
} else {
  const server = createServer(vaultPath, serverOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit when the client disconnects (stdin EOF) or the process is asked to
  // terminate. Hosts that don't send an MCP shutdown request otherwise leave
  // this process running forever, orphaned once stdin closes (#159).
  // stdio only: the HTTP server has no stdin to watch and is stopped by the
  // container runtime instead.
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      await server.close();
    } catch {
      // Best-effort: exit regardless of transport close errors.
    }
    process.exit(0);
  };

  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
