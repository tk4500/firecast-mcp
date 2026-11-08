-- commands/chat.lua
-- Manipulação de chats, leitura/envio de mensagens e rolagem de dados no Firecast.

local Firecast = require("sdk/firecast.lua");
local rrpgObjs = require("sdk/rrpgObjs.lua");

local chatCommands = {};
local _eventReceivers = {};

local function safeGet(obj, prop)
    if obj == nil then return nil; end
    local ok, val = pcall(function() return obj[prop]; end);
    if ok then return val; end
    return nil;
end

local function serializeRoll(rollObj)
    if rollObj == nil then return nil; end

    local ops = {};
    local rawOps = safeGet(rollObj, "ops");
    if rawOps then
        for i = 1, #rawOps do
            local op = rawOps[i];
            if op then
                local opData = {
                    tipo       = op.tipo,
                    quantidade = op.quantidade,
                    face       = op.face,
                    resultados = op.resultados,
                    valor      = op.valor,
                };
                table.insert(ops, opData);
            end
        end
    end

    return {
        resultado = safeGet(rollObj, "resultado"),
        asString  = safeGet(rollObj, "asString"),
        isRolado  = safeGet(rollObj, "isRolado"),
        ops       = ops,
    };
end

local function timestampToEpoch(ts)
    if type(ts) == "number" then return ts; end
    if type(ts) == "table" and ts.year and ts.month and ts.day then
        local t = {
            year  = ts.year,
            month = ts.month,
            day   = ts.day,
            hour  = ts.hour or 0,
            min   = ts.minute or ts.min or 0,
            sec   = ts.second or ts.sec or 0,
        };
        local ok, epoch = pcall(os.time, t);
        if ok and epoch then return epoch; end
    end
    return os.time();
end

local function serializeLogRec(rec)
    if rec == nil then return nil; end

    local entity = nil;
    local rawEntity = safeGet(rec, "entity");
    if rawEntity then
        entity = {
            id    = rawEntity.userId or rawEntity.id,
            login = rawEntity.login,
            nick  = rawEntity.nick,
        };
    end

    local msgData = nil;
    local rawMsg = safeGet(rec, "msg");
    if rawMsg then
        msgData = {
            msgType = rawMsg.msgType,
            content = rawMsg.content,
        };
        if rawMsg.roll then
            msgData.roll = serializeRoll(rawMsg.roll);
        end
    end

    return {
        id        = safeGet(rec, "id"),
        tid       = safeGet(rec, "tid"),
        timestamp = timestampToEpoch(safeGet(rec, "timestamp")),
        entity    = entity,
        msg       = msgData,
    };
end

local function getChatId(chat, mesa, idx)
    local mainChat = safeGet(mesa, "chat");
    local mainHandle = safeGet(mainChat, "handle");
    local cHandle = safeGet(chat, "handle");
    if (cHandle ~= nil and cHandle == mainHandle) or (chat == mainChat) then
        return "main";
    end

    local medium = safeGet(chat, "medium");
    if type(medium) == "table" then
        local k = safeGet(medium, "kind");
        if k == "pvtOnRoom" then
            local parts = safeGet(chat, "participants");
            local meuJogador = safeGet(mesa, "meuJogador");
            local myLogin = meuJogador and safeGet(meuJogador, "login");
            if type(parts) == "table" then
                for i = 1, #parts do
                    local p = parts[i];
                    local pLogin = p and safeGet(p, "login");
                    if pLogin and pLogin ~= myLogin then
                        return "pvt:" .. tostring(pLogin);
                    end
                end
            end
            local u2 = safeGet(medium, "user2");
            if u2 then
                return "pvt:" .. tostring(u2);
            end
        elseif k == "groupPvtOnRoom" then
            local gId = safeGet(medium, "groupId");
            if gId then
                return "group:" .. tostring(gId);
            end
        end
    end

    return "chat_" .. tostring(idx or math.random(1000, 9999));
end

