-- firedrive.lua
-- Comando de upload rápido para o FireDrive do Firecast (blobs Firecast)

local FireDrive = require("sdk/fireDrive.lua");
local utils = require("sdk/rrpgUtil.lua");
local VHD = require("sdk/vhd.lua");

local firedrive = {};

local function getMimeFromFilename(filename)
    local ext = filename:match("%.([^%.]+)$");
    if not ext then return "application/octet-stream"; end
    ext = ext:lower();
    if ext == "png" then return "image/png"; end
    if ext == "jpg" or ext == "jpeg" then return "image/jpeg"; end
    if ext == "gif" then return "image/gif"; end
    if ext == "webp" then return "image/webp"; end
    if ext == "mp3" then return "audio/mpeg"; end
    if ext == "ogg" then return "audio/ogg"; end
    if ext == "wav" then return "audio/wav"; end
    if ext == "pdf" then return "application/pdf"; end
    if ext == "zip" then return "application/zip"; end
    if ext == "txt" then return "text/plain"; end
    if ext == "json" then return "application/json"; end
    return "application/octet-stream";
end

function firedrive.quickUpload(args, reply)
    local filename = args.filename or ("upload_" .. tostring(os.time()) .. ".bin");
    local mimeType = args.mime_type or getMimeFromFilename(filename);
    local stream = nil;

    if args.content_base64 and args.content_base64 ~= "" then
        stream = utils.newMemoryStream();
        stream:writeBase64(args.content_base64);
        stream.position = 0;
    elseif args.vhd_path and args.vhd_path ~= "" then
        if not VHD.fileExists(args.vhd_path) then
            if reply then reply(false, "Arquivo VHD não encontrado: " .. tostring(args.vhd_path)); end
            return;
        end
        stream = VHD.openFile(args.vhd_path, "r");
    end

    if not stream then
        if reply then reply(false, "Nenhum conteúdo fornecido (necessário content_base64 ou vhd_path)"); end
        return;
    end

    FireDrive.quickUpload(filename, mimeType, stream,
        function(successData)
            pcall(function() stream:close(); end);
            local url = successData.url or successData.fileURL or successData.fullURL;
            if reply then
                reply(true, {
                    url = url,
                    name = successData.name or filename,
                    size = successData.size or stream.size,
                    mime_type = successData.mimeType or mimeType,
                    talemark_image = "[§I " .. tostring(url) .. "]",
                    talemark_link = "[§B]📁 [" .. tostring(filename) .. "](" .. tostring(url) .. ")[§R]"
                });
            end
        end,
        nil, -- onProgress
        function(err)
            pcall(function() stream:close(); end);
            if reply then
                reply(false, "Falha no upload do FireDrive: " .. tostring(err));
            end
        end
    );
end

return firedrive;
