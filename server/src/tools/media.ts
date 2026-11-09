// media.ts
// Ferramentas MCP para upload, hospedagem e envio de mídia (Google Drive & FireDrive)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import {
  detectGDrive,
  resolveGDriveFile,
  saveToGDrive,
  listGDriveFiles,
  type GDriveFileResult,
} from "../storage/gdrive.js";
import { readConfig, updateConfig, type AppConfig } from "../config.js";
import { sendCommand } from "../bridge.js";
import { handleSendChatMessage } from "./chat.js";
import { handleImpersonateCharacter } from "./characters.js";

export interface MediaUploadResult {
  success: boolean;
  provider: "gdrive" | "firedrive";
  url: string;
  name: string;
  size: number;
  mime_type: string;
  file_id?: string;
  download_url?: string;
  view_url?: string;
  talemark_image: string;
  talemark_link: string;
  local_path?: string;
}

export interface UploadMediaArgs {
  filePath?: string;
  contentBase64?: string;
  filename?: string;
  provider?: "auto" | "gdrive" | "firedrive";
  subfolder?: string;
  timeoutSeconds?: number;
}

export interface GetMediaUrlArgs {
  pathOrFilename: string;
}

export interface ListMediaArgs {
  subfolder?: string;
  limit?: number;
}

export interface SendMediaToChatArgs {
  roomId: number;
  chatId?: string;
  filePath?: string;
  contentBase64?: string;
  filename?: string;
  mediaUrl?: string;
  caption?: string;
  asCharacterId?: string;
  npcName?: string;
  provider?: "auto" | "gdrive" | "firedrive";
  subfolder?: string;
}

