-- init.lua
-- Entry point do plugin Firecast MCP
-- Inicializa a bridge, gerencia o config.json, atualiza o server.exe no VHD e expõe comandos de chat.

local bridge = require("plugin/bridge.lua");
local rooms  = require("plugin/commands/rooms.lua");
local chat   = require("plugin/commands/chat.lua");
local ndb    = require("plugin/commands/ndb.lua");
local pluginsCmd = require("plugin/commands/plugins.lua");
local rrpgObjs = require("sdk/rrpgObjs.lua");
local Firecast = require("sdk/firecast.lua");
local VHD      = require("sdk/vhd.lua");
local json     = require("sdk/json.lua");

local POLL_INTERVAL_MS = 500;
local CONFIG_FILE = "/mcp/config.json";

-- Guarda referência forte para evitar que o Garbage Collector do Lua destrua o timer
local _pollTimer = nil;

-- 1. Gerenciamento do config.json no VHD
local function loadConfig()
    VHD.forceDirectory("/mcp");
    if VHD.fileExists(CONFIG_FILE) then
        local file = VHD.openFile(CONFIG_FILE, "r");
        if file ~= nil then
            local content = file:readBinary("utf8");
            file:close();
            if content ~= nil and content ~= "" then
                local ok, data = pcall(json.decode, content);
                if ok and type(data) == "table" then
                    return data;
                end
            end
        end
    end
    -- Valores padrão caso não exista
    return {
        poll_interval_ms = 500,
        http_port = 3000,
        version = "1.0.0"
    };
end

local function saveConfig(cfg)
    VHD.forceDirectory("/mcp");
    local file, msgError = VHD.openFile(CONFIG_FILE, "w+");
    if file ~= nil then
        file:writeBinary("utf8", json.encode(cfg));
        file:close();
        return true;
    else
        local Log = require("sdk/log.lua");
        Log.e("FirecastMCP", "Erro ao salvar config.json: " .. tostring(msgError));
    end
    return false;
end

-- 2. Copia / Atualiza o server.exe do RPK para o VHD gravável
local function deployServer()
    pcall(function()
        local SRC = "/server.exe";      -- raiz do .rpk
        local DST = "/mcp/server.exe";  -- destino gravável no VHD

        if not VHD.fileExists(SRC) then
            return;
        end

        local srcFile = nil;
        pcall(function() srcFile = VHD.openFile(SRC, "r"); end);
        if srcFile == nil then return; end
        local srcSize = srcFile.size;
        pcall(function() srcFile:close(); end);

        local needsCopy = true;
        if VHD.fileExists(DST) then
            local dstFile = nil;
            pcall(function() dstFile = VHD.openFile(DST, "r"); end);
            if dstFile ~= nil then
                local dstSize = dstFile.size;
                pcall(function() dstFile:close(); end);
                if dstSize == srcSize and srcSize > 0 then
                    needsCopy = false;
                end
            end
        end

        if needsCopy then
            VHD.forceDirectory("/mcp");
            local ok, err = pcall(VHD.copyFile, SRC, DST);
            if not ok then
                local Log = require("sdk/log.lua");
                Log.e("FirecastMCP", "Erro ao copiar server.exe: " .. tostring(err));
            end
        end
    end);
end

-- 3. Registra comandos de chat /mcp para configuração interativa no Firecast
local function registerChatCommands()
    -- Anuncia o comando no /help
    Firecast.listen("ListChatCommands", function(message)
        message.response = {{
            command = "/mcp",
            description = "Gerencia o servidor MCP (status, local do banco SQLite, etc.)"
        }};
    end);

    -- Executa o comando /mcp
    Firecast.listen("HandleChatCommand", function(message)
        if message.command == "mcp" then
            message.response = { handled = true };
            local param = (message.parameter or ""):gsub("^%s+", ""):gsub("%s+$", "");
            local cfg = loadConfig();

            if param == "" or param == "status" then
                message.chat:escrever("[Firecast MCP] Status: Ativo");
                if cfg.db_path and cfg.db_path ~= "" then
                    message.chat:escrever("[Firecast MCP] Banco de Dados: " .. tostring(cfg.db_path));
                else
                    message.chat:escrever("[Firecast MCP] Banco de Dados: Padrão (<VHD>/mcp/firecast.db)");
                end
                message.chat:escrever("[Firecast MCP] Comandos: /mcp db <caminho> | /mcp db reset | /mcp help");

            elseif param:find("^db%s+") then
                local newPath = param:match("^db%s+(.+)$");
                if newPath == "reset" or newPath == "default" then
                    cfg.db_path = nil;
                    saveConfig(cfg);
                    message.chat:escrever("[Firecast MCP] Local do banco restaurado para o padrão (<VHD>/mcp/firecast.db).");
                else
                    cfg.db_path = newPath;
                    saveConfig(cfg);
                    message.chat:escrever("[Firecast MCP] Local do banco de dados alterado para: " .. newPath);
                    message.chat:escrever("[Firecast MCP] Reinicie o server.exe para usar o novo caminho.");
                end

            elseif param == "help" then
                message.chat:escrever("[Firecast MCP] Ajuda de comandos:");
                message.chat:escrever("  /mcp status         - Exibe o status e o caminho atual do banco.");
                message.chat:escrever("  /mcp db <caminho>   - Define um caminho customizado para o firecast.db.");
                message.chat:escrever("  /mcp db reset       - Restaura o caminho do banco para o padrão no VHD.");

            else
                message.chat:escrever("[Firecast MCP] Comando desconhecido: " .. param .. ". Digite /mcp help");
            end
        end
    end);
