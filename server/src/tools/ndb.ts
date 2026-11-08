// tools/ndb.ts
// MCP tools para o domínio de Biblioteca e Node Database (NDB) no Firecast SDK3

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommand } from "../bridge.js";
import { extractSheetTemplate } from "../template.js";

const TEST_ROOM_ID = 239256; // Mesa 'tttttaaaaa'

// Tipos e Schemas
export const NodeOperationSchema = z.object({
  action: z.enum(["set", "delete"]).describe("Ação a ser executada: 'set' para atribuir valor ou 'delete' para remover"),
  path: z.string().describe("Caminho do campo/sub-nodo (ex: 'atributos.forca', 'equipamento.arma', 'vida.atual')"),
  value: z.any().optional().describe("Valor a ser atribuído quando action for 'set'"),
});

export type NodeOperation = z.infer<typeof NodeOperationSchema>;

// Handlers
export async function handleListLibrary(params: {
  roomId: number;
  parentCodigo?: number;
  recursive?: boolean;
  maxDepth?: number;
}): Promise<unknown> {
  return await sendCommand(
    "list_library",
    {
      roomId: params.roomId,
      parentCodigoInterno: params.parentCodigo,
      recursive: params.recursive,
      maxDepth: params.maxDepth,
    },
    30_000
  );
}

export async function handleGetLibraryItem(params: {
  roomId: number;
  codigoInterno: number;
}): Promise<unknown> {
  return await sendCommand(
    "get_library_item",
    {
      roomId: params.roomId,
      codigoInterno: params.codigoInterno,
    },
    30_000
  );
}

export async function handleGetSheetNDB(params: {
  roomId: number;
  codigoInterno: number;
  path?: string;
  rawXml?: boolean;
  maxDepth?: number;
}): Promise<unknown> {
  return await sendCommand(
    "get_sheet_ndb",
    {
      roomId: params.roomId,
      codigoInterno: params.codigoInterno,
      path: params.path,
      rawXml: params.rawXml,
      maxDepth: params.maxDepth,
    },
    30_000
  );
}

export async function handleEditSheetNDB(params: {
  roomId: number;
  codigoInterno: number;
  operations: NodeOperation[];
}): Promise<unknown> {
  if (params.roomId !== TEST_ROOM_ID) {
    throw new Error(
      `Safety guard: modifications to character sheets are restricted to test room 'tttttaaaaa' (id ${TEST_ROOM_ID}).`
    );
  }
  return await sendCommand(
    "edit_sheet_ndb",
    {
      roomId: params.roomId,
      codigoInterno: params.codigoInterno,
      operations: params.operations,
    },
    30_000
  );
}

export async function handleOpenDockNDB(params: {
  roomId: number;
  name: string;
  isUser?: boolean;
  create?: boolean;
  path?: string;
  rawXml?: boolean;
  maxDepth?: number;
}): Promise<unknown> {
  return await sendCommand(
    "open_dock_ndb",
    {
      roomId: params.roomId,
      name: params.name,
      isUser: params.isUser,
      create: params.create ?? true,
      path: params.path,
      rawXml: params.rawXml,
      maxDepth: params.maxDepth,
    },
    30_000
  );
}

export async function handleEditDockNDB(params: {
  roomId: number;
  name: string;
  operations: NodeOperation[];
  isUser?: boolean;
}): Promise<unknown> {
  if (params.roomId !== TEST_ROOM_ID) {
    throw new Error(
      `Safety guard: modifications to dock NDB are restricted to test room 'tttttaaaaa' (id ${TEST_ROOM_ID}).`
    );
  }
  return await sendCommand(
    "edit_dock_ndb",
    {
      roomId: params.roomId,
      name: params.name,
      operations: params.operations,
      isUser: params.isUser,
    },
    30_000
  );
}

export async function handleManageLibraryItem(params: {
  roomId: number;
  action: "create_dir" | "create_char" | "update" | "delete" | "move";
  parentCodigo?: number;
  codigoInterno?: number;
  name?: string;
  dataType?: string;
  changes?: Record<string, unknown>;
}): Promise<unknown> {
  if (params.roomId !== TEST_ROOM_ID) {
    throw new Error(
      `Safety guard: library management is restricted to test room 'tttttaaaaa' (id ${TEST_ROOM_ID}).`
    );
  }
  return await sendCommand(
    "manage_library_item",
    {
      roomId: params.roomId,
      action: params.action,
      parentCodigoInterno: params.parentCodigo,
      codigoInterno: params.codigoInterno,
      name: params.name,
      dataType: params.dataType,
      changes: params.changes,
    },
    30_000
  );
}

