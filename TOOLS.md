# Firecast MCP — referência das tools

> Gerado automaticamente por `npm run docs:tools` (server/scripts/gen-tools-doc.ts) a partir das definições em `server/src/tools/`. Não edite à mão: altere as descrições no código e gere de novo.

Total: 38 tools. Todas recebem um objeto JSON de argumentos e devolvem JSON em texto.

## Visão geral (instruções enviadas ao modelo)

```text
Firecast MCP: controla o Firecast (mesa virtual de RPG) através de um plugin rodando no cliente Firecast do usuário.

PRÉ-REQUISITO: o Firecast precisa estar aberto, com o plugin carregado e conectado à mesa. Sem isso, tools que consultam o Firecast falham por timeout (30 s); tools com cache (list_rooms, get_room, list_players, get_chat_messages, get_character_sheet) ainda respondem com dados salvos, e as do Character Manager e get_sheet_template funcionam offline.

DE ONDE VÊM OS IDS:
- room_id (às vezes chamado só de id): campo `id` de list_rooms.
- codigo_interno / parent_codigo: campo `codigoInterno` dos itens de list_library (fichas têm tipo='personagem').
- id e login de jogador: list_players (id → visibility.recipients; login → chat_id 'pvt:<login>').
- chat_id: 'main' (padrão) ou o `id` de list_chats.
- data_type: list_data_types (form_type='sheetTemplate' para fichas).

DOIS TIPOS DE "PERSONAGEM" — não confunda:
1. Ficha na Biblioteca do Firecast: identificada por codigo_interno; lida/escrita com get_sheet_ndb, edit_sheet_ndb, get_character_sheet, update_character_sheet.
2. Personagem do Character Manager: registro local do MCP (nome, avatar, cor, personalidade) identificado por `character` (id, code ou nome); usado com impersonate_character e character_roll. Pode ser vinculado a uma ficha com link_character_sheet.

FLUXOS COMUNS:
- Ler uma ficha: list_rooms → list_library(room_id) → get_character_sheet(room_id, codigo_interno).
- Alterar valores da ficha: get_character_sheet (para ver os nomes dos campos) → update_character_sheet(changes={'pv': 30}).
- Falar como NPC: create_character uma vez → impersonate_character(character, message, room_id).
- Mostrar uma imagem: send_media_to_chat(room_id, file_path ou media_url).

CUIDADOS:
- send_chat_message, roll_dice, impersonate_character, character_roll e send_media_to_chat publicam DE VERDADE para os jogadores da mesa.
- edit_sheet_ndb, edit_dock_ndb, manage_library_item, manage_room e create_character_sheet só funcionam na mesa de testes 239256 ou se o usuário for mestre; em mesas reais de campanha confirme com o usuário antes de escrever.
- As respostas são JSON em texto; erros vêm como { error } ou como erro da tool.
```

## Índice