end

-- 4. Registra os comandos do MCP
local function registerCommands()
    bridge.registerCommand("list_rooms",        rooms.listRooms);
    bridge.registerCommand("get_room",          rooms.getRoom);
    bridge.registerCommand("list_players",      rooms.listPlayers);
    bridge.registerCommand("list_chats",        chat.listChats);
    bridge.registerCommand("get_chat_messages", chat.getChatMessages);
    bridge.registerCommand("send_chat_message", chat.sendChatMessage);
    bridge.registerCommand("roll_dice",         chat.rollDice);

    -- Comandos de Biblioteca e NDB
    bridge.registerCommand("list_library",        ndb.list_library);
    bridge.registerCommand("get_library_item",    ndb.get_library_item);
    bridge.registerCommand("get_sheet_ndb",       ndb.get_sheet_ndb);
    bridge.registerCommand("edit_sheet_ndb",      ndb.edit_sheet_ndb);
    bridge.registerCommand("open_dock_ndb",       ndb.open_dock_ndb);
    bridge.registerCommand("edit_dock_ndb",       ndb.edit_dock_ndb);
    bridge.registerCommand("manage_library_item", ndb.manage_library_item);
    bridge.registerCommand("manage_room",         ndb.manage_room);

    -- Comandos de Plugins e Modelos de Fichas (DataTypes)
    bridge.registerCommand("list_data_types",     pluginsCmd.list_data_types);
    bridge.registerCommand("list_plugins",        pluginsCmd.list_plugins);
end

-- 5. Registra os listeners de eventos
local function registerEvents()
    rooms.registerEvents(bridge);
    chat.registerEvents(bridge);
end

local function logDebug(msg)
    pcall(function()
        local f = VHD.openFile("/mcp/debug.txt", "a");
        if f ~= nil then
            f:writeBinary("utf8", msg);
            f:close();
        end
    end);
end

-- 6. Inicialização geral do plugin
local function init()
    pcall(function()
        VHD.forceDirectory("/mcp");
        local f = VHD.openFile("/mcp/debug.txt", "w+");
        if f ~= nil then
            f:writeBinary("utf8", "init() called at " .. tostring(os.time()) .. "\n");
            f:close();
        end
    end);

    local ok, err = pcall(bridge.init);
    logDebug("bridge.init: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    ok, err = pcall(function()
        local cfg = loadConfig();
        saveConfig(cfg);
    end);
    logDebug("config: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    ok, err = pcall(deployServer);
    logDebug("deployServer: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    ok, err = pcall(registerChatCommands);
    logDebug("registerChatCommands: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    ok, err = pcall(registerCommands);
    logDebug("registerCommands: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    ok, err = pcall(registerEvents);
    logDebug("registerEvents: " .. tostring(ok) .. " " .. tostring(err) .. "\n");

    if _G._firecastMcpTimer ~= nil then
        pcall(function() _G._firecastMcpTimer:setEnabled(false); end);
    end

    local tickCount = 0;
    _G._firecastMcpTimer = rrpgObjs.newTimer(POLL_INTERVAL_MS, function()
        tickCount = tickCount + 1;
        if tickCount <= 3 then
            logDebug("Timer ticked (" .. tostring(tickCount) .. ") at " .. tostring(os.time()) .. "\n");
        end
        local okT, errT = pcall(bridge.tick);
        if not okT then
            logDebug("tick error: " .. tostring(errT) .. "\n");
        end
    end);
    logDebug("Timer created!\n");
end

init();
