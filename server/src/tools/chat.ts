// tools/chat.ts
// MCP tools para o domínio de Chat, Mensagens e Rolagem de Dados no Firecast

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getChatMessages, insertChatMessage } from "../db.js";
import { sendCommand } from "../bridge.js";
import {
  jsonResult,
  roomIdSchema,
  chatIdSchema,
  ImpersonationSchema,
  VisibilitySchema,
  TalemarkOptionsSchema,
} from "./common.js";

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

export function registerChatTools(server: McpServer): void {
  server.tool(
    "list_chats",
    "Lista os chats abertos na mesa: o principal ('main') e abas de PVT/grupo já abertas no cliente. Retorna [{ id, name, kind, is_main, is_active, participants[] }]. Use o `id` retornado como chat_id nas outras tools. Sempre consulta ao vivo.",
    { room_id: roomIdSchema },
    async ({ room_id }) => jsonResult(await handleListChats(room_id))
  );

  server.tool(
    "get_chat_messages",
    "Lê o histórico de mensagens de um chat. Três modos: (1) padrão = cache SQLite local, preenchido apenas por leituras ao vivo anteriores (pode estar desatualizado; se vazio, cai para o modo 2); (2) fresh=true = buffer local do cliente Firecast (mensagens recentes desde que você entrou); (3) server_query=true ou tid = histórico do servidor Firecast, com paginação para trás. Retorna { source, count, messages[{ id, tid, timestamp, entity{login,nick}, msg{msgType, content, impersonation, roll}, visibility }] }.",
    {
      room_id: roomIdSchema,
      chat_id: chatIdSchema,
      limit: z.number().int().min(1).max(50).optional().describe("Máximo de mensagens (1–50; o plugin limita a 50). Padrão: 50."),
      fresh: z.boolean().optional().describe("true = ignora o cache e lê o buffer ao vivo do cliente Firecast. Padrão: false."),
      server_query: z.boolean().optional().describe("true = consulta o histórico salvo no servidor Firecast (alcança mensagens anteriores à sua entrada). Padrão: false."),
      tid: z.string().optional().describe("Paginação retroativa: passe o `tid` da mensagem mais antiga já recebida para buscar as anteriores a ela. Ativa server_query automaticamente."),
      audit: z.boolean().optional().describe("true = inclui mensagens apagadas (requer server_query). Padrão: false."),
    },
    async ({ room_id, chat_id, limit, fresh, server_query, tid, audit }) =>
      jsonResult(
        await handleGetChatMessages(room_id, chat_id ?? "main", limit ?? 50, fresh, {
          serverQuery: server_query,
          tid,
          audit,
        })
      )
  );

  server.tool(
    "send_chat_message",
    "Envia uma mensagem ao chat da mesa (é publicado de verdade para os jogadores). Como escolher a identidade: (a) texto normal → só `message`; (b) narração → type='narrator'; (c) NPC simples → npc_name (+ avatar opcional); (d) controle total → objeto `impersonation`. Prioridade: impersonation > npc_name > type='narrator'. Para falar como um personagem salvo no Character Manager prefira impersonate_character. Para sussurro use `visibility`.",
    {
      room_id: roomIdSchema,
      message: z.string().describe("Texto da mensagem. Aceita marcação Talemark (ex: '[§B]negrito[§R]', '[§K#FF0000]vermelho', '[§I url]' para imagem). Pode ser vazio só com type='laugh'."),
      chat_id: chatIdSchema,
      type: z
        .enum(["standard", "narrator", "npc", "action", "laugh"])
        .optional()
        .describe("'standard' (padrão) = fala normal; 'narrator' = narração; 'npc' = rótulo para fala de NPC (o nome vem de npc_name — sem npc_name sai como fala normal); 'action' = ação em terceira pessoa ('/me'); 'laugh' = risada (ignora message)."),
      npc_name: z.string().optional().describe("Nome do NPC exibido como autor (ex: 'Taverneiro'). Basta informar para falar como NPC; ignorado se `impersonation` for enviado."),
      avatar: z.string().url().optional().describe("URL do avatar usado junto com npc_name ou type='narrator'."),
      gender: z.enum(["undefined", "masculine", "feminine", "neuter"]).optional().describe("Gênero gramatical usado junto com npc_name ou type='narrator'."),
      impersonation: ImpersonationSchema.optional(),
      visibility: VisibilitySchema.optional(),
      talemark_options: TalemarkOptionsSchema.optional(),
    },
    async ({ room_id, message, chat_id, type, npc_name, avatar, gender, impersonation, visibility, talemark_options }) =>
      jsonResult(
        await handleSendChatMessage({
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
        })
      )
  );

  server.tool(
    "roll_dice",
    "Faz uma rolagem oficial de dados no chat da mesa (o resultado aparece para os jogadores e é gerado pelo Firecast, não pelo modelo). Retorna { total, asString, roll{ops[...]} }. Para rolar em nome de um personagem do Character Manager prefira character_roll. Para rolagem secreta use visibility mode='recipients'.",
    {
      room_id: roomIdSchema,
      expression: z.string().describe("Fórmula no formato do Firecast: '1d20+5', '2d6+3', '4dF', '3d6+1d4-2'."),
      chat_id: chatIdSchema,
      message: z.string().optional().describe("Motivo exibido junto à rolagem (ex: 'Ataque de Adaga', 'Teste de Percepção')."),
      impersonation: ImpersonationSchema.optional(),
      visibility: VisibilitySchema.optional(),
    },
    async ({ room_id, expression, chat_id, message, impersonation, visibility }) =>
      jsonResult(
        await handleRollDice({
          roomId: room_id,
          expression,
          chatId: chat_id,
          message,
          impersonation,
          visibility,
        })
      )
  );
}
