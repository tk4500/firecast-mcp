// tools/registry.ts
// Fonte única das tools MCP: registra todas no McpServer, coleta as definições
// (nome, descrição, schema zod) para o modo HTTP (/tools) e para gerar docs/TOOLS.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerRoomTools } from "./rooms.js";
import { registerChatTools } from "./chat.js";
import { registerNdbTools } from "./ndb.js";
import { registerPluginsTools } from "./plugins.js";
import { registerCharacterTools } from "./characters.js";
import { registerMediaTools } from "./media.js";
import { registerSheetSyncTools } from "./sheet_sync.js";

/** Grupos de tools, na ordem em que aparecem na documentação. */
export const TOOL_GROUPS: { title: string; register: (server: McpServer) => void }[] = [
  { title: "Mesas e jogadores", register: registerRoomTools },
  { title: "Chat e dados", register: registerChatTools },
  { title: "Biblioteca e Node Database (fichas no Firecast)", register: registerNdbTools },
  { title: "Fichas com cache (atalhos de leitura/escrita)", register: registerSheetSyncTools },
  { title: "Plugins e modelos de ficha", register: registerPluginsTools },
  { title: "Character Manager (NPCs locais do MCP)", register: registerCharacterTools },
  { title: "Mídia (upload e envio de imagens)", register: registerMediaTools },
];

/** Instruções gerais enviadas ao cliente MCP no handshake (campo `instructions`). */
export const SERVER_INSTRUCTIONS = `Firecast MCP: controla o Firecast (mesa virtual de RPG) através de um plugin rodando no cliente Firecast do usuário.

PRÉ-REQUISITO: o Firecast precisa estar aberto, com o plugin carregado e conectado à mesa. Sem isso, tools que consultam o Firecast falham por timeout (30 s); tools com cache (list_rooms, get_room, list_players, get_chat_messages, get_character_sheet) ainda respondem com dados salvos, e as do Character Manager e get_sheet_template funcionam offline.

DE ONDE VÊM OS IDS:
- room_id (às vezes chamado só de id): campo \`id\` de list_rooms.
- codigo_interno / parent_codigo: campo \`codigoInterno\` dos itens de list_library (fichas têm tipo='personagem').
- id e login de jogador: list_players (id → visibility.recipients; login → chat_id 'pvt:<login>').
- chat_id: 'main' (padrão) ou o \`id\` de list_chats.
- data_type: list_data_types (form_type='sheetTemplate' para fichas).

DOIS TIPOS DE "PERSONAGEM" — não confunda:
1. Ficha na Biblioteca do Firecast: identificada por codigo_interno; lida/escrita com get_sheet_ndb, edit_sheet_ndb, get_character_sheet, update_character_sheet.
2. Personagem do Character Manager: registro local do MCP (nome, avatar, cor, personalidade) identificado por \`character\` (id, code ou nome); usado com impersonate_character e character_roll. Pode ser vinculado a uma ficha com link_character_sheet.

FLUXOS COMUNS:
- Ler uma ficha: list_rooms → list_library(room_id) → get_character_sheet(room_id, codigo_interno).
- Alterar valores da ficha: get_character_sheet (para ver os nomes dos campos) → update_character_sheet(changes={'pv': 30}).
- Falar como NPC: create_character uma vez → impersonate_character(character, message, room_id).
- Mostrar uma imagem: send_media_to_chat(room_id, file_path ou media_url).

CUIDADOS:
- send_chat_message, roll_dice, impersonate_character, character_roll e send_media_to_chat publicam DE VERDADE para os jogadores da mesa.
- edit_sheet_ndb, edit_dock_ndb, manage_library_item, manage_room e create_character_sheet só funcionam na mesa de testes 239256 ou se o usuário for mestre; em mesas reais de campanha confirme com o usuário antes de escrever.
- As respostas são JSON em texto; erros vêm como { error } ou como erro da tool.`;

export interface CollectedTool {
  group: string;
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<{ content: { type: string; text: string }[] }>;
}

/** Registra todas as tools num McpServer real (modo stdio). */
export function registerAllTools(server: McpServer): void {
  for (const g of TOOL_GROUPS) g.register(server);
}

/**
 * Coleta as definições das tools sem subir um servidor MCP, usando um registrador
 * falso que só grava o que cada register*Tools passaria para server.tool().
 */
export function collectTools(): CollectedTool[] {
  const tools: CollectedTool[] = [];
  for (const g of TOOL_GROUPS) {
    const recorder = {
      tool: (name: string, description: string, shape: z.ZodRawShape, handler: CollectedTool["handler"]) => {
        tools.push({ group: g.title, name, description, shape, handler });
      },
    };
    g.register(recorder as unknown as McpServer);
  }
  return tools;
}

/** JSON Schema do input de uma tool (o mesmo que o cliente MCP recebe). */
export function toolInputJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  return z.toJSONSchema(z.object(shape), { unrepresentable: "any" }) as Record<string, unknown>;
}