local function getChatName(chat, mesa, idx)
    local mainChat = safeGet(mesa, "chat");
    local mainHandle = safeGet(mainChat, "handle");
    local cHandle = safeGet(chat, "handle");
    if (cHandle ~= nil and cHandle == mainHandle) or (chat == mainChat) then
        return "Chat Principal";
    end

    local medium = safeGet(chat, "medium");
    if type(medium) == "table" then
        local k = safeGet(medium, "kind");
        if k == "pvtOnRoom" then
            local parts = safeGet(chat, "participants");
            local meuJogador = safeGet(mesa, "meuJogador");
            local myLogin = meuJogador and safeGet(meuJogador, "login");
            if type(parts) == "table" then
                for i = 1, #parts do
                    local p = parts[i];
                    local pLogin = p and safeGet(p, "login");
                    if pLogin and pLogin ~= myLogin then
                        return "PVT: " .. tostring(safeGet(p, "nick") or pLogin);
                    end
                end
            end
            local u2 = safeGet(medium, "user2");
            return "PVT: " .. tostring(u2 or "Jogador");
        elseif k == "groupPvtOnRoom" then
            local gId = safeGet(medium, "groupId");
            return "Grupo PVT (" .. tostring(gId or "") .. ")";
        end
    end

    return "Chat " .. tostring(idx or "Aba");
end

local function findChat(mesa, chatId)
    local mainChat = safeGet(mesa, "chat");
    if chatId == nil or chatId == "" or chatId == "main" or chatId == "room" then
        return mainChat;
    end

    local activeChat = safeGet(mesa, "activeChat");
    if chatId == "active" then
        return activeChat or mainChat;
    end

    local rawChats = nil;
    local ok, res = pcall(function() return mesa:getChats(); end);
    if ok and type(res) == "table" then
        rawChats = res;
    end
    if rawChats == nil then return mainChat; end

    -- 1. Se for numérico direto: "1", "2" ou "chat_1"
    local num = tonumber(chatId);
    if not num and type(chatId) == "string" and chatId:sub(1, 5) == "chat_" then
        num = tonumber(chatId:sub(6));
    end
    if num and rawChats[num] then
        return rawChats[num];
    end

    -- 2. Correspondência por getChatId ou login de participante
    for i = 1, #rawChats do
        local c = rawChats[i];
        if c then
            if getChatId(c, mesa, i) == chatId then
                return c;
            end
            local rawParts = safeGet(c, "participants");
            if type(rawParts) == "table" then
                for p = 1, #rawParts do
                    local part = rawParts[p];
                    if part and type(part) == "table" then
                        local pLogin = safeGet(part, "login");
                        local pNick = safeGet(part, "nick");
                        if pLogin == chatId or pNick == chatId or ("pvt:" .. tostring(pLogin)) == chatId then
                            return c;
                        end
                    end
                end
            end
        end
    end

    return mainChat;
end

-- =========================================================================
-- Comandos
-- =========================================================================

-- list_chats: lista chats disponíveis na mesa
function chatCommands.listChats(args)
    local roomId = tonumber(args.room_id or args.id);
    if roomId == nil then
        error("invalid or missing 'room_id' argument");
    end

    local mesa = Firecast.findRoom(roomId);
    if mesa == nil then
        error("room not found: " .. tostring(roomId));
    end

    local mainChat = safeGet(mesa, "chat");
    local activeChat = safeGet(mesa, "activeChat");
    local mainHandle = safeGet(mainChat, "handle");
    local activeHandle = safeGet(activeChat, "handle");

    local result = {};

    -- 1. Chat principal
    if mainChat ~= nil then
        table.insert(result, {
            id           = "main",
            name         = "Chat Principal",
            kind         = "room",
            is_main      = true,
            is_active    = (activeHandle == nil or activeHandle == mainHandle),
            participants = {},
        });
    end

    -- 2. Outros chats da mesa (PVTs abertos, grupos)
    local ok, rawChats = pcall(function() return mesa:getChats(); end);
    if ok and type(rawChats) == "table" then
        for i = 1, #rawChats do
            local c = rawChats[i];
            if c ~= nil then
                local cHandle = safeGet(c, "handle");
                if cHandle ~= mainHandle then
                    local chatId = getChatId(c, mesa, i);
                    local name = getChatName(c, mesa, i);
                    local parts = {};
                    local rawParts = safeGet(c, "participants");
                    if type(rawParts) == "table" then
                        for p = 1, #rawParts do
                            local part = rawParts[p];
                            if part and type(part) == "table" then
                                table.insert(parts, {
                                    id    = safeGet(part, "userId") or safeGet(part, "id"),
                                    login = safeGet(part, "login"),
                                    nick  = safeGet(part, "nick"),
                                });
                            end
                        end
                    end
                    local medium = safeGet(c, "medium");
                    local kind = (type(medium) == "table" and safeGet(medium, "kind")) or "unknown";
                    table.insert(result, {
                        id           = chatId,
                        name         = name,
                        kind         = kind,
                        is_main      = false,
                        is_active    = (cHandle ~= nil and cHandle == activeHandle),
                        participants = parts,
                    });
                end
            end
        end
    end

    return result;
