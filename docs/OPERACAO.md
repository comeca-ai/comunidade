# Operação

O dia a dia depois que está no ar.

> **Linha de comando e banco.** Todo `wrangler d1 execute` abaixo precisa saber
> qual é o banco: rode da raiz do repo, onde está o `wrangler.jsonc`. Sem isso
> o wrangler responde `Authentication error [code: 10000]`, que não é problema
> de token.

## Liberar um aluno

A escola dos alunos é a **comunidade** (`comunidade.comeca.ai`, app
`classica`). Pelo painel: `comunidade.comeca.ai/admin` → aba *Convidar* → *Cadastrar alunos*.
Aceita vários e-mails de uma vez, separados por vírgula ou quebra de linha, e
por padrão **envia o convite na hora** — um link de entrada válido por 48 horas,
de uso único. Desmarque a caixa para só cadastrar.

O painel também mostra, por aluno, último acesso, aulas concluídas, leituras e
o estado do convite, com dois botões: *Reenviar convite* (para quem nunca
entrou) ou *Link de acesso* (para quem já entrou), e *Ver*, que abre a ficha —
progresso por módulo e aula com data, leituras, últimos links gerados, nome
editável, remover da comunidade e excluir. Convite que o provedor rejeita não
deixa link no banco.

O estado do convite é só o que o banco sabe: *nenhum link enviado* (nenhuma
linha em `links_magicos` — convite mandado à mão pelo WhatsApp não conta),
*link enviado · não abriu* (link válido, `usado_em` vazio) e *link expirou ·
não abriu*. Quem entra ganha `usado_em` no link e `ultimo_acesso` no cadastro.

Três visões dos alunos: **Cartões**, **Lista** e **Kanban**. O kanban é uma
coluna por etapa — cadastrado → convidado → entrou → assistindo → concluiu —
em que cada aluno está numa coluna só; a barra do topo diz quantos chegaram
até ali. As duas primeiras colunas têm a ação em massa correspondente:
*Enviar link* para quem nunca recebeu e *Reenviar* para quem está com o link
vencido (rota `POST /admin/convidar-pendentes`, campo `grupo` = `sem-link` |
`expirados`; sem o campo, manda para todo mundo que nunca entrou — é o botão
do bloco "Nunca entraram" das outras visões). Em qualquer caso só vai para
quem tem **de acordo** registrado (abaixo).

## Funil de entrada

A aba **Funil** conta a história de uma turma, do curso ao engajamento, em
sete etapas — cada aluno fica na mais avançada que alcançou:

| # | etapa | o que o banco sabe |
|---|-------|--------------------|
| 1 | Fez o curso | está na base (`matriculas`), com ou sem `turma` |
| 2 | Deu o de acordo | `matriculas.consentiu_em` (fonte em `consentimento`: `quero`, `painel`, `importacao`, `legado`) |
| 3 | Recebeu o convite | link `tipo = 'convite'` aceito pelo provedor (rejeição na hora apaga o link) |
| 4 | Abriu o e-mail | `links_magicos.aberto_em`, pelo pixel 1×1 do e-mail — **sinal, não certeza**: Apple Mail marca sem ninguém abrir, clientes corporativos bloqueiam a imagem |
| 5 | Entrou | clicou no link (`usado_em`, `ultimo_acesso`) |
| 6 | Engajou | ≥ 1 aula concluída, leitura lida, ou voltou em outro dia (`acessos`, um registro por aluno e dia) |
| 7 | Concluiu | todas as aulas publicadas |

A barra é acumulada (quem passou pela etapa); a linha de queda diz a
conversão para a próxima etapa e quantos pararam ali; clicar na etapa abre a
lista de quem está parado, com a ação individual (*Marcar de acordo e
convidar*, *Enviar convite*, *Reenviar link*, *Lembrete da 1ª aula*) e, quando
faz sentido, a ação em massa. Filtros: **turma** e **tempo na base** (30/90
dias/tudo). O funil só faz sentido por turma — comparar Imersão com Sebrae é o
uso principal.