export async function handleManageRoom(params: {
  roomId: number;
  action: "get_details" | "set_moderada";
  moderada?: boolean;
}): Promise<unknown> {
  if (params.roomId !== TEST_ROOM_ID) {
    throw new Error(
      `Safety guard: room management is restricted to test room 'tttttaaaaa' (id ${TEST_ROOM_ID}).`
    );
  }
  return await sendCommand(
    "manage_room",
    {
      roomId: params.roomId,
      action: params.action,
      moderada: params.moderada,
    },
    30_000
  );
}

export async function handleGetSheetTemplate(params: { dataType: string }): Promise<unknown> {
  const template = extractSheetTemplate(params.dataType);
  if (!template) {
    throw new Error(`Template not found for dataType or RPK: '${params.dataType}'`);
  }
  return template;
}

export async function handleCreateCharacterSheet(params: {
  roomId: number;
  name: string;
  dataType: string;
  parentCodigo?: number;
  autoStructure?: boolean;
  initialData?: Record<string, unknown>;
}): Promise<unknown> {
  if (params.roomId !== TEST_ROOM_ID) {
    throw new Error(
      `Safety guard: character sheet creation is restricted to test room 'tttttaaaaa' (id ${TEST_ROOM_ID}).`
    );
  }

  // 1. Create character item in library
  const createResult: any = await handleManageLibraryItem({
    roomId: params.roomId,
    action: "create_char",
    name: params.name,
    dataType: params.dataType,
    parentCodigo: params.parentCodigo,
  });

  const charItem = createResult?.item;
  const codigoInterno = charItem?.codigoInterno;

  if (!codigoInterno) {
    return {
      success: false,
      error: "Character created but no codigoInterno returned",
      createResult,
    };
  }

  // 2. If autoStructure is requested (default true), populate NDB structure
  let templateInfo = null;
  let populatedData = null;
  if (params.autoStructure !== false) {
    const template = extractSheetTemplate(params.dataType);
    if (template) {
      templateInfo = {
        dataType: template.dataType,
        pluginName: template.pluginName,
        rpkFile: template.rpkFile,
        totalFields: template.totalDirectFields,
        totalLists: template.totalLists,
      };

      const dataToSet = JSON.parse(JSON.stringify(template.defaultData));
      if (params.initialData && typeof params.initialData === "object") {
        for (const [k, v] of Object.entries(params.initialData)) {
          dataToSet[k] = v;
        }
      }
      populatedData = dataToSet;

      // Apply to NDB
      await handleEditSheetNDB({
        roomId: params.roomId,
        codigoInterno,
        operations: [
          {
            action: "set",
            path: "",
            value: dataToSet,
          },
        ],
      });
    }
  }

  return {
    success: true,
    item: charItem,
    template: templateInfo,
    structured: !!templateInfo,
    initialData: populatedData,
  };
}

