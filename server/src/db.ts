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
      tid           TEXT,
      room_id       INTEGER,
      chat_id       TEXT,
      chat_kind     TEXT,
      sender_id     INTEGER,
      sender_login  TEXT,
      sender_nick   TEXT,
      sender_gender TEXT,
      mine          INTEGER,
      type          TEXT,
      content       TEXT,
      npc_name      TEXT,
      impersonation TEXT,
      visibility    TEXT,
      file_url      TEXT,
      extra         TEXT,
      roll_result   INTEGER,
      roll_data     TEXT,
      raw_json      TEXT,
      ts            INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(room_id, chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_ts   ON chat_messages(ts);

    CREATE TABLE IF NOT EXISTS characters (
      id               TEXT PRIMARY KEY,
      room_id          INTEGER,
      code             TEXT,
      name             TEXT NOT NULL,
      title            TEXT,
      avatar_url       TEXT,
      images           TEXT,
      gender           TEXT DEFAULT 'undefined',
      color            TEXT,
      bkg_color        TEXT,
      bold             INTEGER DEFAULT 0,
      italic           INTEGER DEFAULT 0,
      underline        INTEGER DEFAULT 0,
      strikeout        INTEGER DEFAULT 0,
      talemark_options TEXT,
      voice            TEXT,
      personality      TEXT,
      speech_style     TEXT,
      appearance       TEXT,
      background       TEXT,
      notes            TEXT,
      tags             TEXT,
      sheet_codigo     INTEGER,
      sheet_data_type  TEXT,
      bars             TEXT,
      stats            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_characters_room ON characters(room_id);
    CREATE INDEX IF NOT EXISTS idx_characters_code ON characters(code);
    CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);

    CREATE TABLE IF NOT EXISTS character_sheets (
      room_id           INTEGER NOT NULL,
      codigo_interno    INTEGER NOT NULL,
      character_name    TEXT,
      data_type         TEXT,
      data_json         TEXT NOT NULL,
      raw_xml           TEXT,
      sync_source       TEXT DEFAULT 'auto',
      is_open_in_tab    INTEGER DEFAULT 0,
      last_updated_at   INTEGER NOT NULL,
      PRIMARY KEY (room_id, codigo_interno)
    );

    CREATE INDEX IF NOT EXISTS idx_character_sheets_room ON character_sheets(room_id);
    CREATE INDEX IF NOT EXISTS idx_character_sheets_name ON character_sheets(character_name);
  `);

  try {
    db.run("ALTER TABLE rooms ADD COLUMN players TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE rooms ADD COLUMN meu_jogador TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN tid TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN sender_gender TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN impersonation TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN visibility TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN file_url TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN extra TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE chat_messages ADD COLUMN raw_json TEXT");
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
  tid?: string | null;
  room_id: number;
  chat_id: string;
  chat_kind?: string | null;
  sender_id?: number | null;
  sender_login?: string | null;
  sender_nick?: string | null;
  sender_gender?: string | null;
  mine?: number;
  type?: string;
  content: string;
  npc_name?: string | null;
  impersonation?: any;
  visibility?: any;
  file_url?: string | null;
  extra?: any;
  roll_result?: number | null;
  roll_data?: string | null;
  raw_json?: string | null;
  ts: number;
}

function formatChatMessageRow(row: any): ChatMessageRow {
  if (!row) return row;
  if (row.roll_data && typeof row.roll_data === "string") {
    try { row.roll_data = JSON.parse(row.roll_data); } catch {}
  }
  if (row.impersonation && typeof row.impersonation === "string") {
    try { row.impersonation = JSON.parse(row.impersonation); } catch {}
  }
  if (row.visibility && typeof row.visibility === "string") {
    try { row.visibility = JSON.parse(row.visibility); } catch {}
  }
  if (row.extra && typeof row.extra === "string") {
    try { row.extra = JSON.parse(row.extra); } catch {}
  }
  if (row.raw_json && typeof row.raw_json === "string") {
    try { row.raw_json = JSON.parse(row.raw_json); } catch {}
  }
  return row as ChatMessageRow;
}

export function insertChatMessage(msg: {
  message_id?: string | null;
  tid?: string | null;
  room_id: number;
  chat_id?: string | null;
  chat_kind?: string | null;
  sender?: { id?: number; login?: string; nick?: string; gender?: string } | null;
  mine?: boolean | number;
  type?: string;
  content?: string;
  npc?: string | null;
  npc_name?: string | null;
  impersonation?: any;
  visibility?: any;
  file_url?: string | null;
  extra?: any;
  roll?: { resultado?: number; asString?: string; ops?: any[] } | null;
  raw_json?: any;
  ts?: number;
}): void {
  const ts = msg.ts ?? Math.floor(Date.now() / 1000);
  const chatId = msg.chat_id ?? "main";
  const messageId = msg.message_id ?? null;
  const mine = msg.mine ? 1 : 0;
  const rollResult = msg.roll?.resultado ?? null;
  const rollData = msg.roll ? JSON.stringify(msg.roll) : null;
  const npcName = msg.npc_name ?? msg.npc ?? msg.impersonation?.name ?? null;
  const impersonationStr = msg.impersonation ? JSON.stringify(msg.impersonation) : null;
  const visibilityStr = msg.visibility ? JSON.stringify(msg.visibility) : null;
  const extraStr = msg.extra ? JSON.stringify(msg.extra) : null;
  const rawJsonStr = msg.raw_json ? JSON.stringify(msg.raw_json) : null;

  run(
    `INSERT OR IGNORE INTO chat_messages (
      message_id, tid, room_id, chat_id, chat_kind,
      sender_id, sender_login, sender_nick, sender_gender,
      mine, type, content, npc_name,
      impersonation, visibility, file_url, extra,
      roll_result, roll_data, raw_json, ts
    ) VALUES (
      :message_id, :tid, :room_id, :chat_id, :chat_kind,
      :sender_id, :sender_login, :sender_nick, :sender_gender,
      :mine, :type, :content, :npc_name,
      :impersonation, :visibility, :file_url, :extra,
      :roll_result, :roll_data, :raw_json, :ts
    )`,
    {
      ":message_id":    messageId,
      ":tid":           msg.tid ?? null,
      ":room_id":       msg.room_id,
      ":chat_id":       chatId,
      ":chat_kind":     msg.chat_kind ?? null,
      ":sender_id":     msg.sender?.id ?? null,
      ":sender_login":  msg.sender?.login ?? null,
      ":sender_nick":   msg.sender?.nick ?? null,
      ":sender_gender": msg.sender?.gender ?? null,
      ":mine":          mine,
      ":type":          msg.type ?? "standard",
      ":content":       msg.content ?? "",
      ":npc_name":      npcName,
      ":impersonation": impersonationStr,
      ":visibility":    visibilityStr,
      ":file_url":      msg.file_url ?? null,
      ":extra":         extraStr,
      ":roll_result":   rollResult,
      ":roll_data":     rollData,
      ":raw_json":      rawJsonStr,
      ":ts":            ts,
    }
  );
}

export function getChatMessages(roomId: number, chatId?: string, limit = 50): ChatMessageRow[] {
  let rows: any[];
  if (chatId && chatId !== "all") {
    rows = query<any>(
      `SELECT * FROM chat_messages WHERE room_id = ? AND chat_id = ? ORDER BY ts ASC, seq ASC LIMIT ?`,
      [roomId, chatId, limit]
    );
  } else {
    rows = query<any>(
      `SELECT * FROM chat_messages WHERE room_id = ? ORDER BY ts ASC, seq ASC LIMIT ?`,
      [roomId, limit]
    );
  }
  return rows.map(formatChatMessageRow);
}

// --- Characters (Character Manager) ---

export interface CharacterImage {
  url: string;
  label?: string; // e.g. "Padrão", "Combate", "Furioso", "Casual", "Token"
  tag?: string;   // e.g. "portrait", "battle", "token", "nsfw"
}

export interface CharacterTalemarkStyle {
  color?: string;
  bkgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  parseCharActions?: boolean;
  parseCharEmDashSpeech?: boolean;
  parseCharQuotedSpeech?: boolean;
  parseSmileys?: boolean;
  parseURL?: boolean;
}

export interface CharacterRow {
  id: string;
  room_id: number | null;
  code: string | null;
  name: string;
  title: string | null;
  avatar_url: string | null;
  images: CharacterImage[];
  gender: "masculine" | "feminine" | "neuter" | "undefined";
  color: string | null;
  bkg_color: string | null;
  bold: number;
  italic: number;
  underline: number;
  strikeout: number;
  talemark_options: any;
  voice: string | null;
  personality: string | null;
  speech_style: string | null;
  appearance: string | null;
  background: string | null;
  notes: string | null;
  tags: string[];
  sheet_codigo: number | null;
  sheet_data_type: string | null;
  bars: Record<string, { val: number; max: number; label?: string; color?: string }>;
  stats: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CharacterInput {
  id?: string;
  room_id?: number | null;
  code?: string | null;
  name: string;
  title?: string | null;
  avatar_url?: string | null;
  images?: (CharacterImage | string)[];
  gender?: "masculine" | "feminine" | "neuter" | "undefined";
  color?: string | null;
  bkg_color?: string | null;
  bold?: boolean | number;
  italic?: boolean | number;
  underline?: boolean | number;
  strikeout?: boolean | number;
  talemark_options?: any;
  voice?: string | null;
  personality?: string | null;
  speech_style?: string | null;
  appearance?: string | null;
  background?: string | null;
  notes?: string | null;
  tags?: string[];
  sheet_codigo?: number | null;
  sheet_data_type?: string | null;
  bars?: Record<string, { val: number; max: number; label?: string; color?: string }>;
  stats?: Record<string, any>;
}

export function formatCharacterRow(row: any): CharacterRow {
  if (!row) return row;
  const parsed = { ...row };
  if (typeof parsed.images === "string") {
    try { parsed.images = JSON.parse(parsed.images); } catch { parsed.images = []; }
  } else if (!Array.isArray(parsed.images)) {
    parsed.images = [];
  }
  if (typeof parsed.talemark_options === "string") {
    try { parsed.talemark_options = JSON.parse(parsed.talemark_options); } catch { parsed.talemark_options = null; }
  }
  if (typeof parsed.tags === "string") {
    try { parsed.tags = JSON.parse(parsed.tags); } catch { parsed.tags = []; }
  } else if (!Array.isArray(parsed.tags)) {
    parsed.tags = [];
  }
  if (typeof parsed.bars === "string") {
    try { parsed.bars = JSON.parse(parsed.bars); } catch { parsed.bars = {}; }
  } else if (!parsed.bars || typeof parsed.bars !== "object") {
    parsed.bars = {};
  }
  if (typeof parsed.stats === "string") {
    try { parsed.stats = JSON.parse(parsed.stats); } catch { parsed.stats = {}; }
  } else if (!parsed.stats || typeof parsed.stats !== "object") {
    parsed.stats = {};
  }
  return parsed as CharacterRow;
}

function generateSlug(name: string, code?: string | null): string {
  if (code && code.trim()) {
    return code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }
  const clean = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || `char_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

export function getCharacterById(id: string): CharacterRow | undefined {
  const row = queryOne<any>("SELECT * FROM characters WHERE id = ?", [id]);
  return row ? formatCharacterRow(row) : undefined;
}

export function findCharacter(queryStr: string, roomId?: number | null): CharacterRow | undefined {
  const clean = queryStr.trim();
  if (!clean) return undefined;

  // 1. Exact ID
  let row = queryOne<any>("SELECT * FROM characters WHERE id = ?", [clean]);
  if (row) return formatCharacterRow(row);

  // 2. Exact code
  if (roomId) {
    row = queryOne<any>("SELECT * FROM characters WHERE code = ? AND room_id = ?", [clean, roomId]);
    if (row) return formatCharacterRow(row);
  }
  row = queryOne<any>("SELECT * FROM characters WHERE code = ?", [clean]);
  if (row) return formatCharacterRow(row);

  // 3. Exact name
  if (roomId) {
    row = queryOne<any>("SELECT * FROM characters WHERE name = ? COLLATE NOCASE AND room_id = ?", [clean, roomId]);
    if (row) return formatCharacterRow(row);
  }
  row = queryOne<any>("SELECT * FROM characters WHERE name = ? COLLATE NOCASE", [clean]);
  if (row) return formatCharacterRow(row);

  // 4. Fuzzy name LIKE
  if (roomId) {
    row = queryOne<any>("SELECT * FROM characters WHERE name LIKE ? AND room_id = ? LIMIT 1", [`%${clean}%`, roomId]);
    if (row) return formatCharacterRow(row);
  }
  row = queryOne<any>("SELECT * FROM characters WHERE name LIKE ? LIMIT 1", [`%${clean}%`]);
  if (row) return formatCharacterRow(row);

  return undefined;
}

export function upsertCharacter(input: CharacterInput): CharacterRow {
  const now = Math.floor(Date.now() / 1000);
  const id = input.id?.trim() || generateSlug(input.name, input.code);
  const existing = getCharacterById(id);

  const imagesFormatted: CharacterImage[] = (input.images || []).map((img) =>
    typeof img === "string" ? { url: img } : img
  );

  const imagesStr = JSON.stringify(imagesFormatted);
  const tagsStr = JSON.stringify(input.tags || []);
  const barsStr = JSON.stringify(input.bars || {});
  const statsStr = JSON.stringify(input.stats || {});
  const talemarkStr = input.talemark_options ? JSON.stringify(input.talemark_options) : null;

  const bold = input.bold === true || input.bold === 1 ? 1 : 0;
  const italic = input.italic === true || input.italic === 1 ? 1 : 0;
  const underline = input.underline === true || input.underline === 1 ? 1 : 0;
  const strikeout = input.strikeout === true || input.strikeout === 1 ? 1 : 0;

  const createdAt = existing ? existing.created_at : now;

  run(
    `INSERT INTO characters (
      id, room_id, code, name, title, avatar_url, images, gender,
      color, bkg_color, bold, italic, underline, strikeout, talemark_options, voice,
      personality, speech_style, appearance, background, notes, tags,
      sheet_codigo, sheet_data_type, bars, stats, created_at, updated_at
    ) VALUES (
      :id, :room_id, :code, :name, :title, :avatar_url, :images, :gender,
      :color, :bkg_color, :bold, :italic, :underline, :strikeout, :talemark_options, :voice,
      :personality, :speech_style, :appearance, :background, :notes, :tags,
      :sheet_codigo, :sheet_data_type, :bars, :stats, :created_at, :updated_at
    ) ON CONFLICT(id) DO UPDATE SET
      room_id=excluded.room_id,
      code=excluded.code,
      name=excluded.name,
      title=excluded.title,
      avatar_url=excluded.avatar_url,
      images=excluded.images,
      gender=excluded.gender,
      color=excluded.color,
      bkg_color=excluded.bkg_color,
      bold=excluded.bold,
      italic=excluded.italic,
      underline=excluded.underline,
      strikeout=excluded.strikeout,
      talemark_options=excluded.talemark_options,
      voice=excluded.voice,
      personality=excluded.personality,
      speech_style=excluded.speech_style,
      appearance=excluded.appearance,
      background=excluded.background,
      notes=excluded.notes,
      tags=excluded.tags,
      sheet_codigo=excluded.sheet_codigo,
      sheet_data_type=excluded.sheet_data_type,
      bars=excluded.bars,
      stats=excluded.stats,
      updated_at=excluded.updated_at
    `,
    {
      ":id": id,
      ":room_id": input.room_id ?? null,
      ":code": input.code?.trim() || null,
      ":name": input.name.trim(),
      ":title": input.title?.trim() || null,
      ":avatar_url": input.avatar_url?.trim() || null,
      ":images": imagesStr,
      ":gender": input.gender ?? "undefined",
      ":color": input.color?.trim() || null,
      ":bkg_color": input.bkg_color?.trim() || null,
      ":bold": bold,
      ":italic": italic,
      ":underline": underline,
      ":strikeout": strikeout,
      ":talemark_options": talemarkStr,
      ":voice": input.voice?.trim() || null,
      ":personality": input.personality?.trim() || null,
      ":speech_style": input.speech_style?.trim() || null,
      ":appearance": input.appearance?.trim() || null,
      ":background": input.background?.trim() || null,
      ":notes": input.notes?.trim() || null,
      ":tags": tagsStr,
      ":sheet_codigo": input.sheet_codigo ?? null,
      ":sheet_data_type": input.sheet_data_type?.trim() || null,
      ":bars": barsStr,
      ":stats": statsStr,
      ":created_at": createdAt,
      ":updated_at": now,
    }
  );

  return getCharacterById(id)!;
}

export function listCharacters(options?: {
  roomId?: number | null;
  includeGlobal?: boolean;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): { characters: CharacterRow[]; total: number } {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (options?.roomId !== undefined && options?.roomId !== null) {
    if (options.includeGlobal) {
      conditions.push("(room_id = ? OR room_id IS NULL)");
      params.push(options.roomId);
    } else {
      conditions.push("room_id = ?");
      params.push(options.roomId);
    }
  }

  if (options?.tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${options.tag}"%`);
  }

  if (options?.search) {
    conditions.push("(name LIKE ? OR code LIKE ? OR title LIKE ? OR tags LIKE ?)");
    const s = `%${options.search}%`;
    params.push(s, s, s, s);
  }

  const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countRow = queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM characters ${whereClause}`, params);
  const total = countRow?.count ?? 0;

  const rows = query<any>(
    `SELECT * FROM characters ${whereClause} ORDER BY updated_at DESC, name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    characters: rows.map(formatCharacterRow),
    total,
  };
}

export function deleteCharacter(idOrCode: string, roomId?: number | null): boolean {
  const char = findCharacter(idOrCode, roomId);
  if (!char) return false;
  run("DELETE FROM characters WHERE id = :id", { ":id": char.id });
  return true;
}

// --- Sincronização Bidirecional de Fichas (Character Sheets) ---

export interface CharacterSheetRow {
  room_id: number;
  codigo_interno: number;
  character_name: string;
  data_type: string;
  data: any;
  raw_xml?: string | null;
  sync_source: string;
  is_open_in_tab: boolean;
  last_updated_at: number;
}

export function applyNestedDeltas(target: any, changes: Record<string, any>): any {
  if (typeof target !== "object" || target === null) {
    target = {};
  }

  for (const [path, value] of Object.entries(changes)) {
    if (!path || path === "." || path === "/") {
      if (typeof value === "object" && value !== null) {
        Object.assign(target, value);
      }
      continue;
    }

    const parts = path.split(/[./\\]+/).filter(Boolean);
    if (parts.length === 0) continue;

    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part];
    }

    const finalKey = parts[parts.length - 1];
    if (value === null || value === undefined) {
      delete current[finalKey];
    } else {
      current[finalKey] = value;
    }
  }

  return target;
}

