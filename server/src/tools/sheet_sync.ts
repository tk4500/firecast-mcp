// server/src/tools/sheet_sync.ts
// Ferramentas MCP de leitura/escrita simplificada de fichas (NDB) com cache SQLite.
//
// Observação: os observadores contínuos (NodeObserver) e a emissão de eventos em tempo real estão
// DESATIVADOS no plugin Lua. O cache SQLite só é preenchido por leituras feitas por estas tools
// (snapshot via get_sheet_ndb) e atualizado pelas escritas de update_character_sheet.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommand } from "../bridge.js";
import {
  getSheetFromDb,
  listSheetsFromDb,
  applySheetDeltas,
  upsertSheetSnapshot,
  CharacterSheetRow,
} from "../db.js";
import { jsonResult, roomIdSchema, codigoInternoSchema } from "./common.js";

// Helper: formata resposta amigável
function formatSheetResponse(sheet: CharacterSheetRow) {
  return {
    room_id: sheet.room_id,
    codigo_interno: sheet.codigo_interno,
    character_name: sheet.character_name,
    data_type: sheet.data_type,
    sync_source: sheet.sync_source,
    is_open_in_tab: sheet.is_open_in_tab,
    last_updated_at: new Date(sheet.last_updated_at * 1000).toISOString(),
    data: sheet.data,
  };
}

/** Lê a ficha inteira ao vivo (get_sheet_ndb) e grava o snapshot completo no SQLite. */
async function snapshotSheet(roomId: number, codigoInterno: number, syncSource: string): Promise<CharacterSheetRow | null> {
  const ndbData = (await sendCommand("get_sheet_ndb", { roomId, codigoInterno })) as any;
  upsertSheetSnapshot({
    roomId,
    codigoInterno,
    characterName: ndbData?.characterName || ndbData?.name || "",
    dataType: ndbData?.dataType || "",
    data: ndbData?.data || {},
    syncSource,
  });
  return getSheetFromDb(roomId, codigoInterno);
}

const sheetRefShape = {
  room_id: roomIdSchema,
  codigo_interno: codigoInternoSchema,
};

interface SheetSyncTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<unknown>;
}

