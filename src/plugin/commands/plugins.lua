-- commands/plugins.lua
-- Gerencia comandos de descoberta de plugins e modelos de fichas (dataTypes) no Firecast SDK3.

local Firecast = require("sdk/firecast.lua");

local pluginsCommands = {};

-- Obtém a biblioteca de plugins de forma segura
local function getPluginsLib()
    pcall(function() require("plugins.lua"); end);
    pcall(function() require("sdk/plugins.lua"); end);

    if Firecast.Plugins ~= nil then
        return Firecast.Plugins;
    end
    if Firecast.plugins ~= nil then
        return Firecast.plugins;
    end

    local legacyRrpg = rawget(_G, "rrpg");
    if legacyRrpg ~= nil and legacyRrpg.plugins ~= nil then
        return legacyRrpg.plugins;
    end
    if legacyRrpg ~= nil and legacyRrpg.Plugins ~= nil then
        return legacyRrpg.Plugins;
    end

    -- Fallback direto para funções C globais da engine do Firecast
    if type(_rrpg_plugins_getInstalledDataTypes) == "function" then
        return {
            getInstalledDataTypes = _rrpg_plugins_getInstalledDataTypes,
            getInstalledPlugins = _rrpg_plugins_getInstalledPlugins or function() return {}; end,
        };
    end

    return nil;
end

-- Lista todos os dataTypes instalados (modelos de fichas, janelas acopláveis, etc.)
function pluginsCommands.list_data_types(params, reply)
    params = params or {};
    local lib = getPluginsLib();
    if lib == nil or type(lib.getInstalledDataTypes) ~= "function" then
        local errRes = {
            ok = false,
            error = "Biblioteca Firecast.Plugins não disponível ou função getInstalledDataTypes ausente."
        };
        if type(reply) == "function" then reply(false, errRes.error); end
        return errRes;
    end

    local rawList = nil;
    local ok, err = pcall(function()
        rawList = lib.getInstalledDataTypes();
    end);

    if not ok or rawList == nil then
        local errRes = {
            ok = false,
            error = "Falha ao invocar getInstalledDataTypes: " .. tostring(err)
        };
        if type(reply) == "function" then reply(false, errRes.error); end
        return errRes;
    end

    local formTypeFilter = params.form_type;
    if formTypeFilter ~= nil and formTypeFilter ~= "" then
        formTypeFilter = string.lower(formTypeFilter);
    else
        formTypeFilter = nil;
    end

    local query = params.query;
    if query ~= nil and query ~= "" then
        query = string.lower(query);
    else
        query = nil;
    end

    local dataTypes = {};
    for i = 1, #rawList do
        local item = rawList[i];
        if item ~= nil then
            local fType = tostring(item.formType or "");
            local dType = tostring(item.dataType or "");
            local title = tostring(item.title or "");
            local modId = tostring(item.moduleId or "");

            local matchesFormType = true;
            if formTypeFilter ~= nil then
                matchesFormType = (string.lower(fType) == formTypeFilter);
            end

            local matchesQuery = true;
            if query ~= nil then
                local strSearch = string.lower(dType .. " " .. title .. " " .. modId);
                matchesQuery = string.find(strSearch, query, 1, true) ~= nil;
            end

            if matchesFormType and matchesQuery then
                table.insert(dataTypes, {
                    dataType = dType,
                    formType = fType,
                    title    = title,
                    moduleId = modId,
                });
            end
        end
    end

    local res = {
        ok = true,
        total = #dataTypes,
        data_types = dataTypes
    };
    if type(reply) == "function" then
        reply(true, res);
    end
    return res;
end

-- Lista todos os plugins SDK3 instalados no Firecast
function pluginsCommands.list_plugins(params, reply)
    params = params or {};
    local lib = getPluginsLib();
    if lib == nil or type(lib.getInstalledPlugins) ~= "function" then
        local errRes = {
            ok = false,
            error = "Biblioteca Firecast.Plugins não disponível ou função getInstalledPlugins ausente."
        };
        if type(reply) == "function" then reply(false, errRes.error); end
        return errRes;
    end

    local rawList = nil;
    local ok, err = pcall(function()
        rawList = lib.getInstalledPlugins();
    end);

    if not ok or rawList == nil then
        local errRes = {
            ok = false,
            error = "Falha ao invocar getInstalledPlugins: " .. tostring(err)
        };
        if type(reply) == "function" then reply(false, errRes.error); end
        return errRes;
    end

    local query = params.query;
    if query ~= nil and query ~= "" then
        query = string.lower(query);
    else
        query = nil;
    end

    local plugins = {};
    for i = 1, #rawList do
        local p = rawList[i];
        if p ~= nil then
            local modId = tostring(p.moduleId or "");
            local name = tostring(p.name or "");
            local desc = tostring(p.description or "");
            local author = tostring(p.author or "");
            local version = tostring(p.version or "");
            local site = tostring(p.site or "");
            local contact = tostring(p.contact or "");
            local fileName = tostring(p.fileName or "");

            local matchesQuery = true;
            if query ~= nil then
                local strSearch = string.lower(modId .. " " .. name .. " " .. desc .. " " .. author);
                matchesQuery = string.find(strSearch, query, 1, true) ~= nil;
            end

            if matchesQuery then
                table.insert(plugins, {
                    moduleId    = modId,
                    name        = name,
                    version     = version,
                    description = desc,
                    author      = author,
                    site        = site,
                    contact     = contact,
                    fileName    = fileName
                });
            end
        end
    end

    local res = {
        ok = true,
        total = #plugins,
        plugins = plugins
    };
    if type(reply) == "function" then
        reply(true, res);
    end
    return res;
end

return pluginsCommands;
