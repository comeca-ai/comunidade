# Publicação automática

Todo push na `main` que toque `src/`, `packages/`, `transcricoes/` ou o
`wrangler.jsonc` publica na Cloudflare. Também dá para publicar à mão em
*Actions → Deploy → Run workflow*.

Antes de publicar, o fluxo roda um `wrangler deploy --dry-run`. Se o código não
compilar, nada vai para produção.

## Segredos necessários

Em **Settings → Secrets and variables → Actions**, crie dois:

| Segredo | Onde conseguir |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | está na URL do painel, depois de `dash.cloudflare.com/` |
| `CLOUDFLARE_API_TOKEN` | Perfil → Tokens de API → Criar token |

### Permissões do token

Comece pelo modelo **Editar Cloudflare Workers** e acrescente:

- **D1** — Editar
- **Stream** — Editar

Remova a permissão de **Zona → Rotas de Workers** se você publica em
`workers.dev` — ela não é usada e obriga a escolher uma zona.

## Segredos do Worker (opcionais)

Se existirem nos secrets do repositório, o deploy desce para o Worker via
`wrangler secret bulk`: `CORTES_CHAVE`, `DEEPGRAM_API_KEY`, `GH_TOKEN_CORTES`
e `MODELOS_API_KEY`. Sem valor, o segredo correspondente do Worker fica como
está.

## Cortador (`cortes.yml`)

O cortador de vídeos para redes roda no repositório apontado por
`CORTES_REPOSITORIO` no `wrangler.jsonc` — hoje, `comeca-ai/escoladofuturo`.
O `cortes.yml` daqui está com a rodada de hora em hora **desligada** para não
duplicar; o passo a passo da migração está comentado no próprio arquivo.
