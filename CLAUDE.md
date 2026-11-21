# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes the Firecast (Brazilian virtual tabletop RPG client) plugin SDK3 to AI agents. Two halves that never talk directly — they exchange JSON files through a shared folder:

```
Agent ←stdio→ server.exe (Node/TS, server/)  ⇄  <VHD>/mcp/inbox|outbox  ⇄  Lua plugin (src/, runs inside Firecast)
```

Code comments, tool descriptions and user-facing strings are in Portuguese (pt-BR); keep that convention.

## Commands

All server commands run from `server/`:

```bash
npm install
npm run build        # tsc → dist/
npm run dev          # tsx src/index.ts (stdio MCP mode)
npm run pkg          # build + esbuild bundle + pkg → ../src/server.exe (node18-win-x64)
npm run rpk:build    # rdk.exe -c in src/ → packages the plugin .rpk (src/output/)
npm run rpk:install  # rdk.exe -i → installs the .rpk into the local Firecast
node dist/index.js --http --port 3060   # HTTP debug mode (see below)
node dist/index.js --path <dir>         # override bridge dir
```

There is no test suite and no linter. Verification = `npm run build` (type-check) plus exercising tools against a running Firecast, usually via HTTP mode: `curl -X POST localhost:3060/call -H "Content-Type: application/json" -d '{"name":"list_rooms","arguments":{"fresh":true}}'`. `POST /command {"command","args"}` sends a raw bridge command; `POST /simulate-event` writes a fake outbox event; `GET /inbox`, `/outbox`, `/db/{rooms,events,messages,characters,sheets}` inspect state.