Regras que evitam spam e cobrem a LGPD:

- **Convite em massa só para quem tem de acordo.** O de acordo entra pela
  página pública `/quero`, pela caixa "já deram o de acordo" no cadastro
  (fonte `importacao`) ou pelo clique individual do admin em *Enviar/Reenviar*
  (fonte `painel` — é o admin afirmando que tem). Quem já estava na base antes
  do funil ficou como `legado`, na data da matrícula.
- **Reenvio em massa só para quem está parado há 3 dias ou mais.** O reenvio
  individual não tem essa trava.
- **`/quero` manda no máximo um convite por hora por e-mail**, tem isca para
  robô, e e-mail que não está na base vira **pedido** (aba Convidar → "Pedidos
  pelo site"), não cadastro — o admin aprova (cadastra com de acordo `quero` e
  convida) ou descarta. Divulgue `comunidade.comeca.ai/quero?turma=Nome` no
  curso (QR code) para já classificar a turma.

Cadastro de turma: cola a lista (um e-mail por linha, `Nome <e-mail>`, ou as
duas colunas copiadas da planilha — cabeçalho e telefone são ignorados) ou
envia o CSV, informa a turma, marca ou não o de acordo. Nome existente nunca
é sobrescrito; turma só entra onde não havia. XLSX direto não é aceito —
"salvar como CSV" resolve.

Esquema: as colunas e tabelas do funil entram sozinhas no primeiro pedido
depois do deploy (`garantirEsquemaFunil`, `PRAGMA table_info` + `ALTER TABLE`),
também no cron. Nada a rodar à mão.

Fluxo sugerido para uma turma nova: cadastrar todo mundo de uma vez em
*Cadastrar alunos* com a turma e o de acordo que se tem, divulgar o `/quero`
para quem ainda não deu, e acompanhar no funil quem parou onde — reenviando
para os parados há 3+ dias e mandando o lembrete da primeira aula para quem
entrou e não começou.

As outras escolas têm um painel mais simples e são bancada de teste.

Pela linha de comando:

```bash
npx wrangler d1 execute escola --remote --command \
  "INSERT OR IGNORE INTO alunos (email,nome,criado_em) VALUES ('aluno@email.com','Nome',unixepoch())"
```

O painel matricula o aluno **na escola em que você está**. Pela linha de comando,
o cadastro em `alunos` não basta — é a matrícula que libera:

```bash
npx wrangler d1 execute escola --remote --command \
  "INSERT OR IGNORE INTO matriculas (aluno_id,escola,criada_em)
   SELECT id,'classica',unixepoch() FROM alunos WHERE email='aluno@email.com'"
```

