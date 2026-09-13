# Comunidade — começa.ai

A área de membros da escola de IA do começa.ai, no ar em
**[comunidade.comeca.ai](https://comunidade.comeca.ai)**
(`classica.comeca.ai` redireciona). Roda inteiramente na Cloudflare: Workers,
D1, Stream, R2, Email Service e AI. Sem servidor para manter, sem chave de API
no código, sem senha para o aluno.

Ambiente Virtual de Aprendizagem tradicional: sumário fixo à esquerda, trilha
de navegação, aulas numeradas em sequência, aproveitamento em porcentagem,
leituras em PDF com marca-d'água, provas por módulo, certificado com validação
pública e relatório de progresso por e-mail. Fundo claro, azul da marca,
densidade alta — a leitura de quem já usou um AVA.

## Rotas

| Rota | O que faz |
|---|---|
| `/` | entrada por e-mail |
| `/verificar?t=` | consome o link mágico e cria a sessão |
| `/app` | programa do curso, com sumário lateral |
| `/app/aula/:uid` | player e marcação de conclusão |
| `/app/prova/:modulo` | prova do módulo (abre ao concluir as aulas) e `/resultado` da última tentativa |
| `/app/certificado`, `/certificado/:codigo` | certificado do aluno e validação pública — retidos até a aprovação nas provas publicadas (ajuste no painel) |
| `/admin` | painel: alunos, funil, desempenho, provas, convites, aulas, leituras, Inteligência (busca na fala, cortes) e equipe (outros admins) |
| `/admin/provas/:modulo` | revisão e edição das questões de um módulo (`/salvar`); gerar, publicar, exigir e o ajuste do certificado são POSTs em `/admin/provas/*` |
| `/admin/cortes/:id/video.mp4` | download do corte gerado (admin) |
| `/cortes/fila`, `/cortes/retorno` | cortador do GitHub Actions (segredo `CORTES_CHAVE`) |
| `/deepgram/retorno` | callback da transcrição (chave por pedido) |

## Como funciona o acesso

Não há senha. O aluno digita o e-mail; se estiver cadastrado **e matriculado**,
recebe um link de acesso válido por 20 minutos, enviado pelo Cloudflare Email
Service. Quem não está vê exatamente a mesma tela — assim ninguém descobre quem
é aluno testando endereços. Os vídeos são servidos com token assinado do
Stream, gerado a cada acesso, e os PDFs passam pelo Worker: nenhum arquivo fica
público, e um link copiado não funciona para terceiros.

## Estrutura

```
src/            o Worker (Hono): rotas, painel, player, funil, provas, cortes
packages/
  identidade/   cores, tipografia e marca do começa.ai
  conteudo/     classificação de título → módulo; formato das transcrições
transcricoes/   transcrições das aulas (geradas por tools/transcrever.mjs)
db/schema.sql   esquema do banco D1 `escola`
tools/          cortador de vídeo (ffmpeg) e transcritor (Deepgram)
docs/           arquitetura, deploy, operação e segurança
```

O conteúdo vive no Cloudflare Stream; o módulo de cada vídeo sai do título,
por regras em `packages/conteudo/modulos.ts` (`[Módulo] Título`,
`Título [Parte N]`, `[Sessão Prática] - Título`). O Worker sincroniza o Stream
sozinho por cron (15 min) — vídeo novo aparece sem clique.

## Documentação

- [Arquitetura](docs/ARQUITETURA.md) — como as peças se encaixam e por quê
- [Deploy](docs/DEPLOY.md) — subir do zero em uma conta nova
- [Operação](docs/OPERACAO.md) — liberar alunos, transcrever, cortar, trocar conteúdo
- [Segurança](docs/SEGURANCA.md) — o que é protegido, como e o que ainda não é

## Stack

Hono sobre Cloudflare Workers, HTML renderizado no servidor, sem build de
frontend e sem dependência de framework de UI. O CSS vive em `src/ui.ts`; os
tokens visuais, em `packages/identidade/marca.ts`.

```bash
npm install
npm run dev        # local (Stream e Email não funcionam localmente)
npm run deploy     # publica o Worker escola-classica
```

O deploy contínuo (push na `main`) está em `.github/workflows/deploy.yml` —
segredos necessários em [.github/workflows/README.md](.github/workflows/README.md).

## Origem

Código extraído do monorepo
[`comeca-ai/escoladofuturo`](https://github.com/comeca-ai/escoladofuturo)
(app `apps/classica`, commit `8385f34`, 08/09/2026), que segue abrigando as
três escolas experimentais (`modulos`, `futuro`, `sensacionalista`) e o
cortador de vídeo em produção. O banco D1 `escola` é compartilhado entre os
dois repositórios. O bundle gerado por este repositório é byte a byte idêntico
ao que estava em produção no Worker `escola-classica` na data da extração
(SHA-256 conferido, normalizados os prefixos de caminho do bundler).