export const sheetSyncTools: SheetSyncTool[] = [
  {
    name: "get_character_sheet",
    description:
      "Lê os dados de uma ficha de personagem, com cache. Por padrão devolve o último snapshot salvo no SQLite (instantâneo, mas pode estar desatualizado se a ficha mudou no Firecast); se não houver snapshot, ou com fresh=true, lê ao vivo e atualiza o cache. Retorna { source, sheet{ character_name, data_type, last_updated_at, data } }. Para ler só um trecho ou obter XML use get_sheet_ndb.",
    shape: {
      ...sheetRefShape,
      fresh: z.boolean().optional().describe("true = ignora o cache e lê ao vivo do Firecast. Use quando a ficha pode ter mudado (ex: após o jogador editar). Padrão: false."),
    },
    handler: async (args: { room_id: number; codigo_interno: number; fresh?: boolean }) => {
      if (!args.fresh) {
        const cached = getSheetFromDb(args.room_id, args.codigo_interno);
        if (cached && cached.data && Object.keys(cached.data).length > 0) {
          return { source: "sqlite_cache", sheet: formatSheetResponse(cached) };
        }
      }

      try {
        const sheet = await snapshotSheet(args.room_id, args.codigo_interno, "ndb_query");
        if (sheet) {
          return { source: "firecast_live", sheet: formatSheetResponse(sheet) };
        }
        return { error: "Ficha lida, mas não foi possível gravar o snapshot no cache." };
      } catch (err: any) {
        const cachedFallback = getSheetFromDb(args.room_id, args.codigo_interno);
        if (cachedFallback) {
          return {
            source: "sqlite_cache_stale",
            warning: `Falha ao ler a ficha ao vivo (${err.message}). Retornando dados em cache.`,
            sheet: formatSheetResponse(cachedFallback),
          };
        }
        return { error: `Falha ao obter ficha: ${err.message}` };
      }
    },
  },

  {
    name: "update_character_sheet",
    description:
      "Forma simples de alterar valores numa ficha de personagem: um dicionário { caminho: valor }. Grava no Firecast (sincroniza para todos na mesa) e atualiza o cache. Não remove campos — para apagar use edit_sheet_ndb com action='delete'. Os nomes dos campos dependem do modelo de ficha (leia a ficha antes com get_character_sheet ou veja get_sheet_template). Só funciona se você for mestre (+GM) da mesa; caso contrário o Firecast recusa a escrita.",
    shape: {
      ...sheetRefShape,
      changes: z
        .record(z.string(), z.any())
        .describe(
          "Mapa caminho → novo valor. Caminhos com ponto criam/navegam sub-nós. Ex: { 'pv': 45, 'atributos.forca': 18, 'inventario.moedas': 100 }. Valores null são ignorados."
        ),
    },
    handler: async (args: { room_id: number; codigo_interno: number; changes: Record<string, any> }) => {
      // JSON null vira nil no Lua e a chave some da tabela: nulls não teriam efeito no Firecast.
      const changes: Record<string, any> = {};
      const ignoredNulls: string[] = [];
      for (const [k, v] of Object.entries(args.changes ?? {})) {
        if (v === null || v === undefined) ignoredNulls.push(k);
        else changes[k] = v;
      }
      if (Object.keys(changes).length === 0) {
        return { error: "Nenhuma alteração válida em `changes` (valores null são ignorados; para apagar use edit_sheet_ndb action='delete')." };
      }

      try {
        const res = (await sendCommand("update_sheet", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
          changes,
        })) as any;

        // Só aplica no cache se já houver um snapshot completo; senão o cache ficaria com
        // uma ficha parcial (apenas os campos alterados) e enganaria leituras futuras.
        if (getSheetFromDb(args.room_id, args.codigo_interno)) {
          applySheetDeltas({
            roomId: args.room_id,
            codigoInterno: args.codigo_interno,
            changes,
            syncSource: "mcp_edit",
          });
        }
        const updated = getSheetFromDb(args.room_id, args.codigo_interno);

        return {
          success: true,
          message: "Ficha atualizada no Firecast",
          result: res,
          ignored_null_keys: ignoredNulls.length ? ignoredNulls : undefined,
          sheet: updated ? formatSheetResponse(updated) : undefined,
        };
      } catch (err: any) {
        return { error: `Falha ao atualizar a ficha no Firecast: ${err.message}` };
      }
    },
  },

  {
    name: "list_synced_sheets",
    description:
      "Lista as fichas conhecidas. Padrão: fichas com snapshot no cache SQLite (lidas antes por get_character_sheet/sync_character_sheet), com os dados. fresh=true: fichas rastreadas pelo plugin nesta sessão do Firecast, com isTabOpen (aberta numa aba do cliente), sem os dados.",
    shape: {
      room_id: z.number().int().optional().describe("Filtra por mesa (campo `id` de list_rooms). Omitido = todas."),
      fresh: z.boolean().optional().describe("true = pergunta ao plugin quais fichas ele está rastreando agora. Padrão: false."),
    },
    handler: async (args: { room_id?: number; fresh?: boolean }) => {
      if (args.fresh) {
        try {
          const res = (await sendCommand("list_synced_sheets", { roomId: args.room_id })) as any;
          if (res) {
            return { source: "firecast_live", sheets: res.sheets || [], total: res.total || 0 };
          }
        } catch {}
      }

      const cached = listSheetsFromDb(args.room_id);
      return {
        source: "sqlite_cache",
        total: cached.length,
        sheets: cached.map(formatSheetResponse),
      };
    },
  },

  {
    name: "sync_character_sheet",
    description:
      "Marca a ficha como rastreada pelo plugin e grava um snapshot completo e atualizado no cache SQLite. Equivale a get_character_sheet com fresh=true, mais o registro de rastreamento (visível em list_synced_sheets fresh=true). Observação: a sincronização contínua em tempo real está desativada no plugin; o cache só muda quando você lê ou escreve pelas tools.",
    shape: {
      ...sheetRefShape,
      source: z.string().optional().describe("Rótulo livre de origem gravado no rastreamento ('manual', 'tab', 'player', 'mcp'). Padrão: 'manual'."),
    },
    handler: async (args: { room_id: number; codigo_interno: number; source?: string }) => {
      try {
        const res = (await sendCommand("sync_sheet", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
          source: args.source || "manual",
        })) as any;
        const sheet = await snapshotSheet(args.room_id, args.codigo_interno, args.source || "manual");
        return {
          success: true,
          message: "Ficha rastreada e snapshot atualizado",
          result: res,
          sheet: sheet ? formatSheetResponse(sheet) : undefined,
        };
      } catch (err: any) {
        return { error: `Falha ao sincronizar a ficha: ${err.message}` };
      }
    },
  },

  {
    name: "open_character_sheet",
    description:
      "Abre a ficha do personagem numa nova aba da interface do Firecast (na tela do usuário que roda o MCP) e a marca como rastreada. Não retorna os dados da ficha — use get_character_sheet para isso.",
    shape: { ...sheetRefShape },
    handler: async (args: { room_id: number; codigo_interno: number }) => {
      try {
        const res = (await sendCommand("open_sheet_in_tab", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
        })) as any;
        return { success: true, message: "Ficha aberta em aba no cliente Firecast", result: res };
      } catch (err: any) {
        return { error: `Falha ao abrir ficha: ${err.message}` };
      }
    },
  },
];

export function registerSheetSyncTools(server: McpServer): void {
  for (const tool of sheetSyncTools) {
    server.tool(tool.name, tool.description, tool.shape, async (args: any) => jsonResult(await tool.handler(args)));
  }
}
