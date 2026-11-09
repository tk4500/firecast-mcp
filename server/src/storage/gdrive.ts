// gdrive.ts
// Integração local com Google Drive para Computador (Desktop)
// Lê metadados diretamente do SQLite local do DriveFS (zero chamadas de rede/API externa)

// @ts-ignore
import initSqlJs from "sql.js/dist/sql-wasm-inline.js";
import type { Database, SqlJsStatic } from "sql.js";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

export interface GDriveDetection {
  available: boolean;
  dbPath?: string;
  driveLetter?: string;
  driveRoot?: string;
  defaultAssetsPath?: string;
  accountId?: string;
  totalItems?: number;
  error?: string;
}

export interface GDriveFileResult {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  path: string;
  embed_url: string;
  download_url: string;
  view_url: string;
  talemark_image: string;
  talemark_link: string;
  local_path?: string;
}

export interface SaveToGDriveOptions {
  filePath?: string;
  contentBase64?: string;
  filename?: string;
  subfolder?: string;
  assetsDir?: string;
  timeoutSeconds?: number;
}

let cachedSQL: SqlJsStatic | null = null;
let cachedDb: Database | null = null;
let cachedDbMtime: number = 0;
let cachedDbSize: number = 0;
let cachedDbPath: string | null = null;

/**
 * Detecta a instalação do Google Drive para Desktop no Windows.
 */
export function detectGDrive(): GDriveDetection {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return { available: false, error: "Variável LOCALAPPDATA não encontrada." };
  }

  const driveFsBase = path.join(localAppData, "Google", "DriveFS");
  if (!fs.existsSync(driveFsBase)) {
    return { available: false, error: `Diretório DriveFS não encontrado: ${driveFsBase}` };
  }

  let accountId: string | undefined;
  let dbPath: string | undefined;

  try {
    const entries = fs.readdirSync(driveFsBase);
    for (const entry of entries) {
      const candidateDb = path.join(driveFsBase, entry, "metadata_sqlite_db");
      if (fs.existsSync(candidateDb)) {
        accountId = entry;
        dbPath = candidateDb;
        break;
      }
    }
  } catch (err) {
    return { available: false, error: `Erro ao escanear DriveFS: ${err}` };
  }

  if (!dbPath) {
    return { available: false, error: "metadata_sqlite_db não encontrado em nenhuma conta do DriveFS." };
  }

  // Detecta a letra da unidade virtual do Google Drive (geralmente G:, mas pode ser outra)
  let driveLetter = "G:";
  let driveRoot: string | undefined;

  // Letras candidatas comuns
  const candidateLetters = ["G:", "H:", "I:", "J:", "F:", "E:"];
  for (const letter of candidateLetters) {
    const meuDrive = path.join(letter + "\\", "Meu Drive");
    const myDrive = path.join(letter + "\\", "My Drive");
    if (fs.existsSync(meuDrive)) {
      driveLetter = letter;
      driveRoot = meuDrive;
      break;
    }
    if (fs.existsSync(myDrive)) {
      driveLetter = letter;
      driveRoot = myDrive;
      break;
    }
  }

  if (!driveRoot) {
    if (fs.existsSync(driveLetter + "\\")) {
      driveRoot = path.join(driveLetter + "\\", "Meu Drive");
    } else {
      driveRoot = "G:\\Meu Drive";
    }
  }

  const defaultAssetsPath = path.join(driveRoot, "Firecast Assets").replace(/\\/g, "/");

  return {
    available: true,
    dbPath,
    driveLetter,
    driveRoot: driveRoot.replace(/\\/g, "/"),
    defaultAssetsPath,
    accountId,
  };
}

/**
 * Tenta executar consulta rápida através do interpretador Python local caso disponível.
 * Isso lê o banco SQLite nativo incluindo transações ativas do arquivo WAL instantaneamente.
 */
