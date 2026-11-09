// config.ts
// Gerenciamento centralizado do config.json compartilhado entre o plugin Lua e o servidor Node.js

import fs from "fs";
import path from "path";

export interface AppConfig {
  poll_interval_ms?: number;
  http_port?: number;
  db_path?: string;
  version?: string;
  storage_provider?: "auto" | "gdrive" | "firedrive";
  gdrive_assets_path?: string;
  [key: string]: unknown;
}

let activeBridgeDir: string = "";

export function setActiveBridgeDir(dir: string): void {
  activeBridgeDir = dir;
}

export function getActiveBridgeDir(): string {
  return activeBridgeDir;
}

export function getConfigPath(): string {
  return path.join(activeBridgeDir || process.cwd(), "config.json");
}

export function readConfig(bridgeDir?: string): AppConfig {
  const dir = (bridgeDir && bridgeDir.trim() !== "") ? bridgeDir : (activeBridgeDir && activeBridgeDir.trim() !== "") ? activeBridgeDir : process.cwd();
  const configPath = path.join(dir, "config.json");

  if (!fs.existsSync(configPath)) {
    const defaultConfig: AppConfig = {
      poll_interval_ms: 500,
      http_port: 3000,
      version: "1.0.0",
      storage_provider: "auto",
      gdrive_assets_path: "G:/Meu Drive/Firecast Assets",
    };
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
      return defaultConfig;
    } catch (err) {
      process.stderr.write(`[Firecast MCP] Aviso: erro ao criar config.json inicial: ${err}\n`);
      return defaultConfig;
    }
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as AppConfig;
  } catch (err) {
    process.stderr.write(`[Firecast MCP] Aviso: erro ao ler config.json: ${err}\n`);
    return {
      storage_provider: "auto",
      gdrive_assets_path: "G:/Meu Drive/Firecast Assets",
    };
  }
}

export function updateConfig(updates: Partial<AppConfig>): AppConfig {
  const current = readConfig();
  const next: AppConfig = {
    ...current,
    ...updates,
  };

  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    process.stderr.write(`[Firecast MCP] Erro ao atualizar config.json: ${err}\n`);
  }

  return next;
}