O slug desta escola é `classica` (comunidade). Os demais — `modulos`, `futuro`
e `sensacionalista` — são as escolas experimentais do monorepo
[`escoladofuturo`](https://github.com/comeca-ai/escoladofuturo), que dividem o
mesmo banco.
Para colocar **todo mundo** na comunidade de uma vez, sem mexer no que já existe:

```bash
npx wrangler d1 execute escola --remote --command \
  "INSERT OR IGNORE INTO matriculas (aluno_id,escola,criada_em)
   SELECT id,'classica',unixepoch() FROM alunos"
```

## Desempenho das aulas

A aba **Desempenho** responde "esta turma travou onde?". Os números vêm do
próprio player: o SDK do Stream avisa a página enquanto o vídeo roda, a
página junta a reprodução em trechos de 10 s e manda um pulso para
`POST /app/aula/:uid/pulso` a cada 20 s, ao pausar, ao terminar e ao sair
(`sendBeacon`). Tabelas, criadas sozinhas: `aberturas` (abriu a página,
plays, pulos, onde parou), `assistencia` (trechos vistos por aluno e aula —
conjunto, não soma: rever não infla), `pulos` (saltos para frente de mais de
15 s) e `avaliacoes` ("essa aula foi útil?", 👍 😐 👎 + comentário).

O que a aba mostra, com os mesmos filtros do funil (turma e período):

- quatro números: **retenção média** (quanto do vídeo quem dá play vê),
  **terminam a aula** (chegaram a 90% — não "marcou concluída"), **aulas com
  alerta** e **foi útil?**;
- **Onde melhorar**: diagnóstico automático das piores aulas — *queda* (30
  pontos ou mais de quem estava assistindo somem num trecho de até 3 min),
  *concluem sem ver* (marcaram concluída com menos de 30% visto), *abrem,
  não dão play* (5+ abriram e menos de 40% deu play) e *muito pulo* (1,5
  pulos por aluno, com o salto mais comum);
- a tabela por aula, das piores para as melhores, com a curva de retenção
  em miniatura; clicar abre a curva grande, os pulos mais comuns e os
  comentários;
- **a trilha**: quantos terminaram cada aula na ordem oficial — barra
  laranja onde caiu mais de 40% em relação à anterior.

Para o aluno, de brinde: a aula **volta de onde parou** (`?startTime` com a
posição salva; `?t=` de um link de busca manda mais), **marca concluída
sozinha** ao chegar a 90% do vídeo (o botão continua existindo) e, ao
terminar, aparece uma vez a pergunta *Essa aula foi útil?* — nunca bloqueia
nada. Só conta daqui para frente: aula assistida antes desta versão não tem
curva, e o número de "abriram" começa em zero.

## Equipe do painel

Quem administra vem de dois lugares somados: a var `ADMINS` do
`wrangler.jsonc` (fixos, só mudam com deploy) e a aba **Equipe** do painel.
Para adicionar alguém: e-mail, nome opcional e "Enviar link de acesso agora"
— a pessoa ganha cadastro e matrícula na hora (de acordo "painel") e entra
pelo mesmo link mágico do aluno. Remover tira só o painel; o acesso de aluno
continua. Ninguém remove a si mesmo, e os fixos saem só pelo `wrangler.jsonc`.
Tabela `administradores` (escola, e-mail, quem adicionou, quando).

## Notícias — "No radar"

O bloco no fim da jornada do aluno com notícias de IA, empreendedorismo e
estratégia. O cron coleta os feeds RSS das fontes (~1x/h; a lista de fontes é
código, em `src/noticias.ts`), a IA tria e resume cada item (Model Studio com
`MODELOS_API_KEY`, senão Workers AI), e a aba **Notícias** do painel decide o
que vai ao ar — nada aparece ao aluno sem aprovação. Cada item é título,
resumo de uma frase e link com crédito; o texto integral fica na fonte.
*Buscar e triar agora* força uma passada sem esperar o cron. Aprovada, a
notícia entra na hora; *Tirar do ar* remove na hora. Itens com mais de 21
dias não são coletados, e o que a IA marca como fora de tema morre sem
passar pelo painel.

## Provas de módulo

Ao terminar as aulas de um módulo, o aluno vê na trilha a linha **Prova do
módulo**: 5 questões (4 de múltipla escolha e 1 aberta), aprova com 70%,
pode refazer quantas vezes quiser (a ordem embaralha) e cada erro aponta o
minuto da aula onde o assunto foi tratado. A questão aberta é lida pelo
modelo com o gabarito do professor e volta com um comentário; sem modelo
configurado, ela fica registrada na ficha do aluno e não entra na nota.

Como montar, na aba **Provas** do painel:

1. **Gerar com IA** no módulo — lê as transcrições das aulas (precisa de ao
   menos uma aula transcrita) e escreve as questões como rascunho. Demora
   uns 20–40 s. "Gerar de novo" substitui as questões do módulo.
2. **Revisar** — enunciado, alternativas (marque a correta), explicação,
   aula e segundo de referência; dá para desativar, excluir ou acrescentar
   uma questão à mão. Sem transcrição, "Escrever à mão" abre a mesma tela
   vazia.
3. **Publicar** — só então o aluno vê. Mudanças depois de publicar valem na
   hora; "Despublicar" esconde sem apagar nada.

Dois controles decidem o peso da prova:

- **exige para avançar** (por módulo): as aulas dos módulos seguintes ficam
  trancadas até a aprovação; abrir uma aula trancada leva à prova. Desligado
  (padrão), a prova é opcional para seguir.
- **Certificado exige aprovação nas provas publicadas** (global, ligado por
  padrão): quem concluiu todas as aulas mas não aprovou em alguma prova
  publicada não recebe o certificado — a trilha, a página do certificado e a
  validação pública dizem qual prova falta, e a ficha do aluno também.
  Desligado, o certificado sai só pelas aulas, como antes. Com provas, o
  certificado imprime o **aproveitamento** (média das melhores notas).

Na aba, cada módulo mostra tentativas, alunos, aprovados e média; na tela de
revisão, a taxa de erro de cada questão (uma questão que todos erram costuma
ser questão ruim, não turma ruim). Tabelas, criadas sozinhas: `provas`,
`questoes`, `tentativas` (respostas em JSON) e `ajustes`.

## Transcrições e a aba Inteligência

Toda aula tem (ou terá) transcrição com tempo por frase e por palavra e
identificação de quem fala, feita pelo **Deepgram** (nova-3, pt-BR). Serve
para a busca na fala (aba **Inteligência** do painel: cada resultado abre a
aula no minuto certo), para a transcrição que o aluno vê embaixo do vídeo,
para a legenda no player (subida no Stream como VTT) e para os cortes.

Dois caminhos, mesmo resultado:

- **Script local** (`tools/transcrever.mjs`, precisa de `ffmpeg` e da chave
  em `DEEPGRAM_API_KEY` ou `~/.deepgram_key`): baixa só o áudio do HLS,
  transcreve e grava `transcricoes/<uid>.json` + `index.ts`.
  Commit + deploy: o painel e o cron semeiam no banco/R2 na primeira
  passada. Para transcrever tudo de uma vez: exporte a lista com
  `wrangler d1 execute … "SELECT uid, titulo, duracao_seg FROM aulas WHERE publicada=1" --json > aulas.json`
  e rode `node tools/transcrever.mjs --lista aulas.json`.
- **Worker sozinho**, para vídeo novo, quando existe o segredo
  `DEEPGRAM_API_KEY` (`npx wrangler secret put DEEPGRAM_API_KEY`): a cada
  cron ele pede o MP4 ao Stream, manda a URL ao
  Deepgram com callback em `POST /deepgram/retorno` (chave aleatória por
  pedido) e guarda o resultado. Estado por aula em `transcricoes`
  (`download` → `enviado` → `pronto` | `erro`), trechos em `trechos`,
  JSON compacto em `transcricoes/<uid>.json` no R2. O botão *Transcrever
  pendentes* na aba Inteligência força uma passada.

Sem `smart_format` de propósito: em português ele troca o artigo "um" por
"1". Os `keyterm` (nomes e marcas em `packages/conteudo/transcricao.ts`)
corrigem grafias — "Jonathan" virava "Jhonata" no teste.

### Cortes para redes

Na mesma aba, **Pedir um corte**: a equipe descreve o tema; o sistema acha
nas transcrições os parágrafos mais próximos do pedido, expande cada um numa
janela de até 90 s, e a IA escolhe até 3 cortes de 30 a 90 s com início e
fim em frase inteira, título, gancho, por que funciona e o texto do post.

Com o segredo `MODELOS_API_KEY` (API compatível com OpenAI — hoje o Model
Studio da Alibaba, `MODELOS_BASE` no wrangler), a busca é **por
significado**: cada parágrafo vira um vetor (`MODELO_EMBED`,
text-embedding-v4), guardado no R2 em `vetores/<uid>.bin` com controle na
tabela `vetores`; o índice completa em poucas passadas (cron, primeira busca
e *Transcrever pendentes*, ~300 parágrafos por passada) e "já deu de hype"
acha "modinha", "promessa", "entrega". Quem escolhe os cortes é uma opção
no formulário: **Rápido** (`MODELO_CORTES`, qwen3.8-max, ~15 s) ou
**Editor-chefe** (`MODELO_CORTES_EDITOR`, Kimi K3, que pensa à vontade e
escolhe melhor — 3 a 5 min). No modo editor-chefe a resposta vira uma página
de espera que fica aberta enquanto o modelo escreve (o Worker não tem
limite de duração enquanto o navegador está conectado; o cron e o
`waitUntil` têm, por isso não servem) e volta ao painel sozinha; fechar a
aba cancela. Cada lote registra o modelo que escolheu (`cortes.modelo`).
Sem a chave, fica a busca por palavra + Workers AI (`AI`). Cada sugestão fica em `cortes` (estado `sugerido`) — é o
histórico de pedidos — com *Ver no player* (abre no segundo certo), *Legenda
SRT* (relativa ao início do corte) e *Aprovar*.

Quem transforma o corte aprovado em vídeo é o **cortador**
(`tools/cortar.mjs`, ffmpeg), rodando no GitHub Actions
(`.github/workflows/cortes.yml`):

1. *Aprovar* marca `aprovado`. Se o Worker tem `GH_TOKEN_CORTES`, ele
   aciona o workflow na hora; sem isso, o workflow roda de hora em hora (há
   um link *acionar agora no GitHub ↗* na aba para não esperar).
2. O workflow pede `POST /cortes/fila` (autenticado pelo segredo
   `CORTES_CHAVE`), recebe até 3 cortes com início/fim, título, texto do post
   e as palavras com tempo, e marca cada um como `gerando`.
3. Baixa só os segmentos HLS **públicos** do intervalo (não precisa de token
   do Stream), corta e devolve em `POST /cortes/retorno`:
   **vertical 1080×1920** (o vídeo sobre ele mesmo desfocado e escurecido,
   título em cima, legenda palavra a palavra com a palavra falada em
   verde-lima; entrevista/talk/podcast sai com as laterais cortadas — pessoa
   maior — e aula com slide sai com o quadro inteiro; voz com grave de
   ambiente e ruído de sala reduzidos e nivelada a −16 LUFS em duas
   passagens; 0,2 s de respiro antes da primeira palavra) para
   Reels/TikTok/Shorts; **LinkedIn 1080×1350 (4:5)**, mesma composição sem
   barra de título (o texto do post faz esse papel); **horizontal 1280×720**
   limpo para YouTube/site; e o **SRT**. Tudo vai para o R2 em
   `cortes/<id>/…`, o corte fica `pronto` e a aba mostra *Baixar vertical
   (Reels)*, *Baixar LinkedIn (4:5)*, *Baixar horizontal* e *Gerar de novo*
   (refaz com o cortador atual; só admin; `/admin/cortes/:id/video.mp4`).
4. Deu erro (ffmpeg, rede), o corte fica `erro` com a mensagem e um *Tentar
   de novo*. Um `gerando` sem retorno há mais de 45 min (execução que morreu)
   volta sozinho para a fila.

O mesmo script corta na mão, em qualquer máquina com ffmpeg:
`node tools/cortar.mjs --uid <uid> --inicio 2381.04 --fim 2415.61 --titulo "…"`
(legenda vem de `transcricoes/<uid>.json`; `--formato
todos|vertical|linkedin|horizontal`, `--enquadramento cheio|4x3`, `--fundo
desfoque|escuro`). Fontes IBM Plex em `tools/fontes/`
(licença OFL), para a legenda sair igual no Mac e no CI.

Segredos envolvidos — ficam nos **secrets do repositório** e descem para o
Worker no deploy (passo *Segredos do Worker*, `wrangler secret bulk`):

- `CORTES_CHAVE` (obrigatório para o cortador): chave aleatória longa; o
  workflow usa para falar com o painel, o Worker usa para conferir.
- `GH_TOKEN_CORTES` (opcional): token fino do GitHub com **Actions:
  read/write** só neste repositório — aciona o cortador ao aprovar. Sem ele,
  fica a rodada de hora em hora.
- `DEEPGRAM_API_KEY` (transcrição automática de aula nova; ver acima).
- `MODELOS_API_KEY` (busca por significado e escolha dos cortes pelo Model
  Studio; ver acima).
- `STREAM_API_TOKEN` (opcional, alternativa ao cortador): token da conta com
  **Stream:Edit**; aprovar cria o clipe pela API REST (`/stream/clip`) e
  *Conferir* pega o MP4 em 16:9, sem legenda. Só vale se o cortador não
  estiver configurado.

Outras notas:

- Se a IA falhar ou responder algo inválido, os 3 candidatos mais fortes
  entram inteiros, marcados "sem IA".
- Vídeo de entrevista com convidado (Safra, USP…): confirme o de acordo do
  convidado e do canal antes de postar — o corte é outro uso da imagem.
- Media Transformations da Cloudflare não serve aqui: só aceita MP4 de até
  10 min/100 MB fora do Stream e devolve no máximo 60 s, sem legenda.

## Mover ou tirar o acesso de uma escola

```bash
# tira só de uma escola
npx wrangler d1 execute escola --remote --command \
  "DELETE FROM matriculas WHERE escola='futuro'
   AND aluno_id=(SELECT id FROM alunos WHERE email='aluno@email.com')"
```

A sessão dele naquela escola para de valer na requisição seguinte.

## Tirar o acesso de alguém

```bash
npx wrangler d1 execute escola --remote --command \
  "DELETE FROM alunos WHERE email='aluno@email.com'"
```

As sessões e o progresso caem junto, por cascata — **exceto** `matriculas`,
`acervo_progresso` e `trilhas`, que em produção foram criadas sem chave
estrangeira. Depois de apagar alguém, varra os órfãos:

```bash
npx wrangler d1 execute escola --remote --command \
  "DELETE FROM matriculas WHERE aluno_id NOT IN (SELECT id FROM alunos);
   DELETE FROM acervo_progresso WHERE aluno_id NOT IN (SELECT id FROM alunos);
   DELETE FROM trilhas WHERE aluno_id NOT IN (SELECT id FROM alunos);
   DELETE FROM acessos WHERE aluno_id NOT IN (SELECT id FROM alunos)"
```

## Aluno diz que o e-mail não chega

O banco separa duas perguntas — *ele está matriculado?* e *o app chegou a
gerar um link?* — e a resposta fecha o diagnóstico:

```bash
npx wrangler d1 execute escola --remote --command \
  "SELECT m.escola FROM matriculas m JOIN alunos a ON a.id=m.aluno_id WHERE a.email='aluno@email.com';
   SELECT COUNT(*) AS links FROM links_magicos WHERE email='aluno@email.com'"
```

| Matrícula | Links | O que aconteceu | O que fazer |
|---|---|---|---|
| nenhuma | 0 | não está cadastrado, ou está com outra grafia | liberar pelo painel |
| só em outra escola | 0 | tentou na escola errada — o app finge que enviou | mandar o link de `comunidade.comeca.ai` |
| na comunidade | 0 | digitou diferente do cadastro, ou não enviou o formulário | conferir o que ele digita |
| na comunidade | ≥ 1 | o app enviou; o provedor segurou | spam; log de envio em Cloudflare → Email |

Provedores como `terra.com.br` são rigorosos com remetente novo — o log de
envio da Cloudflare diz se houve rejeição.

## Publicar uma aula nova

1. Suba o vídeo no Cloudflare Stream.
2. Nomeie seguindo o padrão — o módulo sai do próprio título
   ([`packages/conteudo/modulos.ts`](../packages/conteudo/modulos.ts)):
   - `[Nome do Módulo] Título` vira módulo *Nome do Módulo*
   - `Nome do Módulo [Parte 3]` vira módulo *Nome do Módulo*, parte 3
   - `[Sessão Prática] - Título` vira módulo *Sessões Práticas*
   - **qualquer outro nome** cai no `MODULO_PADRAO` do `wrangler.jsonc`
     (hoje *Entrevistas: dados, IA e empreendedorismo*) — é onde entram
     palestras, talks e entrevistas avulsas
3. Espere o cron (15 min) ou clique em *Sincronizar com o Stream* no
   `/admin`.

Para abrir um **módulo novo**, ou o vídeo leva o prefixo `[Módulo]`, ou o nome
entra na `ORDEM_MODULOS` — separada por `|`, porque nome de módulo pode ter
vírgula. Dentro do módulo, aulas sem `[Parte N]` saem na ordem de publicação
no Stream. Vídeos antigos com título livre podem ser fixados por uid em
`POR_UID`, no mesmo arquivo.

## Leituras em PDF (só na clássica)

`comunidade.comeca.ai/admin` → *Leituras em PDF*: título, uma linha, módulo,
arquivo. Só PDF, até 25 MB. O aluno vê a seção *Leituras* no fim da jornada e lê
dentro da escola, página a página, com o e-mail dele em marca-d'água; não há link
de download e o arquivo só sai do Worker com sessão válida. É dissuasão, não DRM
— quem abrir a aba de rede consegue os bytes, com o nome dele dentro. *Ocultar*
tira da lista sem apagar; *Excluir* apaga também do R2. Marcar como lida não
entra no percentual do curso nem no certificado.

## Proteger os vídeos

Por padrão o Stream entrega o vídeo a quem tiver o link. Para exigir token
assinado, marque cada vídeo:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/stream/{VIDEO_UID}" \
  -H "Authorization: Bearer {TOKEN}" -H "Content-Type: application/json" \
  -d '{"requireSignedURLs": true}'
```

O código já gera o token sozinho — não é preciso mudar nada.

## Materiais em PDF

Envie para o bucket R2 configurado em `r2_buckets` e rode a importação. O nome do
arquivo vira o título: `dados_conceitos_fundamentais.pdf` aparece como
*dados conceitos fundamentais*.

## Reimportar o acervo

`/app` → *Reimportar acervo*, visível para administradores. É idempotente: itens
existentes são atualizados, nada é duplicado, progresso é preservado.

## Acompanhar a turma

```bash
# quem entrou e quem nunca entrou
npx wrangler d1 execute escola --remote --command \
  "SELECT nome, email, ultimo_acesso FROM alunos ORDER BY ultimo_acesso"

# progresso por aluno
npx wrangler d1 execute escola --remote --command \
  "SELECT a.nome, COUNT(p.aula_uid) concluidas FROM alunos a
   LEFT JOIN progresso p ON p.aluno_id = a.id GROUP BY a.id ORDER BY concluidas DESC"
```

## Custo

Workers e D1 cabem no plano pago. O que cresce com a audiência:

| Item | Preço |
|---|---|
| Stream — armazenamento | US$ 5 por 1.000 minutos |
| Stream — entrega | US$ 1 por 1.000 minutos assistidos |
| Email Service | 3.000/mês inclusos, depois US$ 0,35 por mil |
| Workers AI / AI Gateway | por uso: escolha dos cortes |
| Deepgram (transcrição) | por minuto de áudio, na conta própria (créditos) |
| GitHub Actions (cortador) | minutos do plano do repositório privado; a rodada de hora em hora gasta ~720 min/mês mesmo sem corte na fila |

Com ~2h de catálogo, o armazenamento fica abaixo de US$ 1 por mês. A entrega é
que escala: 100 alunos assistindo 2h cada dão 12.000 minutos, cerca de US$ 12.
Se os minutos do Actions apertarem, afrouxe o `cron` em
`.github/workflows/cortes.yml` (com `GH_TOKEN_CORTES` o corte sai na hora de
qualquer jeito).
