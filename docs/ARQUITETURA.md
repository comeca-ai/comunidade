# Arquitetura

## Decisão de fundo

O ponto de partida foi uma restrição: rodar tudo dentro da Cloudflare, para
consumir crédito já contratado em vez de abrir fatura nova, e sem servidor para
manter.

Isso descartou os LMS de prateleira. LearnHouse, Moodle e Open edX precisam de
Python ou PHP com Postgres e WebSocket — três coisas que Workers não faz. A
alternativa foi construir o que o tamanho da operação realmente pede: uma área
de membros, não um LMS.

Para 20 aulas e turmas de 20 pessoas, a diferença prática entre as duas coisas é
pequena; a diferença de custo e manutenção é enorme.

## Peças

```
navegador
    │
    ▼
Worker (Hono)  ──► D1        alunos, sessões, aulas, acervo, progresso, trilhas
    │
    ├──────────► Stream      vídeo com token assinado
    ├──────────► R2          PDFs, servidos pelo Worker
    ├──────────► Email       link de acesso
    └──────────► Modelos     transcrição (Deepgram), cortes e busca na fala
                                (Workers AI ou Alibaba Model Studio)
```

A comunidade é um Worker com seu `wrangler.jsonc` e o slug `classica` em
`vars.ESCOLA`. O banco D1 `escola` é **compartilhado** com as escolas
experimentais do monorepo
[`escoladofuturo`](https://github.com/comeca-ai/escoladofuturo), mas o acesso é
separado: um aluno só entra onde tem linha em `matriculas`. Quem está em mais de
uma escola leva o progresso junto, porque o conteúdo é o mesmo.

## Modelo de dados

| Tabela | Papel |
|---|---|
| `alunos` | quem existe no sistema |
| `matriculas` | em quais escolas cada aluno entra — a autorização de fato |
| `sessoes` | sessão por cookie, 30 dias |
| `links_magicos` | token de uso único, 20 minutos |
| `aulas` | aulas de vídeo, sincronizadas do Stream |
| `progresso` | aula concluída por aluno (escolas clássica e módulos) |
| `acervo` | conteúdo unificado: aula, slide, artigo, vídeo (escola futuro) |
| `acervo_progresso` | item concluído por aluno (escola futuro) |
| `trilhas` | a trilha gerada para cada aluno, em JSON (escola futuro) |

O schema (`db/schema.sql`) cobre também as tabelas usadas só pelas escolas
experimentais, porque o banco é um só. A comunidade trabalha sobre `aulas` e
`progresso`; a escola futuro, sobre `acervo` — duplicação consciente: unificar
exigiria migrar sem ganho para o aluno.

## Autenticação

Link mágico, sem senha:

1. O aluno informa o e-mail.
2. Se estiver em `alunos`, gera-se um token de 32 bytes com validade de 20 min.
3. O Email Service envia o link.
4. Ao ser aberto, o token é marcado como usado e vira uma sessão de 30 dias em
   cookie `HttpOnly`, `Secure`, `SameSite=Lax`.

Quem não está cadastrado recebe a mesma resposta na tela. A diferença só existe
na caixa de entrada — o site não confirma nem nega se um endereço é aluno.

## Proteção do conteúdo

**Vídeo.** O Worker chama `STREAM.video(uid).generateToken()` e monta a URL do
player com o token no lugar do id. O link expira e não vale para terceiros. Para
a proteção valer, o vídeo precisa estar marcado com `requireSignedURLs` — veja
[Operação](OPERACAO.md).

**PDF.** O bucket R2 não é público. A rota `/material/:chave` exige sessão e faz
o streaming do objeto. Sem sessão válida, não há arquivo.

## Por que não React

O conteúdo é essencialmente estático por requisição e cada página cabe em uma
resposta HTML. Um framework de frontend acrescentaria build, bundle e hidratação
sem melhorar o que o aluno vê. O resultado é um Worker de ~90 KB que responde em
poucos milissegundos e não tem passo de build.