`rdk.exe` (Firecast SDK3 tool) lives in `%LOCALAPPDATA%\FirecastSDK3\`. Full release flow: `npm run pkg` → `npm run rpk:build` → `npm run rpk:install` → restart Firecast / reload plugin.

## Using this MCP from Claude Code

`.mcp.json` registers the deployed binary `${APPDATA}/Firecast/Plugins/com.tkplayer.firecast_mcp_vhd/mcp/server.exe` as the `firecast` server. Tools only return live data when Firecast is open with the plugin loaded (the plugin polls the inbox every 500 ms); otherwise bridge calls time out after 30 s, while cache-first tools (`list_rooms`, `get_room`, characters) still answer from SQLite. To run against uncompiled source instead, point the command at `npx tsx server/src/index.ts` — bridge-path discovery finds the same VHD folder.

Note: the README's Claude Desktop path (`com.tkplayer.firecast-mcp\mcp\server.exe`) is outdated; the real writable location is the `_vhd` folder above.

## Architecture

### Bridge protocol (file-based RPC)
- **Request**: `server/src/bridge.ts` `sendCommand(command, args, timeoutMs)` writes `inbox/<uuid>.<command>.json` = `{id, command, args}` and registers a callback.
- **Plugin side**: `src/plugin/init.lua` starts an `rrpgObjs.newTimer` (500 ms) calling `bridge.tick()` in `src/plugin/bridge.lua`, which drains the inbox (read + delete), dispatches to handlers registered with `bridge.registerCommand`, and emits `outbox/<ts>-<id>.command_result.json` = `{id, type, ts, data:{id, success, result|error}}`.
- **Handler contract (Lua)**: `handler(args, reply)` may return a value (sync result), return an SDK3 Promise (`thenDo`/`onError`), or return `nil` and call `reply(ok, res)` later. Errors thrown are caught and returned as `success:false`.
- **Response**: `server/src/watcher.ts` uses `fs.watch` + 300 ms polling (fs.watch is unreliable on the VHD), parses, deletes, and routes by `type`: `command_result` resolves the pending promise; `room_joined/room_parted/chat_message/sheet_snapshot/sheet_change` are persisted to SQLite. Unknown types are ignored. Partially written files fail JSON.parse and are retried next poll.
- Push events are currently **disabled**: `registerEvents()` in `src/plugin/init.lua` has the listeners commented out, so SQLite is only populated by tool calls, not by live Firecast activity.

### Bridge path & config
`index.ts` resolves the bridge dir: `--path` → `FIRECAST_BRIDGE_PATH` → `%APPDATA%/Firecast/Plugins/com.tkplayer.firecast_mcp_vhd/mcp` (if exists) → exe dir (when pkg'd) → cwd. In Lua the same folder is just `/mcp/` on the plugin's VHD. `config.json` there is shared by both sides (`config.ts` / `loadConfig` in Lua; the `/mcp` chat command and the dock panel `src/controlPanel.lfm` write it). DB path: `FIRECAST_DB_PATH` → `config.db_path` → `<bridge>/firecast.db`.

### Server
- `db.ts`: sql.js (pure WASM, inline build so `pkg` needs no external files). Whole DB is exported and rewritten to disk after every write. Tables: `rooms`, `room_events`, `chat_messages`, `characters` (server-local NPC/character manager, not Firecast data), `character_sheets` (NDB snapshots + deltas).
- `tools/*.ts`: each exports `handleXxx` functions plus a `registerXxxTools(server)` that wraps them with zod schemas. Many are cache-first with a `fresh` flag.
- `template.ts`: reads installed `.rpk` files (zip, via adm-zip) under `%APPDATA%/Firecast/Plugins` to extract sheet-template schemas — runs server-side, no bridge.
- `storage/gdrive.ts`: media uploads go to a locally mounted Google Drive for Desktop (reads DriveFS's SQLite to get file IDs, no network API) with fallback to FireDrive via the `quick_upload` bridge command.
- `http.ts`: debug HTTP server. Its `/call` dispatcher, `/tools` and `/status` listings are **hand-maintained duplicates** of the MCP registrations; `/mcp` JSON-RPC only supports `list_rooms`/`get_room`.

### Adding a tool that needs Firecast
Touch all of: Lua handler in `src/plugin/commands/<domain>.lua` → `bridge.registerCommand(...)` in `src/plugin/init.lua` → `handleXxx` + `server.tool(...)` in `server/src/tools/<domain>.ts` (register function called from `index.ts`) → the `/call` branch (and `/tools` entry) in `http.ts`. Bridge command names (snake_case) don't always match MCP tool names (e.g. MCP `get_character_sheet` → bridge `sync_sheet`/`get_sheet_ndb`).

### Lua plugin
- `src/module.xml` defines plugin id `com.tkplayer.firecast_mcp` and version — bump `<version>` on release. Its writable VHD is `com.tkplayer.firecast_mcp_vhd`.
- `src/init.lua` → `src/plugin/init.lua` is the entry point. Everything is wrapped in `pcall` and logged to `<VHD>/mcp/debug.txt` (truncated on each init) — check it first when the plugin seems dead.
- `src/sdk/` is the vendored Firecast SDK3 Lua bridge (copied by `rdk p`); don't edit it. Use it (and `docs/scraped_html/`, gitignored scraped SDK3 docs, plus `docs/Firecast_decompilado/`) as API reference.
- Timer reference is stored in `_G._firecastMcpTimer` so reloads disable the old timer and the GC doesn't kill it.

## Pitfalls
- **server.exe deployment compares file size only.** The plugin copies `/server.exe` from the .rpk to `/mcp/server.exe` only when sizes differ; an identical-size rebuild won't be redeployed (delete the VHD copy). Also a running `server.exe` locks the file — stop MCP clients before reinstalling.
- `src/server.exe` (~40 MB) is committed because it is packed into the .rpk.
- **Mutating commands are guarded in Lua**: `edit_sheet_ndb`, `edit_dock_ndb`, `manage_library_item`, `manage_room` refuse unless the room is the test table `tttttaaaaa` (id `239256`) or the user is master (`meuJogador.isMestre`). Use room 239256 for experiments; don't write to real campaign tables without asking.
- In stdio mode stdout is the MCP channel — log only to stderr.
- Lua timestamps are `os.time()` seconds; keep `ts` fields in seconds.
