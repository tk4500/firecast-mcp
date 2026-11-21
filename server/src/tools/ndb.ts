// tools/ndb.ts
// MCP tools para o domínio de Biblioteca e Node Database (NDB) no Firecast SDK3

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendCommand } from "../bridge.js";
import { extractSheetTemplate } from "../template.js";
import {
  jsonResult,
  roomIdSchema,
  codigoInternoSchema,
  NodeOperationSchema,
  GUARD_NOTE,
  type NodeOperation,
} from "./common.js";

export { NodeOperationSchema, type NodeOperation } from "./common.js";

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
  operations?: NodeOperation[];
  xml?: string;
}): Promise<unknown> {
  return await sendCommand(
    "edit_sheet_ndb",
    {
      roomId: params.roomId,
      codigoInterno: params.codigoInterno,
      operations: params.operations,
      xml: params.xml,
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
  avatar?: string;
  changes?: Record<string, unknown>;
}): Promise<unknown> {
  return await sendCommand(
    "manage_library_item",
    {
      roomId: params.roomId,
      action: params.action,
      parentCodigoInterno: params.parentCodigo,
      codigoInterno: params.codigoInterno,
      name: params.name,
      dataType: params.dataType,
      avatar: params.avatar,
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
  xml?: string;
}): Promise<unknown> {
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

  // Se XML foi fornecido, importa diretamente
  if (params.xml) {
    await handleEditSheetNDB({
      roomId: params.roomId,
      codigoInterno,
      xml: params.xml,
    });
    return {
      success: true,
      item: charItem,
      importedXml: true,
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
  server.tool(
    "list_library",
    "Navega pela Biblioteca da mesa (pastas e personagens/fichas). Use para descobrir o `codigoInterno` de fichas e pastas. Sem recursive: retorna { item, children[] } só com os filhos imediatos. Com recursive=true: retorna { tree } aninhado. Itens com tipo='personagem' trazem dataType, avatar, barras (bar0Val..bar3Max) e linhas editáveis (edtLine0/1).",
    {
      room_id: roomIdSchema,
      parent_codigo: z.number().int().optional().describe("codigoInterno da pasta a listar. Omitido = raiz da biblioteca."),
      recursive: z.boolean().optional().describe("true = desce pelas subpastas e devolve a árvore inteira. Padrão: false."),
      max_depth: z.number().int().optional().describe("Profundidade máxima quando recursive=true. Padrão: 5."),
    },
    async ({ room_id, parent_codigo, recursive, max_depth }) =>
      jsonResult(
        await handleListLibrary({
          roomId: room_id,
          parentCodigo: parent_codigo,
          recursive,
          maxDepth: max_depth,
        })
      )
  );

  server.tool(
    "get_library_item",
    "Detalhes de UM item da Biblioteca (pasta ou personagem): nome, tipo, dono, visibilidade, dataType, avatar, barras e filhos imediatos. Não lê o conteúdo da ficha — para isso use get_sheet_ndb ou get_character_sheet.",
    {
      room_id: roomIdSchema,
      codigo_interno: z.number().int().describe("codigoInterno do item (pasta ou personagem), obtido em list_library."),
    },
    async ({ room_id, codigo_interno }) =>
      jsonResult(await handleGetLibraryItem({ roomId: room_id, codigoInterno: codigo_interno }))
  );

  server.tool(
    "get_sheet_ndb",
    "Lê o conteúdo completo da ficha de um personagem (Node Database) direto do Firecast, sempre ao vivo. Retorna { characterName, dataType, data } onde `data` é a árvore de campos (nós repetidos de recordList viram arrays). Use `path` para ler só um trecho. Os nomes dos campos dependem do modelo de ficha (veja get_sheet_template).",
    {
      room_id: roomIdSchema,
      codigo_interno: codigoInternoSchema,
      path: z.string().optional().describe("Sub-nó a retornar, com ponto (ex: 'atributos', 'atributos.forca'). Omitido = ficha inteira. Erro se o caminho não existir."),
      raw_xml: z.boolean().optional().describe("true = inclui também `xml` com a exportação XML do nó (útil para backup ou para copiar a ficha via edit_sheet_ndb xml). Padrão: false."),
      max_depth: z.number().int().optional().describe("Profundidade máxima da árvore serializada; nós mais fundos aparecem como { _truncated: true }. Padrão: 8."),
    },
    async ({ room_id, codigo_interno, path, raw_xml, max_depth }) =>
      jsonResult(
        await handleGetSheetNDB({
          roomId: room_id,
          codigoInterno: codigo_interno,
          path,
          rawXml: raw_xml,
          maxDepth: max_depth,
        })
      )
  );

  server.tool(
    "edit_sheet_ndb",
    "Escreve na ficha de um personagem (Node Database) via lista de operações set/delete, e/ou importa um XML completo. Se ambos forem enviados, o XML é importado primeiro e as operações aplicadas depois. As alterações sincronizam para todos na mesa. Retorna { appliedOperations, updatedData }. Alternativa mais simples para só trocar valores: update_character_sheet. " + GUARD_NOTE,
    {
      room_id: roomIdSchema,
      codigo_interno: codigoInternoSchema,
      operations: z
        .array(NodeOperationSchema)
        .optional()
        .describe("Operações aplicadas em ordem, numa única transação. Ex: [{action:'set', path:'pv', value:30}, {action:'delete', path:'condicoes.envenenado'}]."),
      xml: z.string().optional().describe("XML de NDB (formato de exportação do Firecast, ex: o `xml` de get_sheet_ndb com raw_xml=true) a importar na raiz da ficha."),
    },
    async ({ room_id, codigo_interno, operations, xml }) =>
      jsonResult(
        await handleEditSheetNDB({
          roomId: room_id,
          codigoInterno: codigo_interno,
          operations,
          xml,
        })
      )
  );

  server.tool(
    "open_dock_ndb",
    "Lê um Node Database compartilhado da mesa (dados de janelas acopláveis/plugins, como trackers de iniciativa) ou o NDB privado do seu usuário na mesa. Retorna { name, isUser, data }. Sem efeito colateral, exceto criar o NDB vazio quando create=true e ele não existir.",
    {
      room_id: roomIdSchema,
      name: z.string().describe("Nome/identificador do NDB da mesa (normalmente o dataType do dock; ver list_data_types com form_type='tablesDock')."),
      is_user: z.boolean().optional().describe("true = NDB exclusivo do seu usuário nesta mesa; false = NDB compartilhado da mesa. Padrão: false."),
      create: z.boolean().optional().describe("true = cria o NDB vazio se não existir; false = erro se não existir. Padrão: true."),
      path: z.string().optional().describe("Sub-nó a retornar, com ponto. Omitido = tudo."),
      raw_xml: z.boolean().optional().describe("true = inclui também a exportação XML. Padrão: false."),
      max_depth: z.number().int().optional().describe("Profundidade máxima de serialização. Padrão: 8."),
    },
    async ({ room_id, name, is_user, create, path, raw_xml, max_depth }) =>
      jsonResult(
        await handleOpenDockNDB({
          roomId: room_id,
          name,
          isUser: is_user,
          create,
          path,
          rawXml: raw_xml,
          maxDepth: max_depth,
        })
      )
  );

  server.tool(
    "edit_dock_ndb",
    "Escreve num Node Database compartilhado da mesa (dock) ou no NDB do seu usuário, com operações set/delete. Cria o NDB se não existir. Mesma semântica de operações de edit_sheet_ndb. " + GUARD_NOTE,
    {
      room_id: roomIdSchema,
      name: z.string().describe("Nome/identificador do NDB da mesa (o mesmo usado em open_dock_ndb)."),
      operations: z.array(NodeOperationSchema).describe("Operações aplicadas em ordem, numa única transação."),
      is_user: z.boolean().optional().describe("true = edita o NDB exclusivo do seu usuário; false = NDB compartilhado da mesa. Padrão: false."),
    },
    async ({ room_id, name, operations, is_user }) =>
      jsonResult(
        await handleEditDockNDB({
          roomId: room_id,
          name,
          operations,
          isUser: is_user,
        })
      )
  );

  server.tool(
    "manage_library_item",
    "Altera a Biblioteca da mesa. Parâmetros necessários por ação: create_dir → name (+parent_codigo); create_char → name, data_type (+parent_codigo, avatar) — cria a ficha VAZIA (para já preencher a estrutura use create_character_sheet); update → codigo_interno + name e/ou changes; delete → codigo_interno (irreversível); move → codigo_interno + parent_codigo. " + GUARD_NOTE,
    {
      room_id: roomIdSchema,
      action: z
        .enum(["create_dir", "create_char", "update", "delete", "move"])
        .describe("create_dir = criar pasta; create_char = criar personagem; update = alterar atributos do item; delete = apagar item; move = mover para outra pasta."),
      parent_codigo: z.number().int().optional().describe("codigoInterno da pasta pai/destino (create_dir, create_char, move). Omitido em create_* = raiz."),
      codigo_interno: z.number().int().optional().describe("codigoInterno do item alvo (update, delete, move)."),
      name: z.string().optional().describe("Nome do item (obrigatório em create_dir/create_char; em update renomeia)."),
      data_type: z.string().optional().describe("Modelo de ficha para create_char (ex: 'br.com.rrpg.DnD5_S3'). Descubra com list_data_types form_type='sheetTemplate'."),
      avatar: z.string().optional().describe("URL do avatar para create_char."),
      changes: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Para update. Chaves aceitas pelo Firecast: name, visible (bool), editionBlocked (bool), ownerLogin (login do dono; '' = NPC), avatar (URL), bar0Val..bar3Val e bar0Max..bar3Max (números), edtLine0, edtLine1 (strings). Chaves omitidas não mudam."),
    },
    async ({ room_id, action, parent_codigo, codigo_interno, name, data_type, avatar, changes }) =>
      jsonResult(
        await handleManageLibraryItem({
          roomId: room_id,
          action,
          parentCodigo: parent_codigo,
          codigoInterno: codigo_interno,
          name,
          dataType: data_type,
          avatar,
          changes,
        })
      )
  );

  server.tool(
    "manage_room",
    "Administração da mesa. action='get_details' lê { nome, sistema, isModerada, haVagas, podeTablesDock }; action='set_moderada' liga/desliga a moderação da mesa. " + GUARD_NOTE,
    {
      room_id: roomIdSchema,
      action: z.enum(["get_details", "set_moderada"]).describe("'get_details' = leitura; 'set_moderada' = altera a moderação (exige `moderada`)."),
      moderada: z.boolean().optional().describe("Com action='set_moderada': true = mesa moderada, false = livre."),
    },
    async ({ room_id, action, moderada }) =>
      jsonResult(await handleManageRoom({ roomId: room_id, action, moderada }))
  );

  server.tool(
    "get_sheet_template",
    "Descreve a estrutura de um modelo de ficha instalado (lido dos arquivos .rpk locais; funciona mesmo com o Firecast fechado): campos diretos, módulos/abas, recordLists (listas de itens) e `defaultData` (JSON com a estrutura padrão). Use antes de escrever numa ficha para saber os nomes exatos dos campos.",
    {
      data_type: z
        .string()
        .describe("dataType do modelo (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.T20') ou nome do arquivo .rpk. Descubra os disponíveis com list_data_types ou pelo `dataType` de um personagem em list_library."),
    },
    async ({ data_type }) => jsonResult(await handleGetSheetTemplate({ dataType: data_type }))
  );

  server.tool(
    "create_character_sheet",
    "Cria um personagem na Biblioteca da mesa já com a ficha preenchida. Fluxo: cria o item (como manage_library_item create_char) e então (a) importa `xml`, se informado; senão (b) com auto_structure (padrão) grava a estrutura padrão do modelo (defaultData de get_sheet_template) com `initial_data` por cima. Retorna { item{codigoInterno,...}, template, initialData }. " + GUARD_NOTE,
    {
      room_id: roomIdSchema,
      name: z.string().describe("Nome do personagem na Biblioteca."),
      data_type: z.string().describe("Modelo de ficha (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.T20'). Descubra com list_data_types form_type='sheetTemplate'."),
      parent_codigo: z.number().int().optional().describe("codigoInterno da pasta de destino. Omitido = raiz da biblioteca."),
      auto_structure: z.boolean().optional().describe("true (padrão) = grava a estrutura padrão do modelo na ficha; false = ficha vazia (initial_data é ignorado)."),
      initial_data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Valores que sobrescrevem as chaves de PRIMEIRO nível de defaultData (um objeto aninhado substitui o objeto padrão inteiro, não é mesclado). Ex: { nome: 'Conan', nivel: 3 }."),
      xml: z.string().optional().describe("XML completo de NDB a importar. Se informado, auto_structure e initial_data são ignorados."),
    },
    async ({ room_id, name, data_type, parent_codigo, auto_structure, initial_data, xml }) =>
      jsonResult(
        await handleCreateCharacterSheet({
          roomId: room_id,
          name,
          dataType: data_type,
          parentCodigo: parent_codigo,
          autoStructure: auto_structure,
          initialData: initial_data,
          xml,
        })
      )
  );
}
