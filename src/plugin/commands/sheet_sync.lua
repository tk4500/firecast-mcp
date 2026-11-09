-- sheet_sync.lua
-- Gerencia a sincronização bidirecional em tempo real de fichas (NDB) com o servidor MCP e SQLite.
-- Suporta detecção de fichas de jogadores, fichas abertas em abas do Firecast, cancelamento de eco (anti-loop) e debouncing de digitação.

local Firecast = require("sdk/firecast.lua");
local NDB      = require("sdk/ndb.lua");
local rrpgObjs = require("sdk/rrpgObjs.lua");
local bridge   = require("plugin/bridge.lua");

local function safeSetTimeout(callback, ms)
    local fnSetTimeout = rawget(_G, "setTimeout");
    if fnSetTimeout ~= nil then
        fnSetTimeout(callback, ms or 1);
    else
        local t;
        t = rrpgObjs.newTimer(ms or 1, function()
            pcall(function() t:setEnabled(false); end);
            callback();
        end);
    end
end

local sheetSync = {};

-- Fichas rastreadas atualmente:
-- [codigoInterno] = {
--    roomId = number,
--    codigoInterno = number,
--    charName = string,
--    dataType = string,
--    item = ObjetoBibliotecaItem,
--    rootNode = ObjetoNodo,
--    observer = ObjetoNodeObserver,
--    source = "player" | "tab" | "mcp" | "manual",
--    isTabOpen = boolean,
--    lastSync = number,
--    pendingChanges = table,
--    debounceTimer = timer,
-- }
local trackedSheets = {};

-- Trava de loopback / cancelamento de eco:
-- [codigoInterno] = true quando a alteração foi originada pelo MCP.
local isApplyingMcpSync = {};

--------------------------------------------------------------------------------
-- Funções Auxiliares de Navegação e Serialização NDB
--------------------------------------------------------------------------------

-- Reconstrói o caminho hierárquico relativo ao rootNode (ex: "atributos.forca" ou "ataques.item1.dano")
local function getNodePath(node, rootNode)
    if node == nil or node == rootNode then
        return "";
    end

    local parts = {};
    local curr = node;
    local depth = 0;

    while curr ~= nil and curr ~= rootNode and depth < 30 do
        local name = NDB.getNodeName(curr);
        if name and name ~= "" then
            table.insert(parts, 1, name);
        end

        local ok, parent = pcall(NDB.getParent, curr);
        if ok and parent ~= nil then
            curr = parent;
        else
            break;
        end
        depth = depth + 1;
    end

    return table.concat(parts, ".");
end

-- Serializa recursivamente um ObjetoNodo NDB para uma tabela Lua simples
local function serializeNDBNode(node, maxDepth, currentDepth)
    if node == nil then return nil; end
    currentDepth = currentDepth or 0;
    maxDepth = maxDepth or 8;

    if currentDepth > maxDepth then
        return { _truncated = true };
    end

    local result = {};

    -- Atributos primitivos (escalares)
    local okAttrs, attrs = pcall(NDB.getAttributes, node);
    if okAttrs and type(attrs) == "table" then
        for k, v in pairs(attrs) do
            result[k] = v;
        end
    end

    -- Filhos (Child Nodes)
    local okChilds, children = pcall(NDB.getChildNodes, node);
    if okChilds and type(children) == "table" and #children > 0 then
        local groupedByName = {};
        local listUnnamed = {};

        for i = 1, #children do
            local child = children[i];
            local name = NDB.getNodeName(child);
            local childData = serializeNDBNode(child, maxDepth, currentDepth + 1);

            if name and name ~= "" then
                if groupedByName[name] == nil then
                    groupedByName[name] = childData;
                else
                    if type(groupedByName[name]) == "table" and groupedByName[name]._isListGroup then
                        table.insert(groupedByName[name], childData);
                    else
                        groupedByName[name] = { _isListGroup = true, groupedByName[name], childData };
                    end
                end
            else
                table.insert(listUnnamed, childData);
            end
        end

        for name, data in pairs(groupedByName) do
            if type(data) == "table" and data._isListGroup then
                data._isListGroup = nil;
            end
            result[name] = data;
        end

        if #listUnnamed > 0 then
            result._unnamedChildren = listUnnamed;
        end
    end

    return result;
