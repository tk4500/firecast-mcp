// db.ts
// SQLite store para eventos do outbox e dados estruturados buscados do Firecast.
// Usa sql.js (WASM puro, sem bindings nativos — empacotável com pkg).

// @ts-ignore
import initSqlJs from "sql.js/dist/sql-wasm-inline.js";
import type { Database, SqlJsStatic } from "sql.js";
import path from "path";
import fs from "fs";

let db: Database;
let SQL: SqlJsStatic;
let dbPath: string;

function resolveDbFilePath(target: string): string {
  let resolved = path.resolve(target);
  if (fs.existsSync(resolved)) {
    try {
      if (fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, "firecast.db");
      }
    } catch {
      // Ignora erro de stat
    }
  } else if (!path.extname(resolved) || resolved.endsWith("/") || resolved.endsWith("\\")) {
    resolved = path.join(resolved, "firecast.db");
  }
  return resolved;
}

export async function initDb(bridgePath: string): Promise<void> {
  const target = process.env.FIRECAST_DB_PATH ?? path.join(bridgePath, "firecast.db");
  dbPath = resolveDbFilePath(target);
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  // sql-wasm-inline.js embute o WebAssembly diretamente no JS — funciona 100% standalone sem arquivos externos
  SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    try {
      const stat = fs.statSync(dbPath);
      if (stat.isFile() && stat.size > 0) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
      } else {
        db = new SQL.Database();
      }
    } catch (err) {
      process.stderr.write(`[Firecast MCP] Aviso: não foi possível ler ${dbPath}, criando novo: ${err}\n`);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  migrate();
  persistDb();
}

