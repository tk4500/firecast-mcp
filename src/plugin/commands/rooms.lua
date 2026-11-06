-- commands/rooms.lua
-- Handlers de comandos MCP para o domínio de Mesas

local Firecast = require("sdk/firecast.lua");

local rooms = {};

-- Serializa um Objeto Mesa para JSON-safe table
local function serializeRoom(mesa)
    if mesa == nil then return nil; end

    local players = {};
    if mesa.jogadores then
        for i = 1, #mesa.jogadores do
            local j = mesa.jogadores[i];
            table.insert(players, {
                login  = j.login,
                nome   = j.nome,
                isMe   = (j == mesa.meuJogador),
                isMestre = j.isMestre or false,
            });
        end
    end

    return {
        id           = mesa.codigoInterno,
        nome         = mesa.nome,
        sistema      = mesa.sistema,
        msgStatus    = mesa.msgStatus,
        msgBoasVindas = mesa.msgBoasVindas,
        site         = mesa.site,
        logotipo     = mesa.logotipo,
        haVagas      = mesa.haVagas,
        isRestrito18 = mesa.isRestrito18Anos,
        isModerada   = mesa.isModerada,
        firecastURI  = mesa.firecastURI,
        players      = players,
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
    local mesa = Firecast.findRoom(args.id);
    if mesa == nil then
        error("room not found: " .. tostring(args.id));
    end
    return serializeRoom(mesa);
end

-- Registra listeners de eventos de mesa no bridge.
-- Mantém referências fortes para evitar que o GC desinstale as escutas.
local _receivers = {};

function rooms.registerEvents(bridge)
    require("sdk/firecast.lua");  -- garante que Firecast.listen está disponível

    _receivers.joined = Firecast.listen("MesaJoined", function(params)
        bridge.emit("room_joined", {
            room   = serializeRoom(params.room),
            isMe   = params.me,
            player = params.player and {
                login    = params.player.login,
                nome     = params.player.nome,
                isMestre = params.player.isMestre or false,
            } or nil,
        });
    end);

    _receivers.parted = Firecast.listen("MesaParted", function(params)
        bridge.emit("room_parted", {
            room   = serializeRoom(params.room),
            isMe   = params.me,
            player = params.player and {
                login = params.player.login,
                nome  = params.player.nome,
            } or nil,
            text   = params.text,
            isKick = params.isKick,
            responsible = params.responsible and {
                login = params.responsible.login,
                nome  = params.responsible.nome,
            } or nil,
        });
    end);
end

return rooms;
