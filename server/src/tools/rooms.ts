// tools/rooms.ts
// MCP tools para o domínio de Mesas

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllRooms, getRoomById, upsertRoom } from "../db.js";
import { sendCommand } from "../bridge.js";

export async function handleListRooms(fresh = false): Promise<unknown> {
  if (!fresh) {
    const cached = getAllRooms();
    if (cached.length > 0) {
      return cached;
    }
  }
  const liveRooms = (await sendCommand("list_rooms", {})) as Record<string, unknown>[];
  if (Array.isArray(liveRooms)) {
    for (const room of liveRooms) {
      if (room && typeof room === "object" && room.id) {
        upsertRoom(room);
      }
    }
  }
  return liveRooms;
}

export async function handleGetRoom(id: number, fresh = false): Promise<unknown> {
  if (!fresh) {
    const cached = getRoomById(id);
    if (cached) {
      return cached;
    }
  }
  const room = (await sendCommand("get_room", { id })) as Record<string, unknown>;
  if (room && typeof room === "object" && room.id) {
    upsertRoom(room);
  }
  return room;
}

export async function handleListPlayers(roomId: number, fresh = false): Promise<unknown> {
  if (!fresh) {
    const cached = getRoomById(roomId);
    if (cached && cached.players && Array.isArray(cached.players) && cached.players.length > 0) {
      return cached.players;
    }
  }
  const players = await sendCommand("list_players", { id: roomId });
  const room = getRoomById(roomId);
  if (room) {
    upsertRoom({ ...room, players: players as any });
  }
  return players;
}

export function registerRoomTools(server: McpServer): void {
  // list_rooms: retorna todas as mesas do SQLite (cache do last-known-state)
  // Se o cache estiver vazio (ou fresh=true), busca ao vivo no Firecast via inbox.
  server.tool(
    "list_rooms",
    "Lista todas as mesas abertas no Firecast. Usa cache local quando disponível, ou busca ao vivo com fresh: true.",
    { fresh: z.boolean().optional().describe("Força busca ao vivo no Firecast ignorando cache") },
    async ({ fresh }) => {
      const result = await handleListRooms(fresh);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // get_room: busca uma mesa específica por ID (inclui lista de jogadores e detalhes completos)
  server.tool(
    "get_room",
    "Retorna os detalhes de uma mesa específica pelo seu ID interno, incluindo jogadores conectados.",
    {
      id: z.number().int().describe("codigoInterno da mesa"),
      fresh: z.boolean().optional().describe("Força busca ao vivo no Firecast ignorando cache"),
    },
    async ({ id, fresh }) => {
      const result = await handleGetRoom(id, fresh);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // list_players: lista os jogadores de uma mesa
  server.tool(
    "list_players",
    "Lista todos os jogadores conectados na mesa especificada por ID, com status (+mestre, +jogador, espectador, ausente, etc.).",
    {
      room_id: z.number().int().describe("codigoInterno da mesa"),
      fresh: z.boolean().optional().describe("Força busca ao vivo no Firecast ignorando cache"),
    },
    async ({ room_id, fresh }) => {
      const result = await handleListPlayers(room_id, fresh);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
