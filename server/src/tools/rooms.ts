// tools/rooms.ts
// MCP tools para o domínio de Mesas

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAllRooms, getRoomById, upsertRoom } from "../db.js";
import { sendCommand } from "../bridge.js";
import { jsonResult, freshSchema, roomIdSchema, ROOM_ID_DESC } from "./common.js";

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
  server.tool(
    "list_rooms",
    "Lista as mesas em que você está conectado no Firecast. Ponto de partida de quase todo fluxo: o campo `id` de cada mesa é o `room_id` exigido pelas outras tools. Retorna array de { id, nome, sistema, isModerada, haVagas, players[...], ... }. Usa o cache SQLite por padrão; se o cache estiver vazio busca ao vivo automaticamente.",
    { fresh: freshSchema },
    async ({ fresh }) => jsonResult(await handleListRooms(fresh))
  );

  server.tool(
    "get_room",
    "Retorna os detalhes de UMA mesa (nome, sistema, mensagens de status/boas-vindas, moderação e lista de jogadores). Atenção: aqui o parâmetro se chama `id`, não `room_id`.",
    {
      id: z.number().int().describe(ROOM_ID_DESC),
      fresh: freshSchema,
    },
    async ({ id, fresh }) => jsonResult(await handleGetRoom(id, fresh))
  );

  server.tool(
    "list_players",
    "Lista os jogadores presentes na mesa: { id, login, nick, isMe, isMestre, isJogador, isEspectador, isAusente, personagemPrincipal, ... }. Use `id` como destinatário em visibility.recipients e `login` para chat_id 'pvt:<login>'.",
    {
      room_id: roomIdSchema,
      fresh: freshSchema,
    },
    async ({ room_id, fresh }) => jsonResult(await handleListPlayers(room_id, fresh))
  );
}
