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
import { jsonResult, roomIdSchema, chatIdSchema, characterRefSchema } from "./common.js";

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
  // Exclusão exige id ou code exatos: findCharacter faz busca parcial por nome,
  // o que poderia apagar o personagem errado.
  const clean = idOrCode.trim();
  const target = findCharacter(clean, roomId);
  if (!target || (target.id !== clean && target.code !== clean)) {
    return { success: false, error: `Character with id or code '${idOrCode}' not found (delete requires the exact id or code).` };
  }
  const deleted = deleteCharacter(target.id, roomId);
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
  url: z.string().describe("URL http(s) da imagem."),
  label: z.string().optional().describe("Rótulo para escolher a imagem depois via image_label (ex: 'Combate', 'Furioso', 'Retrato')."),
  tag: z.string().optional().describe("Tag para escolher a imagem depois via image_tag (ex: 'battle', 'portrait', 'token')."),
});

const CHARACTER_MANAGER_NOTE =
  "O Character Manager é um banco local do MCP (SQLite) para NPCs/personagens com identidade visual e notas de interpretação; NÃO é a Biblioteca do Firecast e não aparece para os jogadores.";

/** Campos editáveis de um personagem do Character Manager (compartilhados por create e update). */
function characterFieldsShape() {
  return {
    room_id: z.number().int().optional().describe("Mesa à qual o personagem pertence (campo `id` de list_rooms). Omitido = personagem global, usável em qualquer mesa."),
    code: z.string().optional().describe("Código curto único usado como atalho para referenciar o personagem nas outras tools (ex: 'akn', 'taverneiro')."),
    title: z.string().optional().describe("Título/epíteto (ex: 'Guardiã do Abismo'). Informativo."),
    avatar_url: z.string().optional().describe("URL http(s) do avatar padrão exibido no chat."),
    images: z
      .array(z.union([z.string(), CharacterImageSchema]))
      .optional()
      .describe("Galeria de avatares alternativos: URLs simples ou { url, label, tag }. Escolha uma no envio com image_label/image_tag."),
    gender: z.enum(["masculine", "feminine", "neuter", "undefined"]).optional().describe("Gênero gramatical do personagem."),
    color: z.string().optional().describe("Cor do nome e do texto no chat: '#RRGGBB' ou índice de cor do Firecast '0'–'15' (ex: '4' = vermelho)."),
    bkg_color: z.string().optional().describe("Cor de fundo do texto ('#RRGGBB')."),
    bold: z.boolean().optional().describe("Texto das falas em negrito."),
    italic: z.boolean().optional().describe("Texto das falas em itálico."),
    underline: z.boolean().optional().describe("Texto das falas sublinhado."),
    strikeout: z.boolean().optional().describe("Texto das falas tachado."),
    talemark_options: z
      .record(z.string(), z.any())
      .optional()
      .describe("Avançado: sobrescreve as talemarkOptions geradas (ex: { parseSmileys: false, defaultTextStyle: {...} })."),
    voice: z.string().optional().describe("Voz de TTS associada (informativo)."),
    personality: z.string().optional().describe("Personalidade/diretrizes de interpretação, para o modelo consultar antes de falar como o personagem."),
    speech_style: z.string().optional().describe("Jeito de falar, bordões, sotaque."),
    appearance: z.string().optional().describe("Descrição física."),
    background: z.string().optional().describe("História/origem."),
    notes: z.string().optional().describe("Notas e segredos do mestre."),
    tags: z.array(z.string()).optional().describe("Tags para filtrar em list_characters (ex: ['npc', 'boss', 'mercador'])."),
    sheet_codigo: z.number().int().optional().describe("codigoInterno da ficha vinculada na Biblioteca do Firecast (ou use link_character_sheet)."),
    sheet_data_type: z.string().optional().describe("dataType do modelo da ficha vinculada (ex: 'br.com.rrpg.DnD5_S3')."),
    bars: z.record(z.string(), z.any()).optional().describe("Barras resumidas, informativo (ex: { bar0: { val: 20, max: 20, label: 'PV' } })."),
    stats: z.record(z.string(), z.any()).optional().describe("Atributos resumidos, informativo (ex: { forca: 18, ca: 16 })."),
  };
}

