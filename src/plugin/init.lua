-- init.lua
-- Entry point do plugin Firecast MCP
-- Inicializa a bridge, gerencia o config.json, atualiza o server.exe no VHD e expõe comandos de chat.

local bridge   = require("plugin/bridge.lua");
local rooms    = require("plugin/commands/rooms.lua");
local rrpgObjs = require("sdk/rrpgObjs.lua");
local Firecast = require("sdk/firecast.lua");
local VHD      = require("sdk/vhd.lua");
local json     = require("sdk/json.lua");

local POLL_INTERVAL_MS = 500;
local CONFIG_FILE = "/mcp/config.json";

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
    local SRC = "/server.exe";      -- raiz do .rpk
    local DST = "/mcp/server.exe";  -- destino gravável no VHD

    if not VHD.fileExists(SRC) then
        return;
    end

    local srcFile = VHD.openFile(SRC, "r");
    if srcFile == nil then return; end
    local srcSize = srcFile.size;
    srcFile:close();

    local needsCopy = true;
    if VHD.fileExists(DST) then
        local dstFile = VHD.openFile(DST, "r");
        if dstFile ~= nil then
            local dstSize = dstFile.size;
            dstFile:close();
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
    bridge.registerCommand("list_rooms", rooms.listRooms);
    bridge.registerCommand("get_room",   rooms.getRoom);
end

-- 5. Registra os listeners de eventos
local function registerEvents()
    rooms.registerEvents(bridge);
end

-- 6. Inicialização geral do plugin
local function init()
    bridge.init();

    -- Garante que config.json existe no VHD desde o primeiro boot
    local cfg = loadConfig();
    saveConfig(cfg);

    deployServer();
    registerChatCommands();
    registerCommands();
    registerEvents();

    -- Timer de polling da bridge
    rrpgObjs.newTimer(POLL_INTERVAL_MS, function()
        bridge.tick();
    end);
end

init();
