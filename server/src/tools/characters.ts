import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import {
  upsertCharacter,
  getCharacterById,
  findCharacter,
  listCharacters,
  deleteCharacter,
  type CharacterRow,
  type CharacterInput,
  type CharacterImage,
} from "../db.js";
import {
  handleSendChatMessage,
  handleRollDice,
  type ImpersonationParam,
  type TalemarkOptionsParam,
  type VisibilityParam,
} from "./chat.js";
import { handleCreateCharacterSheet } from "./ndb.js";

const FIRECAST_COLORS: Record<string, string> = {
  "0": "#000000",
  "1": "#FFFFFF",
  "2": "#000080",
  "3": "#008000",
  "4": "#FF0000",
  "5": "#7F0000",
  "6": "#990099",
  "7": "#FF7F00",
  "8": "#FFFF00",
  "9": "#00FF00",
  "10": "#008080",
  "11": "#00FFFF",
  "12": "#0000FF",
  "13": "#FF00FF",
  "14": "#7F7F7F",
  "15": "#DCDCDC",
};

export function buildCharacterImpersonation(
  char: CharacterRow,
  options?: {
    imageLabel?: string;
    imageTag?: string;
    avatarOverride?: string;
    rawName?: boolean;
  }
): {
  impersonation: ImpersonationParam;
  talemarkOptions: TalemarkOptionsParam;
} {
  // 1. Resolve avatar
  let avatar = char.avatar_url ?? undefined;
  if (options?.avatarOverride) {
    avatar = options.avatarOverride;
  } else if (options?.imageLabel && char.images && char.images.length > 0) {
    const found = char.images.find(
      (img) => img.label?.toLowerCase() === options.imageLabel!.toLowerCase()
    );
    if (found?.url) avatar = found.url;
  } else if (options?.imageTag && char.images && char.images.length > 0) {
    const found = char.images.find(
      (img) => img.tag?.toLowerCase() === options.imageTag!.toLowerCase()
    );
    if (found?.url) avatar = found.url;
  }

  // 2. Format name with color tag if present
  let formattedName = char.name;
  if (!options?.rawName && char.color) {
    const col = char.color.startsWith("#")
      ? char.color
      : (FIRECAST_COLORS[char.color] || char.color);
    if (!formattedName.startsWith("[§K")) {
      formattedName = `[§K${col}]${formattedName}`;
    }
  }

  const impersonation: ImpersonationParam = {
    mode: "character",
    name: formattedName,
    avatar,
    gender: (char.gender === "undefined" ? undefined : char.gender) as any,
  };

  // 3. Build talemarkOptions
  const hexColor = char.color
    ? char.color.startsWith("#")
      ? char.color
      : (FIRECAST_COLORS[char.color] || char.color)
    : undefined;

  const style: any = {};
  if (hexColor) style.color = hexColor;
  if (char.bkg_color) style.bkgColor = char.bkg_color;
  if (char.bold === 1) style.bold = true;
  if (char.italic === 1) style.italic = true;
  if (char.underline === 1) style.underline = true;
  if (char.strikeout === 1) style.strikeout = true;

  const baseTalemark = char.talemark_options || {};
  const talemarkOptions: TalemarkOptionsParam = {
    defaultTextStyle: {
      ...style,
      ...(baseTalemark.defaultTextStyle || {}),
    },
    charActionTextStyle: {
      ...style,
      italic: true,
      ...(baseTalemark.charActionTextStyle || {}),
    },
    charEmDashSpeechTextStyle: {
      ...style,
      ...(baseTalemark.charEmDashSpeechTextStyle || {}),
    },
    charQuotedSpeechTextStyle: {
      ...style,
      ...(baseTalemark.charQuotedSpeechTextStyle || {}),
    },
    parseCharActions: baseTalemark.parseCharActions ?? true,
    parseCharEmDashSpeech: baseTalemark.parseCharEmDashSpeech ?? true,
    parseCharQuotedSpeech: baseTalemark.parseCharQuotedSpeech ?? true,
    parseSmileys: baseTalemark.parseSmileys ?? true,
    parseURL: baseTalemark.parseURL ?? true,
    ...baseTalemark,
  };

  return { impersonation, talemarkOptions };
}