const appearanceOverrideShape = {
  image_label: z.string().optional().describe("Usa como avatar a imagem da galeria com este `label` (sem diferenciar maiúsculas)."),
  image_tag: z.string().optional().describe("Usa como avatar a imagem da galeria com esta `tag`. Ignorado se image_label for informado."),
  avatar_override: z.string().optional().describe("URL de avatar só para este envio; tem prioridade sobre image_label/image_tag."),
  raw_name: z.boolean().optional().describe("true = envia o nome sem o prefixo de cor '[§K...]'. Padrão: false."),
};

export function registerCharacterTools(server: McpServer): void {
  server.tool(
    "create_character",
    "Cadastra (ou sobrescreve) um personagem/NPC no Character Manager com identidade visual (avatar, galeria, cor e estilo do texto) e notas de interpretação, para depois falar/rolar como ele com impersonate_character e character_roll. " +
      CHARACTER_MANAGER_NOTE +
      " O `id` é gerado a partir de name/code; criar de novo com o mesmo name/code SUBSTITUI o registro. Retorna { character }.",
    {
      name: z.string().describe("Nome exibido no chat."),
      ...characterFieldsShape(),
    },
    async (args) => jsonResult(await handleCreateCharacter(args as any))
  );

  server.tool(
    "update_character",
    "Atualiza um personagem do Character Manager. Só os campos enviados mudam; campos de lista/objeto (images, tags, bars, stats, talemark_options) são SUBSTITUÍDOS por inteiro, não mesclados — leia com get_character antes se quiser acrescentar.",
    {
      character: characterRefSchema,
      name: z.string().optional().describe("Novo nome."),
      ...characterFieldsShape(),
      room_id: z.number().int().optional().describe("Mesa para desambiguar a busca do personagem (não move o personagem de mesa)."),
    },
    async ({ character, room_id, ...updates }) =>
      jsonResult(await handleUpdateCharacter(character, updates as any, room_id))
  );

  server.tool(
    "get_character",
    "Retorna todos os campos de um personagem do Character Manager (identidade, galeria, personalidade, notas, ficha vinculada). Leia antes de interpretar o personagem. Retorna { found, character }.",
    {
      character: characterRefSchema,
      room_id: z.number().int().optional().describe("Mesa para priorizar na busca quando há nomes/códigos repetidos."),
    },
    async ({ character, room_id }) => jsonResult(await handleGetCharacter(character, room_id))
  );

  server.tool(
    "list_characters",
    "Lista personagens do Character Manager, com filtros. Retorna { characters[], total }. " + CHARACTER_MANAGER_NOTE,
    {
      room_id: z.number().int().optional().describe("Só personagens desta mesa (+ globais, ver include_global). Omitido = todos."),
      include_global: z.boolean().optional().describe("Com room_id: true (padrão) inclui também os personagens globais (sem mesa)."),
      tag: z.string().optional().describe("Só personagens com esta tag (ex: 'npc')."),
      search: z.string().optional().describe("Busca parcial em nome, código, título e tags."),
      limit: z.number().int().optional().describe("Máximo de resultados. Padrão: 50."),
      offset: z.number().int().optional().describe("Pula N resultados (paginação). Padrão: 0."),
    },
    async ({ room_id, include_global, tag, search, limit, offset }) =>
      jsonResult(
        await handleListCharacters({
          roomId: room_id,
          includeGlobal: include_global ?? true,
          tag,
          search,
          limit,
          offset,
        })
      )
  );

  server.tool(
    "delete_character",
    "Remove um personagem do Character Manager (irreversível). Não apaga a ficha vinculada na Biblioteca do Firecast.",
    {
      character: z.string().describe("`id` ou `code` do personagem (nome não é aceito aqui, para evitar apagar o errado)."),
      room_id: z.number().int().optional().describe("Mesa para desambiguar códigos repetidos."),
    },
    async ({ character, room_id }) => jsonResult(await handleDeleteCharacter(character, room_id))
  );

  server.tool(
    "impersonate_character",
    "Publica uma fala/ação no chat da mesa COMO um personagem do Character Manager, aplicando automaticamente nome colorido, avatar e estilo de texto dele. Prefira esta tool a send_chat_message para personagens cadastrados.",
    {
      character: characterRefSchema,
      message: z.string().describe("Fala ou ação. Texto entre *asteriscos* sai como ação; aceita marcação Talemark."),
      room_id: z.number().int().optional().describe("Mesa de destino. Obrigatório se o personagem for global (sem room_id próprio); senão usa a mesa do personagem."),
      chat_id: chatIdSchema,
      type: z.enum(["standard", "narrator", "npc", "action", "laugh"]).optional().describe("Tipo de mensagem. Padrão: 'npc' (fala do personagem). 'action' = ação em terceira pessoa."),
      ...appearanceOverrideShape,
      as_whisper_to: z
        .string()
        .optional()
        .describe("Sussurro. Número (campo `id` de list_players) = mensagem visível só para esse jogador (seguro). Texto (login) = envia no chat 'pvt:<login>', que precisa já estar aberto; se não estiver, a mensagem cai no chat PÚBLICO. Prefira o id numérico."),
    },
    async (args) => jsonResult(await handleImpersonateCharacter(args))
  );

  server.tool(
    "character_roll",
    "Faz uma rolagem oficial de dados no chat em nome de um personagem do Character Manager (com nome e avatar dele). Retorna { total, asString, roll }.",
    {
      character: characterRefSchema,
      expression: z.string().describe("Fórmula no formato do Firecast: '1d20+5', '3d6+2', '4dF'."),
      room_id: z.number().int().optional().describe("Mesa de destino. Obrigatório se o personagem for global."),
      message: z.string().optional().describe("Motivo exibido junto à rolagem (ex: 'Ataque com Espada Vorpal')."),
      chat_id: chatIdSchema,
      ...appearanceOverrideShape,
    },
    async (args) => jsonResult(await handleCharacterRoll(args))
  );

  server.tool(
    "link_character_sheet",
    "Vincula um personagem do Character Manager a uma ficha da Biblioteca do Firecast (grava sheet_codigo no personagem). Informe sheet_codigo de uma ficha existente, ou auto_create=true para criar uma nova ficha com o nome do personagem (usa create_character_sheet; sujeito à proteção de mesa de teste/mestre).",
    {
      character: characterRefSchema,
      room_id: roomIdSchema,
      sheet_codigo: z.number().int().optional().describe("codigoInterno de uma ficha existente (list_library). Se omitido, usa o já vinculado ou cria (auto_create)."),
      sheet_data_type: z.string().optional().describe("Modelo da ficha a criar com auto_create. Padrão: 'br.com.rrpg.FICHA_BASICA_V3'."),
      auto_create: z.boolean().optional().describe("true = cria uma ficha nova se não houver sheet_codigo. Padrão: false."),
      parent_folder_codigo: z.number().int().optional().describe("codigoInterno da pasta onde criar a ficha. Omitido = raiz."),
    },
    async ({ character, room_id, sheet_codigo, sheet_data_type, auto_create, parent_folder_codigo }) =>
      jsonResult(
        await handleLinkCharacterSheet({
          character,
          roomId: room_id,
          sheetCodigo: sheet_codigo,
          sheetDataType: sheet_data_type,
          autoCreate: auto_create,
          parentFolderCodigo: parent_folder_codigo,
        })
      )
  );

  server.tool(
    "import_external_npcs",
    "Importa para o Character Manager os NPCs salvos pelos plugins NPC Saver (npcs.txt) e NPC Interpreter (pasta rooms/<mesa>/npcs) instalados neste computador. Lê arquivos locais; não precisa do Firecast aberto. Retorna { imported, skipped, details[] }.",
    {
      source: z.enum(["all", "npcsaver", "npc_interpreter"]).optional().describe("Qual plugin importar. Padrão: 'all'."),
      room_id: z.number().int().optional().describe("Só importa NPCs desta mesa. Omitido = todas."),
      overwrite: z.boolean().optional().describe("true = sobrescreve NPCs já importados; false (padrão) = pula os existentes."),
    },
    async (args) => jsonResult(await handleImportExternalNpcs(args))
  );
}
