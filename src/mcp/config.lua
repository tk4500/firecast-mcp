-- config.lua
-- Configuração do servidor MCP do Firecast
-- Este arquivo é lido pelo servidor Node na inicialização.

return {
  -- Caminho do banco de dados SQLite (opcional)
  -- Se não especificado, usa <VHD>/mcp/firecast.db
  -- Exemplo: "D:/Backups/firecast-mesas.db"
  db_path = nil,
  
  -- Intervalo de polling do inbox em milissegundos (opcional, padrão 500)
  -- poll_interval_ms = 500,
}
