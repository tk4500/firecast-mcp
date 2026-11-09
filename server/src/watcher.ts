// watcher.ts
// Monitora a pasta outbox/ no VHD path, lê cada arquivo novo, insere no SQLite, deleta.

import fs from "fs";
import path from "path";
import {
  getDb,
  upsertRoom,
  insertRoomEvent,
  insertChatMessage,
  upsertSheetSnapshot,
  applySheetDeltas,
} from "./db.js";

type OutboxEvent = {
  id: string;
  type: string;
  ts: number;
  data: Record<string, unknown>;
};

// Callbacks para notificar o index.ts quando chega um command_result
type ResultCallback = (event: OutboxEvent) => void;
const resultCallbacks = new Map<string, ResultCallback>();

export function onCommandResult(id: string, cb: ResultCallback): void {
  resultCallbacks.set(id, cb);
}

export function removeResultCallback(id: string): void {
  resultCallbacks.delete(id);
}

let watchedOutboxDir: string;

export function getOutboxDir(): string {
  return watchedOutboxDir;
}

export function startWatcher(outboxDir: string): void {
  watchedOutboxDir = outboxDir;
  fs.mkdirSync(outboxDir, { recursive: true });

  // Processa qualquer arquivo já existente ao iniciar
  drainOutbox(outboxDir);

  // 1. Monitora eventos imediatos do sistema de arquivos
  try {
    fs.watch(outboxDir, (_event, filename) => {
      if (!filename) return;
      const filePath = path.join(outboxDir, filename);
      setTimeout(() => processFile(filePath), 50);
    });
  } catch {
    // fs.watch pode falhar em alguns ambientes de rede/VHD
  }

  // 2. Polling interval contínuo a cada 300ms (garantia contra falhas de fs.watch no Windows)
  setInterval(() => {
    drainOutbox(outboxDir);
  }, 300);
}

function drainOutbox(outboxDir: string): void {
  try {
    if (!fs.existsSync(outboxDir)) return;
    const files = fs.readdirSync(outboxDir);
    for (const file of files) {
      processFile(path.join(outboxDir, file));
    }
  } catch {
    // pasta pode estar sendo acessada por outro processo
  }
}

function processFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return;

    // Tenta fazer o parse primeiro
    const event: OutboxEvent = JSON.parse(content);

    // Se o parse teve sucesso, remove o arquivo do outbox
    try {
      fs.unlinkSync(filePath);
    } catch {
      // se falhar ao deletar (arquivo ocupado), ignora por agora
    }

    handleEvent(event);
  } catch {
    // Se o arquivo estiver incompleto sendo escrito pelo Lua,
    // não deleta e deixa o próximo ciclo de polling processar
  }
}

function handleEvent(event: OutboxEvent): void {
  const { type, data } = event;

  switch (type) {
    case "command_result": {
      const targetId = (data?.id ?? event.id) as string;
      const cb = resultCallbacks.get(targetId);
      if (cb) {
        resultCallbacks.delete(targetId);
        cb(event);
      }
      break;
    }

    case "room_joined":
    case "room_parted": {
      const room = data.room as Record<string, unknown> | undefined;
      if (room?.id) {
        upsertRoom(room);
      }
      insertRoomEvent({
        event_id:          event.id,
        type,
        room_id:           (room?.id as number) ?? 0,
        player_login:      (data.player as Record<string, string> | undefined)?.login ?? "",
        player_nome:       (data.player as Record<string, string> | undefined)?.nome ?? "",
        is_me:             !!data.isMe,
        is_kick:           !!data.isKick,
        kick_reason:       undefined,
        responsible_login: (data.responsible as Record<string, string> | undefined)?.login,
        ts:                event.ts,
      });
      break;
    }

    case "chat_message": {
      insertChatMessage({
        message_id:    (data.id as string) ?? event.id,
        tid:           data.tid as string,
        room_id:       (data.room_id as number) ?? 0,
        chat_id:       (data.chat_id as string) ?? "main",
        chat_kind:     (data.chat_kind as string) ?? null,
        sender:        data.sender as any,
        mine:          !!data.mine,
        type:          (data.type as string) ?? "standard",
        content:       (data.content as string) ?? "",
        npc:           (data.npc as string) ?? null,
        impersonation: data.impersonation,
        visibility:    data.visibility,
        file_url:      data.file_url as string,
        roll:          data.roll as any,
        raw_json:      data.log_rec,
        ts:            event.ts,
      });
      break;
    }

    case "sheet_snapshot": {
      upsertSheetSnapshot({
        roomId:         (data.roomId as number) ?? 0,
        codigoInterno:  (data.codigoInterno as number) ?? 0,
        characterName:  (data.characterName as string) ?? "",
        dataType:       (data.dataType as string) ?? "",
        syncSource:     (data.source as string) ?? "auto",
        isOpenInTab:    !!data.isTabOpen,
        data:           data.data ?? {},
        rawXml:         data.rawXml as string | undefined,
        timestamp:      (data.timestamp as number) ?? event.ts,
      });
      break;
    }

    case "sheet_change": {
      applySheetDeltas({
        roomId:         (data.roomId as number) ?? 0,
        codigoInterno:  (data.codigoInterno as number) ?? 0,
        characterName:  (data.characterName as string) ?? "",
        dataType:       (data.dataType as string) ?? "",
        syncSource:     (data.source as string) ?? "auto",
        isOpenInTab:    !!data.isTabOpen,
        changes:        (data.changes as Record<string, any>) ?? {},
        timestamp:      (data.timestamp as number) ?? event.ts,
      });
      break;
    }

    default:
      // Tipos futuros são silenciosamente ignorados (serão adicionados por fase)
      break;
  }
}