function tryQueryViaPython(dbPath: string, targetPath: string): {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
} | null {
  const pyCode = `
import sqlite3, json, sys

db_path = sys.argv[1]
target_path = sys.argv[2].replace("\\\\", "/").strip("/")
parts = [p for p in target_path.split("/") if p and not p.endswith(":")]
if not parts:
    print(json.dumps(None))
    sys.exit(0)

filename = parts[-1]

try:
    conn = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
    c = conn.cursor()
    candidates = c.execute("SELECT stable_id, id, local_title, mime_type, file_size FROM items WHERE local_title = ? AND trashed = 0", (filename,)).fetchall()
    matched = None
    for stable_id, file_id, title, mime_type, size in candidates:
        curr = stable_id
        path_rev = [title]
        while True:
            parent = c.execute("SELECT parent_stable_id FROM stable_parents WHERE item_stable_id = ?", (curr,)).fetchone()
            if not parent:
                break
            p_item = c.execute("SELECT local_title FROM items WHERE stable_id = ?", (parent[0],)).fetchone()
            if not p_item:
                break
            path_rev.append(p_item[0])
            curr = parent[0]
        full_match = "/".join(reversed(path_rev))
        if len(parts) == 1 or target_path.lower().endswith(full_match.lower()):
            matched = {
                "id": file_id,
                "name": title,
                "mime": mime_type,
                "size": size,
                "path": full_match
            }
            break
    print(json.dumps(matched))
except Exception as e:
    print(json.dumps(None))
`;

  const commands = ["python3", "python", "py"];
  for (const cmd of commands) {
    try {
      const res = spawnSync(cmd, ["-c", pyCode, dbPath, targetPath], {
        timeout: 4000,
        encoding: "utf8",
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        if (parsed && parsed.id) {
          return parsed;
        }
      }
    } catch {
      // Tenta próximo comando
    }
  }

  return null;
}

/**
 * Obtém ou recarrega a instância do banco metadata_sqlite_db via sql.js (somente-leitura).
 */
export async function getDriveDbInstance(targetDbPath?: string): Promise<Database | null> {
  const dbPathToUse = targetDbPath ?? detectGDrive().dbPath;
  if (!dbPathToUse || !fs.existsSync(dbPathToUse)) {
    return null;
  }

  try {
    const stat = fs.statSync(dbPathToUse);
    if (
      cachedDb &&
      cachedDbPath === dbPathToUse &&
      cachedDbMtime === stat.mtimeMs &&
      cachedDbSize === stat.size
    ) {
      return cachedDb;
    }

    if (!cachedSQL) {
      cachedSQL = await initSqlJs();
    }
    const sqlInstance = cachedSQL!;

    const buffer = fs.readFileSync(dbPathToUse);
    if (cachedDb) {
      try {
        cachedDb.close();
      } catch {
        // Ignora erro ao fechar versão anterior
      }
    }

    cachedDb = new sqlInstance.Database(buffer);
    cachedDbPath = dbPathToUse;
    cachedDbMtime = stat.mtimeMs;
    cachedDbSize = stat.size;

    return cachedDb;
  } catch (err) {
    process.stderr.write(`[Firecast GDrive] Erro ao carregar metadata_sqlite_db: ${err}\n`);
    return null;
  }
}

/**
 * Força a invalidação do cache do banco de dados do Drive.
 */
export function invalidateDbCache(): void {
  cachedDbMtime = 0;
  cachedDbSize = 0;
}

/**
 * Resolve os metadados e links de um arquivo localizado no Google Drive para Computador.
 * Aceita caminho absoluto (ex: "G:/Meu Drive/Fotos/token.png") ou relativo ao Meu Drive.
 */
export async function resolveGDriveFile(
  targetPathOrFilename: string,
  customDbPath?: string
): Promise<GDriveFileResult | null> {
  const detection = detectGDrive();
  const dbPathToUse = customDbPath ?? detection.dbPath;
  if (!dbPathToUse) return null;

  // 1. Tenta consulta direta via Python nativo (lê o banco e arquivo WAL instantaneamente)
  const pyResult = tryQueryViaPython(dbPathToUse, targetPathOrFilename);
  if (pyResult && pyResult.id) {
    const fileId = pyResult.id;
    const isImage =
      (pyResult.mime || "").startsWith("image/") ||
      /\.(png|jpg|jpeg|gif|webp)$/i.test(pyResult.name);
    // lh3.googleusercontent.com/d/<ID>=w1600 entrega HTTP 200 direto pelo CDN do Google sem redirecionamento 302
    const embedUrl = `https://lh3.googleusercontent.com/d/${fileId}=w1600`;
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&confirm=t`;
    const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;

    return {
      id: fileId,
      name: pyResult.name,
      mime_type: pyResult.mime || (isImage ? "image/png" : "application/octet-stream"),
      size: pyResult.size || 0,
      path: pyResult.path,
      embed_url: embedUrl,
      download_url: downloadUrl,
      view_url: viewUrl,
      talemark_image: `[§I ${embedUrl}]`,
      talemark_link: `[§B]📁 [${pyResult.name}](${downloadUrl})[§R]`,
    };
  }

  // 2. Fallback: sql.js WASM autônomo (caso Python não esteja disponível)
  const db = await getDriveDbInstance(dbPathToUse);
  if (!db) return null;

  // Normaliza o caminho
  const clean = targetPathOrFilename.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/").filter((p) => p && !p.endsWith(":"));
  if (parts.length === 0) return null;

  const filename = parts[parts.length - 1];

  let stmt;
  const candidates: Array<{
    stable_id: number;
    id: string;
    local_title: string;
    mime_type: string;
    file_size: number;
  }> = [];

  try {
    stmt = db.prepare(
      "SELECT stable_id, id, local_title, mime_type, file_size FROM items WHERE local_title = :title AND trashed = 0"
    );
    stmt.bind({ ":title": filename });
    while (stmt.step()) {
      candidates.push(stmt.getAsObject() as any);
    }
    stmt.free();
  } catch (err) {
    if (stmt) stmt.free();
    process.stderr.write(`[Firecast GDrive] Erro na consulta de arquivo: ${err}\n`);
    return null;
  }

  if (candidates.length === 0) {
    return null;
  }

  for (const cand of candidates) {
    // Reconstrói a árvore de diretórios subindo pelos pais
    let curr = cand.stable_id;
    const pathRev: string[] = [cand.local_title];

    while (true) {
      let pStmt;
      let parentStableId: number | null = null;
      try {
        pStmt = db.prepare("SELECT parent_stable_id FROM stable_parents WHERE item_stable_id = :curr");
        pStmt.bind({ ":curr": curr });
        if (pStmt.step()) {
          parentStableId = (pStmt.getAsObject() as any).parent_stable_id;
        }
        pStmt.free();
      } catch {
        if (pStmt) pStmt.free();
        break;
      }

      if (!parentStableId) break;

      let itemStmt;
      let parentTitle: string | null = null;
      try {
        itemStmt = db.prepare("SELECT local_title FROM items WHERE stable_id = :id");
        itemStmt.bind({ ":id": parentStableId });
        if (itemStmt.step()) {
          parentTitle = (itemStmt.getAsObject() as any).local_title;
        }
        itemStmt.free();
      } catch {
        if (itemStmt) itemStmt.free();
        break;
      }

      if (!parentTitle) break;
      pathRev.push(parentTitle);
      curr = parentStableId;
    }

    const fullMatch = pathRev.reverse().join("/");
    const targetNorm = parts.join("/");

    // Se passou apenas o nome do arquivo ou se o final do caminho coincide
    if (parts.length === 1 || targetNorm.toLowerCase().endsWith(fullMatch.toLowerCase())) {
      const fileId = cand.id;
      const isImage = (cand.mime_type || "").startsWith("image/");
      // lh3.googleusercontent.com/d/<ID>=w1600 entrega HTTP 200 direto pelo CDN do Google sem redirecionamento 302
      const embedUrl = `https://lh3.googleusercontent.com/d/${fileId}=w1600`;
      const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&confirm=t`;
      const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;

      return {
        id: fileId,
        name: cand.local_title,
        mime_type: cand.mime_type || (isImage ? "image/png" : "application/octet-stream"),
        size: cand.file_size || 0,
        path: fullMatch,
        embed_url: embedUrl,
        download_url: downloadUrl,
        view_url: viewUrl,
        talemark_image: `[§I ${embedUrl}]`,
        talemark_link: `[§B]📁 [${cand.local_title}](${downloadUrl})[§R]`,
      };
    }
  }

  return null;
}

/**
 * Salva um arquivo qualquer (local ou base64) dentro da pasta do Google Drive
 * e aguarda o Google Drive para Desktop sincronizar o ID remoto.
 */
export async function saveToGDrive(options: SaveToGDriveOptions): Promise<GDriveFileResult> {
  const detection = detectGDrive();
  if (!detection.available) {
    throw new Error(`Google Drive para Desktop não está disponível: ${detection.error}`);
  }

  const targetBaseDir = options.assetsDir || detection.defaultAssetsPath || "G:/Meu Drive/Firecast Assets";
  const finalDir = options.subfolder ? path.join(targetBaseDir, options.subfolder) : targetBaseDir;

  if (!fs.existsSync(finalDir)) {
    fs.mkdirSync(finalDir, { recursive: true });
  }

  let filename = options.filename;
  if (!filename && options.filePath) {
    filename = path.basename(options.filePath);
  }
  if (!filename) {
    filename = `upload_${Date.now()}.png`;
  }

  const destFilePath = path.join(finalDir, filename).replace(/\\/g, "/");

  // Se o arquivo de origem já estiver no mesmo caminho de destino, não precisa copiar
  const sourceIsSame = options.filePath && path.resolve(options.filePath) === path.resolve(destFilePath);

  if (!sourceIsSame) {
    if (options.contentBase64) {
      const buffer = Buffer.from(options.contentBase64, "base64");
      fs.writeFileSync(destFilePath, buffer);
    } else if (options.filePath) {
      if (!fs.existsSync(options.filePath)) {
        throw new Error(`Arquivo de origem não encontrado: ${options.filePath}`);
      }
      fs.copyFileSync(options.filePath, destFilePath);
    } else {
      throw new Error("Nenhum arquivo fornecido (informe filePath ou contentBase64).");
    }
  }

  // Aguarda a sincronização do Google Drive (o arquivo recebe um ID real em metadata_sqlite_db)
  const timeoutMs = (options.timeoutSeconds ?? 25) * 1000;
  const pollIntervalMs = 800;
  const start = Date.now();

  let lastResult: GDriveFileResult | null = null;

  while (Date.now() - start < timeoutMs) {
    invalidateDbCache(); // Força releitura do banco local do Drive
    lastResult = await resolveGDriveFile(destFilePath);

    // Se encontrou o item e o ID não é o temporário "local-XXXX"
    if (lastResult && lastResult.id && !lastResult.id.startsWith("local-")) {
      lastResult.local_path = destFilePath;
      return lastResult;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Se o timeout estourou mas já temos um resultado (mesmo que com ID local provisório)
  if (lastResult) {
    lastResult.local_path = destFilePath;
    return lastResult;
  }

  throw new Error(
    `Tempo limite excedido (${options.timeoutSeconds ?? 25}s) aguardando sincronização do Google Drive para '${filename}'. O arquivo foi copiado para '${destFilePath}'.`
  );
}

/**
 * Lista arquivos armazenados na pasta de assets do Google Drive.
 */
export async function listGDriveFiles(options?: {
  subfolder?: string;
  assetsDir?: string;
  limit?: number;
}): Promise<GDriveFileResult[]> {
  const detection = detectGDrive();
  if (!detection.available) return [];

  const targetBaseDir = options?.assetsDir || detection.defaultAssetsPath || "G:/Meu Drive/Firecast Assets";
  const finalDir = options?.subfolder ? path.join(targetBaseDir, options.subfolder) : targetBaseDir;

  if (!fs.existsSync(finalDir)) {
    return [];
  }

  const entries = fs.readdirSync(finalDir);
  const results: GDriveFileResult[] = [];
  const limit = options?.limit ?? 50;

  for (const entry of entries) {
    if (results.length >= limit) break;
    const fullPath = path.join(finalDir, entry).replace(/\\/g, "/");
    try {
      if (fs.statSync(fullPath).isFile()) {
        const res = await resolveGDriveFile(fullPath);
        if (res) {
          res.local_path = fullPath;
          results.push(res);
        }
      }
    } catch {
      // Ignora erro de arquivo individual
    }
  }

  return results;
}