end

-- Verifica se a ficha do personagem está aberta atualmente em uma aba da interface do Firecast
local function isCharacterOpenInClient(charItem)
    if not charItem or charItem.tipo ~= "personagem" then
        return false;
    end

    local ok, ndbHandle = pcall(function()
        return _obj_invokeEx(charItem.handle, 'GetOrCreateSheetNDB');
    end);

    if not ok or not ndbHandle then
        return false;
    end

    local ndbBib = require("sdk/ndb.lua");
    local ndbObj = ndbBib.openNodeDatabaseFromHandle(ndbHandle);
    if not ndbObj then return false; end

    local rootNode = ndbBib.getRoot(ndbObj);
    if not rootNode then return false; end

    local state = ndbBib.getState(rootNode);
    return state == "open";
end

-- Define um valor na hierarquia NDB por caminho com notação de ponto
local function setNodeValueByPath(rootNode, pathStr, value)
    if not pathStr or pathStr == "" or pathStr == "." or pathStr == "/" then
        if type(value) == "table" then
            for k, v in pairs(value) do
                rootNode[k] = v;
            end
        end
        return;
    end

    local parts = {};
    for seg in string.gmatch(pathStr, "[^.%/]+") do
        table.insert(parts, seg);
    end

    if #parts == 0 then return; end

    local target = rootNode;
    for i = 1, #parts - 1 do
        local seg = parts[i];
        local nextNode = target[seg];
        if nextNode == nil then
            if value ~= nil then
                target[seg] = {};
                nextNode = target[seg];
            else
                return; -- Não precisa criar nó se for deletar
            end
        end
        target = nextNode;
    end

    local finalKey = parts[#parts];
    if target ~= nil then
        target[finalKey] = value;
    end
end

--------------------------------------------------------------------------------
-- Rastreamento e Observação de Fichas
--------------------------------------------------------------------------------

-- Inscreve uma ficha (DESATIVADO: sem observer contínuo ou emissão de eventos em tempo real)
local function trackCharacterSheet(mesa, item, source)
    if not mesa or not item then return; end
    local codigo = tonumber(item.codigoInterno);
    if not codigo then return; end

    local isOpenTab = isCharacterOpenInClient(item);

    if trackedSheets[codigo] and trackedSheets[codigo].rootNode then
        trackedSheets[codigo].isTabOpen = isOpenTab;
        if source then
            trackedSheets[codigo].source = source;
        end
        return;
    end

    if type(item.asyncOpenNDB) ~= "function" then
        return;
    end

    item:asyncOpenNDB():thenDo(function(rootNode)
        if rootNode == nil then return; end

        local tracked = {
            roomId = tonumber(mesa.codigoInterno),
            codigoInterno = codigo,
            charName = item.nome or item.name,
            dataType = item.dataType,
            item = item,
            rootNode = rootNode,
            observer = nil,
            source = source or "manual",
            isTabOpen = isOpenTab,
            lastSync = os.time(),
            pendingChanges = {},
            debounceTimer = nil,
        };

        trackedSheets[codigo] = tracked;
        -- Observers contínuos e emissão em tempo real desativados a pedido.
    end):onError(function(err)
        -- Falha silenciosa
    end);
end

--------------------------------------------------------------------------------
-- Comandos Recebidos do MCP (Bridge)
--------------------------------------------------------------------------------

-- COMANDO: list_synced_sheets
function sheetSync.list_synced_sheets(args, reply)
    local roomId = args.roomId and tonumber(args.roomId);
    local list = {};

    for codigo, tracked in pairs(trackedSheets) do
        if not roomId or tracked.roomId == roomId then
            local isTab = isCharacterOpenInClient(tracked.item);
            tracked.isTabOpen = isTab;

            table.insert(list, {
                roomId = tracked.roomId,
                codigoInterno = tracked.codigoInterno,
                characterName = tracked.charName,
                dataType = tracked.dataType,
                source = tracked.source,
                isTabOpen = isTab,
                lastSync = tracked.lastSync,
            });
        end
    end

    return reply(true, { sheets = list, total = #list });
end

-- COMANDO: sync_sheet (força snapshot e início de observação)
function sheetSync.sync_sheet(args, reply)
    local roomId = tonumber(args.roomId);
    local codigoInterno = tonumber(args.codigoInterno);

    if not roomId or not codigoInterno then
        return reply(false, "roomId and codigoInterno are required");
    end

    local mesa = Firecast.findRoom(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(codigoInterno);
    if not item or item.tipo ~= "personagem" then
        return reply(false, "Character " .. tostring(codigoInterno) .. " not found in room");
    end

    trackCharacterSheet(mesa, item, args.source or "manual");

    return reply(true, {
        roomId = roomId,
        codigoInterno = codigoInterno,
        characterName = item.nome or item.name,
        tracked = true,
    });
end

-- COMANDO: update_sheet (Escreve alterações com cancelamento de eco)
function sheetSync.update_sheet(args, reply)
    local roomId = tonumber(args.roomId);
    local codigoInterno = tonumber(args.codigoInterno);
    local changes = args.changes;

    if not roomId or not codigoInterno or not changes then
        return reply(false, "roomId, codigoInterno and changes are required");
    end

    local mesa = Firecast.findRoom(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(codigoInterno);
    if not item or item.tipo ~= "personagem" then
        return reply(false, "Character " .. tostring(codigoInterno) .. " not found in room");
    end

    item:asyncOpenNDB():thenDo(function(rootNode)
        if rootNode == nil then
            return reply(false, "Could not open character NDB");
        end

        -- 1. Ativa flag anti-loop (não repassa as próprias alterações para o outbox)
        isApplyingMcpSync[codigoInterno] = true;

        local appliedCount = 0;
        local ok, err = pcall(function()
            NDB.beginUpdate(rootNode);

            for pathStr, val in pairs(changes) do
                setNodeValueByPath(rootNode, pathStr, val);
                appliedCount = appliedCount + 1;
            end

            NDB.endUpdate(rootNode);
        end);

        -- 2. Desativa flag anti-loop após pequeno intervalo
        safeSetTimeout(function()
            isApplyingMcpSync[codigoInterno] = nil;
        end, 400);

        if not ok then
            return reply(false, "Error applying changes to sheet: " .. tostring(err));
        end

        -- Garante que continue rastreada
        trackCharacterSheet(mesa, item, "mcp");

        return reply(true, {
            roomId = roomId,
            codigoInterno = codigoInterno,
            appliedCount = appliedCount,
            characterName = item.nome or item.name,
        });
    end):onError(function(err)
        return reply(false, "Failed to open sheet NDB: " .. tostring(err));
    end);
end

-- COMANDO: open_sheet_in_tab (Abre a ficha em uma aba visual na interface do Firecast)
function sheetSync.open_sheet_in_tab(args, reply)
    local roomId = tonumber(args.roomId);
    local codigoInterno = tonumber(args.codigoInterno);

    if not roomId or not codigoInterno then
        return reply(false, "roomId and codigoInterno are required");
    end

    local mesa = Firecast.findRoom(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(codigoInterno);
    if not item or item.tipo ~= "personagem" then
        return reply(false, "Character " .. tostring(codigoInterno) .. " not found in room");
    end

    local ok, err = pcall(function()
        if item.firecastURI then
            local GUI = require("sdk/gui.lua");
            GUI.open(item.firecastURI, { newTab = true, autoFocus = true });
        else
            item:executar();
        end
    end);

    if not ok then
        return reply(false, "Error executing character sheet item: " .. tostring(err));
    end

    -- Começa a rastrear com marcador de aba
    trackCharacterSheet(mesa, item, "tab");

    return reply(true, {
        roomId = roomId,
        codigoInterno = codigoInterno,
        characterName = item.nome or item.name,
        opened = true,
    });
end

--------------------------------------------------------------------------------
-- Inicialização e Varredura Periódica (DESATIVADO)
--------------------------------------------------------------------------------

function sheetSync.init()
    -- Desativado a pedido: sem hooks em formulários e sem varredura periódica de abas/fichas.
end

return sheetSync;
