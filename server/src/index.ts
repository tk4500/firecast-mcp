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
import { registerRoomTools } from "./tools/rooms.js";
import { startHttpServer } from "./http.js";

interface Config {
  db_path?: string | null;
  poll_interval_ms?: number;
  http_port?: number;
  version?: string;
}

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
  if ((process as any).pkg) {
    // Quando empacotado como server.exe, o executável fica em <VHD>/mcp/server.exe
    return path.dirname(process.execPath);
  }

  // Em modo dev (node dist/index.js), tenta o VHD padrão do usuário se existir
  const appData = process.env.APPDATA;
  if (appData) {
    const vhdMcp = path.join(appData, "Firecast", "Plugins", "com.tkplayer.firecast_mcp_vhd", "mcp");
    if (fs.existsSync(vhdMcp)) {
      return vhdMcp;
    }
  }

  return process.cwd();
}

// 3. Leitura do config.json escrito pelo plugin Lua (cria padrão se inexistente)
function readConfig(bridgeDir: string): Config {
  const configPath = path.join(bridgeDir, "config.json");
  if (!fs.existsSync(configPath)) {
    const defaultConfig: Config = {
      poll_interval_ms: 500,
      http_port: 3000,
      version: "1.0.0",
    };
    try {
      if (!fs.existsSync(bridgeDir)) {
        fs.mkdirSync(bridgeDir, { recursive: true });
      }
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
      return defaultConfig;
    } catch (err) {
      process.stderr.write(`[Firecast MCP] Aviso: erro ao criar config.json inicial: ${err}\n`);
      return {};
    }
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as Config;
  } catch (err) {
    process.stderr.write(`[Firecast MCP] Aviso: erro ao ler config.json: ${err}\n`);
    return {};
  }
}

async function main(): Promise<void> {
  const bridgePath = resolveBridgePath();
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
    const port = cliPort ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : (config.http_port ?? 3000));
    startHttpServer({
      port,
      bridgePath,
      config: config as Record<string, unknown>,
    });
  } else {
    // --- Modo stdio (Padrão para MCP) ---
    const server = new McpServer({
      name: "firecast-mcp",
      version: "1.0.0",
    });

    // Registra ferramentas do MCP
    registerRoomTools(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  process.stderr.write(`[Firecast MCP] Fatal: ${err.stack ?? err}\n`);
  process.exit(1);
});
