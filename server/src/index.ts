// index.ts
// Ponto de entrada do servidor MCP stdio para o Firecast.
// 
// O servidor descobre o bridgePath a partir do seu próprio __dirname:
// como o server.exe fica em <VHD>/mcp/server.exe, o bridgePath é o diretório pai (__dirname/../).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import { initDb } from "./db.js";
import { initBridge } from "./bridge.js";
import { startWatcher } from "./watcher.js";
import { registerRoomTools } from "./tools/rooms.js";
import fs from "fs";

// bridgePath: pasta onde ficam inbox/, outbox/ e firecast.db
// Quando empacotado, o .exe fica em <VHD>/mcp/server.exe, então process.cwd() ou dirname(process.execPath) aponta para mcp/
// Em dev (node dist/index.js), usar FIRECAST_BRIDGE_PATH para apontar para o VHD de teste.
const bridgePath = process.env.FIRECAST_BRIDGE_PATH ?? path.dirname(process.execPath);

// Lê configuração do config.lua (formato simples: db_path = "...")
function readConfig(): { db_path?: string } {
  const configPath = path.join(bridgePath, "config.lua");
  if (!fs.existsSync(configPath)) return {};
  
  const content = fs.readFileSync(configPath, "utf-8");
  const match = content.match(/db_path\s*=\s*"([^"]+)"/);
  if (match) return { db_path: match[1] };
  return {};
}

async function main(): Promise<void> {
  const config = readConfig();
  
  // Se db_path está no config, sobrescreve a env var
  if (config.db_path && !process.env.FIRECAST_DB_PATH) {
    process.env.FIRECAST_DB_PATH = config.db_path;
  }
  
  // Inicializa DB e bridge antes de registrar tools
  await initDb(bridgePath);
  initBridge(bridgePath);
  startWatcher(path.join(bridgePath, "mcp", "outbox"));

  const server = new McpServer({
    name: "firecast-mcp",
    version: "1.0.0",
  });

  // Fase 1: Mesas
  registerRoomTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
