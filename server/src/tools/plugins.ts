// tools/plugins.ts
// MCP tools para o domínio de Plugins e Modelos de Fichas (DataTypes) no Firecast SDK3

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommand } from "../bridge.js";

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
  // 1. list_data_types
  server.tool(
    "list_data_types",
    "Lista todos os tipos de dados / modelos de fichas (dataTypes) instalados no Firecast SDK3. Permite filtrar por tipo de formulário (ex: 'sheetTemplate' para fichas de personagem, 'tablesDock' para janelas acopláveis) ou por termo de busca.",
    {
      form_type: z
        .string()
        .optional()
        .describe("Filtro opcional pelo tipo de form: 'sheetTemplate' (fichas de personagens), 'tablesDock' (janelas acopláveis), etc."),
      query: z
        .string()
        .optional()
        .describe("Termo de busca opcional para filtrar por título, dataType ou moduleId"),
    },
    async ({ form_type, query }) => {
      const result = await handleListDataTypes({
        formType: form_type,
        query,
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

  // 2. list_installed_plugins
  server.tool(
    "list_installed_plugins",
    "Lista todos os plug-ins SDK3 instalados no cliente Firecast (nome, versão, autor, moduleId, arquivo .rpk).",
    {
      query: z
        .string()
        .optional()
        .describe("Termo de busca opcional para filtrar por nome, autor, descrição ou moduleId"),
    },
    async ({ query }) => {
      const result = await handleListInstalledPlugins({
        query,
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
