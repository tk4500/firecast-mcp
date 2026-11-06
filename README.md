# Firecast MCP

MCP server que expõe os métodos de plugin do Firecast para agentes de IA (Claude, Hermes, etc.).

## Arquitetura

```
Agente (Claude/Hermes) ←stdio→ server.exe (Node.js MCP)
                                     ↕ (inbox/outbox files)
                          Plugin Lua ↔ Firecast SDK3
```

- **Plugin Lua** (`src/plugin/`) roda dentro do Firecast, cria pastas `inbox/` e `outbox/` no VHD
- **Servidor MCP** (`server/`) empacotado como `server.exe`, roda como processo separado
- **Bridge** via arquivos: servidor escreve comandos em `inbox/`, plugin lê e executa, escreve resultado em `outbox/`
- **SQLite local** (`firecast.db`) cacheia eventos e dados estruturados para queries rápidas sem bater no Firecast

## Fase 1 — Mesas (Implementado)

### Tools MCP
- `list_rooms` — lista todas as mesas abertas (cache-first)
- `get_room` — detalhes de uma mesa por ID

### Eventos capturados
- `room_joined` — alguém entrou em uma mesa
- `room_parted` — alguém saiu de uma mesa

### Schema SQLite
- `rooms` — cache de mesas (id, nome, sistema, etc.)
- `room_events` — log de eventos (entrada/saída de jogadores)

## Configuração

### Localização do banco de dados

O banco de dados SQLite (`firecast.db`) pode ser configurado de três formas:

1. **Pelo Chat do Firecast (Recomendado):**
   Dentro de qualquer chat no Firecast, digite:
   - `/mcp status` — exibe o local atual do banco de dados e status do plugin.
   - `/mcp db D:/MinhaPasta/firecast.db` — altera o caminho do banco. O plugin salva em `mcp/config.json`.
   - `/mcp db reset` — restaura para o local padrão (`<VHD>/mcp/firecast.db`).

2. **Pelo arquivo `mcp/config.json` no VHD:**
   ```json
   {
     "db_path": "D:/MinhaPasta/firecast.db",
     "poll_interval_ms": 500,
     "http_port": 3000
   }
   ```

3. **Por variável de ambiente:**
   ```bash
   export FIRECAST_DB_PATH="D:/MinhaPasta/firecast.db"
   ```

## Modos de Execução do Servidor

### 1. Modo Padrão (stdio) — Para Agentes de IA
Utilizado pelo Claude Desktop, Hermes e outros clientes MCP:
```bash
server.exe
```

### 2. Modo HTTP (`--http`) — Para Testes e Depuração
Permite testar o servidor diretamente via navegador, curl ou scripts sem precisar de um cliente MCP:
```bash
server.exe --http --port 3000
```

Rotas disponíveis no modo HTTP:
- `GET /status` — exibe status, versão, caminhos do VHD/banco e ferramentas registradas.
- `GET /tools` — lista os schemas JSON das ferramentas MCP.
- `POST /call` — executa uma ferramenta diretamente:
  ```bash
  curl -X POST http://localhost:3000/call -H "Content-Type: application/json" -d '{"name": "list_rooms", "arguments": {}}'
  ```
- `GET /db/rooms` — inspeciona todas as mesas cacheadas no SQLite.
- `GET /db/events` — inspeciona os últimos eventos de mesa recebidos no SQLite.
- `GET /inbox` e `GET /outbox` — lista arquivos pendentes nas pastas de sincronização.
- `POST /simulate-event` — injeta um evento simulado para testar o watcher e a persistência.
- `POST /mcp` — endpoint MCP JSON-RPC completo via HTTP POST.

## Build

### Servidor

```bash
cd server
npm install
npm run build
npm run pkg  # gera server.exe
```

O `server.exe` vai para `../src/server.exe` (dentro do `.rpk`).

### Plugin

Empacote `src/` como `.rpk` seguindo as instruções do Firecast SDK3.

## Uso

### Com Claude Desktop

Edite `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou equivalente:

```json
{
  "mcpServers": {
    "firecast": {
      "command": "C:\\Users\\<USER>\\AppData\\Roaming\\Firecast\\Plugins\\com.tkplayer.firecast-mcp\\mcp\\server.exe"
    }
  }
}
```

### Com Hermes Agent

```bash
hermes config set mcp.servers.firecast.command "C:\\Users\\<USER>\\AppData\\Roaming\\Firecast\\Plugins\\com.tkplayer.firecast-mcp\\mcp\\server.exe"
```

## Roadmap

- **Fase 1**: Mesas ✅
- **Fase 2**: Rolagens de dados (`roll_dice`, evento `dice_rolled`)
- **Fase 3**: Chat (`send_chat`, `get_messages`, evento `chat_message`)
- **Fase 4**: Personagens/NDB (`list_characters`, `get_character`, `set_character_attr`)
- **Fase 5**: Cenas/Tabuleiro (tokens, fog of war)
- **Fase 6**: Áudio (play SFX, trilha)

## Estrutura de pastas no VHD

```
<VHD>/
├── mcp/
│   ├── server.exe          ← MCP server empacotado
│   ├── config.lua          ← configuração (db_path, etc.)
│   ├── firecast.db         ← SQLite (cache de eventos)
│   ├── inbox/              ← comandos do servidor → plugin
│   │   └── <uuid>.<command>.json
│   └── outbox/             ← eventos do plugin → servidor
│       └── <ts>-<id>.<type>.json
└── plugin/
    ├── init.lua
    ├── bridge.lua
    └── commands/
        └── rooms.lua
```

## Desenvolvimento

### Testar servidor localmente

```bash
cd server
npm run dev  # ou: node dist/index.js
```

Com bridge path customizado:

```bash
FIRECAST_BRIDGE_PATH="C:/Users/<USER>/AppData/Roaming/Firecast/Plugins/com.tkplayer.firecast-mcp/mcp" \
SQLJS_WASM_PATH="$(pwd)/node_modules/sql.js/dist/sql-wasm.wasm" \
node dist/index.js
```

### Testar protocolo MCP

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node dist/index.js
```

## Licença

MIT
