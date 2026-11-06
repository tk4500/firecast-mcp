-- bridge.lua
-- Gerencia a comunicação entre o plugin e o servidor MCP via pastas inbox/outbox no VHD.
-- inbox/  <- servidor escreve arquivos <id>.<command>.json, plugin lê e deleta
-- outbox/ <- plugin escreve arquivos <ts>-<id>.<type>.json, servidor lê e deleta

local json = require("sdk/json.lua");
local VHD = require("sdk/vhd.lua");

local bridge = {};

local INBOX_DIR  = "/mcp/inbox/";
local OUTBOX_DIR = "/mcp/outbox/";

-- Garante que as pastas existam
local function ensureDirs()
    VHD.forceDirectory("/mcp");
    VHD.forceDirectory("/mcp/inbox");
    VHD.forceDirectory("/mcp/outbox");
end

-- Lê e deleta todos os arquivos do inbox, retorna lista de {id, command, args}
local function drainInbox()
    local items = {};
    local entries = VHD.enumerateContent(INBOX_DIR);
    if entries == nil then return items; end

    for i = 1, #entries do
        local entry = entries[i];
        if not entry.isDirectory then
            local fileName = INBOX_DIR .. entry.name;
            local file = VHD.openFile(fileName, "r");
            if file ~= nil then
                local content = file:readBinary("utf8");
                file:close();
                VHD.deleteFile(fileName);

                if content ~= nil and content ~= "" then
                    local ok, data = pcall(json.decode, content);
                    if ok and data then
                        -- nome do arquivo: <id>.<command>.json
                        -- extrai command do nome para evitar parsear o JSON para roteamento
                        local id, command = string.match(entry.name, "^(.-)%.(.-)%.json$");
                        if id and command then
                            data.id      = data.id or id;
                            data.command = data.command or command;
                            table.insert(items, data);
                        end
                    end
                end
            end
        end
    end
    return items;
end

-- Escreve um evento no outbox
-- type: string (ex: "room_joined", "command_result", "chat_message")
-- payload: table
function bridge.emit(eventType, payload)
    local ts = os.time();
    local id = payload.id or tostring(ts) .. math.random(1000, 9999);
    local fileName = OUTBOX_DIR .. ts .. "-" .. id .. "." .. eventType .. ".json";
    
    local data = {
        id   = id,
        type = eventType,
        ts   = ts,
        data = payload,
    };

    local file = VHD.openFile(fileName, "w+");
    if file ~= nil then
        file:writeBinary("utf8", json.encode(data));
        file:close();
    end
end

-- Callback chamado pelo timer: processa inbox
local commandHandlers = {};

function bridge.registerCommand(command, handler)
    commandHandlers[command] = handler;
end

function bridge.tick()
    local items = drainInbox();
    for _, item in ipairs(items) do
        local handler = commandHandlers[item.command];
        if handler then
            local ok, result = pcall(handler, item.args or {});
            if ok then
                bridge.emit("command_result", {
                    id      = item.id,
                    command = item.command,
                    result  = result,
                    success = true,
                });
            else
                bridge.emit("command_result", {
                    id      = item.id,
                    command = item.command,
                    error   = tostring(result),
                    success = false,
                });
            end
        else
            bridge.emit("command_result", {
                id      = item.id,
                command = item.command,
                error   = "unknown command: " .. tostring(item.command),
                success = false,
            });
        end
    end
end

function bridge.init()
    ensureDirs();
end

return bridge;