// Registro no MCP Server
export function registerNdbTools(server: McpServer): void {
  // 1. list_library
  server.tool(
    "list_library",
    "Lista itens ou a árvore hierárquica da Biblioteca de uma mesa (pastas, personagens, etc.).",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      parent_codigo: z
        .number()
        .optional()
        .describe("codigoInterno do item/pasta pai. Se omitido, lista a partir da raiz da biblioteca"),
      recursive: z
        .boolean()
        .optional()
        .describe("Se true, percorre recursivamente as subpastas montando uma árvore hierárquica. Padrão: false"),
      max_depth: z
        .number()
        .optional()
        .describe("Profundidade máxima de recursão ao listar a árvore. Padrão: 5"),
    },
    async ({ room_id, parent_codigo, recursive, max_depth }) => {
      const result = await handleListLibrary({
        roomId: room_id,
        parentCodigo: parent_codigo,
        recursive,
        maxDepth: max_depth,
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

  // 2. get_library_item
  server.tool(
    "get_library_item",
    "Obtém detalhes de um item específico da biblioteca (pasta, personagem, etc.) incluindo barras de recursos, status e filhos imediatos.",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      codigo_interno: z.number().describe("codigoInterno do item da biblioteca"),
    },
    async ({ room_id, codigo_interno }) => {
      const result = await handleGetLibraryItem({
        roomId: room_id,
        codigoInterno: codigo_interno,
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

  // 3. get_sheet_ndb
  server.tool(
    "get_sheet_ndb",
    "Abre o Node Database (NDB) de uma ficha de personagem no Firecast e retorna seus dados estruturados (atributos, nós filhos, listas) e/ou XML exportado.",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      codigo_interno: z.number().describe("codigoInterno do personagem na biblioteca"),
      path: z
        .string()
        .optional()
        .describe("Caminho opcional para filtrar apenas um sub-nodo da ficha (ex: 'atributos', 'magias', 'inventario')"),
      raw_xml: z
        .boolean()
        .optional()
        .describe("Se true, inclui também o XML bruto exportado do NDB via NDB.exportXML. Padrão: false"),
      max_depth: z
        .number()
        .optional()
        .describe("Profundidade máxima de serialização da árvore de nós. Padrão: 8"),
    },
    async ({ room_id, codigo_interno, path, raw_xml, max_depth }) => {
      const result = await handleGetSheetNDB({
        roomId: room_id,
        codigoInterno: codigo_interno,
        path,
        rawXml: raw_xml,
        maxDepth: max_depth,
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

  // 4. edit_sheet_ndb (Trava de segurança: apenas na mesa 239256)
  server.tool(
    "edit_sheet_ndb",
    "Modifica atributos ou sub-nós no Node Database (NDB) de uma ficha de personagem. Por segurança, habilitado exclusivamente para a mesa de testes 'tttttaaaaa' (id 239256).",
    {
      room_id: z.number().describe("codigoInterno da mesa (deve ser 239256)"),
      codigo_interno: z.number().describe("codigoInterno do personagem na biblioteca"),
      operations: z
        .array(NodeOperationSchema)
        .describe("Lista de operações a aplicar (action: 'set'|'delete', path: 'caminho.campo', value: ...)"),
    },
    async ({ room_id, codigo_interno, operations }) => {
      const result = await handleEditSheetNDB({
        roomId: room_id,
        codigoInterno: codigo_interno,
        operations,
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

  // 5. open_dock_ndb
  server.tool(
    "open_dock_ndb",
    "Abre um Node Database de janela acoplável (Dock NDB) ou NDB compartilhado da mesa / usuário no Firecast.",
    {
      room_id: z.number().describe("codigoInterno da mesa"),
      name: z.string().describe("Identificador do NodeDatabase da mesa (dataType/nome)"),
      is_user: z
        .boolean()
        .optional()
        .describe("Se true, abre o NDB exclusivo do usuário na mesa via asyncOpenUserRoomNDB. Padrão: false"),
      create: z
        .boolean()
        .optional()
        .describe("Se true, cria o NDB se ele ainda não existir. Padrão: true"),
      path: z
        .string()
        .optional()
        .describe("Caminho opcional para filtrar apenas um sub-nodo"),
      raw_xml: z
        .boolean()
        .optional()
        .describe("Se true, inclui também o XML bruto exportado via NDB.exportXML"),
      max_depth: z
        .number()
        .optional()
        .describe("Profundidade máxima de serialização. Padrão: 8"),
    },
    async ({ room_id, name, is_user, create, path, raw_xml, max_depth }) => {
      const result = await handleOpenDockNDB({
        roomId: room_id,
        name,
        isUser: is_user,
        create,
        path,
        rawXml: raw_xml,
        maxDepth: max_depth,
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

  // 6. edit_dock_ndb (Trava de segurança: apenas na mesa 239256)
  server.tool(
    "edit_dock_ndb",
    "Modifica atributos ou sub-nós em um Node Database de janela acoplável (Dock NDB) da mesa. Por segurança, habilitado exclusivamente para a mesa de testes 'tttttaaaaa' (id 239256).",
    {
      room_id: z.number().describe("codigoInterno da mesa (deve ser 239256)"),
      name: z.string().describe("Identificador do NodeDatabase da mesa (dataType/nome)"),
      operations: z
        .array(NodeOperationSchema)
        .describe("Lista de operações a aplicar (action: 'set'|'delete', path: 'caminho.campo', value: ...)"),
      is_user: z
        .boolean()
        .optional()
        .describe("Se true, edita o NDB exclusivo do usuário na mesa"),
    },
    async ({ room_id, name, operations, is_user }) => {
      const result = await handleEditDockNDB({
        roomId: room_id,
        name,
        operations,
        isUser: is_user,
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

  // 7. manage_library_item (Trava de segurança: apenas na mesa 239256)
  server.tool(
    "manage_library_item",
    "Cria pastas ou personagens, atualiza nomes/avatares, move ou remove itens da biblioteca. Por segurança, habilitado exclusivamente para a mesa de testes 'tttttaaaaa' (id 239256).",
    {
      room_id: z.number().describe("codigoInterno da mesa (deve ser 239256)"),
      action: z
        .enum(["create_dir", "create_char", "update", "delete", "move"])
        .describe("Ação na biblioteca: create_dir (criar pasta), create_char (criar personagem), update (atualizar), delete (remover), move (mover para outra pasta)"),
      parent_codigo: z
        .number()
        .optional()
        .describe("codigoInterno da pasta destino (para create_dir, create_char ou move)"),
      codigo_interno: z
        .number()
        .optional()
        .describe("codigoInterno do item alvo (para update, delete ou move)"),
      name: z
        .string()
        .optional()
        .describe("Nome do item a ser criado ou atualizado"),
      data_type: z
        .string()
        .optional()
        .describe("dataType da ficha ao criar personagem (ex: 'alteris.fichas', 'dnd5e', 'default')"),
      changes: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Objeto contendo alterações de propriedades para update"),
    },
    async ({ room_id, action, parent_codigo, codigo_interno, name, data_type, changes }) => {
      const result = await handleManageLibraryItem({
        roomId: room_id,
        action,
        parentCodigo: parent_codigo,
        codigoInterno: codigo_interno,
        name,
        dataType: data_type,
        changes,
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

  // 8. manage_room (Trava de segurança: apenas na mesa 239256)
  server.tool(
    "manage_room",
    "Lê detalhes ou altera configurações administrativas de uma mesa (ex: moderação). Por segurança, habilitado exclusivamente para a mesa de testes 'tttttaaaaa' (id 239256).",
    {
      room_id: z.number().describe("codigoInterno da mesa (deve ser 239256)"),
      action: z
        .enum(["get_details", "set_moderada"])
        .describe("Ação administrativa"),
      moderada: z
        .boolean()
        .optional()
        .describe("Se a mesa deve ser moderada (true) ou livre (false) quando action for 'set_moderada'"),
    },
    async ({ room_id, action, moderada }) => {
      const result = await handleManageRoom({
        roomId: room_id,
        action,
        moderada,
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

  // 9. get_sheet_template
  server.tool(
    "get_sheet_template",
    "Inspeciona e extrai o schema completo de um modelo de ficha (RPK/LFM) instalado no Firecast pelo dataType ou nome. Retorna todos os campos diretos, módulos, recordLists de sub-itens e a estrutura padrão em JSON.",
    {
      data_type: z
        .string()
        .describe("dataType do modelo de ficha (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.Nefertyne.FichaMultiaba', 'Ambesek.T20', 'br.com.cherryth.SoloLevelingRPG') ou nome do arquivo RPK"),
    },
    async ({ data_type }) => {
      const result = await handleGetSheetTemplate({
        dataType: data_type,
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

  // 10. create_character_sheet (Trava de segurança: apenas na mesa 239256)
  server.tool(
    "create_character_sheet",
    "Cria um novo personagem na biblioteca com um modelo de ficha específico e opcionalmente inicializa toda a estrutura de nós (NDB) com base no template extraído do RPK (com suporte a módulos, abas e recordLists). Por segurança, habilitado exclusivamente para a mesa de testes 'tttttaaaaa' (id 239256).",
    {
      room_id: z.number().describe("codigoInterno da mesa (deve ser 239256)"),
      name: z.string().describe("Nome do personagem a ser criado"),
      data_type: z
        .string()
        .describe("dataType do modelo de ficha (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.Nefertyne.FichaMultiaba', 'Ambesek.T20')"),
      parent_codigo: z
        .number()
        .optional()
        .describe("codigoInterno da pasta destino na biblioteca"),
      auto_structure: z
        .boolean()
        .optional()
        .describe("Se true (padrão), extrai o template do RPK e inicializa toda a estrutura do NDB no banco de dados."),
      initial_data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Objeto com valores iniciais para mesclar sobre a estrutura padrão da ficha (ex: { nome: 'Conan', atributos: { forca: 18 } })"),
    },
    async ({ room_id, name, data_type, parent_codigo, auto_structure, initial_data }) => {
      const result = await handleCreateCharacterSheet({
        roomId: room_id,
        name,
        dataType: data_type,
        parentCodigo: parent_codigo,
        autoStructure: auto_structure,
        initialData: initial_data,
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