export function upsertSheetSnapshot(params: {
  roomId: number;
  codigoInterno: number;
  characterName: string;
  dataType: string;
  syncSource?: string;
  isOpenInTab?: boolean;
  data: any;
  rawXml?: string | null;
  timestamp?: number;
}): void {
  const now = params.timestamp ?? Math.floor(Date.now() / 1000);
  const dataJson = typeof params.data === "string" ? params.data : JSON.stringify(params.data ?? {});

  run(
    `INSERT INTO character_sheets (
      room_id, codigo_interno, character_name, data_type, data_json, raw_xml, sync_source, is_open_in_tab, last_updated_at
    ) VALUES (
      :room_id, :codigo_interno, :character_name, :data_type, :data_json, :raw_xml, :sync_source, :is_open_in_tab, :last_updated_at
    ) ON CONFLICT(room_id, codigo_interno) DO UPDATE SET
      character_name = excluded.character_name,
      data_type = excluded.data_type,
      data_json = excluded.data_json,
      raw_xml = COALESCE(excluded.raw_xml, character_sheets.raw_xml),
      sync_source = COALESCE(excluded.sync_source, character_sheets.sync_source),
      is_open_in_tab = excluded.is_open_in_tab,
      last_updated_at = excluded.last_updated_at`,
    {
      ":room_id": params.roomId,
      ":codigo_interno": params.codigoInterno,
      ":character_name": params.characterName || "",
      ":data_type": params.dataType || "",
      ":data_json": dataJson,
      ":raw_xml": params.rawXml ?? null,
      ":sync_source": params.syncSource || "auto",
      ":is_open_in_tab": params.isOpenInTab ? 1 : 0,
      ":last_updated_at": now,
    }
  );

  // Se houver personagem correspondente no MCP, atualiza os dados básicos
  try {
    const existingChar = queryOne<any>(
      `SELECT id FROM characters WHERE room_id = ? AND (sheet_codigo = ? OR name = ?) LIMIT 1`,
      [params.roomId, params.codigoInterno, params.characterName]
    );
    if (existingChar) {
      run(
        `UPDATE characters SET
          sheet_codigo = :sheet_codigo,
          sheet_data_type = :sheet_data_type,
          updated_at = :updated_at
        WHERE id = :id`,
        {
          ":id": existingChar.id,
          ":sheet_codigo": params.codigoInterno,
          ":sheet_data_type": params.dataType,
          ":updated_at": now,
        }
      );
    }
  } catch {}
}

