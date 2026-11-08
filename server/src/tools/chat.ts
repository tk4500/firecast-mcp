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
  fresh = false,
  options?: {
    serverQuery?: boolean;
    tid?: string;
    audit?: boolean;
  }
): Promise<unknown> {
  const needsLive = fresh || options?.serverQuery || options?.tid;

  if (!needsLive) {
    const cached = getChatMessages(roomId, chatId, limit);
    if (cached.length > 0) {
      return {
        room_id: roomId,
        chat_id: chatId,
        source: "cache",
        count: cached.length,
        messages: cached.map((c) => ({
          ...c,
          roll_data: c.roll_data && typeof c.roll_data === "string" ? JSON.parse(c.roll_data) : c.roll_data,
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
        server_query: options?.serverQuery,
        tid: options?.tid,
        audit: options?.audit,
      },
      30_000
    )) as Record<string, any>;

    if (live && Array.isArray(live.messages)) {
      for (const msg of live.messages) {
        insertChatMessage({
          message_id:    msg.id,
          tid:           msg.tid,
          room_id:       roomId,
          chat_id:       chatId,
          sender:        msg.entity,
          mine:          false,
          type:          msg.msg?.msgType ?? "standard",
          content:       msg.msg?.content ?? "",
          npc_name:      msg.msg?.impersonation?.name,
          impersonation: msg.msg?.impersonation,
          visibility:    msg.visibility,
          file_url:      msg.msg?.fileURL,
          roll:          msg.msg?.roll,
          raw_json:      msg,
          ts:            msg.timestamp,
        });
      }
    }

    return {
      ...live,
      source: live.source || "live",
    };
  } catch (err: any) {
    if (!needsLive) {
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

export interface ImpersonationParam {
  mode?: "none" | "narrator" | "character";
  name?: string;
  avatar?: string;
  gender?: "undefined" | "masculine" | "feminine" | "neuter";
}

export interface VisibilityParam {
  mode?: "standard" | "recipients";
  recipients?: number[];
  blacklist?: number[];
}

export interface TalemarkOptionsParam {
  parseCharActions?: boolean;
  parseSmileys?: boolean;
  parseURL?: boolean;
}

export async function handleSendChatMessage(args: {
  roomId: number;
  message: string;
  chatId?: string;
  type?: "standard" | "narrator" | "npc" | "action" | "laugh";
  npcName?: string;
  avatar?: string;
  gender?: "undefined" | "masculine" | "feminine" | "neuter";
  impersonation?: ImpersonationParam;
  visibility?: VisibilityParam;
  talemarkOptions?: TalemarkOptionsParam;
}): Promise<unknown> {
  return await sendCommand("send_chat_message", {
    room_id:         args.roomId,
    message:         args.message,
    chat_id:         args.chatId ?? "main",
    type:            args.type ?? "standard",
    npc_name:        args.npcName,
    avatar:          args.avatar,
    gender:          args.gender,
    impersonation:   args.impersonation,
    visibility:      args.visibility,
    talemarkOptions: args.talemarkOptions,
  }, 30_000);
}

export async function handleRollDice(args: {
  roomId: number;
  expression: string;
  chatId?: string;
  message?: string;
  impersonation?: ImpersonationParam;
  visibility?: VisibilityParam;
}): Promise<unknown> {
  return await sendCommand("roll_dice", {
    room_id:       args.roomId,
    expression:    args.expression,
    chat_id:       args.chatId ?? "main",
    message:       args.message,
    impersonation: args.impersonation,
    visibility:    args.visibility,
  }, 30_000);
}

const ImpersonationSchema = z.object({
  mode: z.enum(["none", "narrator", "character"]).optional().describe("Modo de impersonation"),
  name: z.string().optional().describe("Nome do personagem ou NPC exibido no chat"),
  avatar: z.string().url().optional().describe("URL da imagem de avatar do personagem ou NPC"),
  gender: z.enum(["undefined", "masculine", "feminine", "neuter"]).optional().describe("Gênero do personagem"),
});

const VisibilitySchema = z.object({
  mode: z.enum(["standard", "recipients"]).optional().describe("Modo de visibilidade ('standard' para todos ou 'recipients' para lista restrita)"),
  recipients: z.array(z.number()).optional().describe("Lista de IDs de usuários (userId) que podem ver a mensagem"),
  blacklist: z.array(z.number()).optional().describe("Lista de IDs de usuários (userId) proibidos de ver a mensagem"),
});

const TalemarkOptionsSchema = z.object({
  parseCharActions: z.boolean().optional().describe("Interpretar ações entre asteriscos (*acao*)"),
  parseSmileys: z.boolean().optional().describe("Interpretar emoticons e smileys"),
  parseURL: z.boolean().optional().describe("Detectar e transformar URLs em links"),
});

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
    "Recupera o histórico de mensagens de um chat da mesa (padrão: chat principal), com suporte a cache local SQLite ou consulta histórica no servidor Firecast.",
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
      server_query: z
        .boolean()
        .optional()
        .describe("Se true, consulta o histórico do servidor Firecast via asyncQueryLogRecs"),
      tid: z
        .string()
        .optional()
        .describe("TID da mensagem de referência para paginação histórica retroativa"),
      audit: z
        .boolean()
        .optional()
        .describe("Se true, inclui mensagens apagadas / auditoria"),
    },
    async ({ room_id, chat_id, limit, fresh, server_query, tid, audit }) => {
      const result = await handleGetChatMessages(room_id, chat_id ?? "main", limit ?? 50, fresh, {
        serverQuery: server_query,
        tid,
        audit,
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

  // 3. send_chat_message
  server.tool(
    "send_chat_message",
    "Envia uma mensagem para o chat especificado de uma mesa no Firecast, com suporte total a impersonation (narrador, NPC com nome e avatar customizado), visibilidade direcionada (sussurro para lista de usuários) e talemarkOptions.",
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
      avatar: z
        .string()
        .url()
        .optional()
        .describe("URL da imagem de avatar personalizada para o personagem / narrador"),
      gender: z
        .enum(["undefined", "masculine", "feminine", "neuter"])
        .optional()
        .describe("Gênero gramatical do personagem"),
      impersonation: ImpersonationSchema.optional().describe("Estrutura completa de impersonation (mode, name, avatar, gender)"),
      visibility: VisibilitySchema.optional().describe("Controle de visibilidade da mensagem (mode, recipients, blacklist)"),
      talemark_options: TalemarkOptionsSchema.optional().describe("Opções de formatação e parsing do texto"),
    },
    async ({ room_id, message, chat_id, type, npc_name, avatar, gender, impersonation, visibility, talemark_options }) => {
      const result = await handleSendChatMessage({
        roomId: room_id,
        message,
        chatId: chat_id,
        type,
        npcName: npc_name,
        avatar,
        gender,
        impersonation,
        visibility,
        talemarkOptions: talemark_options,
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
    "Executa uma rolagem de dados oficial dentro do chat especificado da mesa no Firecast (ex: '1d20+5', '3d6', '4dF') com suporte a impersonation e visibilidade direcionada (rolagem secreta para o mestre ou jogadores específicos).",
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
      impersonation: ImpersonationSchema.optional().describe("Estrutura completa de impersonation (mode, name, avatar, gender)"),
      visibility: VisibilitySchema.optional().describe("Controle de visibilidade da rolagem (mode, recipients, blacklist)"),
    },
    async ({ room_id, expression, chat_id, message, impersonation, visibility }) => {
      const result = await handleRollDice({
        roomId: room_id,
        expression,
        chatId: chat_id,
        message,
        impersonation,
        visibility,
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
