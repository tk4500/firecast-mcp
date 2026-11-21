// tools/plugins.ts
// MCP tools para o domínio de Plugins e Modelos de Fichas (DataTypes) no Firecast SDK3

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommand } from "../bridge.js";
import { jsonResult } from "./common.js";

// Handlers
export async function handleListDataTypes(params: {
  formType?: string;
  query?: string;
}): Promise<unknown> {
  return await sendCommand(
    "list_data_types",
    {
      form_type: params.formType,
      query: params.query,
    },
    20_000
  );
}

export async function handleListInstalledPlugins(params: {
  query?: string;
}): Promise<unknown> {
  return await sendCommand(
    "list_plugins",
    {
      query: params.query,
    },
    20_000
  );
}

// Registro no McpServer
export function registerPluginsTools(server: McpServer): void {
  server.tool(
    "list_data_types",
    "Lista os modelos de ficha e janelas acopláveis instalados no Firecast (dataTypes). Use o `dataType` retornado em create_character_sheet, manage_library_item (create_char), get_sheet_template e open_dock_ndb. Retorna { total, data_types[{ dataType, formType, title, moduleId }] }.",
    {
      form_type: z
        .string()
        .optional()
        .describe("Filtra pelo tipo exato (sem diferenciar maiúsculas): 'sheetTemplate' = fichas de personagem, 'tablesDock' = janelas acopláveis da mesa. Omitido = todos."),
      query: z.string().optional().describe("Busca parcial (sem diferenciar maiúsculas) em dataType, título e moduleId (ex: 'dnd', 't20')."),
    },
    async ({ form_type, query }) => jsonResult(await handleListDataTypes({ formType: form_type, query }))
  );

  server.tool(
    "list_installed_plugins",
    "Lista os plugins SDK3 instalados no cliente Firecast (nome, versão, autor, moduleId, arquivo .rpk). Útil para saber quais sistemas de ficha e ferramentas estão disponíveis.",
    {
      query: z.string().optional().describe("Busca parcial em nome, autor, descrição ou moduleId."),
    },
    async ({ query }) => jsonResult(await handleListInstalledPlugins({ query }))
  );
}
