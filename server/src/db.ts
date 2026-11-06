// db.ts
// SQLite store para eventos do outbox e dados estruturados buscados do Firecast.
// Usa sql.js (WASM puro, sem bindings nativos — empacotável com pkg).

import initSqlJs, { Database, SqlJsStatic } from "sql.js/dist/sql-asm.js";
import path from "path";
import fs from "fs";

let db: Database;
let SQL: SqlJsStatic;
let dbPath: string;

export async function initDb(bridgePath: string): Promise<void> {
  dbPath = process.env.FIRECAST_DB_PATH ?? path.join(bridgePath, "firecast.db");
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  // sql-asm.js não precisa de wasm — funciona standalone
  SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
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
  `);
}

export function getDb(): Database { return db; }

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
  updated_at: number;
}

export function upsertRoom(room: Record<string, unknown>): void {
  run(`
    INSERT INTO rooms (id, nome, sistema, msg_status, msg_boas_vindas, site, logotipo,
                       ha_vagas, is_restrito, is_moderada, firecast_uri, updated_at)
    VALUES (:id, :nome, :sistema, :msg_status, :msg_boas_vindas, :site, :logotipo,
            :ha_vagas, :is_restrito, :is_moderada, :firecast_uri, :updated_at)
    ON CONFLICT(id) DO UPDATE SET
      nome=excluded.nome, sistema=excluded.sistema, msg_status=excluded.msg_status,
      msg_boas_vindas=excluded.msg_boas_vindas, site=excluded.site, logotipo=excluded.logotipo,
      ha_vagas=excluded.ha_vagas, is_restrito=excluded.is_restrito,
      is_moderada=excluded.is_moderada, firecast_uri=excluded.firecast_uri,
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
    ":updated_at":      Date.now(),
  });
}

export function getAllRooms(): RoomRow[] {
  return query<RoomRow>("SELECT * FROM rooms ORDER BY nome");
}

export function getRoomById(id: number): RoomRow | undefined {
  return queryOne<RoomRow>("SELECT * FROM rooms WHERE id = ?", [id]);
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