export function applySheetDeltas(params: {
  roomId: number;
  codigoInterno: number;
  characterName?: string;
  dataType?: string;
  syncSource?: string;
  isOpenInTab?: boolean;
  changes: Record<string, any>;
  timestamp?: number;
}): void {
  const now = params.timestamp ?? Math.floor(Date.now() / 1000);

  const existing = queryOne<{ data_json: string; character_name: string; data_type: string }>(
    `SELECT data_json, character_name, data_type FROM character_sheets WHERE room_id = ? AND codigo_interno = ?`,
    [params.roomId, params.codigoInterno]
  );

  let currentData: any = {};
  if (existing?.data_json) {
    try {
      currentData = JSON.parse(existing.data_json);
    } catch {
      currentData = {};
    }
  }

  applyNestedDeltas(currentData, params.changes);
  const updatedJson = JSON.stringify(currentData);

  run(
    `INSERT INTO character_sheets (
      room_id, codigo_interno, character_name, data_type, data_json, sync_source, is_open_in_tab, last_updated_at
    ) VALUES (
      :room_id, :codigo_interno, :character_name, :data_type, :data_json, :sync_source, :is_open_in_tab, :last_updated_at
    ) ON CONFLICT(room_id, codigo_interno) DO UPDATE SET
      character_name = COALESCE(:character_name, character_sheets.character_name),
      data_type = COALESCE(:data_type, character_sheets.data_type),
      data_json = :data_json,
      sync_source = COALESCE(:sync_source, character_sheets.sync_source),
      is_open_in_tab = COALESCE(:is_open_in_tab, character_sheets.is_open_in_tab),
      last_updated_at = :last_updated_at`,
    {
      ":room_id": params.roomId,
      ":codigo_interno": params.codigoInterno,
      ":character_name": params.characterName || existing?.character_name || "",
      ":data_type": params.dataType || existing?.data_type || "",
      ":data_json": updatedJson,
      ":sync_source": params.syncSource || "auto",
      ":is_open_in_tab": params.isOpenInTab !== undefined ? (params.isOpenInTab ? 1 : 0) : null,
      ":last_updated_at": now,
    }
  );
}

