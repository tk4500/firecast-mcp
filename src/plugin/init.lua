-- init.lua
-- Entry point do plugin Firecast MCP
-- Inicializa a bridge, copia o server.exe para o VHD gravável, e sobe o timer de polling.

local bridge  = require("plugin/bridge.lua");
local rooms   = require("plugin/commands/rooms.lua");
local rrpgObjs = require("sdk/rrpgObjs.lua");

local POLL_INTERVAL_MS = 500;

-- Copia o server.exe do RPK (read-only) para mcp/ (gravável) se ainda não estiver lá
local function deployServer()
    local VHD = require("sdk/vhd.lua");
    local SRC = "server.exe";      -- caminho dentro do .rpk / VHD read-only
    local DST = "mcp/server.exe";  -- destino gravável

    if not VHD.fileExists(DST) then
        pcall(VHD.copyFile, SRC, DST);
        -- silencioso: pode falhar se já foi copiado ou se não existe ainda
    end
end

-- Registra todos os comandos no bridge
local function registerCommands()
    bridge.registerCommand("list_rooms", rooms.listRooms);
    bridge.registerCommand("get_room",   rooms.getRoom);
end

-- Registra listeners de eventos
local function registerEvents()
    rooms.registerEvents(bridge);
end

-- Inicializa tudo
local function init()
    bridge.init();
    deployServer();
    registerCommands();
    registerEvents();

    -- Timer de polling do inbox — usa addEventListener conforme SDK3
    local timer = rrpgObjs.newTimer(POLL_INTERVAL_MS, function()
        bridge.tick();
    end);
end

init();
