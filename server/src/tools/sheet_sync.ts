// server/src/tools/sheet_sync.ts
// Ferramentas MCP para sincronização bidirecional em tempo real de fichas (NDB).
// Lê instantaneamente do cache SQLite (persistido via NodeObserver) e escreve com propagação segura para o cliente Firecast.

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

export const sheetSyncTools = [
  {
    name: "get_character_sheet",
    description:
      "Obtém os dados em tempo real da ficha de personagem (NDB). Por padrão lê do cache SQLite continuamente sincronizado via NodeObserver. Se fresh=true, força a leitura ao vivo via bridge.",
    parameters: z.object({
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      fresh: z.boolean().optional().describe("Se true, força requisição direta ao vivo ao Firecast"),
    }),
    handler: async (args: { room_id: number; codigo_interno: number; fresh?: boolean }) => {
      if (!args.fresh) {
        const cached = getSheetFromDb(args.room_id, args.codigo_interno);
        if (cached && cached.data && Object.keys(cached.data).length > 0) {
          return {
            source: "sqlite_sync_cache",
            sheet: formatSheetResponse(cached),
          };
        }
      }

      // Se não encontrou no cache ou pediu fresh, requisita sincronização ao vivo
      try {
        const syncRes = (await sendCommand("sync_sheet", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
          source: "manual",
        })) as any;

        // Aguarda 150ms para o snapshot do bridge ser processado no watcher/SQLite
        await new Promise((r) => setTimeout(r, 150));
        const updated = getSheetFromDb(args.room_id, args.codigo_interno);
        if (updated) {
          return {
            source: "firecast_live_sync",
            sheet: formatSheetResponse(updated),
          };
        }

        return {
          source: "firecast_live_sync_pending",
          message: "Sincronização iniciada com sucesso no Firecast. Dados em processamento.",
          info: syncRes,
        };
      } catch (err: any) {
        // Fallback para get_sheet_ndb clássico se sync_sheet falhar
        try {
          const ndbData = (await sendCommand("get_sheet_ndb", {
            roomId: args.room_id,
            codigoInterno: args.codigo_interno,
          })) as any;

          upsertSheetSnapshot({
            roomId: args.room_id,
            codigoInterno: args.codigo_interno,
            characterName: ndbData?.name || "",
            dataType: ndbData?.dataType || "",
            data: ndbData?.data || {},
            syncSource: "ndb_query",
          });

          return {
            source: "firecast_live_ndb",
            sheet: {
              room_id: args.room_id,
              codigo_interno: args.codigo_interno,
              character_name: ndbData?.name,
              data_type: ndbData?.dataType,
              data: ndbData?.data,
            },
          };
        } catch (ndbErr: any) {
          const cachedFallback = getSheetFromDb(args.room_id, args.codigo_interno);
          if (cachedFallback) {
            return {
              source: "sqlite_cache_stale",
              warning: `Falha ao contatar bridge (${err.message}). Retornando dados em cache.`,
              sheet: formatSheetResponse(cachedFallback),
            };
          }
          return { error: `Falha ao obter ficha: ${err.message}` };
        }
      }
    },
  },

  {
    name: "update_character_sheet",
    description:
      "Modifica campos ou sub-árvores na ficha de personagem (NDB) no Firecast de forma segura com cancelamento de eco (anti-loop). Os novos valores são sincronizados imediatamente no Firecast e no SQLite.",
    parameters: z.object({
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      changes: z
        .record(z.string(), z.any())
        .describe(
          "Dicionário de alterações chave-valor. Suporta caminhos com notação de ponto (ex: {'pv': 45, 'atributos.forca': 18, 'inventario.moedas': 100}). Passar null apaga o campo."
        ),
    }),
    handler: async (args: { room_id: number; codigo_interno: number; changes: Record<string, any> }) => {
      // 1. Atualiza cache SQLite local imediatamente para leituras rápidas
      applySheetDeltas({
        roomId: args.room_id,
        codigoInterno: args.codigo_interno,
        changes: args.changes,
        syncSource: "mcp_edit",
      });

      // 2. Envia comando para a bridge atualizar o NDB da ficha no Firecast
      try {
        const res = (await sendCommand("update_sheet", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
          changes: args.changes,
        })) as any;

        const updated = getSheetFromDb(args.room_id, args.codigo_interno);

        return {
          success: true,
          message: "Ficha atualizada com sucesso no Firecast e no SQLite",
          result: res,
          sheet: updated ? formatSheetResponse(updated) : undefined,
        };
      } catch (err: any) {
        return {
          error: `Falha ao enviar comando de atualização para a bridge: ${err.message}`,
        };
      }
    },
  },

  {
    name: "list_synced_sheets",
    description:
      "Lista todas as fichas atualmente sincronizadas e observadas na mesa, indicando quais pertencem a jogadores conectados e quais estão abertas em abas do Firecast.",
    parameters: z.object({
      room_id: z.number().optional().describe("ID da mesa (opcional)"),
      fresh: z
        .boolean()
        .optional()
        .describe("Se true, consulta a bridge para listar o estado dos observadores ativos"),
    }),
    handler: async (args: { room_id?: number; fresh?: boolean }) => {
      if (args.fresh) {
        try {
          const res = (await sendCommand("list_synced_sheets", {
            roomId: args.room_id,
          })) as any;
          if (res) {
            return {
              source: "firecast_live_bridge",
              sheets: res.sheets || [],
              total: res.total || 0,
            };
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
      "Inicia ou força a sincronização contínua de uma ficha de personagem específica com observador em tempo real.",
    parameters: z.object({
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      source: z
        .string()
        .optional()
        .describe("Marcador de origem da sincronização ('manual', 'tab', 'player', 'mcp')"),
    }),
    handler: async (args: { room_id: number; codigo_interno: number; source?: string }) => {
      try {
        const res = (await sendCommand("sync_sheet", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
          source: args.source || "manual",
        })) as any;

        // Aguarda 150ms para processamento do snapshot
        await new Promise((r) => setTimeout(r, 150));
        const sheet = getSheetFromDb(args.room_id, args.codigo_interno);

        return {
          success: true,
          message: "Sincronização contínua ativada com sucesso para a ficha",
          result: res,
          sheet: sheet ? formatSheetResponse(sheet) : undefined,
        };
      } catch (err: any) {
        return { error: `Falha ao iniciar sincronização: ${err.message}` };
      }
    },
  },

  {
    name: "open_character_sheet",
    description:
      "Abre a ficha de personagem visualmente em uma aba da mesa no cliente Firecast e marca a ficha como aberta em aba para sincronização prioritária.",
    parameters: z.object({
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
    }),
    handler: async (args: { room_id: number; codigo_interno: number }) => {
      try {
        const res = (await sendCommand("open_sheet_in_tab", {
          roomId: args.room_id,
          codigoInterno: args.codigo_interno,
        })) as any;

        return {
          success: true,
          message: "Ficha aberta em aba no cliente Firecast",
          result: res,
        };
      } catch (err: any) {
        return { error: `Falha ao abrir ficha: ${err.message}` };
      }
    },
  },
];

export function registerSheetSyncTools(server: McpServer): void {
  // 1. get_character_sheet
  server.tool(
    "get_character_sheet",
    "Obtém os dados em tempo real da ficha de personagem (NDB). Lê instantaneamente do cache SQLite mantido pelo NodeObserver ou direto do Firecast com fresh=true.",
    {
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      fresh: z.boolean().optional().describe("Se true, força consulta ao vivo via bridge"),
    },
    async (args) => {
      const tool = sheetSyncTools.find((t) => t.name === "get_character_sheet")!;
      const result = await tool.handler(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 2. update_character_sheet
  server.tool(
    "update_character_sheet",
    "Modifica campos ou sub-árvores na ficha de personagem (NDB) com cancelamento de eco. Suporta notação de ponto (ex: 'pv': 50, 'atributos.forca': 18).",
    {
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      changes: z.record(z.string(), z.any()).describe("Dicionário de alterações chave-valor"),
    },
    async (args) => {
      const tool = sheetSyncTools.find((t) => t.name === "update_character_sheet")!;
      const result = await tool.handler(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 3. list_synced_sheets
  server.tool(
    "list_synced_sheets",
    "Lista todas as fichas sincronizadas e observadas na mesa, indicando se pertencem a jogadores online ou se estão abertas em abas visuais do cliente Firecast.",
    {
      room_id: z.number().optional().describe("ID da mesa (opcional)"),
      fresh: z.boolean().optional().describe("Se true, consulta a bridge em tempo real"),
    },
    async (args) => {
      const tool = sheetSyncTools.find((t) => t.name === "list_synced_sheets")!;
      const result = await tool.handler(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 4. sync_character_sheet
  server.tool(
    "sync_character_sheet",
    "Inicia a sincronização contínua de uma ficha de personagem específica com observador em tempo real.",
    {
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
      source: z.string().optional().describe("Origem da sincronização ('manual', 'tab', 'player')"),
    },
    async (args) => {
      const tool = sheetSyncTools.find((t) => t.name === "sync_character_sheet")!;
      const result = await tool.handler(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 5. open_character_sheet
  server.tool(
    "open_character_sheet",
    "Abre a ficha de personagem em uma aba visual na interface do Firecast e marca a ficha para sincronização ativa.",
    {
      room_id: z.number().describe("ID da mesa"),
      codigo_interno: z.number().describe("Código interno da ficha de personagem"),
    },
    async (args) => {
      const tool = sheetSyncTools.find((t) => t.name === "open_character_sheet")!;
      const result = await tool.handler(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