export interface ConfigureStorageArgs {
  provider?: "auto" | "gdrive" | "firedrive";
  gdriveAssetsPath?: string;
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    case "mp3": return "audio/mpeg";
    case "ogg": return "audio/ogg";
    case "wav": return "audio/wav";
    case "mp4": return "video/mp4";
    case "zip": return "application/zip";
    case "json": return "application/json";
    case "txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

/**
 * Faz o upload de qualquer arquivo local ou buffer base64 para o storage configurado
 * (Google Drive local ou FireDrive do Firecast) e retorna a URL permanente e formatações Talemark.
 */
export async function handleUploadMedia(args: UploadMediaArgs): Promise<MediaUploadResult> {
  const config = readConfig();
  let effectiveProvider: "gdrive" | "firedrive" = "gdrive";

  const requested = args.provider || config.storage_provider || "auto";

  if (requested === "auto") {
    const gdrive = detectGDrive();
    effectiveProvider = gdrive.available ? "gdrive" : "firedrive";
  } else {
    effectiveProvider = requested;
  }

  // --- 1. Rota Google Drive ---
  if (effectiveProvider === "gdrive") {
    const gdrive = detectGDrive();
    if (!gdrive.available) {
      if (requested === "auto") {
        // Fallback automático para FireDrive se GDrive não estiver montado
        effectiveProvider = "firedrive";
      } else {
        throw new Error(`Google Drive não disponível: ${gdrive.error}`);
      }
    } else {
      const assetsDir = config.gdrive_assets_path || gdrive.defaultAssetsPath;
      const gRes = await saveToGDrive({
        filePath: args.filePath,
        contentBase64: args.contentBase64,
        filename: args.filename,
        subfolder: args.subfolder,
        assetsDir,
        timeoutSeconds: args.timeoutSeconds,
      });

      return {
        success: true,
        provider: "gdrive",
        url: gRes.embed_url,
        name: gRes.name,
        size: gRes.size,
        mime_type: gRes.mime_type,
        file_id: gRes.id,
        download_url: gRes.download_url,
        view_url: gRes.view_url,
        talemark_image: gRes.talemark_image,
        talemark_link: gRes.talemark_link,
        local_path: gRes.local_path,
      };
    }
  }

  // --- 2. Rota FireDrive (Upload via bridge do Firecast) ---
  let filename = args.filename;
  if (!filename && args.filePath) {
    filename = path.basename(args.filePath);
  }
  if (!filename) {
    filename = `upload_${Date.now()}.png`;
  }

  let contentBase64 = args.contentBase64;
  if (!contentBase64 && args.filePath) {
    if (!fs.existsSync(args.filePath)) {
      throw new Error(`Arquivo local não encontrado: ${args.filePath}`);
    }
    const buffer = fs.readFileSync(args.filePath);
    contentBase64 = buffer.toString("base64");
  }

  if (!contentBase64) {
    throw new Error("Nenhum conteúdo fornecido para upload (informe filePath ou contentBase64).");
  }

  const mimeType = getMimeType(filename);
  const bridgeRes = (await sendCommand(
    "quick_upload",
    {
      filename,
      content_base64: contentBase64,
      mime_type: mimeType,
    },
    60_000
  )) as {
    url: string;
    name: string;
    size: number;
    mime_type: string;
    talemark_image?: string;
    talemark_link?: string;
  };

  const isImage = mimeType.startsWith("image/");
  const url = bridgeRes.url;
  const talemarkImage = bridgeRes.talemark_image || `[§I ${url}]`;
  const talemarkLink = bridgeRes.talemark_link || `[§B]📁 [${filename}](${url})[§R]`;

  return {
    success: true,
    provider: "firedrive",
    url,
    name: bridgeRes.name || filename,
    size: bridgeRes.size || 0,
    mime_type: bridgeRes.mime_type || mimeType,
    talemark_image: talemarkImage,
    talemark_link: talemarkLink,
  };
}

/**
 * Recupera os links de um arquivo já existente no Google Drive (sem re-upload).
 */
export async function handleGetMediaUrl(args: GetMediaUrlArgs): Promise<MediaUploadResult> {
  const gdrive = detectGDrive();
  if (!gdrive.available) {
    throw new Error(`Google Drive não disponível: ${gdrive.error}`);
  }

  const res = await resolveGDriveFile(args.pathOrFilename);
  if (!res) {
    throw new Error(`Arquivo não encontrado no Google Drive: ${args.pathOrFilename}`);
  }

  return {
    success: true,
    provider: "gdrive",
    url: res.embed_url,
    name: res.name,
    size: res.size,
    mime_type: res.mime_type,
    file_id: res.id,
    download_url: res.download_url,
    view_url: res.view_url,
    talemark_image: res.talemark_image,
    talemark_link: res.talemark_link,
    local_path: res.path,
  };
}

/**
 * Lista arquivos armazenados na pasta de assets.
 */
export async function handleListMediaFiles(args: ListMediaArgs): Promise<{ files: GDriveFileResult[] }> {
  const config = readConfig();
  const assetsDir = config.gdrive_assets_path;
  const files = await listGDriveFiles({
    subfolder: args.subfolder,
    assetsDir,
    limit: args.limit,
  });
  return { files };
}

/**
 * Envia uma mídia diretamente para o chat do Firecast com formatação Talemark inline,
 * suportando personificação de personagem MCP ou NPC.
 */
export async function handleSendMediaToChat(args: SendMediaToChatArgs): Promise<{
  success: boolean;
  upload?: MediaUploadResult;
  chat_result: unknown;
}> {
  let upload: MediaUploadResult | undefined;
  let formattedSnippet = "";

  if (args.mediaUrl) {
    const isImage = args.mediaUrl.match(/\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i) !== null || args.mediaUrl.includes("thumbnail?id=");
    formattedSnippet = isImage ? `[§I ${args.mediaUrl}]` : `[§B]📁 [Arquivo](${args.mediaUrl})[§R]`;
  } else {
    // Se o usuário passou apenas o nome ou caminho de um arquivo já existente no Drive
    if ((args.filePath || args.filename) && !args.contentBase64) {
      const target = args.filePath || args.filename!;
      const existing = await resolveGDriveFile(target);
      if (existing) {
        upload = {
          success: true,
          provider: "gdrive",
          url: existing.embed_url,
          name: existing.name,
          size: existing.size,
          mime_type: existing.mime_type,
          file_id: existing.id,
          download_url: existing.download_url,
          view_url: existing.view_url,
          talemark_image: existing.talemark_image,
          talemark_link: existing.talemark_link,
          local_path: existing.path,
        };
        const isImage = (upload.mime_type || "").startsWith("image/");
        formattedSnippet = isImage ? upload.talemark_image : upload.talemark_link;
      }
    }

    if (!upload) {
      upload = await handleUploadMedia({
        filePath: args.filePath,
        contentBase64: args.contentBase64,
        filename: args.filename,
        provider: args.provider,
        subfolder: args.subfolder,
      });

      const isImage = (upload.mime_type || "").startsWith("image/");
      formattedSnippet = isImage ? upload.talemark_image : upload.talemark_link;
    }
  }

  const fullMessage = args.caption ? `${args.caption}\n${formattedSnippet}` : formattedSnippet;

  let chatResult: unknown;

  if (args.asCharacterId) {
    // Envia personificando personagem do banco MCP
    chatResult = await handleImpersonateCharacter({
      character: args.asCharacterId,
      roomId: args.roomId,
      message: fullMessage,
      chatId: args.chatId,
    });
  } else {
    // Envia como mensagem comum ou NPC genérico
    const msgType = args.npcName ? "npc" : "standard";
    chatResult = await handleSendChatMessage({
      roomId: args.roomId,
      message: fullMessage,
      chatId: args.chatId,
      type: msgType,
      npcName: args.npcName,
    });
  }

  return {
    success: true,
    upload,
    chat_result: chatResult,
  };
}

/**
 * Configura ou consulta o storage provider do Firecast MCP.
 */
export async function handleConfigureStorage(args?: ConfigureStorageArgs): Promise<{
  config: AppConfig;
  gdrive_detection: ReturnType<typeof detectGDrive>;
}> {
  if (args && (args.provider || args.gdriveAssetsPath)) {
    const updates: Partial<AppConfig> = {};
    if (args.provider) updates.storage_provider = args.provider;
    if (args.gdriveAssetsPath) updates.gdrive_assets_path = args.gdriveAssetsPath;
    updateConfig(updates);
  }

  const config = readConfig();
  const gdrive = detectGDrive();

  return {
    config,
    gdrive_detection: gdrive,
  };
}

/**
 * Registra as ferramentas MCP de mídia no McpServer.
 */
export function registerMediaTools(server: McpServer): void {
  server.tool(
    "upload_media",
    "Faz upload de qualquer arquivo (imagem, mapa, áudio, PDF) para o Google Drive ou FireDrive e retorna URLs diretas prontas para o chat ou avatares.",
    {
      file_path: z.string().optional().describe("Caminho absoluto de qualquer arquivo no computador (ex: 'C:/Imagens/token.png')."),
      content_base64: z.string().optional().describe("Conteúdo do arquivo codificado em Base64 (alternativa a file_path)."),
      filename: z.string().optional().describe("Nome do arquivo (ex: 'caverna_mapa.png')."),
      provider: z.enum(["auto", "gdrive", "firedrive"]).optional().describe("Provedor de armazenamento: 'auto' (padrão), 'gdrive' (Google Drive local), ou 'firedrive' (blobs do Firecast)."),
      subfolder: z.string().optional().describe("Subpasta de destino (ex: 'campanhas/tokens')."),
      timeout_seconds: z.number().optional().describe("Tempo máximo em segundos aguardando sincronização do Drive (padrão: 25s)."),
    },
    async (args) => {
      const res = await handleUploadMedia({
        filePath: args.file_path,
        contentBase64: args.content_base64,
        filename: args.filename,
        provider: args.provider,
        subfolder: args.subfolder,
        timeoutSeconds: args.timeout_seconds,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_media_url",
    "Recupera links e formatações Talemark de um arquivo já existente no Google Drive para Computador sem re-upload.",
    {
      path_or_filename: z.string().describe("Caminho no G: ou nome do arquivo na pasta de assets (ex: 'G:/Meu Drive/Firecast Assets/token.png' ou 'token.png')."),
    },
    async (args) => {
      const res = await handleGetMediaUrl({
        pathOrFilename: args.path_or_filename,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_media_files",
    "Lista os arquivos armazenados na pasta de assets do Google Drive com seus links gerados.",
    {
      subfolder: z.string().optional().describe("Subpasta opcional."),
      limit: z.number().optional().describe("Limite de itens (padrão: 50)."),
    },
    async (args) => {
      const res = await handleListMediaFiles({
        subfolder: args.subfolder,
        limit: args.limit,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "send_media_to_chat",
    "Envia uma imagem ou arquivo diretamente para o chat de uma mesa no Firecast, com suporte a legenda e personificação de personagem.",
    {
      room_id: z.number().describe("ID da mesa no Firecast."),
      chat_id: z.string().optional().describe("ID do chat (opcional, padrão chat principal)."),
      file_path: z.string().optional().describe("Caminho do arquivo local para fazer upload e enviar."),
      content_base64: z.string().optional().describe("Conteúdo base64 do arquivo."),
      filename: z.string().optional().describe("Nome do arquivo."),
      media_url: z.string().optional().describe("URL da mídia se já tiver sido feito upload anteriormente."),
      caption: z.string().optional().describe("Legenda ou mensagem que acompanha a imagem/arquivo."),
      as_character_id: z.string().optional().describe("ID do personagem no gerenciador MCP para enviar como ele."),
      npc_name: z.string().optional().describe("Nome de NPC genérico caso não use personagem salvo."),
      provider: z.enum(["auto", "gdrive", "firedrive"]).optional().describe("Provedor de upload ('auto', 'gdrive', 'firedrive')."),
      subfolder: z.string().optional().describe("Subpasta no storage."),
    },
    async (args) => {
      const res = await handleSendMediaToChat({
        roomId: args.room_id,
        chatId: args.chat_id,
        filePath: args.file_path,
        contentBase64: args.content_base64,
        filename: args.filename,
        mediaUrl: args.media_url,
        caption: args.caption,
        asCharacterId: args.as_character_id,
        npcName: args.npc_name,
        provider: args.provider,
        subfolder: args.subfolder,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "configure_storage",
    "Consulta ou altera a configuração do provedor de armazenamento (Google Drive vs FireDrive) e pasta de assets.",
    {
      provider: z.enum(["auto", "gdrive", "firedrive"]).optional().describe("Novo provedor padrão."),
      gdrive_assets_path: z.string().optional().describe("Novo caminho base no Google Drive (ex: 'G:/Meu Drive/Firecast Assets')."),
    },
    async (args) => {
      const res = await handleConfigureStorage({
        provider: args.provider,
        gdriveAssetsPath: args.gdrive_assets_path,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );
}