// --- Handler Functions ---

export async function handleCreateCharacter(input: CharacterInput): Promise<{ success: boolean; character: CharacterRow }> {
  const character = upsertCharacter(input);
  return { success: true, character };
}

export async function handleUpdateCharacter(
  idOrCode: string,
  updates: Partial<CharacterInput>,
  roomId?: number
): Promise<{ success: boolean; character?: CharacterRow; error?: string }> {
  const existing = findCharacter(idOrCode, roomId);
  if (!existing) {
    return { success: false, error: `Character '${idOrCode}' not found.` };
  }

  const mergedInput: CharacterInput = {
    ...existing,
    ...updates,
    id: existing.id,
    name: updates.name ?? existing.name,
  };

  const character = upsertCharacter(mergedInput);
  return { success: true, character };
}

export async function handleGetCharacter(
  idOrCodeOrName: string,
  roomId?: number
): Promise<{ found: boolean; character?: CharacterRow; error?: string }> {
  const character = findCharacter(idOrCodeOrName, roomId);
  if (!character) {
    return { found: false, error: `Character '${idOrCodeOrName}' not found.` };
  }
  return { found: true, character };
}

export async function handleListCharacters(options?: {
  roomId?: number;
  includeGlobal?: boolean;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ characters: CharacterRow[]; total: number }> {
  return listCharacters(options);
}

export async function handleDeleteCharacter(
  idOrCode: string,
  roomId?: number
): Promise<{ success: boolean; error?: string }> {
  const deleted = deleteCharacter(idOrCode, roomId);
  if (!deleted) {
    return { success: false, error: `Character '${idOrCode}' not found.` };
  }
  return { success: true };
}

export async function handleImpersonateCharacter(args: {
  character: string;
  message: string;
  roomId?: number;
  chatId?: string;
  type?: "standard" | "narrator" | "npc" | "action" | "laugh";
  imageLabel?: string;
  imageTag?: string;
  avatarOverride?: string;
  rawName?: boolean;
  asWhisperTo?: string;
}): Promise<unknown> {
  const char = findCharacter(args.character, args.roomId);
  if (!char) {
    throw new Error(`Character '${args.character}' not found in Character Manager.`);
  }

  const targetRoomId = args.roomId ?? char.room_id;
  if (!targetRoomId) {
    throw new Error(`room_id is required to impersonate character '${char.name}' (character has no room_id assigned).`);
  }

  const { impersonation, talemarkOptions } = buildCharacterImpersonation(char, {
    imageLabel: args.imageLabel,
    imageTag: args.imageTag,
    avatarOverride: args.avatarOverride,
    rawName: args.rawName,
  });

  let targetChatId = args.chatId ?? "main";
  let visibility: VisibilityParam | undefined = undefined;

  if (args.asWhisperTo) {
    const maybeId = parseInt(args.asWhisperTo, 10);
    if (!isNaN(maybeId) && String(maybeId) === args.asWhisperTo.trim()) {
      visibility = {
        mode: "recipients",
        recipients: [maybeId],
      };
    } else {
      targetChatId = `pvt:${args.asWhisperTo.trim()}`;
    }
  }

  return await handleSendChatMessage({
    roomId: targetRoomId,
    message: args.message,
    chatId: targetChatId,
    type: args.type ?? "npc",
    impersonation,
    talemarkOptions,
    visibility,
  });
}

export async function handleCharacterRoll(args: {
  character: string;
  expression: string;
  roomId?: number;
  message?: string;
  chatId?: string;
  imageLabel?: string;
  imageTag?: string;
  avatarOverride?: string;
  rawName?: boolean;
}): Promise<unknown> {
  const char = findCharacter(args.character, args.roomId);
  if (!char) {
    throw new Error(`Character '${args.character}' not found in Character Manager.`);
  }

  const targetRoomId = args.roomId ?? char.room_id;
  if (!targetRoomId) {
    throw new Error(`room_id is required to roll as character '${char.name}' (character has no room_id assigned).`);
  }

  const { impersonation } = buildCharacterImpersonation(char, {
    imageLabel: args.imageLabel,
    imageTag: args.imageTag,
    avatarOverride: args.avatarOverride,
    rawName: args.rawName,
  });

  return await handleRollDice({
    roomId: targetRoomId,
    expression: args.expression,
    chatId: args.chatId ?? "main",
    message: args.message,
    impersonation,
  });
}

export async function handleLinkCharacterSheet(args: {
  character: string;
  roomId: number;
  sheetCodigo?: number;
  sheetDataType?: string;
  autoCreate?: boolean;
  parentFolderCodigo?: number;
}): Promise<{ success: boolean; character?: CharacterRow; sheetCodigo?: number; error?: string }> {
  const char = findCharacter(args.character, args.roomId);
  if (!char) {
    return { success: false, error: `Character '${args.character}' not found.` };
  }

  let finalSheetCodigo = args.sheetCodigo ?? char.sheet_codigo ?? undefined;
  let finalDataType = args.sheetDataType ?? char.sheet_data_type ?? undefined;

  if (!finalSheetCodigo && args.autoCreate) {
    if (!finalDataType) {
      finalDataType = "br.com.rrpg.FICHA_BASICA_V3";
    }

    const createRes: any = await handleCreateCharacterSheet({
      roomId: args.roomId,
      name: char.name,
      dataType: finalDataType,
      parentCodigo: args.parentFolderCodigo,
    });

    if (createRes?.success && createRes.item?.codigoInterno) {
      finalSheetCodigo = createRes.item.codigoInterno;
    } else {
      return {
        success: false,
        error: `Failed to auto-create character sheet: ${JSON.stringify(createRes)}`,
      };
    }
  }

  if (!finalSheetCodigo) {
    return { success: false, error: "No sheet_codigo provided and autoCreate was false." };
  }

  const updated = upsertCharacter({
    ...char,
    sheet_codigo: finalSheetCodigo,
    sheet_data_type: finalDataType ?? null,
  });

  return {
    success: true,
    character: updated,
    sheetCodigo: finalSheetCodigo,
  };
}

export async function handleImportExternalNpcs(args: {
  source?: "all" | "npcsaver" | "npc_interpreter";
  roomId?: number;
  overwrite?: boolean;
}): Promise<{ imported: number; skipped: number; details: string[] }> {
  const appData = process.env.APPDATA || "";
  const source = args.source ?? "all";
  let imported = 0;
  let skipped = 0;
  const details: string[] = [];

  // 1. NPC Saver
  if (source === "all" || source === "npcsaver") {
    const npcSaverPath = path.join(appData, "Firecast", "Plugins", "com.tkplayer.npcsaver_vhd", "npcs.txt");
    if (fs.existsSync(npcSaverPath)) {
      try {
        const content = fs.readFileSync(npcSaverPath, "utf-8");
        // Regex parse Lua rooms and npcs
        // Pattern: [roomId] = { ... }
        const roomBlocks = content.matchAll(/\[(\d+)\]\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g);
        for (const rMatch of roomBlocks) {
          const rId = parseInt(rMatch[1], 10);
          if (args.roomId && args.roomId !== rId) continue;

          const inner = rMatch[2];
          // Matches: [?code? or "???"] = { ... }
          const npcEntries = inner.matchAll(/(?:\["([^"]+)"\]|([a-zA-Z0-9_]+))\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g);
          for (const nMatch of npcEntries) {
            const code = nMatch[1] || nMatch[2];
            if (code === "logger") continue;

            const npcBlock = nMatch[3];
            const nameMatch = npcBlock.match(/name\s*=\s*"([^"]+)"/);
            const avatarMatch = npcBlock.match(/avatar\s*=\s*"([^"]+)"/);
            const genderMatch = npcBlock.match(/gender\s*=\s*"([^"]+)"/);
            const colorMatch = npcBlock.match(/color\s*=\s*"([^"]+)"/);

            if (nameMatch) {
              let rawName = nameMatch[1];
              let color = colorMatch ? colorMatch[1] : undefined;

              // Check if name has embedded [§K...]
              const kMatch = rawName.match(/^\[§K([^\]]+)\](.*)$/);
              if (kMatch) {
                if (!color) color = kMatch[1];
                rawName = kMatch[2];
              }

              const existing = findCharacter(code, rId);
              if (existing && !args.overwrite) {
                skipped++;
                continue;
              }

              upsertCharacter({
                id: `npcsaver_${rId}_${code}`,
                room_id: rId,
                code,
                name: rawName,
                avatar_url: avatarMatch ? avatarMatch[1] : undefined,
                color,
                gender: (genderMatch ? genderMatch[1] : "undefined") as any,
                tags: ["imported", "npcsaver"],
              });
              imported++;
              details.push(`[npcsaver] Imported '${rawName}' (${code}) for room ${rId}`);
            }
          }
        }
      } catch (err: any) {
        details.push(`[npcsaver] Error reading npcs.txt: ${err.message}`);
      }
    }
  }

  // 2. NPC Interpreter
  if (source === "all" || source === "npc_interpreter") {
    const interpreterRoomsPath = path.join(appData, "Firecast", "Plugins", "com.tkplayer.npc_interpreter_vhd", "rooms");
    if (fs.existsSync(interpreterRoomsPath)) {
      try {
        const roomDirs = fs.readdirSync(interpreterRoomsPath);
        for (const rDir of roomDirs) {
          const rId = parseInt(rDir, 10);
          if (isNaN(rId)) continue;
          if (args.roomId && args.roomId !== rId) continue;

          const npcsDir = path.join(interpreterRoomsPath, rDir, "npcs");
          if (!fs.existsSync(npcsDir)) continue;

          const npcFolders = fs.readdirSync(npcsDir);
          for (const nFolder of npcFolders) {
            const dataPath = path.join(npcsDir, nFolder, "data.txt");
            if (!fs.existsSync(dataPath)) continue;

            const dataContent = fs.readFileSync(dataPath, "utf-8");
            const parsedData: Record<string, any> = {};
            for (const line of dataContent.split(/\r?\n/)) {
              const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*,?$/);
              if (m) {
                const k = m[1];
                let v: any = m[2];
                if (v === "true") v = true;
                else if (v === "false") v = false;
                else if (!isNaN(Number(v))) v = Number(v);
                else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                  v = v.slice(1, -1);
                }
                parsedData[k] = v;
              }
            }

            if (parsedData.name) {
              const charId = parsedData.id || nFolder;
              const existing = findCharacter(charId, rId);
              if (existing && !args.overwrite) {
                skipped++;
                continue;
              }

              // Also check for optional context.txt
              let contextText: string | undefined = undefined;
              const contextPath = path.join(npcsDir, nFolder, "context.txt");
              if (fs.existsSync(contextPath)) {
                try {
                  contextText = fs.readFileSync(contextPath, "utf-8").trim();
                } catch {}
              }

              upsertCharacter({
                id: `interpreter_${rId}_${charId}`,
                room_id: rId,
                code: parsedData.prefix || undefined,
                name: parsedData.name,
                avatar_url: parsedData.avatar || undefined,
                color: parsedData.npcColor !== undefined ? String(parsedData.npcColor) : undefined,
                bold: parsedData.npcBold ? 1 : 0,
                voice: parsedData.voice || undefined,
                personality: parsedData.prompt || undefined,
                notes: contextText,
                tags: ["imported", "npc_interpreter"],
              });
              imported++;
              details.push(`[npc_interpreter] Imported '${parsedData.name}' (${charId}) for room ${rId}`);
            }
          }
        }
      } catch (err: any) {
        details.push(`[npc_interpreter] Error reading rooms: ${err.message}`);
      }
    }
  }

  return { imported, skipped, details };
}

