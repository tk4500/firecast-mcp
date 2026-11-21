// index.ts
// Ponto de entrada do servidor MCP para o Firecast.
//
// Suporta dois modos:
// 1. stdio (padrão): para agentes MCP (Claude Desktop, Hermes, etc.)
// 2. HTTP (--http ou -h): para testes manuais, curl, inspeção de estado e testes E2E.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import fs from "fs";
import { initDb } from "./db.js";
import { initBridge } from "./bridge.js";
import { startWatcher } from "./watcher.js";
import { registerAllTools, SERVER_INSTRUCTIONS } from "./tools/registry.js";
import { startHttpServer } from "./http.js";
import { readConfig, setActiveBridgeDir, type AppConfig } from "./config.js";

// 1. Parsing de argumentos CLI
const args = process.argv.slice(2);
const isHttp = args.includes("--http") || args.includes("-h");

const portArgIdx = args.findIndex((a) => a === "--port" || a === "-p");
const cliPort = portArgIdx !== -1 ? parseInt(args[portArgIdx + 1], 10) : undefined;

const pathArgIdx = args.findIndex((a) => a === "--path");
const cliPath = pathArgIdx !== -1 ? args[pathArgIdx + 1] : undefined;

// 2. Descoberta inteligente do bridgePath (pasta mcp/ com inbox, outbox e firecast.db)
function resolveBridgePath(): string {
  if (cliPath) {
    return path.resolve(cliPath);
  }
  if (process.env.FIRECAST_BRIDGE_PATH) {
    return path.resolve(process.env.FIRECAST_BRIDGE_PATH);
  }

  // 1. Tenta o VHD padrão do Firecast no AppData do usuário (onde o plugin Firecast realmente roda)
  const appData = process.env.APPDATA;
  if (appData) {
    const vhdMcp = path.join(appData, "Firecast", "Plugins", "com.tkplayer.firecast_mcp_vhd", "mcp");
    if (fs.existsSync(vhdMcp)) {
      return vhdMcp;
    }
  }

  // 2. Se o executável estiver rodando dentro de um VHD específico
  if ((process as any).pkg) {
    const execDir = path.dirname(process.execPath);
    if (execDir.toLowerCase().includes("firecast_mcp_vhd")) {
      return execDir;
    }
    return execDir;
  }

  return process.cwd();
}

async function main(): Promise<void> {
  const bridgePath = resolveBridgePath();
  setActiveBridgeDir(bridgePath);
  const config = readConfig(bridgePath);

  // Se db_path foi definido no config.json (ex: via /mcp db no Firecast), aplica ao DB
  if (config.db_path && !process.env.FIRECAST_DB_PATH) {
    process.env.FIRECAST_DB_PATH = config.db_path;
  }

  // Inicializa o banco SQLite, pastas inbox/outbox e o watcher
  await initDb(bridgePath);
  initBridge(bridgePath);
  startWatcher(path.join(bridgePath, "outbox"));

  if (isHttp) {
    // --- Modo HTTP (Testes, curl, inspeção) ---
    const port = cliPort ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : (config.http_port ?? 3060));
    startHttpServer({
      port,
      bridgePath,
      config: config as Record<string, unknown>,
    });
  } else {
    // --- Modo stdio (Padrão para MCP) ---
    const server = new McpServer(
      { name: "firecast-mcp", version: "1.0.0" },
      { instructions: SERVER_INSTRUCTIONS }
    );

    // Registra ferramentas do MCP (lista única em tools/registry.ts)
    registerAllTools(server);

    process.stdin.on("close", () => process.exit(0));
    process.stdin.on("end", () => process.exit(0));

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  process.stderr.write(`[Firecast MCP] Fatal: ${err.stack ?? err}\n`);
  process.exit(1);
});
