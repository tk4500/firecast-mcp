// http.ts
// Servidor HTTP opcional para testes manuais, curl e inspeção direta do estado.

import http from "http";
import fs from "fs";
import path from "path";
import { getDbPath, getAllRooms, getRoomById, getAllRoomEvents } from "./db.js";
import { handleListRooms, handleGetRoom } from "./tools/rooms.js";
import { sendCommand } from "./bridge.js";

export interface HttpServerOptions {
  port: number;
  bridgePath: string;
  config: Record<string, unknown>;
}

export function startHttpServer(options: HttpServerOptions): http.Server {
  const { port, bridgePath, config } = options;
  const inboxDir = path.join(bridgePath, "inbox");
  const outboxDir = path.join(bridgePath, "outbox");

  const server = http.createServer(async (req, res) => {
    // Helper para resposta JSON
    const sendJson = (statusCode: number, data: unknown) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(JSON.stringify(data, null, 2));
    };

    // Pre-flight CORS
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Helper para ler body JSON
    const readBody = (): Promise<any> => {
      return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          if (!body.trim()) return resolve({});
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Invalid JSON body"));
          }
        });
        req.on("error", reject);
      });
    };

    try {
      // 1. Status / Info
      if (req.method === "GET" && (pathname === "/" || pathname === "/status")) {
        return sendJson(200, {
          status: "online",
          server: "firecast-mcp",
          version: "1.0.0",
          mode: "http",
          port,
          bridgePath,
          dbPath: getDbPath(),
          config,
          tools: [
            {
              name: "list_rooms",
              description: "Lista todas as mesas abertas no Firecast. Usa cache local quando disponível.",
            },
            {
              name: "get_room",
              description: "Retorna os detalhes de uma mesa específica pelo seu ID interno.",
              params: { id: "number" },
            },
          ],
        });
      }

      // 2. Lista de Tools MCP
      if (req.method === "GET" && pathname === "/tools") {
        return sendJson(200, {
          tools: [
            {
              name: "list_rooms",
              description: "Lista todas as mesas abertas no Firecast. Usa cache local quando disponível.",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "get_room",
              description: "Retorna os detalhes de uma mesa específica pelo seu ID interno.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "integer", description: "codigoInterno da mesa" } },
                required: ["id"],
              },
            },
          ],
        });
      }

      // 3. Execução de tool: POST /call
      // Ex: { "name": "list_rooms", "arguments": {} }
      if (req.method === "POST" && pathname === "/call") {
        const body = await readBody();
        const toolName = body.name;
        const args = body.arguments ?? {};

        if (toolName === "list_rooms") {
          const result = await handleListRooms();
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_room") {
          if (typeof args.id !== "number") {
            return sendJson(400, { success: false, error: "Missing or invalid 'id' parameter" });
          }
          const result = await handleGetRoom(args.id);
          return sendJson(200, { success: true, tool: toolName, result });
        }

        return sendJson(404, { success: false, error: `Unknown tool "${toolName}"` });
      }

      // 4. Execução de comando Firecast bruto: POST /command
      // Ex: { "command": "list_rooms", "args": {} }
      if (req.method === "POST" && pathname === "/command") {
        const body = await readBody();
        if (!body.command) {
          return sendJson(400, { success: false, error: "Missing 'command' field" });
        }
        const timeoutMs = body.timeoutMs ?? 10_000;
        const result = await sendCommand(body.command, body.args ?? {}, timeoutMs);
        return sendJson(200, { success: true, result });
      }

      // 5. Inspeção do banco: GET /db/rooms
      if (req.method === "GET" && pathname === "/db/rooms") {
        const rooms = getAllRooms();
        return sendJson(200, { count: rooms.length, rooms });
      }

      // 6. Inspeção de eventos no banco: GET /db/events
      if (req.method === "GET" && pathname === "/db/events") {
        const events = getAllRoomEvents();
        return sendJson(200, { count: events.length, events });
      }

      // 7. Inspeção de arquivos em inbox: GET /inbox
      if (req.method === "GET" && pathname === "/inbox") {
        const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
        return sendJson(200, { dir: inboxDir, count: files.length, files });
      }

      // 8. Inspeção de arquivos em outbox: GET /outbox
      if (req.method === "GET" && pathname === "/outbox") {
        const files = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir) : [];
        return sendJson(200, { dir: outboxDir, count: files.length, files });
      }

      // 9. Simulação de evento para testes: POST /simulate-event
      // Escreve um evento direto no outbox para testar a ingestão pelo watcher
      if (req.method === "POST" && pathname === "/simulate-event") {
        const body = await readBody();
        const ts = body.ts ?? Math.floor(Date.now() / 1000);
        const id = body.id ?? `sim-${Date.now()}`;
        const type = body.type ?? "room_joined";
        const fileName = `${ts}-${id}.${type}.json`;
        const filePath = path.join(outboxDir, fileName);

        fs.mkdirSync(outboxDir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ id, type, ts, data: body.data ?? body }), "utf-8");

        return sendJson(200, {
          success: true,
          message: "Event written to outbox (watcher will ingest it shortly)",
          file: fileName,
        });
      }

      // 10. Suporte MCP JSON-RPC básico via POST /mcp
      if (req.method === "POST" && pathname === "/mcp") {
        const rpc = await readBody();
        const { jsonrpc, id, method, params } = rpc;

        if (method === "initialize") {
          return sendJson(200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "firecast-mcp", version: "1.0.0" },
            },
          });
        }

        if (method === "tools/list") {
          return sendJson(200, {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "list_rooms",
                  description: "Lista todas as mesas abertas no Firecast. Usa cache local quando disponível.",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "get_room",
                  description: "Retorna os detalhes de uma mesa específica pelo seu ID interno.",
                  inputSchema: {
                    type: "object",
                    properties: { id: { type: "integer", description: "codigoInterno da mesa" } },
                    required: ["id"],
                  },
                },
              ],
            },
          });
        }

        if (method === "tools/call") {
          const toolName = params?.name;
          const toolArgs = params?.arguments ?? {};
          if (toolName === "list_rooms") {
            const result = await handleListRooms();
            return sendJson(200, {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
            });
          }
          if (toolName === "get_room") {
            const result = await handleGetRoom(toolArgs.id);
            return sendJson(200, {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
            });
          }
        }

        return sendJson(404, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }

      // Rota não encontrada
      return sendJson(404, { error: "Not Found", pathname });
    } catch (err: any) {
      return sendJson(500, { error: err.message ?? "Internal Server Error" });
    }
  });

  server.listen(port, () => {
    process.stderr.write(`[Firecast MCP] Servidor HTTP ouvindo em http://localhost:${port}\n`);
    process.stderr.write(`[Firecast MCP] Rotas disponíveis: GET /status, GET /tools, POST /call, GET /db/rooms, GET /db/events, POST /simulate-event\n`);
  });

  return server;
}