export function getSheetFromDb(roomId: number, codigoInterno: number): CharacterSheetRow | null {
  const row = queryOne<any>(
    `SELECT * FROM character_sheets WHERE room_id = ? AND codigo_interno = ?`,
    [roomId, codigoInterno]
  );
  if (!row) return null;

  let parsedData: any = {};
  try {
    parsedData = JSON.parse(row.data_json);
  } catch {}

  return {
    room_id: row.room_id,
    codigo_interno: row.codigo_interno,
    character_name: row.character_name,
    data_type: row.data_type,
    data: parsedData,
    raw_xml: row.raw_xml,
    sync_source: row.sync_source,
    is_open_in_tab: !!row.is_open_in_tab,
    last_updated_at: row.last_updated_at,
  };
}

export function listSheetsFromDb(roomId?: number | null): CharacterSheetRow[] {
  let rows: any[];
  if (roomId) {
    rows = query<any>(
      `SELECT * FROM character_sheets WHERE room_id = ? ORDER BY last_updated_at DESC, character_name ASC`,
      [roomId]
    );
  } else {
    rows = query<any>(
      `SELECT * FROM character_sheets ORDER BY last_updated_at DESC, character_name ASC`
    );
  }

  return rows.map((row) => {
    let parsedData: any = {};
    try {
      parsedData = JSON.parse(row.data_json);
    } catch {}

    return {
      room_id: row.room_id,
      codigo_interno: row.codigo_interno,
      character_name: row.character_name,
      data_type: row.data_type,
      data: parsedData,
      raw_xml: row.raw_xml,
      sync_source: row.sync_source,
      is_open_in_tab: !!row.is_open_in_tab,
      last_updated_at: row.last_updated_at,
    };
  });
}