// --- Register MCP Tools ---

const CharacterImageSchema = z.object({
  url: z.string().describe("URL da imagem"),
  label: z.string().optional().describe("Rótulo amigável (ex: 'Combate', 'Furioso', 'Token', 'Retrato')"),
  tag: z.string().optional().describe("Tag de busca (ex: 'battle', 'portrait', 'token')"),
});

export function registerCharacterTools(server: McpServer): void {
  // 1. create_character
  server.tool(
    "create_character",
    "Cria um novo personagem ou NPC completo no banco de dados do Character Manager, com avatar, galeria de imagens, estilização de interpretação (Talemark/cores), prompt de personalidade, notas de mestre e ficha vinculada.",
    {
      name: z.string().describe("Nome do personagem"),
      room_id: z.number().optional().describe("ID da mesa à qual o personagem pertence (omitir para personagem global/multiverso)"),
      code: z.string().optional().describe("Código curto / prefixo para atalhos rápidos (ex: 'neferet', 'akn', 'ton')"),
      title: z.string().optional().describe("Título / epíteto / arquétipo (ex: 'Guardiã do Abismo')"),
      avatar_url: z.string().optional().describe("URL da imagem de perfil principal"),
      images: z.array(z.union([z.string(), CharacterImageSchema])).optional().describe("Galeria de imagens adicionais / retratos alternativos / tokens"),
      gender: z.enum(["masculine", "feminine", "neuter", "undefined"]).optional().describe("Gênero do personagem"),
      color: z.string().optional().describe("Cor principal do texto e do nome (§K#RRGGBB ou índice do Firecast)"),
      bkg_color: z.string().optional().describe("Cor de fundo do texto (opcional)"),
      bold: z.boolean().optional().describe("Texto padrão em negrito"),
      italic: z.boolean().optional().describe("Texto padrão em itálico"),
      underline: z.boolean().optional().describe("Texto padrão sublinhado"),
      strikeout: z.boolean().optional().describe("Texto padrão tachado"),
      talemark_options: z.record(z.string(), z.any()).optional().describe("Opções detalhadas de Talemark customizadas"),
      voice: z.string().optional().describe("Voz de TTS associada ao personagem"),
      personality: z.string().optional().describe("Prompt / personalidade / diretrizes de interpretação e comportamento"),
      speech_style: z.string().optional().describe("Modo de falar, maneirismos, bordões, sotaque"),
      appearance: z.string().optional().describe("Descrição física e visual"),
      background: z.string().optional().describe("História e origens do personagem"),
      notes: z.string().optional().describe("Anotações gerais e segredos do mestre"),
      tags: z.array(z.string()).optional().describe("Tags de classificação (ex: ['npc', 'boss', 'aliado', 'mercador'])"),
      sheet_codigo: z.number().optional().describe("Código interno da ficha de personagem na biblioteca do Firecast"),
      sheet_data_type: z.string().optional().describe("DataType do modelo da ficha (ex: 'br.com.rrpg.DnD5_S3')"),
      bars: z.record(z.string(), z.any()).optional().describe("Barras rápidas (ex: { bar0: { val: 20, max: 20, label: 'PV' } })"),
      stats: z.record(z.string(), z.any()).optional().describe("Estatísticas e atributos resumidos (ex: { forca: 18, ca: 16 })"),
    },
    async (args) => {
      const result = await handleCreateCharacter(args as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 2. update_character
  server.tool(
    "update_character",
    "Atualiza campos de um personagem existente no Character Manager.",
    {
      character: z.string().describe("ID, código ou nome do personagem a ser atualizado"),
      room_id: z.number().optional().describe("ID da mesa para desambiguação"),
      name: z.string().optional().describe("Novo nome do personagem"),
      code: z.string().optional().describe("Novo código curto"),
      title: z.string().optional().describe("Novo título"),
      avatar_url: z.string().optional().describe("Nova URL de avatar"),
      images: z.array(z.union([z.string(), CharacterImageSchema])).optional().describe("Nova galeria de imagens"),
      gender: z.enum(["masculine", "feminine", "neuter", "undefined"]).optional().describe("Gênero"),
      color: z.string().optional().describe("Cor do texto e nome"),
      bkg_color: z.string().optional().describe("Cor de fundo"),
      bold: z.boolean().optional().describe("Negrito"),
      italic: z.boolean().optional().describe("Itálico"),
      underline: z.boolean().optional().describe("Sublinhado"),
      strikeout: z.boolean().optional().describe("Tachado"),
      talemark_options: z.record(z.string(), z.any()).optional().describe("Talemark options"),
      voice: z.string().optional().describe("Voz de TTS"),
      personality: z.string().optional().describe("Personalidade / prompt"),
      speech_style: z.string().optional().describe("Estilo de fala"),
      appearance: z.string().optional().describe("Descrição física"),
      background: z.string().optional().describe("História"),
      notes: z.string().optional().describe("Anotações"),
      tags: z.array(z.string()).optional().describe("Tags"),
      sheet_codigo: z.number().optional().describe("Código interno da ficha na biblioteca"),
      sheet_data_type: z.string().optional().describe("DataType da ficha"),
      bars: z.record(z.string(), z.any()).optional().describe("Barras rápidas"),
      stats: z.record(z.string(), z.any()).optional().describe("Atributos resumidos"),
    },
    async ({ character, room_id, ...updates }) => {
      const result = await handleUpdateCharacter(character, updates as any, room_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 3. get_character
  server.tool(
    "get_character",
    "Recupera os detalhes completos de um personagem no Character Manager por ID, código curto ou nome.",
    {
      character: z.string().describe("ID, código ou nome do personagem"),
      room_id: z.number().optional().describe("ID da mesa para priorização"),
    },
    async ({ character, room_id }) => {
      const result = await handleGetCharacter(character, room_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 4. list_characters
  server.tool(
    "list_characters",
    "Lista personagens cadastrados no Character Manager com filtros por mesa, tags e busca textual.",
    {
      room_id: z.number().optional().describe("Filtrar por ID da mesa (se omitido, lista todos)"),
      include_global: z.boolean().optional().describe("Se true (padrão), inclui personagens globais (sem mesa) junto com os da mesa"),
      tag: z.string().optional().describe("Filtrar por tag específica (ex: 'npc', 'boss')"),
      search: z.string().optional().describe("Termo de busca no nome, código, título ou tags"),
      limit: z.number().optional().describe("Limite de resultados (padrão: 50)"),
      offset: z.number().optional().describe("Deslocamento para paginação (padrão: 0)"),
    },
    async ({ room_id, include_global, tag, search, limit, offset }) => {
      const result = await handleListCharacters({
        roomId: room_id,
        includeGlobal: include_global ?? true,
        tag,
        search,
        limit,
        offset,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 5. delete_character
  server.tool(
    "delete_character",
    "Remove um personagem do Character Manager por ID ou código.",
    {
      character: z.string().describe("ID ou código do personagem"),
      room_id: z.number().optional().describe("ID da mesa para desambiguação"),
    },
    async ({ character, room_id }) => {
      const result = await handleDeleteCharacter(character, room_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 6. impersonate_character
  server.tool(
    "impersonate_character",
    "Fala ou atua no chat oficial da mesa personificando um personagem do Character Manager, aplicando automaticamente seu avatar, nome colorido e estilo de texto Talemark.",
    {
      character: z.string().describe("ID, código ou nome do personagem cadastrado"),
      message: z.string().describe("Mensagem ou ação a ser dita pelo personagem"),
      room_id: z.number().optional().describe("ID da mesa (obrigatório se o personagem for global)"),
      chat_id: z.string().optional().describe("Identificador do chat ('main', 'active', etc.). Padrão: 'main'"),
      type: z.enum(["standard", "narrator", "npc", "action", "laugh"]).optional().describe("Tipo de mensagem (padrão: 'npc')"),
      image_label: z.string().optional().describe("Rótulo da imagem a usar da galeria do personagem (ex: 'Combate', 'Furioso')"),
      image_tag: z.string().optional().describe("Tag da imagem a usar da galeria (ex: 'battle', 'token')"),
      avatar_override: z.string().optional().describe("URL explícita de avatar para sobrescrever neste envio"),
      raw_name: z.boolean().optional().describe("Se true, envia o nome sem a tag de cor [§K...]"),
      as_whisper_to: z.string().optional().describe("Login de um jogador para enviar como sussurro secreto"),
    },
    async (args) => {
      const result = await handleImpersonateCharacter(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 7. character_roll
  server.tool(
    "character_roll",
    "Rola dados no chat oficial da mesa em nome de um personagem do Character Manager, exibindo seu avatar e identidade.",
    {
      character: z.string().describe("ID, código ou nome do personagem"),
      expression: z.string().describe("Expressão de rolagem (ex: '1d20+5', '3d6+2')"),
      room_id: z.number().optional().describe("ID da mesa"),
      message: z.string().optional().describe("Descrição ou motivo da rolagem (ex: 'Ataque com Espada Vorpal')"),
      chat_id: z.string().optional().describe("Identificador do chat (padrão: 'main')"),
      image_label: z.string().optional().describe("Rótulo da imagem da galeria a usar"),
      image_tag: z.string().optional().describe("Tag da imagem da galeria a usar"),
      avatar_override: z.string().optional().describe("URL explícita de avatar"),
      raw_name: z.boolean().optional().describe("Se true, envia o nome sem formatação de cor"),
    },
    async (args) => {
      const result = await handleCharacterRoll(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 8. link_character_sheet
  server.tool(
    "link_character_sheet",
    "Vincula um personagem do Character Manager a uma ficha na biblioteca do Firecast, ou cria automaticamente uma nova ficha para ele.",
    {
      character: z.string().describe("ID, código ou nome do personagem"),
      room_id: z.number().describe("ID da mesa"),
      sheet_codigo: z.number().optional().describe("Código interno da ficha existente na biblioteca (se já existir)"),
      sheet_data_type: z.string().optional().describe("Modelo da ficha (ex: 'br.com.rrpg.FICHA_BASICA_V3', 'Ambesek.Nefertyne.FichaMultiaba')"),
      auto_create: z.boolean().optional().describe("Se true e sheet_codigo não for fornecido, cria uma nova ficha na biblioteca automaticamente"),
      parent_folder_codigo: z.number().optional().describe("Pasta da biblioteca onde criar a nova ficha"),
    },
    async ({ character, room_id, sheet_codigo, sheet_data_type, auto_create, parent_folder_codigo }) => {
      const result = await handleLinkCharacterSheet({
        character,
        roomId: room_id,
        sheetCodigo: sheet_codigo,
        sheetDataType: sheet_data_type,
        autoCreate: auto_create,
        parentFolderCodigo: parent_folder_codigo,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 9. import_external_npcs
  server.tool(
    "import_external_npcs",
    "Importa NPCs existentes do NPC Saver (npcs.txt) e do NPC Interpreter (/rooms/.../npcs) diretamente para o banco de dados do Character Manager.",
    {
      source: z.enum(["all", "npcsaver", "npc_interpreter"]).optional().describe("Fonte de importação (padrão: 'all')"),
      room_id: z.number().optional().describe("Filtrar importação apenas para uma mesa específica"),
      overwrite: z.boolean().optional().describe("Se true, sobrescreve personagens que já existam no banco com o mesmo código/id"),
    },
    async (args) => {
      const result = await handleImportExternalNpcs(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
