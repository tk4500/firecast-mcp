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
        local entryName = (type(entry) == "table") and entry.name or entry;
        if type(entryName) == "string" and entryName ~= "" then
            local fileName = INBOX_DIR .. entryName;
            if VHD.fileExists(fileName) then
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
                            local id, command = string.match(entryName, "^(.-)%.(.-)%.json$");
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
    end
    return items;
end

-- Escreve um evento no outbox
-- type: string (ex: "room_joined", "command_result", "chat_message")
-- payload: table
function bridge.emit(eventType, payload)
    pcall(function()
        local ts = os.time();
        local id = (payload and payload.id) or (tostring(ts) .. math.random(1000, 9999));
        local fileName = OUTBOX_DIR .. ts .. "-" .. id .. "." .. eventType .. ".json";
        
        local data = {
            id   = id,
            type = eventType,
            ts   = ts,
            data = payload or {},
        };

        local encoded = json.encode(data);
        local file = VHD.openFile(fileName, "w+");
        if file ~= nil then
            file:writeBinary("utf8", encoded);
            file:close();
        end
    end);
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
            local isFinished = false;
            local function reply(ok, res)
                if isFinished then return; end
                isFinished = true;
                if ok then
                    bridge.emit("command_result", {
                        id      = item.id,
                        command = item.command,
                        result  = res,
                        success = true,
                    });
                else
                    bridge.emit("command_result", {
                        id      = item.id,
                        command = item.command,
                        error   = tostring(res),
                        success = false,
                    });
                end
            end

            local ok, result = pcall(handler, item.args or {}, reply);
            if not ok then
                reply(false, result);
            elseif type(result) == "table" and type(result.thenDo) == "function" then
                -- Suporte a Promises do SDK3
                result:thenDo(function(...)
                    local ret = {...};
                    reply(true, #ret == 1 and ret[1] or ret);
                end):onError(function(err)
                    reply(false, err);
                end);
            elseif result ~= nil then
                -- Retorno síncrono
                reply(true, result);
            end
            -- Se result == nil e não chamou reply ainda, está aguardando o callback reply(ok, res)
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
