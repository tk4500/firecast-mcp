-- commands/ndb.lua
-- Gerencia comandos de Biblioteca e NodeDatabase (NDB) no plugin Firecast SDK3.

local Firecast = require("sdk/firecast.lua");
local NDB = require("sdk/ndb.lua");

local ndbCommands = {};

-- Encontra mesa por ID
local function findMesa(roomId)
    local id = tonumber(roomId);
    if not id then return nil; end
    local mesas = Firecast.getMesas();
    if mesas == nil then return nil; end
    for i = 1, #mesas do
        if mesas[i].codigoInterno == id then
            return mesas[i];
        end
    end
    return nil;
end

-- Serializa um item da biblioteca
local function serializeBibliotecaItem(item, recursive, maxDepth, currentDepth)
    if item == nil then return nil; end
    currentDepth = currentDepth or 0;
    maxDepth = maxDepth or 5;

    local info = {
        codigoInterno = item.codigoInterno,
        nome = item.nome or item.name,
        tipo = item.tipo,
        ownerLogin = item.ownerLogin or item.loginDono,
        creatorLogin = item.creatorLogin or item.loginCriador,
        visivel = item.visivel,
        visivelRecursivamente = item.visivelRecursivamente,
    };

    if item.tipo == "personagem" then
        pcall(function()
            info.dataType = item.dataType;
            info.avatar = item.avatar;
            info.bar0Val = item.bar0Val;
            info.bar0Max = item.bar0Max;
            info.bar1Val = item.bar1Val;
            info.bar1Max = item.bar1Max;
            info.bar2Val = item.bar2Val;
            info.bar2Max = item.bar2Max;
            info.bar3Val = item.bar3Val;
            info.bar3Max = item.bar3Max;
            info.edtLine0 = item.edtLine0;
            info.edtLine1 = item.edtLine1;
            info.escritaBloqueada = item.escritaBloqueada or item.editionBlocked;
        end);
    end

    if recursive and currentDepth < maxDepth then
        local children = item.children or item.filhos;
        if children ~= nil and #children > 0 then
            info.children = {};
            for i = 1, #children do
                local childInfo = serializeBibliotecaItem(children[i], true, maxDepth, currentDepth + 1);
                if childInfo ~= nil then
                    table.insert(info.children, childInfo);
                end
            end
        end
    else
        -- Apenas contagem ou lista de IDs se não for recursivo completo
        local children = item.children or item.filhos;
        if children ~= nil then
            info.childCount = #children;
        end
    end

    return info;
end

-- Serializa recursivamente um ObjetoNodo NDB para tabela Lua
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
                    -- Se já existe um filho com o mesmo nome (ex: recordList items), agrupa em lista
                    if type(groupedByName[name]) == "table" and groupedByName[name]._isListGroup then
                        table.insert(groupedByName[name].items, childData);
                    else
                        groupedByName[name] = {
                            _isListGroup = true,
                            items = { groupedByName[name], childData }
                        };
                    end
                end
            else
                table.insert(listUnnamed, childData);
            end
        end

        for k, v in pairs(groupedByName) do
            if type(v) == "table" and v._isListGroup then
                result[k] = v.items;
            else
                result[k] = v;
            end
        end

        if #listUnnamed > 0 then
            result._children = listUnnamed;
        end
    end

    return result;
end

-- Navega até um sub-nodo por caminho ("atributos.forca" ou "habilidades")
local function navigateNodePath(rootNode, pathStr)
    if not pathStr or pathStr == "" or pathStr == "." or pathStr == "/" then
        return rootNode;
    end

    local current = rootNode;
    for segment in string.gmatch(pathStr, "[^.%/]+") do
        if current == nil then break end
        local nextNode = current[segment];
        if nextNode == nil then
            -- Tenta buscar entre os filhos
            local childs = NDB.getChildNodes(current);
            local found = nil;
            if childs then
                for i = 1, #childs do
                    if NDB.getNodeName(childs[i]) == segment then
                        found = childs[i];
                        break
                    end
                end
            end
            current = found;
        else
            current = nextNode;
        end
    end

    return current;
end

