// bridge.ts
// Escreve comandos na pasta inbox/ e aguarda o resultado correspondente no outbox.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { onCommandResult, removeResultCallback } from "./watcher.js";

let inboxDir: string;

export function initBridge(bridgePath: string): void {
  inboxDir = path.join(bridgePath, "mcp", "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
}

export function sendCommand(
  command: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const fileName = `${id}.${command}.json`;
    const filePath = path.join(inboxDir, fileName);

    const payload = JSON.stringify({ id, command, args });

    const timer = setTimeout(() => {
      removeResultCallback(id);
      reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    onCommandResult(id, (event) => {
      clearTimeout(timer);
      const data = event.data as { success: boolean; result?: unknown; error?: string };
      if (data.success) {
        resolve(data.result);
      } else {
        reject(new Error(data.error ?? "unknown error"));
      }
    });

    // Escreve o arquivo de comando (atômico via rename não disponível no SDK Lua,
    // mas o nome único garante que não haverá conflito de leitura parcial)
    fs.writeFileSync(filePath, payload, "utf-8");
  });
}