end

-- get_chat_messages: lê histórico recente de mensagens do chat
function chatCommands.getChatMessages(args)
    local roomId = tonumber(args.room_id or args.id);
    if roomId == nil then
        error("invalid or missing 'room_id' argument");
    end

    local mesa = Firecast.findRoom(roomId);
    if mesa == nil then
        error("room not found: " .. tostring(roomId));
    end

    local c = findChat(mesa, args.chat_id);
    if c == nil then
        error("chat not found: " .. tostring(args.chat_id or "main"));
    end

    local limit = tonumber(args.limit) or 50;
    local recs = nil;
    pcall(function() recs = c:readLogRecs(); end);
    local result = {};

    if recs ~= nil then
        local total = #recs;
        local startIndex = math.max(1, total - limit + 1);
        for i = startIndex, total do
            local item = serializeLogRec(recs[i]);
            if item ~= nil then
                table.insert(result, item);
            end
        end
    end

    return {
        room_id  = roomId,
        chat_id  = args.chat_id or "main",
        count    = #result,
        messages = result,
    };
end

-- send_chat_message: envia mensagem para o chat especificado
function chatCommands.sendChatMessage(args)
    local roomId = tonumber(args.room_id or args.id);
    if roomId == nil then
        error("invalid or missing 'room_id' argument");
    end

    local mesa = Firecast.findRoom(roomId);
    if mesa == nil then
        error("room not found: " .. tostring(roomId));
    end

    local msg = tostring(args.message or "");
    local msgType = tostring(args.type or "standard"):lower();

    if msg == "" and msgType ~= "laugh" and msgType ~= "risada" then
        error("missing 'message' argument");
    end

    local c = findChat(mesa, args.chat_id);
    if c == nil then
        error("chat not found: " .. tostring(args.chat_id or "main"));
    end

    if msgType == "narrator" or msgType == "asnarrator" or msgType == "narracao" then
        c:enviarNarracao(msg);
    elseif msgType == "npc" or msgType == "asnpc" then
        local npcName = tostring(args.npc_name or args.npc or "NPC");
        c:enviarMensagemNPC(npcName, msg);
    elseif msgType == "action" or msgType == "acao" then
        c:enviarAcao(msg);
    elseif msgType == "laugh" or msgType == "risada" or msgType == "rir" then
        c:enviarRisada();
    else
        c:enviarMensagem(msg);
    end

    return {
        success  = true,
        room_id  = roomId,
        chat_id  = args.chat_id or "main",
        type     = msgType,
        message  = msg,
        npc_name = args.npc_name,
    };
end