-- Aplica operações de alteração em um ObjetoNodo
local function applyNodeOperations(rootNode, operations)
    if type(operations) ~= "table" then
        error("operations must be an array of operation objects");
    end

    local appliedCount = 0;
    NDB.beginUpdate(rootNode);

    local ok, err = pcall(function()
        for i = 1, #operations do
            local op = operations[i];
            local action = op.action or "set";
            local pathStr = op.path;
            local value = op.value;

            if not pathStr or pathStr == "" or pathStr == "." or pathStr == "/" then
                if action == "set" then
                    if type(value) == "table" then
                        for k, v in pairs(value) do
                            rootNode[k] = v;
                            appliedCount = appliedCount + 1;
                        end
                    else
                        error("Root set operation requires a table value");
                    end
                elseif action == "delete" then
                    local childNodes = NDB.getChildNodes(rootNode);
                    if childNodes then
                        for _, child in ipairs(childNodes) do
                            NDB.deleteNode(child);
                        end
                    end
                else
                    error("Unknown action on root node: " .. tostring(action));
                end
            else
                -- Separa o caminho em diretórios e chave final
                local parts = {};
                for segment in string.gmatch(pathStr, "[^.%/]+") do
                    table.insert(parts, segment);
                end

                if #parts == 0 then
                    error("Invalid path: " .. tostring(pathStr));
                end

                local finalKey = parts[#parts];
                local targetNode = rootNode;

                -- Navega até o penúltimo nodo, criando filhos se necessário no caso de 'set'
                for p = 1, #parts - 1 do
                    local seg = parts[p];
                    local nextTarget = targetNode[seg];
                    if nextTarget == nil then
                        if action == "set" then
                            targetNode[seg] = {};
                            nextTarget = targetNode[seg];
                        else
                            targetNode = nil;
                            break
                        end
                    end
                    targetNode = nextTarget;
                end

                if targetNode ~= nil then
                    if action == "set" then
                        targetNode[finalKey] = value;
                        appliedCount = appliedCount + 1;
                    elseif action == "delete" then
                        targetNode[finalKey] = nil;
                        appliedCount = appliedCount + 1;
                    else
                        error("Unknown action: " .. tostring(action));
                    end
                end
            end
        end
    end);

    NDB.endUpdate(rootNode);

    if not ok then
        error(err);
    end

    return appliedCount;
end

--------------------------------------------------------------------------------
-- COMANDO: list_library
--------------------------------------------------------------------------------
function ndbCommands.list_library(args, reply)
    local roomId = args.roomId;
    if not roomId then
        return reply(false, "roomId is required");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found or not connected");
    end

    local parentCodigo = args.parentCodigoInterno;
    local startItem = nil;

    if parentCodigo ~= nil and tonumber(parentCodigo) then
        startItem = mesa:findBibliotecaItem(tonumber(parentCodigo));
        if not startItem then
            return reply(false, "Library item " .. tostring(parentCodigo) .. " not found in room " .. tostring(roomId));
        end
    else
        startItem = mesa.biblioteca;
    end

    if not startItem then
        return reply(false, "Could not access library root in room " .. tostring(roomId));
    end

    local recursive = (args.recursive == true or args.recursive == "true");
    local maxDepth = tonumber(args.maxDepth) or 5;

    local rootSerialized = serializeBibliotecaItem(startItem, recursive, maxDepth, 0);

    -- Se não for recursivo, inclui também os filhos imediatos
    if not recursive then
        local children = startItem.children or startItem.filhos;
        local items = {};
        if children ~= nil then
            for i = 1, #children do
                local cInfo = serializeBibliotecaItem(children[i], false, 1, 0);
                if cInfo ~= nil then
                    table.insert(items, cInfo);
                end
            end
        end
        return reply(true, {
            roomId = tonumber(roomId),
            item = rootSerialized,
            children = items,
        });
    else
        return reply(true, {
            roomId = tonumber(roomId),
            tree = rootSerialized,
        });
    end
end

--------------------------------------------------------------------------------
-- COMANDO: get_library_item
--------------------------------------------------------------------------------
function ndbCommands.get_library_item(args, reply)
    local roomId = args.roomId;
    local codigoInterno = args.codigoInterno;

    if not roomId or not codigoInterno then
        return reply(false, "roomId and codigoInterno are required");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(tonumber(codigoInterno));
    if not item then
        return reply(false, "Library item " .. tostring(codigoInterno) .. " not found in room " .. tostring(roomId));
    end

    local serialized = serializeBibliotecaItem(item, false, 1, 0);

    -- Anexa lista de filhos imediatos se houver
    local children = item.children or item.filhos;
    local directChildren = {};
    if children ~= nil then
        for i = 1, #children do
            local cInfo = serializeBibliotecaItem(children[i], false, 1, 0);
            if cInfo ~= nil then
                table.insert(directChildren, cInfo);
            end
        end
    end
    serialized.children = directChildren;

    return reply(true, {
        roomId = tonumber(roomId),
        item = serialized,
    });
end

--------------------------------------------------------------------------------
-- COMANDO: get_sheet_ndb
--------------------------------------------------------------------------------
function ndbCommands.get_sheet_ndb(args, reply)
    local roomId = args.roomId;
    local codigoInterno = args.codigoInterno;

    if not roomId or not codigoInterno then
        return reply(false, "roomId and codigoInterno are required");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(tonumber(codigoInterno));
    if not item then
        return reply(false, "Library item " .. tostring(codigoInterno) .. " not found in room " .. tostring(roomId));
    end

    if item.tipo ~= "personagem" then
        return reply(false, "Library item " .. tostring(codigoInterno) .. " is not a character (tipo=" .. tostring(item.tipo) .. ")");
    end

    if type(item.asyncOpenNDB) ~= "function" then
        return reply(false, "Character item does not support asyncOpenNDB");
    end

    local promise = item:asyncOpenNDB();

    promise:thenDo(function(rootNode)
        if rootNode == nil then
            return reply(false, "Failed to load character NodeDatabase: rootNode is nil");
        end

        local targetNode = rootNode;
        if args.path and args.path ~= "" then
            targetNode = navigateNodePath(rootNode, args.path);
            if targetNode == nil then
                return reply(false, "Path \"" .. tostring(args.path) .. "\" not found in sheet NDB");
            end
        end

        local response = {
            roomId = tonumber(roomId),
            codigoInterno = tonumber(codigoInterno),
            characterName = item.nome or item.name,
            dataType = item.dataType,
            path = args.path,
        };

        if args.rawXml == true or args.rawXml == "true" then
            local okXml, xmlStr = pcall(NDB.exportXML, targetNode);
            if okXml then
                response.xml = xmlStr;
            else
                response.xmlError = tostring(xmlStr);
            end
        end

        local maxDepth = tonumber(args.maxDepth) or 8;
        response.data = serializeNDBNode(targetNode, maxDepth, 0);

        return reply(true, response);
    end):onError(function(err)
        return reply(false, "Error opening character NDB: " .. tostring(err));
    end);
end

--------------------------------------------------------------------------------
-- COMANDO: edit_sheet_ndb (Permitido com segurança apenas na mesa de teste 'tttttaaaaa' = 239256)
--------------------------------------------------------------------------------
function ndbCommands.edit_sheet_ndb(args, reply)
    local roomId = tonumber(args.roomId);
    local codigoInterno = tonumber(args.codigoInterno);

    if not roomId or not codigoInterno then
        return reply(false, "roomId and codigoInterno are required");
    end

    -- Trava de segurança estrita: edição apenas na mesa de testes 'tttttaaaaa' (239256)
    if roomId ~= 239256 then
        return reply(false, "Safety guard: sheet modifications are currently restricted to the test room 'tttttaaaaa' (id 239256)");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local item = mesa:findBibliotecaItem(codigoInterno);
    if not item then
        return reply(false, "Library item " .. tostring(codigoInterno) .. " not found");
    end

    if item.tipo ~= "personagem" then
        return reply(false, "Item is not a character (tipo=" .. tostring(item.tipo) .. ")");
    end

    local promise = item:asyncOpenNDB();
    promise:thenDo(function(rootNode)
        if rootNode == nil then
            return reply(false, "Could not open character NDB");
        end

        local ok, result = pcall(applyNodeOperations, rootNode, args.operations);
        if not ok then
            return reply(false, "Error applying operations to NDB: " .. tostring(result));
        end

        return reply(true, {
            success = true,
            roomId = roomId,
            codigoInterno = codigoInterno,
            appliedOperations = result,
            updatedData = serializeNDBNode(rootNode, 4, 0),
        });
    end):onError(function(err)
        return reply(false, "Error in asyncOpenNDB: " .. tostring(err));
    end);
end

--------------------------------------------------------------------------------
-- COMANDO: open_dock_ndb (Leitura de NDB de janela acoplável / Room NDB)
--------------------------------------------------------------------------------
function ndbCommands.open_dock_ndb(args, reply)
    local roomId = tonumber(args.roomId);
    local name = args.name;

    if not roomId or not name or name == "" then
        return reply(false, "roomId and name are required");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local isUser = (args.isUser == true or args.isUser == "true");
    local create = (args.create == true or args.create == "true");

    local promise = nil;
    if isUser then
        promise = mesa:asyncOpenUserRoomNDB(name, { create = create });
    else
        promise = mesa:asyncOpenRoomNDB(name, { create = create });
    end

    if not promise then
        return reply(false, "Room does not support asyncOpenRoomNDB or failed to initiate");
    end

    promise:thenDo(function(rootNode)
        if rootNode == nil then
            return reply(false, "Dock NDB \"" .. tostring(name) .. "\" is nil (may not exist and create was false)");
        end

        local targetNode = rootNode;
        if args.path and args.path ~= "" then
            targetNode = navigateNodePath(rootNode, args.path);
        end

        local response = {
            roomId = roomId,
            name = name,
            isUser = isUser,
            path = args.path,
        };

        if args.rawXml == true or args.rawXml == "true" then
            local okXml, xmlStr = pcall(NDB.exportXML, targetNode);
            if okXml then
                response.xml = xmlStr;
            end
        end

        local maxDepth = tonumber(args.maxDepth) or 8;
        response.data = serializeNDBNode(targetNode, maxDepth, 0);

        return reply(true, response);
    end):onError(function(err)
        return reply(false, "Error opening Dock NDB: " .. tostring(err));
    end);
end

--------------------------------------------------------------------------------
-- COMANDO: edit_dock_ndb (Edição de NDB de mesa/dock - Permitido apenas na mesa 239256)
--------------------------------------------------------------------------------
function ndbCommands.edit_dock_ndb(args, reply)
    local roomId = tonumber(args.roomId);
    local name = args.name;

    if not roomId or not name or name == "" then
        return reply(false, "roomId and name are required");
    end

    if roomId ~= 239256 then
        return reply(false, "Safety guard: dock modifications are currently restricted to the test room 'tttttaaaaa' (id 239256)");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local isUser = (args.isUser == true or args.isUser == "true");
    local promise = isUser and mesa:asyncOpenUserRoomNDB(name, { create = true }) or mesa:asyncOpenRoomNDB(name, { create = true });

    promise:thenDo(function(rootNode)
        if rootNode == nil then
            return reply(false, "Could not open or create Dock NDB");
        end

        local ok, result = pcall(applyNodeOperations, rootNode, args.operations);
        if not ok then
            return reply(false, "Error applying operations to Dock NDB: " .. tostring(result));
        end

        return reply(true, {
            success = true,
            roomId = roomId,
            name = name,
            appliedOperations = result,
            updatedData = serializeNDBNode(rootNode, 4, 0),
        });
    end):onError(function(err)
        return reply(false, "Error in asyncOpenRoomNDB: " .. tostring(err));
    end);
end

--------------------------------------------------------------------------------
-- COMANDO: manage_library_item (Criação/Edição/Exclusão/Mover de itens - Permitido apenas na mesa 239256)
--------------------------------------------------------------------------------
function ndbCommands.manage_library_item(args, reply)
    local roomId = tonumber(args.roomId);
    local action = args.action;

    if not roomId or not action then
        return reply(false, "roomId and action are required");
    end

    if roomId ~= 239256 then
        return reply(false, "Safety guard: library modifications are currently restricted to the test room 'tttttaaaaa' (id 239256)");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    if action == "create_dir" then
        local parentCodigo = tonumber(args.parentCodigoInterno);
        local parentItem = parentCodigo and mesa:findBibliotecaItem(parentCodigo) or mesa.biblioteca;
        if not parentItem then
            return reply(false, "Parent library item not found");
        end
        if not args.name or args.name == "" then
            return reply(false, "name is required for create_dir");
        end

        local promise = parentItem:asyncCreateDir({ name = args.name });
        promise:thenDo(function(newItem)
            return reply(true, {
                success = true,
                action = action,
                item = serializeBibliotecaItem(newItem, false, 1, 0),
            });
        end):onError(function(err)
            return reply(false, "Error creating directory: " .. tostring(err));
        end);

    elseif action == "create_char" then
        local parentCodigo = tonumber(args.parentCodigoInterno);
        local parentItem = parentCodigo and mesa:findBibliotecaItem(parentCodigo) or mesa.biblioteca;
        if not parentItem then
            return reply(false, "Parent library item not found");
        end
        if not args.name or args.name == "" then
            return reply(false, "name is required for create_char");
        end

        local charParams = {
            name = args.name,
            dataType = args.dataType or args.data_type or "default",
        };
        if args.avatar then charParams.avatar = args.avatar; end

        local promise = parentItem:asyncCreateChar(charParams);
        promise:thenDo(function(newItem)
            return reply(true, {
                success = true,
                action = action,
                item = serializeBibliotecaItem(newItem, false, 1, 0),
            });
        end):onError(function(err)
            return reply(false, "Error creating character: " .. tostring(err));
        end);

    elseif action == "update" then
        local codigoInterno = tonumber(args.codigoInterno);
        if not codigoInterno then
            return reply(false, "codigoInterno is required for update");
        end
        local item = mesa:findBibliotecaItem(codigoInterno);
        if not item then
            return reply(false, "Item " .. tostring(codigoInterno) .. " not found");
        end
        local changes = args.changes or {};
        if args.name then changes.name = args.name; end

        local promise = item:asyncUpdate(changes);
        promise:thenDo(function()
            return reply(true, {
                success = true,
                action = action,
                codigoInterno = codigoInterno,
                item = serializeBibliotecaItem(item, false, 1, 0),
            });
        end):onError(function(err)
            return reply(false, "Error updating item: " .. tostring(err));
        end);

    elseif action == "delete" then
        local codigoInterno = tonumber(args.codigoInterno);
        if not codigoInterno then
            return reply(false, "codigoInterno is required for delete");
        end
        local item = mesa:findBibliotecaItem(codigoInterno);
        if not item then
            return reply(false, "Item " .. tostring(codigoInterno) .. " not found");
        end

        local promise = item:asyncDelete();
        promise:thenDo(function()
            return reply(true, {
                success = true,
                action = action,
                deletedCodigoInterno = codigoInterno,
            });
        end):onError(function(err)
            return reply(false, "Error deleting item: " .. tostring(err));
        end);

    elseif action == "move" then
        local codigoInterno = tonumber(args.codigoInterno);
        local parentCodigo = tonumber(args.parentCodigoInterno);
        if not codigoInterno or not parentCodigo then
            return reply(false, "codigoInterno and parentCodigoInterno are required for move");
        end
        local item = mesa:findBibliotecaItem(codigoInterno);
        local parentItem = mesa:findBibliotecaItem(parentCodigo) or mesa.biblioteca;
        if not item or not parentItem then
            return reply(false, "Item or target parent item not found");
        end

        local promise = item:asyncMoveTo(parentItem);
        promise:thenDo(function()
            return reply(true, {
                success = true,
                action = action,
                codigoInterno = codigoInterno,
                newParentCodigoInterno = parentCodigo,
            });
        end):onError(function(err)
            return reply(false, "Error moving item: " .. tostring(err));
        end);

    else
        return reply(false, "Unknown action: " .. tostring(action));
    end
end

--------------------------------------------------------------------------------
-- COMANDO: manage_room (Configurações da Mesa - Permitido apenas na mesa 239256)
--------------------------------------------------------------------------------
function ndbCommands.manage_room(args, reply)
    local roomId = tonumber(args.roomId);
    if not roomId then
        return reply(false, "roomId is required");
    end

    if roomId ~= 239256 then
        return reply(false, "Safety guard: room modifications are currently restricted to the test room 'tttttaaaaa' (id 239256)");
    end

    local mesa = findMesa(roomId);
    if not mesa then
        return reply(false, "Room " .. tostring(roomId) .. " not found");
    end

    local action = args.action or "get_details";

    if action == "set_moderada" then
        local moderada = (args.moderada == true or args.moderada == "true");
        if type(mesa.requestSetModerada) == "function" then
            mesa:requestSetModerada(moderada);
            return reply(true, {
                success = true,
                action = action,
                roomId = roomId,
                moderada = moderada,
            });
        else
            return reply(false, "mesa:requestSetModerada is not available");
        end
    elseif action == "get_details" then
        return reply(true, {
            roomId = roomId,
            nome = mesa.nome,
            sistema = mesa.sistema,
            isModerada = mesa.isModerada,
            haVagas = mesa.haVagas,
            podeTablesDock = mesa.podeTablesDock,
        });
    else
        return reply(false, "Unknown action: " .. tostring(action));
    end
end

return ndbCommands;
