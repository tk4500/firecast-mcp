-- commands/rooms.lua
-- Handlers de comandos MCP para o domínio de Mesas

local Firecast = require("sdk/firecast.lua");

local rooms = {};

-- Serializa um Objeto Jogador para JSON-safe table
local function serializePlayer(j, mesa)
    if j == nil then return nil; end
    return {
        id                  = j.id,
        codigoInterno       = j.codigoInterno,
        login               = j.login,
        nick                = j.nick,
        nome                = j.nick or j.login,
        avatar              = j.avatar,
        capa                = j.capa,
        isMe                = (mesa ~= nil and mesa.meuJogador ~= nil and j == mesa.meuJogador),
        isMestre            = j.isMestre or false,
        isJogador           = j.isJogador or false,
        isEspectador        = j.isEspectador or false,
        isAusente           = j.isAusente or false,
        isCnxDormente       = j.isCnxDormente or false,
        isSessaoMobile      = j.isSessaoMobile or false,
        isMudo              = j.isMudo or false,
        isCego              = j.isCego or false,
        haveVoice           = (j.haveVoice or j.haveVoz) or false,
        isGold              = j.isGold or false,
        isGoldPlus          = j.isGoldPlus or false,
        isRuby              = j.isRuby or false,
        personagemPrincipal = (j.personagemPrincipal and j.personagemPrincipal ~= -1) and j.personagemPrincipal or nil,
    };
end

-- Serializa um Objeto Mesa para JSON-safe table
local function serializeRoom(mesa)
    if mesa == nil then return nil; end

    local players = {};
    if mesa.jogadores then
        for i = 1, #mesa.jogadores do
            local p = serializePlayer(mesa.jogadores[i], mesa);
            if p ~= nil then
                table.insert(players, p);
            end
        end
    end

    return {
        id            = mesa.codigoInterno,
        nome          = mesa.nome,
        sistema       = mesa.sistema,
        msgStatus     = mesa.msgStatus,
        msgBoasVindas = mesa.msgBoasVindas,
        site          = mesa.site,
        logotipo      = mesa.logotipo,
        haVagas       = mesa.haVagas,
        isRestrito18  = mesa.isRestrito18Anos,
        isModerada    = mesa.isModerada,
        firecastURI   = mesa.firecastURI,
        meuJogador    = serializePlayer(mesa.meuJogador, mesa),
        players       = players,
    };
end

-- command: list_rooms
-- args: {} 
-- retorna: array de mesas
function rooms.listRooms(_args)
    local mesas = Firecast.getRooms();
    local result = {};
    for i = 1, #mesas do
        table.insert(result, serializeRoom(mesas[i]));
    end
    return result;
end

-- command: get_room
-- args: { id: number }
function rooms.getRoom(args)
    local id = tonumber(args.id);
    if id == nil then
        error("invalid or missing 'id' argument");
    end
    local mesa = Firecast.findRoom(id);
    if mesa == nil then
        error("room not found: " .. tostring(args.id));
    end
    return serializeRoom(mesa);
end

-- command: list_players
-- args: { id: number }
function rooms.listPlayers(args)
    local id = tonumber(args.id or args.room_id);
    if id == nil then
        error("invalid or missing 'id' argument");
    end
    local mesa = Firecast.findRoom(id);
    if mesa == nil then
        error("room not found: " .. tostring(args.id or args.room_id));
    end
    local list = {};
    if mesa.jogadores then
        for i = 1, #mesa.jogadores do
            local p = serializePlayer(mesa.jogadores[i], mesa);
            if p ~= nil then
                table.insert(list, p);
            end
        end
    end
    return list;
end

-- Registra listeners de eventos de mesa no bridge (DESATIVADO).
function rooms.registerEvents(bridge)
    -- Desativado: sem escuta contínua de eventos de mesa (MesaJoined / MesaParted).
end

return rooms;
