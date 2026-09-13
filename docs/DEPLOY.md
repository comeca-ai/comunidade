# Deploy

Subir a comunidade do zero, numa conta Cloudflare nova.

> O banco D1 `escola` é compartilhado com as escolas experimentais do
> monorepo [`comeca-ai/escoladofuturo`](https://github.com/comeca-ai/escoladofuturo)
> (modulos, futuro, sensacionalista). Se elas ainda existirem na conta, o
> passo 1 já foi feito — use o mesmo `database_id`.

## Pré-requisitos

- Plano **Workers Paid** (o Email Service e o Stream exigem)
- Node 20 ou superior
- Vídeos já enviados ao **Cloudflare Stream**
- Um domínio verificado no **Email Service**, para o remetente

## 1. Banco de dados

```bash
npx wrangler d1 create escola
```

Copie o `database_id` devolvido e cole no `wrangler.jsonc`. O id de
um banco D1 é identificador, não credencial — sem token ninguém usa —, por isso
o repositório versiona o id real (com `// gitleaks:allow` ao lado).

Crie as tabelas (uma vez só — o banco é compartilhado):

```bash
npm install
npm run db:remote
```

## 2. Configuração

No `wrangler.jsonc`, ajuste `vars`:

| Variável | O que é |
|---|---|
| `NOME_ESCOLA` | nome exibido no topo e nos e-mails |
| `STREAM_SUBDOMINIO` | `customer-XXXX.cloudflarestream.com`, em Stream → Settings |
| `EMAIL_REMETENTE` | remetente dos links; o domínio precisa estar verificado |
| `ORDEM_MODULOS` | ordem da trilha; módulos fora da lista vão para o fim |

`ADMINS` (e-mails com acesso ao painel, separados por vírgula) é segredo do
Worker: `npx wrangler secret put ADMINS`. Depois do primeiro deploy, outros
admins entram pela aba **Equipe** do painel, sem novo deploy.

## 3. Segredos

> Nunca coloque token em `wrangler.jsonc` — ele vai para o Git. Segredo é
> sempre `wrangler secret put` (ou os secrets do repositório, que o
> `.github/workflows/deploy.yml` desce para o Worker via `secret bulk`).

Os segredos usados pela comunidade: `ADMINS`, `CORTES_CHAVE`,
`DEEPGRAM_API_KEY`, `GH_TOKEN_CORTES` e `MODELOS_API_KEY` — o que cada um faz
está em `docs/OPERACAO.md` e nos comentários do `wrangler.jsonc`. Sem eles o
site funciona; transcrição, cortes e busca por significado ficam desligados.

## 4. Publicar

```bash
npm install && npm run deploy
```

Ou deixe o GitHub Actions publicar a cada push na `main`
(`.github/workflows/deploy.yml` — segredos necessários em
`.github/workflows/README.md`).

## 5. Primeiro acesso

Você ainda não é aluno de si mesmo. Cadastre-se:

```bash
npx wrangler d1 execute escola --remote --command \
  "INSERT INTO alunos (email,nome,criado_em) VALUES ('voce@dominio.com','Seu Nome',unixepoch())"
```

Entre pela URL do Worker, receba o link por e-mail e vá em `/admin`.

## 6. Carregar o conteúdo

`/admin` → *Sincronizar com o Stream* (ou espere o cron de 15 min).

## Homologação

Para mudança grande, valide antes em **homologação**: um segundo Worker
(`escola-classica-homolog`, só na URL workers.dev) com banco D1
(`escola-homolog`) e bucket R2 (`slidesaulas-homolog`) próprios — nenhum dado
de aluno real. O mesmo Stream alimenta as aulas pelo cron, então o conteúdo
aparece sozinho em poucos minutos. De propósito, homolog roda **sem
segredos**: transcrição nova, cortador e Model Studio desligados (a triagem
de notícias cai no Workers AI). O admin entra pelo link mágico normal — o
e-mail dele está semeado na tabela `administradores` do banco de homolog.

Fluxo: branch `homolog` → push publica em homologação → validou, merge na
`main` publica em produção. À mão: `npx wrangler deploy --env homolog`.

## Rodar local

```bash
npm run db:local
npm run dev
```

Os bindings de Stream e Email não funcionam localmente. Login e progresso sim;
o player cai no vídeo sem assinatura.
