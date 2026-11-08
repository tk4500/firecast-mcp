// tools/chat.ts
// MCP tools para o domínio de Chat, Mensagens e Rolagem de Dados no Firecast

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getChatMessages, insertChatMessage } from "../db.js";
import { sendCommand } from "../bridge.js";

export async function handleListChats(roomId: number): Promise<unknown> {
  return await sendCommand("list_chats", { room_id: roomId }, 30_000);
}

export async function handleGetChatMessages(
  roomId: number,
  chatId = "main",
  limit = 50,
  fresh = false
): Promise<unknown> {
  if (!fresh) {
    const cached = getChatMessages(roomId, chatId, limit);
    if (cached.length > 0) {
      return {
        room_id: roomId,
        chat_id: chatId,
        source: "cache",
        count: cached.length,
        messages: cached.map((c) => ({
          ...c,
          roll_data: c.roll_data ? JSON.parse(c.roll_data) : null,
        })),
      };
    }
  }

  try {
    const live = (await sendCommand(
      "get_chat_messages",
      {
        room_id: roomId,
        chat_id: chatId,
        limit,
      },
      30_000
    )) as Record<string, any>;

    if (live && Array.isArray(live.messages)) {
      for (const msg of live.messages) {
        insertChatMessage({
          message_id: msg.id,
          room_id: roomId,
          chat_id: chatId,
          sender: msg.entity,
          mine: false,
          type: msg.msg?.msgType ?? "standard",
          content: msg.msg?.content ?? "",
          roll: msg.msg?.roll,
          ts: msg.timestamp,
        });
      }
    }

    return {
      ...live,
      source: "live",
    };
  } catch (err: any) {
    if (!fresh) {
      return {
        room_id: roomId,
        chat_id: chatId,
        source: "cache",
        count: 0,
        messages: [],
        warning: "Nenhuma mensagem no cache local e plugin Firecast não respondeu: " + err.message,
      };
    }
    throw err;
  }
}

export async function handleSendChatMessage(args: {
  roomId: number;
  message: string;
  chatId?: string;
  type?: "standard" | "narrator" | "npc" | "action" | "laugh";
  npcName?: string;
}): Promise<unknown> {
  return await sendCommand("send_chat_message", {
    room_id: args.roomId,
    message: args.message,
    chat_id: args.chatId ?? "main",
    type: args.type ?? "standard",
    npc_name: args.npcName,
  });
}

export async function handleRollDice(args: {
  roomId: number;
  expression: string;
  chatId?: string;
  message?: string;
}): Promise<unknown> {
  return await sendCommand("roll_dice", {
    room_id: args.roomId,
    expression: args.expression,
    chat_id: args.chatId ?? "main",
    message: args.message,
  }, 30_000);
}

export function registerChatTools(server: McpServer): void {
  // 1. list_chats
  server.tool(
    "list_chats",
    "Lista todos os chats disponíveis em uma mesa (chat principal, abas privadas e grupos), indicando qual está ativo no momento.",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
    },
    async ({ room_id }) => {
      const result = await handleListChats(room_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // 2. get_chat_messages
  server.tool(
    "get_chat_messages",
    "Recupera o histórico recente de mensagens de um chat da mesa (padrão: chat principal).",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      chat_id: z
        .string()
        .optional()
        .describe("Identificador do chat ('main', 'active', ou 'pvt:<login>'). Padrão: 'main'"),
      limit: z.number().optional().describe("Quantidade máxima de mensagens a retornar. Padrão: 50"),
      fresh: z
        .boolean()
        .optional()
        .describe("Se true, consulta o Firecast ao vivo em vez do cache SQLite local"),
    },
    async ({ room_id, chat_id, limit, fresh }) => {
      const result = await handleGetChatMessages(room_id, chat_id ?? "main", limit ?? 50, fresh);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // 3. send_chat_message
  server.tool(
    "send_chat_message",
    "Envia uma mensagem para o chat especificado de uma mesa no Firecast (texto normal, narração, fala de NPC, ação descritiva ou risada).",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      message: z.string().describe("Conteúdo da mensagem a ser enviada"),
      chat_id: z
        .string()
        .optional()
        .describe("Identificador do chat ('main', 'active', ou 'pvt:<login>'). Padrão: 'main'"),
      type: z
        .enum(["standard", "narrator", "npc", "action", "laugh"])
        .optional()
        .describe("Tipo de mensagem: standard (padrão), narrator (narração destacada), npc (fala caracterizada), action (ação), laugh (risada)"),
      npc_name: z
        .string()
        .optional()
        .describe("Nome do NPC ou personagem quando type for 'npc' (ex: 'Taverneiro', 'Goblin Lacaio')"),
    },
    async ({ room_id, message, chat_id, type, npc_name }) => {
      const result = await handleSendChatMessage({
        roomId: room_id,
        message,
        chatId: chat_id,
        type,
        npcName: npc_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // 4. roll_dice
  server.tool(
    "roll_dice",
    "Executa uma rolagem de dados oficial dentro do chat especificado da mesa no Firecast (ex: '1d20+5', '3d6', '4dF') e retorna o resultado total e os dados individuais.",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      expression: z.string().describe("Fórmula da rolagem de dados (ex: '1d20+5', '2d6+3', '4dF')"),
      chat_id: z
        .string()
        .optional()
        .describe("Identificador do chat ('main', 'active', ou 'pvt:<login>'). Padrão: 'main'"),
      message: z
        .string()
        .optional()
        .describe("Texto explicativo opcional que acompanha a rolagem (ex: 'Ataque de Adaga', 'Percepção')"),
    },
    async ({ room_id, expression, chat_id, message }) => {
      const result = await handleRollDice({
        roomId: room_id,
        expression,
        chatId: chat_id,
        message,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