- **Mesas e jogadores**: [`list_rooms`](#list_rooms), [`get_room`](#get_room), [`list_players`](#list_players)
- **Chat e dados**: [`list_chats`](#list_chats), [`get_chat_messages`](#get_chat_messages), [`send_chat_message`](#send_chat_message), [`roll_dice`](#roll_dice)
- **Biblioteca e Node Database (fichas no Firecast)**: [`list_library`](#list_library), [`get_library_item`](#get_library_item), [`get_sheet_ndb`](#get_sheet_ndb), [`edit_sheet_ndb`](#edit_sheet_ndb), [`open_dock_ndb`](#open_dock_ndb), [`edit_dock_ndb`](#edit_dock_ndb), [`manage_library_item`](#manage_library_item), [`manage_room`](#manage_room), [`get_sheet_template`](#get_sheet_template), [`create_character_sheet`](#create_character_sheet)
- **Fichas com cache (atalhos de leitura/escrita)**: [`get_character_sheet`](#get_character_sheet), [`update_character_sheet`](#update_character_sheet), [`list_synced_sheets`](#list_synced_sheets), [`sync_character_sheet`](#sync_character_sheet), [`open_character_sheet`](#open_character_sheet)
- **Plugins e modelos de ficha**: [`list_data_types`](#list_data_types), [`list_installed_plugins`](#list_installed_plugins)
- **Character Manager (NPCs locais do MCP)**: [`create_character`](#create_character), [`update_character`](#update_character), [`get_character`](#get_character), [`list_characters`](#list_characters), [`delete_character`](#delete_character), [`impersonate_character`](#impersonate_character), [`character_roll`](#character_roll), [`link_character_sheet`](#link_character_sheet), [`import_external_npcs`](#import_external_npcs)
- **Mídia (upload e envio de imagens)**: [`upload_media`](#upload_media), [`get_media_url`](#get_media_url), [`list_media_files`](#list_media_files), [`send_media_to_chat`](#send_media_to_chat), [`configure_storage`](#configure_storage)

## Mesas e jogadores

### list_rooms

Lista as mesas em que você está conectado no Firecast. Ponto de partida de quase todo fluxo: o campo `id` de cada mesa é o `room_id` exigido pelas outras tools. Retorna array de { id, nome, sistema, isModerada, haVagas, players[...], ... }. Usa o cache SQLite por padrão; se o cache estiver vazio busca ao vivo automaticamente.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `fresh` | booleano | não | false/omitido = responde do cache SQLite local (rápido, pode estar desatualizado). true = consulta o Firecast ao vivo e atualiza o cache. Padrão: false. |

Chamada mínima:

```json
{"name":"list_rooms","arguments":{}}
```

### get_room

Retorna os detalhes de UMA mesa (nome, sistema, mensagens de status/boas-vindas, moderação e lista de jogadores). Atenção: aqui o parâmetro se chama `id`, não `room_id`.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `fresh` | booleano | não | false/omitido = responde do cache SQLite local (rápido, pode estar desatualizado). true = consulta o Firecast ao vivo e atualiza o cache. Padrão: false. |

Chamada mínima:

```json
{"name":"get_room","arguments":{"id":239256}}
```

### list_players

Lista os jogadores presentes na mesa: { id, login, nick, isMe, isMestre, isJogador, isEspectador, isAusente, personagemPrincipal, ... }. Use `id` como destinatário em visibility.recipients e `login` para chat_id 'pvt:<login>'.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `fresh` | booleano | não | false/omitido = responde do cache SQLite local (rápido, pode estar desatualizado). true = consulta o Firecast ao vivo e atualiza o cache. Padrão: false. |

Chamada mínima:

```json
{"name":"list_players","arguments":{"room_id":239256}}
```

## Chat e dados

### list_chats

Lista os chats abertos na mesa: o principal ('main') e abas de PVT/grupo já abertas no cliente. Retorna [{ id, name, kind, is_main, is_active, participants[] }]. Use o `id` retornado como chat_id nas outras tools. Sempre consulta ao vivo.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |

Chamada mínima:

```json
{"name":"list_chats","arguments":{"room_id":239256}}
```

### get_chat_messages

Lê o histórico de mensagens de um chat. Três modos: (1) padrão = cache SQLite local, preenchido apenas por leituras ao vivo anteriores (pode estar desatualizado; se vazio, cai para o modo 2); (2) fresh=true = buffer local do cliente Firecast (mensagens recentes desde que você entrou); (3) server_query=true ou tid = histórico do servidor Firecast, com paginação para trás. Retorna { source, count, messages[{ id, tid, timestamp, entity{login,nick}, msg{msgType, content, impersonation, roll}, visibility }] }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `limit` | inteiro | não | Máximo de mensagens (1–50; o plugin limita a 50). Padrão: 50. |
| `fresh` | booleano | não | true = ignora o cache e lê o buffer ao vivo do cliente Firecast. Padrão: false. |
| `server_query` | booleano | não | true = consulta o histórico salvo no servidor Firecast (alcança mensagens anteriores à sua entrada). Padrão: false. |
| `tid` | texto | não | Paginação retroativa: passe o `tid` da mensagem mais antiga já recebida para buscar as anteriores a ela. Ativa server_query automaticamente. |
| `audit` | booleano | não | true = inclui mensagens apagadas (requer server_query). Padrão: false. |

Chamada mínima:

```json
{"name":"get_chat_messages","arguments":{"room_id":239256}}
```

### send_chat_message

Envia uma mensagem ao chat da mesa (é publicado de verdade para os jogadores). Como escolher a identidade: (a) texto normal → só `message`; (b) narração → type='narrator'; (c) NPC simples → npc_name (+ avatar opcional); (d) controle total → objeto `impersonation`. Prioridade: impersonation > npc_name > type='narrator'. Para falar como um personagem salvo no Character Manager prefira impersonate_character. Para sussurro use `visibility`.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `message` | texto | **sim** | Texto da mensagem. Aceita marcação Talemark (ex: '[§B]negrito[§R]', '[§K#FF0000]vermelho', '[§I url]' para imagem). Pode ser vazio só com type='laugh'. |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `type` | `'standard'` \| `'narrator'` \| `'npc'` \| `'action'` \| `'laugh'` | não | 'standard' (padrão) = fala normal; 'narrator' = narração; 'npc' = rótulo para fala de NPC (o nome vem de npc_name — sem npc_name sai como fala normal); 'action' = ação em terceira pessoa ('/me'); 'laugh' = risada (ignora message). |
| `npc_name` | texto | não | Nome do NPC exibido como autor (ex: 'Taverneiro'). Basta informar para falar como NPC; ignorado se `impersonation` for enviado. |
| `avatar` | texto | não | URL do avatar usado junto com npc_name ou type='narrator'. |
| `gender` | `'undefined'` \| `'masculine'` \| `'feminine'` \| `'neuter'` | não | Gênero gramatical usado junto com npc_name ou type='narrator'. |
| `impersonation` | objeto | não | Identidade com que a mensagem/rolagem aparece no chat. Tem prioridade sobre npc_name/avatar/type='narrator'. |
| `impersonation.mode` | `'none'` \| `'narrator'` \| `'character'` | não | 'character' = fala como personagem/NPC (padrão quando o objeto é enviado), 'narrator' = narração, 'none' = como você mesmo. |
| `impersonation.name` | texto | não | Nome exibido no chat. Aceita prefixo de cor Talemark, ex: '[§K#FF0000]Goblin'. |
| `impersonation.avatar` | texto | não | URL http(s) da imagem de avatar. |
| `impersonation.gender` | `'undefined'` \| `'masculine'` \| `'feminine'` \| `'neuter'` | não | Gênero gramatical usado pelo Firecast em textos automáticos. |
| `visibility` | objeto | não | Quem pode ver a mensagem. Omitido = visível para todos. |
| `visibility.mode` | `'standard'` \| `'recipients'` | não | 'standard' = todos veem (padrão). 'recipients' = só os usuários em `recipients` veem (sussurro/rolagem secreta). |
| `visibility.recipients` | número[] | não | IDs numéricos dos jogadores que podem ver (campo `id` de list_players). Usado com mode='recipients'. |
| `visibility.blacklist` | número[] | não | IDs numéricos dos jogadores que NÃO podem ver (campo `id` de list_players). |
| `talemark_options` | objeto | não | Opções de interpretação do texto (Talemark). Omitido = padrão do Firecast. |
| `talemark_options.parseCharActions` | booleano | não | Formata *texto entre asteriscos* como ação. |
| `talemark_options.parseSmileys` | booleano | não | Converte emoticons (ex: ':)') em smileys. |
| `talemark_options.parseURL` | booleano | não | Transforma URLs em links clicáveis. |

Chamada mínima:

```json
{"name":"send_chat_message","arguments":{"room_id":239256,"message":"..."}}
```

### roll_dice

Faz uma rolagem oficial de dados no chat da mesa (o resultado aparece para os jogadores e é gerado pelo Firecast, não pelo modelo). Retorna { total, asString, roll{ops[...]} }. Para rolar em nome de um personagem do Character Manager prefira character_roll. Para rolagem secreta use visibility mode='recipients'.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `expression` | texto | **sim** | Fórmula no formato do Firecast: '1d20+5', '2d6+3', '4dF', '3d6+1d4-2'. |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `message` | texto | não | Motivo exibido junto à rolagem (ex: 'Ataque de Adaga', 'Teste de Percepção'). |
| `impersonation` | objeto | não | Identidade com que a mensagem/rolagem aparece no chat. Tem prioridade sobre npc_name/avatar/type='narrator'. |
| `impersonation.mode` | `'none'` \| `'narrator'` \| `'character'` | não | 'character' = fala como personagem/NPC (padrão quando o objeto é enviado), 'narrator' = narração, 'none' = como você mesmo. |
| `impersonation.name` | texto | não | Nome exibido no chat. Aceita prefixo de cor Talemark, ex: '[§K#FF0000]Goblin'. |
| `impersonation.avatar` | texto | não | URL http(s) da imagem de avatar. |
| `impersonation.gender` | `'undefined'` \| `'masculine'` \| `'feminine'` \| `'neuter'` | não | Gênero gramatical usado pelo Firecast em textos automáticos. |
| `visibility` | objeto | não | Quem pode ver a mensagem. Omitido = visível para todos. |
| `visibility.mode` | `'standard'` \| `'recipients'` | não | 'standard' = todos veem (padrão). 'recipients' = só os usuários em `recipients` veem (sussurro/rolagem secreta). |
| `visibility.recipients` | número[] | não | IDs numéricos dos jogadores que podem ver (campo `id` de list_players). Usado com mode='recipients'. |
| `visibility.blacklist` | número[] | não | IDs numéricos dos jogadores que NÃO podem ver (campo `id` de list_players). |

Chamada mínima:

```json
{"name":"roll_dice","arguments":{"room_id":239256,"expression":"..."}}
```

## Biblioteca e Node Database (fichas no Firecast)

### list_library

Navega pela Biblioteca da mesa (pastas e personagens/fichas). Use para descobrir o `codigoInterno` de fichas e pastas. Sem recursive: retorna { item, children[] } só com os filhos imediatos. Com recursive=true: retorna { tree } aninhado. Itens com tipo='personagem' trazem dataType, avatar, barras (bar0Val..bar3Max) e linhas editáveis (edtLine0/1).

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `parent_codigo` | inteiro | não | codigoInterno da pasta a listar. Omitido = raiz da biblioteca. |
| `recursive` | booleano | não | true = desce pelas subpastas e devolve a árvore inteira. Padrão: false. |
| `max_depth` | inteiro | não | Profundidade máxima quando recursive=true. Padrão: 5. |

Chamada mínima:

```json
{"name":"list_library","arguments":{"room_id":239256}}
```

### get_library_item

Detalhes de UM item da Biblioteca (pasta ou personagem): nome, tipo, dono, visibilidade, dataType, avatar, barras e filhos imediatos. Não lê o conteúdo da ficha — para isso use get_sheet_ndb ou get_character_sheet.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do item (pasta ou personagem), obtido em list_library. |

Chamada mínima:

```json
{"name":"get_library_item","arguments":{"room_id":239256,"codigo_interno":239256}}
```

### get_sheet_ndb

Lê o conteúdo completo da ficha de um personagem (Node Database) direto do Firecast, sempre ao vivo. Retorna { characterName, dataType, data } onde `data` é a árvore de campos (nós repetidos de recordList viram arrays). Use `path` para ler só um trecho. Os nomes dos campos dependem do modelo de ficha (veja get_sheet_template).

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |
| `path` | texto | não | Sub-nó a retornar, com ponto (ex: 'atributos', 'atributos.forca'). Omitido = ficha inteira. Erro se o caminho não existir. |
| `raw_xml` | booleano | não | true = inclui também `xml` com a exportação XML do nó (útil para backup ou para copiar a ficha via edit_sheet_ndb xml). Padrão: false. |
| `max_depth` | inteiro | não | Profundidade máxima da árvore serializada; nós mais fundos aparecem como { _truncated: true }. Padrão: 8. |

Chamada mínima:

```json
{"name":"get_sheet_ndb","arguments":{"room_id":239256,"codigo_interno":239256}}
```

### edit_sheet_ndb

Escreve na ficha de um personagem (Node Database) via lista de operações set/delete, e/ou importa um XML completo. Se ambos forem enviados, o XML é importado primeiro e as operações aplicadas depois. As alterações sincronizam para todos na mesa. Retorna { appliedOperations, updatedData }. Alternativa mais simples para só trocar valores: update_character_sheet. Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |
| `operations` | objeto[] | não | Operações aplicadas em ordem, numa única transação. Ex: [{action:'set', path:'pv', value:30}, {action:'delete', path:'condicoes.envenenado'}]. |
| `operations[].action` | `'set'` \| `'delete'` | **sim** | 'set' grava `value` no caminho (cria nós intermediários se faltarem). 'delete' remove o campo/nó do caminho. |
| `operations[].path` | texto | **sim** | Caminho no NDB com ponto ou barra (ex: 'pv', 'atributos.forca', 'inventario/moedas'). Caminho vazio ('') = raiz: 'set' exige `value` objeto e grava cada chave na raiz; 'delete' na raiz APAGA TODOS OS NÓS FILHOS. |
| `operations[].value` | qualquer | não | Valor para action='set': string, número, booleano ou objeto (vira sub-nó). Ignorado em 'delete'. |
| `xml` | texto | não | XML de NDB (formato de exportação do Firecast, ex: o `xml` de get_sheet_ndb com raw_xml=true) a importar na raiz da ficha. |

Chamada mínima:

```json
{"name":"edit_sheet_ndb","arguments":{"room_id":239256,"codigo_interno":239256}}
```

### open_dock_ndb

Lê um Node Database compartilhado da mesa (dados de janelas acopláveis/plugins, como trackers de iniciativa) ou o NDB privado do seu usuário na mesa. Retorna { name, isUser, data }. Sem efeito colateral, exceto criar o NDB vazio quando create=true e ele não existir.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `name` | texto | **sim** | Nome/identificador do NDB da mesa (normalmente o dataType do dock; ver list_data_types com form_type='tablesDock'). |
| `is_user` | booleano | não | true = NDB exclusivo do seu usuário nesta mesa; false = NDB compartilhado da mesa. Padrão: false. |
| `create` | booleano | não | true = cria o NDB vazio se não existir; false = erro se não existir. Padrão: true. |
| `path` | texto | não | Sub-nó a retornar, com ponto. Omitido = tudo. |
| `raw_xml` | booleano | não | true = inclui também a exportação XML. Padrão: false. |
| `max_depth` | inteiro | não | Profundidade máxima de serialização. Padrão: 8. |

Chamada mínima:

```json
{"name":"open_dock_ndb","arguments":{"room_id":239256,"name":"..."}}
```

### edit_dock_ndb

Escreve num Node Database compartilhado da mesa (dock) ou no NDB do seu usuário, com operações set/delete. Cria o NDB se não existir. Mesma semântica de operações de edit_sheet_ndb. Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `name` | texto | **sim** | Nome/identificador do NDB da mesa (o mesmo usado em open_dock_ndb). |
| `operations` | objeto[] | **sim** | Operações aplicadas em ordem, numa única transação. |
| `operations[].action` | `'set'` \| `'delete'` | **sim** | 'set' grava `value` no caminho (cria nós intermediários se faltarem). 'delete' remove o campo/nó do caminho. |
| `operations[].path` | texto | **sim** | Caminho no NDB com ponto ou barra (ex: 'pv', 'atributos.forca', 'inventario/moedas'). Caminho vazio ('') = raiz: 'set' exige `value` objeto e grava cada chave na raiz; 'delete' na raiz APAGA TODOS OS NÓS FILHOS. |
| `operations[].value` | qualquer | não | Valor para action='set': string, número, booleano ou objeto (vira sub-nó). Ignorado em 'delete'. |
| `is_user` | booleano | não | true = edita o NDB exclusivo do seu usuário; false = NDB compartilhado da mesa. Padrão: false. |

Chamada mínima:

```json
{"name":"edit_dock_ndb","arguments":{"room_id":239256,"name":"...","operations":[]}}
```

### manage_library_item

Altera a Biblioteca da mesa. Parâmetros necessários por ação: create_dir → name (+parent_codigo); create_char → name, data_type (+parent_codigo, avatar) — cria a ficha VAZIA (para já preencher a estrutura use create_character_sheet); update → codigo_interno + name e/ou changes; delete → codigo_interno (irreversível); move → codigo_interno + parent_codigo. Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `action` | `'create_dir'` \| `'create_char'` \| `'update'` \| `'delete'` \| `'move'` | **sim** | create_dir = criar pasta; create_char = criar personagem; update = alterar atributos do item; delete = apagar item; move = mover para outra pasta. |
| `parent_codigo` | inteiro | não | codigoInterno da pasta pai/destino (create_dir, create_char, move). Omitido em create_* = raiz. |
| `codigo_interno` | inteiro | não | codigoInterno do item alvo (update, delete, move). |
| `name` | texto | não | Nome do item (obrigatório em create_dir/create_char; em update renomeia). |
| `data_type` | texto | não | Modelo de ficha para create_char (ex: 'br.com.rrpg.DnD5_S3'). Descubra com list_data_types form_type='sheetTemplate'. |
| `avatar` | texto | não | URL do avatar para create_char. |
| `changes` | objeto (chave → valor) | não | Para update. Chaves aceitas pelo Firecast: name, visible (bool), editionBlocked (bool), ownerLogin (login do dono; '' = NPC), avatar (URL), bar0Val..bar3Val e bar0Max..bar3Max (números), edtLine0, edtLine1 (strings). Chaves omitidas não mudam. |

Chamada mínima:

```json
{"name":"manage_library_item","arguments":{"room_id":239256,"action":"create_dir"}}
```

### manage_room

Administração da mesa. action='get_details' lê { nome, sistema, isModerada, haVagas, podeTablesDock }; action='set_moderada' liga/desliga a moderação da mesa. Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `action` | `'get_details'` \| `'set_moderada'` | **sim** | 'get_details' = leitura; 'set_moderada' = altera a moderação (exige `moderada`). |
| `moderada` | booleano | não | Com action='set_moderada': true = mesa moderada, false = livre. |

Chamada mínima:

```json
{"name":"manage_room","arguments":{"room_id":239256,"action":"get_details"}}
```

### get_sheet_template

Descreve a estrutura de um modelo de ficha instalado (lido dos arquivos .rpk locais; funciona mesmo com o Firecast fechado): campos diretos, módulos/abas, recordLists (listas de itens) e `defaultData` (JSON com a estrutura padrão). Use antes de escrever numa ficha para saber os nomes exatos dos campos.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `data_type` | texto | **sim** | dataType do modelo (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.T20') ou nome do arquivo .rpk. Descubra os disponíveis com list_data_types ou pelo `dataType` de um personagem em list_library. |

Chamada mínima:

```json
{"name":"get_sheet_template","arguments":{"data_type":"..."}}
```

### create_character_sheet

Cria um personagem na Biblioteca da mesa já com a ficha preenchida. Fluxo: cria o item (como manage_library_item create_char) e então (a) importa `xml`, se informado; senão (b) com auto_structure (padrão) grava a estrutura padrão do modelo (defaultData de get_sheet_template) com `initial_data` por cima. Retorna { item{codigoInterno,...}, template, initialData }. Proteção: só executa se a mesa for a de testes 239256 ('tttttaaaaa') ou se você for mestre (+GM) da mesa; caso contrário retorna erro. Não use em mesas reais de campanha sem pedir ao usuário.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `name` | texto | **sim** | Nome do personagem na Biblioteca. |
| `data_type` | texto | **sim** | Modelo de ficha (ex: 'br.com.rrpg.DnD5_S3', 'Ambesek.T20'). Descubra com list_data_types form_type='sheetTemplate'. |
| `parent_codigo` | inteiro | não | codigoInterno da pasta de destino. Omitido = raiz da biblioteca. |
| `auto_structure` | booleano | não | true (padrão) = grava a estrutura padrão do modelo na ficha; false = ficha vazia (initial_data é ignorado). |
| `initial_data` | objeto (chave → valor) | não | Valores que sobrescrevem as chaves de PRIMEIRO nível de defaultData (um objeto aninhado substitui o objeto padrão inteiro, não é mesclado). Ex: { nome: 'Conan', nivel: 3 }. |
| `xml` | texto | não | XML completo de NDB a importar. Se informado, auto_structure e initial_data são ignorados. |

Chamada mínima:

```json
{"name":"create_character_sheet","arguments":{"room_id":239256,"name":"...","data_type":"..."}}
```

## Fichas com cache (atalhos de leitura/escrita)

### get_character_sheet

Lê os dados de uma ficha de personagem, com cache. Por padrão devolve o último snapshot salvo no SQLite (instantâneo, mas pode estar desatualizado se a ficha mudou no Firecast); se não houver snapshot, ou com fresh=true, lê ao vivo e atualiza o cache. Retorna { source, sheet{ character_name, data_type, last_updated_at, data } }. Para ler só um trecho ou obter XML use get_sheet_ndb.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |
| `fresh` | booleano | não | true = ignora o cache e lê ao vivo do Firecast. Use quando a ficha pode ter mudado (ex: após o jogador editar). Padrão: false. |

Chamada mínima:

```json
{"name":"get_character_sheet","arguments":{"room_id":239256,"codigo_interno":239256}}
```

### update_character_sheet

Forma simples de alterar valores numa ficha de personagem: um dicionário { caminho: valor }. Grava no Firecast (sincroniza para todos na mesa) e atualiza o cache. Não remove campos — para apagar use edit_sheet_ndb com action='delete'. Os nomes dos campos dependem do modelo de ficha (leia a ficha antes com get_character_sheet ou veja get_sheet_template). Só funciona se você for mestre (+GM) da mesa; caso contrário o Firecast recusa a escrita.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |
| `changes` | objeto (chave → valor) | **sim** | Mapa caminho → novo valor. Caminhos com ponto criam/navegam sub-nós. Ex: { 'pv': 45, 'atributos.forca': 18, 'inventario.moedas': 100 }. Valores null são ignorados. |

Chamada mínima:

```json
{"name":"update_character_sheet","arguments":{"room_id":239256,"codigo_interno":239256,"changes":{}}}
```

### list_synced_sheets

Lista as fichas conhecidas. Padrão: fichas com snapshot no cache SQLite (lidas antes por get_character_sheet/sync_character_sheet), com os dados. fresh=true: fichas rastreadas pelo plugin nesta sessão do Firecast, com isTabOpen (aberta numa aba do cliente), sem os dados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | não | Filtra por mesa (campo `id` de list_rooms). Omitido = todas. |
| `fresh` | booleano | não | true = pergunta ao plugin quais fichas ele está rastreando agora. Padrão: false. |

Chamada mínima:

```json
{"name":"list_synced_sheets","arguments":{}}
```

### sync_character_sheet

Marca a ficha como rastreada pelo plugin e grava um snapshot completo e atualizado no cache SQLite. Equivale a get_character_sheet com fresh=true, mais o registro de rastreamento (visível em list_synced_sheets fresh=true). Observação: a sincronização contínua em tempo real está desativada no plugin; o cache só muda quando você lê ou escreve pelas tools.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |
| `source` | texto | não | Rótulo livre de origem gravado no rastreamento ('manual', 'tab', 'player', 'mcp'). Padrão: 'manual'. |

Chamada mínima:

```json
{"name":"sync_character_sheet","arguments":{"room_id":239256,"codigo_interno":239256}}
```

### open_character_sheet

Abre a ficha do personagem numa nova aba da interface do Firecast (na tela do usuário que roda o MCP) e a marca como rastreada. Não retorna os dados da ficha — use get_character_sheet para isso.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `codigo_interno` | inteiro | **sim** | codigoInterno do personagem/ficha na Biblioteca da mesa. Obtenha em list_library (campo `codigoInterno` dos itens com tipo='personagem'). |

Chamada mínima:

```json
{"name":"open_character_sheet","arguments":{"room_id":239256,"codigo_interno":239256}}
```

## Plugins e modelos de ficha

### list_data_types

Lista os modelos de ficha e janelas acopláveis instalados no Firecast (dataTypes). Use o `dataType` retornado em create_character_sheet, manage_library_item (create_char), get_sheet_template e open_dock_ndb. Retorna { total, data_types[{ dataType, formType, title, moduleId }] }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `form_type` | texto | não | Filtra pelo tipo exato (sem diferenciar maiúsculas): 'sheetTemplate' = fichas de personagem, 'tablesDock' = janelas acopláveis da mesa. Omitido = todos. |
| `query` | texto | não | Busca parcial (sem diferenciar maiúsculas) em dataType, título e moduleId (ex: 'dnd', 't20'). |

Chamada mínima:

```json
{"name":"list_data_types","arguments":{}}
```

### list_installed_plugins

Lista os plugins SDK3 instalados no cliente Firecast (nome, versão, autor, moduleId, arquivo .rpk). Útil para saber quais sistemas de ficha e ferramentas estão disponíveis.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `query` | texto | não | Busca parcial em nome, autor, descrição ou moduleId. |

Chamada mínima:

```json
{"name":"list_installed_plugins","arguments":{}}
```

## Character Manager (NPCs locais do MCP)

### create_character

Cadastra (ou sobrescreve) um personagem/NPC no Character Manager com identidade visual (avatar, galeria, cor e estilo do texto) e notas de interpretação, para depois falar/rolar como ele com impersonate_character e character_roll. O Character Manager é um banco local do MCP (SQLite) para NPCs/personagens com identidade visual e notas de interpretação; NÃO é a Biblioteca do Firecast e não aparece para os jogadores. O `id` é gerado a partir de name/code; criar de novo com o mesmo name/code SUBSTITUI o registro. Retorna { character }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `name` | texto | **sim** | Nome exibido no chat. |
| `room_id` | inteiro | não | Mesa à qual o personagem pertence (campo `id` de list_rooms). Omitido = personagem global, usável em qualquer mesa. |
| `code` | texto | não | Código curto único usado como atalho para referenciar o personagem nas outras tools (ex: 'akn', 'taverneiro'). |
| `title` | texto | não | Título/epíteto (ex: 'Guardiã do Abismo'). Informativo. |
| `avatar_url` | texto | não | URL http(s) do avatar padrão exibido no chat. |
| `images` | texto ou objeto[] | não | Galeria de avatares alternativos: URLs simples ou { url, label, tag }. Escolha uma no envio com image_label/image_tag. |
| `gender` | `'masculine'` \| `'feminine'` \| `'neuter'` \| `'undefined'` | não | Gênero gramatical do personagem. |
| `color` | texto | não | Cor do nome e do texto no chat: '#RRGGBB' ou índice de cor do Firecast '0'–'15' (ex: '4' = vermelho). |
| `bkg_color` | texto | não | Cor de fundo do texto ('#RRGGBB'). |
| `bold` | booleano | não | Texto das falas em negrito. |
| `italic` | booleano | não | Texto das falas em itálico. |
| `underline` | booleano | não | Texto das falas sublinhado. |
| `strikeout` | booleano | não | Texto das falas tachado. |
| `talemark_options` | objeto (chave → valor) | não | Avançado: sobrescreve as talemarkOptions geradas (ex: { parseSmileys: false, defaultTextStyle: {...} }). |
| `voice` | texto | não | Voz de TTS associada (informativo). |
| `personality` | texto | não | Personalidade/diretrizes de interpretação, para o modelo consultar antes de falar como o personagem. |
| `speech_style` | texto | não | Jeito de falar, bordões, sotaque. |
| `appearance` | texto | não | Descrição física. |
| `background` | texto | não | História/origem. |
| `notes` | texto | não | Notas e segredos do mestre. |
| `tags` | texto[] | não | Tags para filtrar em list_characters (ex: ['npc', 'boss', 'mercador']). |
| `sheet_codigo` | inteiro | não | codigoInterno da ficha vinculada na Biblioteca do Firecast (ou use link_character_sheet). |
| `sheet_data_type` | texto | não | dataType do modelo da ficha vinculada (ex: 'br.com.rrpg.DnD5_S3'). |
| `bars` | objeto (chave → valor) | não | Barras resumidas, informativo (ex: { bar0: { val: 20, max: 20, label: 'PV' } }). |
| `stats` | objeto (chave → valor) | não | Atributos resumidos, informativo (ex: { forca: 18, ca: 16 }). |

Chamada mínima:

```json
{"name":"create_character","arguments":{"name":"..."}}
```

### update_character

Atualiza um personagem do Character Manager. Só os campos enviados mudam; campos de lista/objeto (images, tags, bars, stats, talemark_options) são SUBSTITUÍDOS por inteiro, não mesclados — leia com get_character antes se quiser acrescentar.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial. |
| `name` | texto | não | Novo nome. |
| `room_id` | inteiro | não | Mesa para desambiguar a busca do personagem (não move o personagem de mesa). |
| `code` | texto | não | Código curto único usado como atalho para referenciar o personagem nas outras tools (ex: 'akn', 'taverneiro'). |
| `title` | texto | não | Título/epíteto (ex: 'Guardiã do Abismo'). Informativo. |
| `avatar_url` | texto | não | URL http(s) do avatar padrão exibido no chat. |
| `images` | texto ou objeto[] | não | Galeria de avatares alternativos: URLs simples ou { url, label, tag }. Escolha uma no envio com image_label/image_tag. |
| `gender` | `'masculine'` \| `'feminine'` \| `'neuter'` \| `'undefined'` | não | Gênero gramatical do personagem. |
| `color` | texto | não | Cor do nome e do texto no chat: '#RRGGBB' ou índice de cor do Firecast '0'–'15' (ex: '4' = vermelho). |
| `bkg_color` | texto | não | Cor de fundo do texto ('#RRGGBB'). |
| `bold` | booleano | não | Texto das falas em negrito. |
| `italic` | booleano | não | Texto das falas em itálico. |
| `underline` | booleano | não | Texto das falas sublinhado. |
| `strikeout` | booleano | não | Texto das falas tachado. |
| `talemark_options` | objeto (chave → valor) | não | Avançado: sobrescreve as talemarkOptions geradas (ex: { parseSmileys: false, defaultTextStyle: {...} }). |
| `voice` | texto | não | Voz de TTS associada (informativo). |
| `personality` | texto | não | Personalidade/diretrizes de interpretação, para o modelo consultar antes de falar como o personagem. |
| `speech_style` | texto | não | Jeito de falar, bordões, sotaque. |
| `appearance` | texto | não | Descrição física. |
| `background` | texto | não | História/origem. |
| `notes` | texto | não | Notas e segredos do mestre. |
| `tags` | texto[] | não | Tags para filtrar em list_characters (ex: ['npc', 'boss', 'mercador']). |
| `sheet_codigo` | inteiro | não | codigoInterno da ficha vinculada na Biblioteca do Firecast (ou use link_character_sheet). |
| `sheet_data_type` | texto | não | dataType do modelo da ficha vinculada (ex: 'br.com.rrpg.DnD5_S3'). |
| `bars` | objeto (chave → valor) | não | Barras resumidas, informativo (ex: { bar0: { val: 20, max: 20, label: 'PV' } }). |
| `stats` | objeto (chave → valor) | não | Atributos resumidos, informativo (ex: { forca: 18, ca: 16 }). |

Chamada mínima:

```json
{"name":"update_character","arguments":{"character":"..."}}
```

### get_character

Retorna todos os campos de um personagem do Character Manager (identidade, galeria, personalidade, notas, ficha vinculada). Leia antes de interpretar o personagem. Retorna { found, character }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial. |
| `room_id` | inteiro | não | Mesa para priorizar na busca quando há nomes/códigos repetidos. |

Chamada mínima:

```json
{"name":"get_character","arguments":{"character":"..."}}
```

### list_characters

Lista personagens do Character Manager, com filtros. Retorna { characters[], total }. O Character Manager é um banco local do MCP (SQLite) para NPCs/personagens com identidade visual e notas de interpretação; NÃO é a Biblioteca do Firecast e não aparece para os jogadores.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | não | Só personagens desta mesa (+ globais, ver include_global). Omitido = todos. |
| `include_global` | booleano | não | Com room_id: true (padrão) inclui também os personagens globais (sem mesa). |
| `tag` | texto | não | Só personagens com esta tag (ex: 'npc'). |
| `search` | texto | não | Busca parcial em nome, código, título e tags. |
| `limit` | inteiro | não | Máximo de resultados. Padrão: 50. |
| `offset` | inteiro | não | Pula N resultados (paginação). Padrão: 0. |

Chamada mínima:

```json
{"name":"list_characters","arguments":{}}
```

### delete_character

Remove um personagem do Character Manager (irreversível). Não apaga a ficha vinculada na Biblioteca do Firecast.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | `id` ou `code` do personagem (nome não é aceito aqui, para evitar apagar o errado). |
| `room_id` | inteiro | não | Mesa para desambiguar códigos repetidos. |

Chamada mínima:

```json
{"name":"delete_character","arguments":{"character":"..."}}
```

### impersonate_character

Publica uma fala/ação no chat da mesa COMO um personagem do Character Manager, aplicando automaticamente nome colorido, avatar e estilo de texto dele. Prefira esta tool a send_chat_message para personagens cadastrados.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial. |
| `message` | texto | **sim** | Fala ou ação. Texto entre *asteriscos* sai como ação; aceita marcação Talemark. |
| `room_id` | inteiro | não | Mesa de destino. Obrigatório se o personagem for global (sem room_id próprio); senão usa a mesa do personagem. |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `type` | `'standard'` \| `'narrator'` \| `'npc'` \| `'action'` \| `'laugh'` | não | Tipo de mensagem. Padrão: 'npc' (fala do personagem). 'action' = ação em terceira pessoa. |
| `image_label` | texto | não | Usa como avatar a imagem da galeria com este `label` (sem diferenciar maiúsculas). |
| `image_tag` | texto | não | Usa como avatar a imagem da galeria com esta `tag`. Ignorado se image_label for informado. |
| `avatar_override` | texto | não | URL de avatar só para este envio; tem prioridade sobre image_label/image_tag. |
| `raw_name` | booleano | não | true = envia o nome sem o prefixo de cor '[§K...]'. Padrão: false. |
| `as_whisper_to` | texto | não | Sussurro. Número (campo `id` de list_players) = mensagem visível só para esse jogador (seguro). Texto (login) = envia no chat 'pvt:<login>', que precisa já estar aberto; se não estiver, a mensagem cai no chat PÚBLICO. Prefira o id numérico. |

Chamada mínima:

```json
{"name":"impersonate_character","arguments":{"character":"...","message":"..."}}
```

### character_roll

Faz uma rolagem oficial de dados no chat em nome de um personagem do Character Manager (com nome e avatar dele). Retorna { total, asString, roll }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial. |
| `expression` | texto | **sim** | Fórmula no formato do Firecast: '1d20+5', '3d6+2', '4dF'. |
| `room_id` | inteiro | não | Mesa de destino. Obrigatório se o personagem for global. |
| `message` | texto | não | Motivo exibido junto à rolagem (ex: 'Ataque com Espada Vorpal'). |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `image_label` | texto | não | Usa como avatar a imagem da galeria com este `label` (sem diferenciar maiúsculas). |
| `image_tag` | texto | não | Usa como avatar a imagem da galeria com esta `tag`. Ignorado se image_label for informado. |
| `avatar_override` | texto | não | URL de avatar só para este envio; tem prioridade sobre image_label/image_tag. |
| `raw_name` | booleano | não | true = envia o nome sem o prefixo de cor '[§K...]'. Padrão: false. |

Chamada mínima:

```json
{"name":"character_roll","arguments":{"character":"...","expression":"..."}}
```

### link_character_sheet

Vincula um personagem do Character Manager a uma ficha da Biblioteca do Firecast (grava sheet_codigo no personagem). Informe sheet_codigo de uma ficha existente, ou auto_create=true para criar uma nova ficha com o nome do personagem (usa create_character_sheet; sujeito à proteção de mesa de teste/mestre).

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `character` | texto | **sim** | Personagem do Character Manager (banco local do MCP, não a Biblioteca do Firecast). Aceita `id`, `code` ou nome; a busca tenta nessa ordem: id exato → code exato → nome exato (sem diferenciar maiúsculas) → nome parcial. |
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `sheet_codigo` | inteiro | não | codigoInterno de uma ficha existente (list_library). Se omitido, usa o já vinculado ou cria (auto_create). |
| `sheet_data_type` | texto | não | Modelo da ficha a criar com auto_create. Padrão: 'br.com.rrpg.FICHA_BASICA_V3'. |
| `auto_create` | booleano | não | true = cria uma ficha nova se não houver sheet_codigo. Padrão: false. |
| `parent_folder_codigo` | inteiro | não | codigoInterno da pasta onde criar a ficha. Omitido = raiz. |

Chamada mínima:

```json
{"name":"link_character_sheet","arguments":{"character":"...","room_id":239256}}
```

### import_external_npcs

Importa para o Character Manager os NPCs salvos pelos plugins NPC Saver (npcs.txt) e NPC Interpreter (pasta rooms/<mesa>/npcs) instalados neste computador. Lê arquivos locais; não precisa do Firecast aberto. Retorna { imported, skipped, details[] }.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `source` | `'all'` \| `'npcsaver'` \| `'npc_interpreter'` | não | Qual plugin importar. Padrão: 'all'. |
| `room_id` | inteiro | não | Só importa NPCs desta mesa. Omitido = todas. |
| `overwrite` | booleano | não | true = sobrescreve NPCs já importados; false (padrão) = pula os existentes. |

Chamada mínima:

```json
{"name":"import_external_npcs","arguments":{}}
```

## Mídia (upload e envio de imagens)

### upload_media

Hospeda um arquivo local (imagem, mapa, áudio, PDF) e devolve URLs públicas para usar no chat ou como avatar. Informe file_path OU content_base64. Retorna { provider, url, talemark_image ('[§I url]', para colar numa mensagem e exibir a imagem), talemark_link, ... }. Não envia nada ao chat — para isso use send_media_to_chat.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `file_path` | texto | não | Caminho absoluto do arquivo neste computador (ex: 'C:/Imagens/token.png'). Use este OU content_base64. |
| `content_base64` | texto | não | Conteúdo do arquivo em Base64 (sem prefixo 'data:'). Exige `filename` para definir o tipo. |
| `filename` | texto | não | Nome do arquivo de destino com extensão (ex: 'caverna_mapa.png'). Padrão: nome de file_path. |
| `provider` | `'auto'` \| `'gdrive'` \| `'firedrive'` | não | Onde hospedar: 'auto' (padrão; usa o Google Drive para Desktop se estiver montado, senão FireDrive), 'gdrive' (erro se o Drive não estiver montado) ou 'firedrive' (armazenamento do Firecast; exige o Firecast aberto). |
| `subfolder` | texto | não | Subpasta de destino dentro da pasta de assets do Drive (ex: 'campanha1/tokens'). Só para gdrive. |
| `timeout_seconds` | número | não | Quanto esperar o Google Drive sincronizar e gerar o link. Padrão: 25. |

Chamada mínima:

```json
{"name":"upload_media","arguments":{}}
```

### get_media_url

Obtém as URLs (e o snippet Talemark) de um arquivo que JÁ está na pasta do Google Drive para Desktop, sem novo upload. Só funciona com Google Drive.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `path_or_filename` | texto | **sim** | Caminho completo no Drive (ex: 'G:/Meu Drive/Firecast Assets/token.png') ou só o nome do arquivo dentro da pasta de assets (ex: 'token.png'). |

Chamada mínima:

```json
{"name":"get_media_url","arguments":{"path_or_filename":"..."}}
```

### list_media_files

Lista os arquivos da pasta de assets no Google Drive (configurável em configure_storage) com suas URLs prontas. Só Google Drive.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `subfolder` | texto | não | Lista só esta subpasta da pasta de assets. |
| `limit` | inteiro | não | Máximo de arquivos. Padrão: 50. |

Chamada mínima:

```json
{"name":"list_media_files","arguments":{}}
```

### send_media_to_chat

Mostra uma imagem (ou link de arquivo) no chat da mesa, com legenda opcional. Fonte da mídia, em ordem de prioridade: media_url (já hospedada) → file_path/filename de um arquivo que já está no Drive (reaproveita o link) → upload de file_path/content_base64. Identidade: as_character_id (personagem do Character Manager) ou npc_name; sem nenhum, envia como você.

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `room_id` | inteiro | **sim** | ID numérico da mesa (codigoInterno). Obtenha no campo `id` de list_rooms. Ex: 239256. |
| `chat_id` | texto | não | Chat de destino/origem. Valores: 'main' (chat principal da mesa, padrão), 'active' (aba de chat em foco no cliente), 'pvt:<login>' (PVT já aberto com o jogador), 'group:<id>' (PVT em grupo) ou o `id` retornado por list_chats. ATENÇÃO: se o chat não for encontrado, o plugin usa o chat principal (público) sem avisar. |
| `media_url` | texto | não | URL de mídia já hospedada. Se informada, nada é enviado para upload. |
| `file_path` | texto | não | Caminho absoluto do arquivo local a enviar (ou de um arquivo já dentro do Drive). |
| `content_base64` | texto | não | Conteúdo em Base64 (exige filename). |
| `filename` | texto | não | Nome do arquivo (com extensão). Sozinho, procura um arquivo com esse nome na pasta de assets do Drive. |
| `caption` | texto | não | Texto exibido na linha acima da imagem. |
| `as_character_id` | texto | não | Envia como este personagem do Character Manager (id, code ou nome), com avatar e cor dele. |
| `npc_name` | texto | não | Envia como um NPC avulso com este nome. Ignorado se as_character_id for informado. |
| `provider` | `'auto'` \| `'gdrive'` \| `'firedrive'` | não | Onde hospedar: 'auto' (padrão; usa o Google Drive para Desktop se estiver montado, senão FireDrive), 'gdrive' (erro se o Drive não estiver montado) ou 'firedrive' (armazenamento do Firecast; exige o Firecast aberto). |
| `subfolder` | texto | não | Subpasta de destino no Drive, caso haja upload. |

Chamada mínima:

```json
{"name":"send_media_to_chat","arguments":{"room_id":239256}}
```

### configure_storage

Sem parâmetros: mostra a configuração de armazenamento atual e se o Google Drive para Desktop foi detectado. Com parâmetros: altera o padrão (gravado em config.json).

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `provider` | `'auto'` \| `'gdrive'` \| `'firedrive'` | não | Novo provedor padrão para uploads. |
| `gdrive_assets_path` | texto | não | Nova pasta base de assets no Drive (ex: 'G:/Meu Drive/Firecast Assets'). |

Chamada mínima:

```json
{"name":"configure_storage","arguments":{}}
```