function persistDb(): void {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function run(sql: string, params: Record<string, unknown> = {}): void {
  db.run(sql, params as any);
  persistDb();
}

function query<T>(sql: string, params: (string | number | null)[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

function queryOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
  return query<T>(sql, params)[0];
}

function migrate(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id           INTEGER PRIMARY KEY,
      nome         TEXT,
      sistema      TEXT,
      msg_status   TEXT,
      msg_boas_vindas TEXT,
      site         TEXT,
      logotipo     TEXT,
      ha_vagas     INTEGER,
      is_restrito  INTEGER,
      is_moderada  INTEGER,
      firecast_uri TEXT,
      players      TEXT,
      meu_jogador  TEXT,
      updated_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS room_events (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id  TEXT UNIQUE,
      type      TEXT NOT NULL,  -- "room_joined" | "room_parted"
      room_id   INTEGER,
      player_login TEXT,
      player_nome  TEXT,
      is_me        INTEGER,
      is_kick      INTEGER,
      kick_reason  TEXT,
      responsible_login TEXT,
      ts        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_room_events_room ON room_events(room_id);
    CREATE INDEX IF NOT EXISTS idx_room_events_ts   ON room_events(ts);

    CREATE TABLE IF NOT EXISTS chat_messages (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT UNIQUE,
      room_id       INTEGER,
      chat_id       TEXT,
      chat_kind     TEXT,
      sender_id     INTEGER,
      sender_login  TEXT,
      sender_nick   TEXT,
      mine          INTEGER,
      type          TEXT,
      content       TEXT,
      npc_name      TEXT,
      roll_result   INTEGER,
      roll_data     TEXT,
      ts            INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(room_id, chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_ts   ON chat_messages(ts);
  `);

  try {
    db.run("ALTER TABLE rooms ADD COLUMN players TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE rooms ADD COLUMN meu_jogador TEXT");
  } catch {}
}

export function getDb(): Database { return db; }
export function getDbPath(): string { return dbPath; }

// --- Rooms ---

export interface RoomRow {
  id: number;
  nome: string;
  sistema: string;
  msg_status: string;
  msg_boas_vindas: string;
  site: string;
  logotipo: string;
  ha_vagas: number;
  is_restrito: number;
  is_moderada: number;
  firecast_uri: string;
  players?: unknown[];
  meu_jogador?: unknown;
  updated_at: number;
}

function formatRoomRow(row: any): RoomRow {
  if (!row) return row;
  if (row.players && typeof row.players === "string") {
    try {
      row.players = JSON.parse(row.players);
    } catch {}
  }
  if (row.meu_jogador && typeof row.meu_jogador === "string") {
    try {
      row.meu_jogador = JSON.parse(row.meu_jogador);
    } catch {}
  }
  return row as RoomRow;
}

export function upsertRoom(room: Record<string, unknown>): void {
  run(`
    INSERT INTO rooms (id, nome, sistema, msg_status, msg_boas_vindas, site, logotipo,
                       ha_vagas, is_restrito, is_moderada, firecast_uri, players, meu_jogador, updated_at)
    VALUES (:id, :nome, :sistema, :msg_status, :msg_boas_vindas, :site, :logotipo,
            :ha_vagas, :is_restrito, :is_moderada, :firecast_uri, :players, :meu_jogador, :updated_at)
    ON CONFLICT(id) DO UPDATE SET
      nome=excluded.nome, sistema=excluded.sistema, msg_status=excluded.msg_status,
      msg_boas_vindas=excluded.msg_boas_vindas, site=excluded.site, logotipo=excluded.logotipo,
      ha_vagas=excluded.ha_vagas, is_restrito=excluded.is_restrito,
      is_moderada=excluded.is_moderada, firecast_uri=excluded.firecast_uri,
      players=excluded.players, meu_jogador=excluded.meu_jogador,
      updated_at=excluded.updated_at
  `, {
    ":id":              room.id as number,
    ":nome":            (room.nome ?? null) as string | null,
    ":sistema":         (room.sistema ?? null) as string | null,
    ":msg_status":      (room.msgStatus ?? null) as string | null,
    ":msg_boas_vindas": (room.msgBoasVindas ?? null) as string | null,
    ":site":            (room.site ?? null) as string | null,
    ":logotipo":        (room.logotipo ?? null) as string | null,
    ":ha_vagas":        room.haVagas ? 1 : 0,
    ":is_restrito":     room.isRestrito18 ? 1 : 0,
    ":is_moderada":     room.isModerada ? 1 : 0,
    ":firecast_uri":    (room.firecastURI ?? null) as string | null,
    ":players":         room.players ? JSON.stringify(room.players) : null,
    ":meu_jogador":     room.meuJogador ? JSON.stringify(room.meuJogador) : null,
    ":updated_at":      Date.now(),
  });
}

export function getAllRooms(): RoomRow[] {
  return query<any>("SELECT * FROM rooms ORDER BY nome").map(formatRoomRow);
}

export function getRoomById(id: number): RoomRow | undefined {
  const row = queryOne<any>("SELECT * FROM rooms WHERE id = ?", [id]);
  return row ? formatRoomRow(row) : undefined;
}

// --- Room Events ---

export function insertRoomEvent(event: {
  event_id: string;
  type: string;
  room_id: number;
  player_login: string;
  player_nome: string;
  is_me: boolean;
  is_kick?: boolean;
  kick_reason?: string;
  responsible_login?: string;
  ts: number;
}): void {
  run(`
    INSERT OR IGNORE INTO room_events
      (event_id, type, room_id, player_login, player_nome, is_me, is_kick, kick_reason, responsible_login, ts)
    VALUES
      (:event_id, :type, :room_id, :player_login, :player_nome, :is_me, :is_kick, :kick_reason, :responsible_login, :ts)
  `, {
    ":event_id":          event.event_id,
    ":type":              event.type,
    ":room_id":           event.room_id,
    ":player_login":      event.player_login,
    ":player_nome":       event.player_nome,
    ":is_me":             event.is_me ? 1 : 0,
    ":is_kick":           event.is_kick ? 1 : 0,
    ":kick_reason":       event.kick_reason ?? null,
    ":responsible_login": event.responsible_login ?? null,
    ":ts":                event.ts,
  });
}

export interface RoomEventRow {
  seq: number;
  event_id: string;
  type: string;
  room_id: number;
  player_login: string;
  player_nome: string;
  is_me: number;
  is_kick: number;
  kick_reason: string | null;
  responsible_login: string | null;
  ts: number;
}

export function getAllRoomEvents(limit = 100): RoomEventRow[] {
  return query<RoomEventRow>("SELECT * FROM room_events ORDER BY seq DESC LIMIT ?", [limit]);
}

// --- Chat Messages ---

export interface ChatMessageRow {
  seq?: number;
  message_id?: string | null;
  room_id: number;
  chat_id: string;
  chat_kind?: string | null;
  sender_id?: number | null;
  sender_login?: string | null;
  sender_nick?: string | null;
  mine?: number;
  type?: string;
  content: string;
  npc_name?: string | null;
  roll_result?: number | null;
  roll_data?: string | null;
  ts: number;
}

export function insertChatMessage(msg: {
  message_id?: string | null;
  room_id: number;
  chat_id?: string | null;
  chat_kind?: string | null;
  sender?: { id?: number; login?: string; nick?: string } | null;
  mine?: boolean | number;
  type?: string;
  content?: string;
  npc?: string | null;
  npc_name?: string | null;
  roll?: { resultado?: number; asString?: string; ops?: any[] } | null;
  ts?: number;
}): void {
  const ts = msg.ts ?? Math.floor(Date.now() / 1000);
  const chatId = msg.chat_id ?? "main";
  const messageId = msg.message_id ?? null;
  const mine = msg.mine ? 1 : 0;
  const rollResult = msg.roll?.resultado ?? null;
  const rollData = msg.roll ? JSON.stringify(msg.roll) : null;
  const npcName = msg.npc_name ?? msg.npc ?? null;

  run(
    `INSERT OR IGNORE INTO chat_messages (
      message_id, room_id, chat_id, chat_kind,
      sender_id, sender_login, sender_nick,
      mine, type, content, npc_name,
      roll_result, roll_data, ts
    ) VALUES (
      :message_id, :room_id, :chat_id, :chat_kind,
      :sender_id, :sender_login, :sender_nick,
      :mine, :type, :content, :npc_name,
      :roll_result, :roll_data, :ts
    )`,
    {
      ":message_id":   messageId,
      ":room_id":      msg.room_id,
      ":chat_id":      chatId,
      ":chat_kind":    msg.chat_kind ?? null,
      ":sender_id":    msg.sender?.id ?? null,
      ":sender_login": msg.sender?.login ?? null,
      ":sender_nick":  msg.sender?.nick ?? null,
      ":mine":         mine,
      ":type":         msg.type ?? "standard",
      ":content":      msg.content ?? "",
      ":npc_name":     npcName,
      ":roll_result":  rollResult,
      ":roll_data":    rollData,
      ":ts":           ts,
    }
  );
}

export function getChatMessages(roomId: number, chatId?: string, limit = 50): ChatMessageRow[] {
  if (chatId && chatId !== "all") {
    return query<ChatMessageRow>(
      `SELECT * FROM chat_messages WHERE room_id = ? AND chat_id = ? ORDER BY ts ASC, seq ASC LIMIT ?`,
      [roomId, chatId, limit]
    );
  }
  return query<ChatMessageRow>(
    `SELECT * FROM chat_messages WHERE room_id = ? ORDER BY ts ASC, seq ASC LIMIT ?`,
    [roomId, limit]
  );
}