-- roll_dice: executa rolagem de dados no chat
function chatCommands.rollDice(args, reply)
    local roomId = tonumber(args.room_id or args.id);
    if roomId == nil then
        error("invalid or missing 'room_id' argument");
    end

    local mesa = Firecast.findRoom(roomId);
    if mesa == nil then
        error("room not found: " .. tostring(roomId));
    end

    local expr = tostring(args.expression or args.formula or "");
    if expr == "" then
        error("missing 'expression' argument");
    end

    local c = findChat(mesa, args.chat_id);
    if c == nil then
        error("chat not found: " .. tostring(args.chat_id or "main"));
    end

    local descMsg = args.message or "";

    -- 1. Se c:asyncRoll estiver disponível (método assíncrono nativo com Promise no SDK3)
    if type(c.asyncRoll) == "function" then
        return c:asyncRoll(expr, descMsg):thenDo(function(resultado, rollObj, logRec)
            local finalRoll = rollObj or (logRec and logRec.msg and logRec.msg.roll);
            return {
                success    = true,
                room_id    = roomId,
                chat_id    = args.chat_id or "main",
                expression = expr,
                total      = resultado or safeGet(finalRoll, "resultado"),
                asString   = safeGet(finalRoll, "asString"),
                roll       = serializeRoll(finalRoll),
            };
        end);
    end

    local timeoutTimer = nil;
    local finished = false;

    local function onComplete(rollObj)
        if finished then return; end
        finished = true;
        if timeoutTimer ~= nil then
            pcall(function() timeoutTimer:setEnabled(false); end);
            timeoutTimer = nil;
        end

        local serialized = serializeRoll(rollObj);
        reply(true, {
            success    = true,
            room_id    = roomId,
            chat_id    = args.chat_id or "main",
            expression = expr,
            total      = safeGet(rollObj, "resultado"),
            asString   = safeGet(rollObj, "asString"),
            roll       = serialized,
        });
    end

    -- Timeout de segurança caso o chat não autorize a rolagem
    timeoutTimer = rrpgObjs.newTimer(7000, function()
        if not finished then
            finished = true;
            if timeoutTimer ~= nil then
                pcall(function() timeoutTimer:setEnabled(false); end);
                timeoutTimer = nil;
            end
            reply(false, "tempo limite esgotado aguardando resultado da rolagem no chat");
        end
    end);

    local ok, err = pcall(function()
        c:rolarDados(expr, descMsg, onComplete);
    end);

    if not ok then
        if timeoutTimer ~= nil then
            pcall(function() timeoutTimer:setEnabled(false); end);
            timeoutTimer = nil;
        end
        reply(false, "erro ao disparar rolagem: " .. tostring(err));
    end
end

-- =========================================================================
-- Eventos em tempo real
-- =========================================================================

function chatCommands.registerEvents(bridge)
    local receiver = Firecast.listen("ChatMessage", function(msg)
        pcall(function()
            local chatKind = "unknown";
            local chatId = "main";
            local roomId = nil;

            local roomObj = safeGet(msg, "room");
            if roomObj then
                roomId = safeGet(roomObj, "codigoInterno");
            end

            local chatObj = safeGet(msg, "chat");
            if chatObj then
                local chatRoom = safeGet(chatObj, "room");
                if chatRoom and roomId == nil then
                    roomId = safeGet(chatRoom, "codigoInterno");
                end
                local medium = safeGet(chatObj, "medium");
                if medium then
                    chatKind = medium.kind or "unknown";
                    if chatKind == "room" then
                        chatId = "main";
                    elseif chatKind == "pvtOnRoom" then
                        local pvtPlayer = safeGet(msg, "pvtPlayer");
                        local target = (pvtPlayer and (pvtPlayer.login or pvtPlayer.nick)) or "pvt";
                        chatId = "pvt:" .. tostring(target);
                    elseif chatKind == "groupPvtOnRoom" then
                        chatId = "group:" .. tostring(medium.groupId or "");
                    end
                end
            end

            local sender = nil;
            local playerObj = safeGet(msg, "player");
            local entityObj = safeGet(msg, "entity");
            if playerObj then
                sender = {
                    id    = safeGet(playerObj, "id") or safeGet(playerObj, "codigoInterno"),
                    login = safeGet(playerObj, "login"),
                    nick  = safeGet(playerObj, "nick"),
                };
            elseif entityObj then
                sender = {
                    id    = safeGet(entityObj, "userId") or safeGet(entityObj, "id"),
                    login = safeGet(entityObj, "login"),
                    nick  = safeGet(entityObj, "nick"),
                };
            end

            local rollData = nil;
            local rollObj = safeGet(msg, "roll");
            if rollObj then
                rollData = serializeRoll(rollObj);
            end

            bridge.emit("chat_message", {
                room_id   = roomId,
                chat_id   = chatId,
                chat_kind = chatKind,
                mine      = safeGet(msg, "mine") or false,
                type      = safeGet(msg, "type") or "standard",
                content   = safeGet(msg, "content") or "",
                npc       = safeGet(msg, "npc"),
                sender    = sender,
                roll      = rollData,
            });
        end);
    end);

    table.insert(_eventReceivers, receiver);
end

return chatCommands;
