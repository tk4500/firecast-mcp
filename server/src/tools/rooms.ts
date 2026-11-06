// tools/rooms.ts
// MCP tools para o domínio de Mesas

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllRooms, getRoomById } from "../db.js";
import { sendCommand } from "../bridge.js";

export async function handleListRooms(): Promise<unknown> {
  const cached = getAllRooms();
  if (cached.length > 0) {
    return cached;
  }
  return await sendCommand("list_rooms", {});
}

export async function handleGetRoom(id: number): Promise<unknown> {
  const cached = getRoomById(id);
  if (cached) {
    return cached;
  }
  return await sendCommand("get_room", { id });
}

export function registerRoomTools(server: McpServer): void {
  // list_rooms: retorna todas as mesas do SQLite (cache do last-known-state)
  // Se o cache estiver vazio, busca ao vivo no Firecast via inbox.
  server.tool(
    "list_rooms",
    "Lista todas as mesas abertas no Firecast. Usa cache local quando disponível.",
    {},
    async () => {
      const result = await handleListRooms();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // get_room: busca uma mesa específica por ID
  server.tool(
    "get_room",
    "Retorna os detalhes de uma mesa específica pelo seu ID interno.",
    { id: z.number().int().describe("codigoInterno da mesa") },
    async ({ id }) => {
      const result = await handleGetRoom(id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
