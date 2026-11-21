// tools/common.ts
// Schemas zod e textos compartilhados entre as tools MCP.
// Centraliza as descrições dos parâmetros que se repetem (room_id, codigo_interno, chat_id...)
// para que o modelo receba sempre a mesma explicação, com a mesma origem do valor.

import { z } from "zod";

/** Resposta MCP padrão: serializa o resultado como JSON indentado. */
export function jsonResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export const TEST_ROOM_ID = 239256; // Mesa de testes 'tttttaaaaa'

export const ROOM_ID_DESC =
  "ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256.";

export const roomIdSchema = z.number().int().describe(ROOM_ID_DESC);

export const codigoInternoSchema = z
  .number()
  .int()
  .describe(
    "codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem')."
  );

export const freshSchema = z
  .boolean()
  .optional()
  .describe(
    "false/omitido = responde do cache SQLite local (rápido, pode estar desatualizado). true = consulta o Firecast ao vivo e atualiza o cache. Padrão: false."
  );

export const chatIdSchema = z
  .string()
  .optional()
  .describe(
    "Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar."
  );

export const characterRefSchema = z
  .string()
  .describe(
    "Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial."
  );

export const ImpersonationSchema = z
  .object({
    mode: z
      .enum(["none", "narrator", "character"])
      .optional()
      .describe("'character' = fala como personagem/NPC (padrão quando o objeto é enviado), 'narrator' = narração, 'none' = como você mesmo."),
    name: z.string().optional().describe("Nome exibido no chat. Aceita prefixo de cor Talemark, ex: '[§K#FF0000]Goblin'."),
    avatar: z.string().url().optional().describe("URL http(s) da imagem de avatar."),
    gender: z
      .enum(["undefined", "masculine", "feminine", "neuter"])
      .optional()
      .describe("Gênero gramatical usado pelo Firecast em textos automáticos."),
  })
  .describe(
    "Identidade com que a mensagem/rolagem aparece no chat. Tem prioridade sobre npc_name/avatar/type='narrator'."
  );

export const VisibilitySchema = z
  .object({
    mode: z
      .enum(["standard", "recipients"])
      .optional()
      .describe("'standard' = todos veem (padrão). 'recipients' = só os usuários em `recipients` veem (sussurro/rolagem secreta)."),
    recipients: z
      .array(z.number())
      .optional()
      .describe("IDs numéricos dos jogadores que podem ver (campo `id` de list_players). Usado com mode='recipients'."),
    blacklist: z
      .array(z.number())
      .optional()
      .describe("IDs numéricos dos jogadores que NÃO podem ver (campo `id` de list_players)."),
  })
  .describe("Quem pode ver a mensagem. Omitido = visível para todos.");

export const TalemarkOptionsSchema = z
  .object({
    parseCharActions: z.boolean().optional().describe("Formata *texto entre asteriscos* como ação."),
    parseSmileys: z.boolean().optional().describe("Converte emoticons (ex: ':)') em smileys."),
    parseURL: z.boolean().optional().describe("Transforma URLs em links clicáveis."),
  })
  .describe("Opções de interpretação do texto (Talemark). Omitido = padrão do Firecast.");

export const NodeOperationSchema = z
  .object({
    action: z
      .enum(["set", "delete"])
      .describe("'set' grava `value` no caminho (cria nós intermediários se faltarem). 'delete' remove o campo/nó do caminho."),
    path: z
      .string()
      .describe(
        "Caminho no NDB com ponto ou barra (ex: 'pv', 'atributos.forca', 'inventario/moedas'). Caminho vazio ('') = raiz: 'set' exige `value` objeto e grava cada chave na raiz; 'delete' na raiz APAGA TODOS OS NÓS FILHOS."
      ),
    value: z
      .any()
      .optional()
      .describe("Valor para action='set': string, número, booleano ou objeto (vira sub-nó). Ignorado em 'delete'."),
  })
  .describe("Uma operação de escrita no Node Database.");

export type NodeOperation = z.infer<typeof NodeOperationSchema>;

export const GUARD_NOTE =
  "Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.";
