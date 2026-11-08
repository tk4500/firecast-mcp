// http.ts
// Servidor HTTP opcional para testes manuais, curl e inspeção direta do estado.

import http from "http";
import fs from "fs";
import path from "path";
import { getDbPath, getAllRooms, getRoomById, getAllRoomEvents, getChatMessages } from "./db.js";
import { handleListRooms, handleGetRoom, handleListPlayers } from "./tools/rooms.js";
import {
  handleListChats,
  handleGetChatMessages,
  handleSendChatMessage,
  handleRollDice,
} from "./tools/chat.js";
import {
  handleListLibrary,
  handleGetLibraryItem,
  handleGetSheetNDB,
  handleEditSheetNDB,
  handleOpenDockNDB,
  handleEditDockNDB,
  handleManageLibraryItem,
  handleManageRoom,
  handleGetSheetTemplate,
  handleCreateCharacterSheet,
} from "./tools/ndb.js";
import {
  handleListDataTypes,
  handleListInstalledPlugins,
} from "./tools/plugins.js";
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
            {
              name: "list_players",
              description: "Lista os jogadores presentes em uma mesa específica.",
              params: { room_id: "number" },
            },
            {
              name: "list_chats",
              description: "Lista todos os chats disponíveis em uma mesa (principal, PVTs, grupos).",
              params: { room_id: "number" },
            },
            {
              name: "get_chat_messages",
              description: "Recupera o histórico recente de mensagens de um chat da mesa.",
              params: { room_id: "number", chat_id: "string (opcional)", limit: "number (opcional)" },
            },
            {
              name: "send_chat_message",
              description: "Envia uma mensagem para o chat da mesa (standard, narrator, npc, action, laugh).",
              params: { room_id: "number", message: "string", chat_id: "string (opcional)", type: "string (opcional)", npc_name: "string (opcional)" },
            },
            {
              name: "roll_dice",
              description: "Executa uma rolagem de dados oficial dentro do chat da mesa no Firecast.",
              params: { room_id: "number", expression: "string", chat_id: "string (opcional)", message: "string (opcional)" },
            },
            {
              name: "list_library",
              description: "Lista itens ou árvore da Biblioteca de uma mesa.",
              params: { room_id: "number", parent_codigo: "number (opcional)", recursive: "boolean (opcional)", max_depth: "number (opcional)" },
            },
            {
              name: "get_library_item",
              description: "Obtém detalhes de um item específico da biblioteca (pasta ou personagem).",
              params: { room_id: "number", codigo_interno: "number" },
            },
            {
              name: "get_sheet_ndb",
              description: "Abre o Node Database (NDB) de uma ficha de personagem e retorna seus dados.",
              params: { room_id: "number", codigo_interno: "number", path: "string (opcional)" },
            },
            {
              name: "edit_sheet_ndb",
              description: "Modifica atributos ou sub-nós no NDB de uma ficha (exclusivo mesa tttttaaaaa).",
              params: { room_id: "number", codigo_interno: "number", operations: "array de {action, path, value}" },
            },
            {
              name: "open_dock_ndb",
              description: "Abre um Node Database de janela acoplável (Dock NDB) ou de usuário.",
              params: { room_id: "number", name: "string", is_user: "boolean (opcional)" },
            },
            {
              name: "edit_dock_ndb",
              description: "Modifica atributos ou sub-nós em um Dock NDB (exclusivo mesa tttttaaaaa).",
              params: { room_id: "number", name: "string", operations: "array de {action, path, value}", is_user: "boolean (opcional)" },
            },
            {
              name: "manage_library_item",
              description: "Cria pastas/personagens, atualiza, move ou deleta na biblioteca (exclusivo mesa tttttaaaaa).",
              params: { room_id: "number", action: "create_dir|create_char|update|delete|move", parent_codigo: "number", codigo_interno: "number", name: "string" },
            },
            {
              name: "manage_room",
              description: "Lê detalhes ou altera configurações administrativas da mesa (exclusivo mesa tttttaaaaa).",
              params: { room_id: "number", action: "get_details|set_moderada", moderada: "boolean (opcional)" },
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
              inputSchema: { type: "object", properties: { fresh: { type: "boolean" } } },
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
            {
              name: "list_players",
              description: "Lista os jogadores presentes em uma mesa específica.",
              inputSchema: {
                type: "object",
                properties: { room_id: { type: "integer", description: "codigoInterno da mesa" } },
                required: ["room_id"],
              },
            },
            {
              name: "list_chats",
              description: "Lista todos os chats disponíveis em uma mesa (principal, PVTs, grupos).",
              inputSchema: {
                type: "object",
                properties: { room_id: { type: "integer", description: "codigoInterno da mesa" } },
                required: ["room_id"],
              },
            },
            {
              name: "get_chat_messages",
              description: "Recupera o histórico recente de mensagens de um chat da mesa.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  chat_id: { type: "string" },
                  limit: { type: "integer" },
                  fresh: { type: "boolean" },
                },
                required: ["room_id"],
              },
            },
            {
              name: "send_chat_message",
              description: "Envia uma mensagem para o chat da mesa no Firecast.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  message: { type: "string" },
                  chat_id: { type: "string" },
                  type: { type: "string", enum: ["standard", "narrator", "npc", "action", "laugh"] },
                  npc_name: { type: "string" },
                },
                required: ["room_id", "message"],
              },
            },
            {
              name: "roll_dice",
              description: "Executa uma rolagem de dados oficial dentro do chat da mesa no Firecast.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  expression: { type: "string" },
                  chat_id: { type: "string" },
                  message: { type: "string" },
                },
                required: ["room_id", "expression"],
              },
            },
            {
              name: "list_library",
              description: "Lista itens ou árvore da Biblioteca de uma mesa.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  parent_codigo: { type: "integer" },
                  recursive: { type: "boolean" },
                  max_depth: { type: "integer" },
                },
                required: ["room_id"],
              },
            },
            {
              name: "get_library_item",
              description: "Obtém detalhes de um item específico da biblioteca (pasta ou personagem).",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  codigo_interno: { type: "integer" },
                },
                required: ["room_id", "codigo_interno"],
              },
            },
            {
              name: "get_sheet_ndb",
              description: "Abre o Node Database (NDB) de uma ficha de personagem e retorna seus dados.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  codigo_interno: { type: "integer" },
                  path: { type: "string" },
                },
                required: ["room_id", "codigo_interno"],
              },
            },
            {
              name: "edit_sheet_ndb",
              description: "Modifica atributos ou sub-nós no NDB de uma ficha (exclusivo mesa tttttaaaaa).",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  codigo_interno: { type: "integer" },
                  operations: { type: "array" },
                },
                required: ["room_id", "codigo_interno", "operations"],
              },
            },
            {
              name: "open_dock_ndb",
              description: "Abre um Node Database de janela acoplável (Dock NDB) ou de usuário.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  name: { type: "string" },
                  is_user: { type: "boolean" },
                },
                required: ["room_id", "name"],
              },
            },
            {
              name: "edit_dock_ndb",
              description: "Modifica atributos ou sub-nós em um Dock NDB (exclusivo mesa tttttaaaaa).",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  name: { type: "string" },
                  operations: { type: "array" },
                  is_user: { type: "boolean" },
                },
                required: ["room_id", "name", "operations"],
              },
            },
            {
              name: "manage_library_item",
              description: "Cria pastas/personagens, atualiza, move ou deleta na biblioteca (exclusivo mesa tttttaaaaa).",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  action: { type: "string", enum: ["create_dir", "create_char", "update", "delete", "move"] },
                  parent_codigo: { type: "integer" },
                  codigo_interno: { type: "integer" },
                  name: { type: "string" },
                },
                required: ["room_id", "action"],
              },
            },
            {
              name: "manage_room",
              description: "Lê detalhes ou altera configurações administrativas da mesa (exclusivo mesa tttttaaaaa).",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  action: { type: "string", enum: ["get_details", "set_moderada"] },
                  moderada: { type: "boolean" },
                },
                required: ["room_id", "action"],
              },
            },
            {
              name: "list_data_types",
              description: "Lista todos os tipos de dados / modelos de fichas (dataTypes) instalados no Firecast.",
              inputSchema: {
                type: "object",
                properties: {
                  form_type: { type: "string" },
                  query: { type: "string" },
                },
              },
            },
            {
              name: "list_installed_plugins",
              description: "Lista todos os plugins SDK3 instalados no cliente Firecast.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
              },
            },
            {
              name: "get_sheet_template",
              description: "Inspeciona e extrai o schema completo de um modelo de ficha (RPK/LFM) instalado no Firecast pelo dataType ou nome.",
              inputSchema: {
                type: "object",
                properties: {
                  data_type: { type: "string" },
                },
                required: ["data_type"],
              },
            },
            {
              name: "create_character_sheet",
              description: "Cria um novo personagem na biblioteca e inicializa toda a estrutura de nós (NDB) do template RPK.",
              inputSchema: {
                type: "object",
                properties: {
                  room_id: { type: "integer" },
                  name: { type: "string" },
                  data_type: { type: "string" },
                  parent_codigo: { type: "integer" },
                  auto_structure: { type: "boolean" },
                  initial_data: { type: "object" },
                },
                required: ["room_id", "name", "data_type"],
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
          const result = await handleListRooms(args.fresh === true);
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_room") {
          if (typeof args.id !== "number") {
            return sendJson(400, { success: false, error: "Missing or invalid 'id' parameter" });
          }
          const result = await handleGetRoom(args.id, args.fresh === true);
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "list_players") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number") {
            return sendJson(400, { success: false, error: "Missing or invalid 'room_id' parameter" });
          }
          const result = await handleListPlayers(roomId, args.fresh === true);
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "list_chats") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number") {
            return sendJson(400, { success: false, error: "Missing or invalid 'room_id' parameter" });
          }
          const result = await handleListChats(roomId);
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_chat_messages") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number") {
            return sendJson(400, { success: false, error: "Missing 'room_id' parameter" });
          }
          const result = await handleGetChatMessages(
            roomId,
            args.chat_id ?? "main",
            args.limit ?? 50,
            args.fresh === true,
            {
              serverQuery: args.server_query === true,
              tid: args.tid,
              audit: args.audit === true,
            }
          );
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "send_chat_message") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.message !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'message' parameter" });
          }
          const result = await handleSendChatMessage({
            roomId,
            message: args.message,
            chatId: args.chat_id,
            type: args.type,
            npcName: args.npc_name,
            avatar: args.avatar,
            gender: args.gender,
            impersonation: args.impersonation,
            visibility: args.visibility,
            talemarkOptions: args.talemark_options,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "roll_dice") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.expression !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'expression' parameter" });
          }
          const result = await handleRollDice({
            roomId,
            expression: args.expression,
            chatId: args.chat_id,
            message: args.message,
            impersonation: args.impersonation,
            visibility: args.visibility,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        // --- NDB e Biblioteca Tools ---
        if (toolName === "list_library") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number") {
            return sendJson(400, { success: false, error: "Missing 'room_id' parameter" });
          }
          const result = await handleListLibrary({
            roomId,
            parentCodigo: args.parent_codigo,
            recursive: args.recursive === true,
            maxDepth: args.max_depth,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_library_item") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          const codigoInterno = args.codigo_interno;
          if (typeof roomId !== "number" || typeof codigoInterno !== "number") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'codigo_interno' parameter" });
          }
          const result = await handleGetLibraryItem({ roomId, codigoInterno });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_sheet_ndb") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          const codigoInterno = args.codigo_interno;
          if (typeof roomId !== "number" || typeof codigoInterno !== "number") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'codigo_interno' parameter" });
          }
          const result = await handleGetSheetNDB({
            roomId,
            codigoInterno,
            path: args.path,
            rawXml: args.raw_xml === true,
            maxDepth: args.max_depth,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "edit_sheet_ndb") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          const codigoInterno = args.codigo_interno;
          if (typeof roomId !== "number" || typeof codigoInterno !== "number" || !Array.isArray(args.operations)) {
            return sendJson(400, { success: false, error: "Missing required 'room_id', 'codigo_interno' or 'operations'" });
          }
          const result = await handleEditSheetNDB({
            roomId,
            codigoInterno,
            operations: args.operations,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "open_dock_ndb") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.name !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'name' parameter" });
          }
          const result = await handleOpenDockNDB({
            roomId,
            name: args.name,
            isUser: args.is_user === true,
            create: args.create !== false,
            path: args.path,
            rawXml: args.raw_xml === true,
            maxDepth: args.max_depth,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "edit_dock_ndb") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.name !== "string" || !Array.isArray(args.operations)) {
            return sendJson(400, { success: false, error: "Missing required 'room_id', 'name' or 'operations'" });
          }
          const result = await handleEditDockNDB({
            roomId,
            name: args.name,
            operations: args.operations,
            isUser: args.is_user === true,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "manage_library_item") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.action !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'action' parameter" });
          }
          const result = await handleManageLibraryItem({
            roomId,
            action: args.action,
            parentCodigo: args.parent_codigo,
            codigoInterno: args.codigo_interno,
            name: args.name,
            dataType: args.data_type,
            changes: args.changes,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "manage_room") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.action !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id' or 'action' parameter" });
          }
          const result = await handleManageRoom({
            roomId,
            action: args.action,
            moderada: args.moderada,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "list_data_types") {
          const result = await handleListDataTypes({
            formType: args.form_type,
            query: args.query,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "list_installed_plugins") {
          const result = await handleListInstalledPlugins({
            query: args.query,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "get_sheet_template") {
          if (typeof args.data_type !== "string") {
            return sendJson(400, { success: false, error: "Missing 'data_type' parameter" });
          }
          const result = await handleGetSheetTemplate({
            dataType: args.data_type,
          });
          return sendJson(200, { success: true, tool: toolName, result });
        }

        if (toolName === "create_character_sheet") {
          const roomId = typeof args.room_id === "number" ? args.room_id : args.id;
          if (typeof roomId !== "number" || typeof args.name !== "string" || typeof args.data_type !== "string") {
            return sendJson(400, { success: false, error: "Missing 'room_id', 'name', or 'data_type' parameter" });
          }
          const result = await handleCreateCharacterSheet({
            roomId,
            name: args.name,
            dataType: args.data_type,
            parentCodigo: args.parent_codigo,
            autoStructure: args.auto_structure,
            initialData: args.initial_data,
          });
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

      // 7. Inspeção de mensagens de chat no banco: GET /db/messages
      if (req.method === "GET" && (pathname === "/db/messages" || pathname.startsWith("/db/messages/"))) {
        let roomId = url.searchParams.get("roomId") ? parseInt(url.searchParams.get("roomId")!, 10) : undefined;
        if (!roomId && pathname.startsWith("/db/messages/")) {
          const part = pathname.replace("/db/messages/", "");
          if (part) roomId = parseInt(part, 10);
        }
        if (!roomId) {
          return sendJson(400, { success: false, error: "Missing 'roomId' query parameter or path segment" });
        }
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
        const messages = getChatMessages(roomId, chatId, limit);
        return sendJson(200, { count: messages.length, roomId, chatId: chatId ?? "all", messages });
      }

      // 8. Inspeção de arquivos em inbox: GET /inbox
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
