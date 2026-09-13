# Segurança

O que está protegido, como, e o que ainda não está.

## Protegido

**Nenhum segredo no repositório.** Tokens e chaves vivem como *Worker secrets*
(`wrangler secret put`), fora do Git. Os `wrangler.jsonc` trazem apenas
configuração pública e identificadores marcados para preencher.

**Acesso por convite e por escola.** Só recebe link quem tem matrícula naquela
escola específica. Não há cadastro aberto, nem senha para vazar ou reusar. A
sessão também é validada contra a matrícula a cada requisição — perder o acesso
derruba a sessão na hora, sem esperar o cookie expirar.

**Enumeração de e-mail bloqueada.** Cadastrado ou não, a tela é a mesma. O site
não revela quem é aluno.

**Link de acesso descartável.** Token de 32 bytes, 20 minutos, uso único —
marcado como usado assim que vira sessão.

**Sessão em cookie endurecido.** `HttpOnly`, `Secure`, `SameSite=Lax`, 30 dias,
revogável apagando a linha em `sessoes`.

**Vídeo com token assinado.** URL gerada por acesso, com validade curta. Um link
copiado e repassado não abre para outra pessoa.

**PDF nunca público.** O bucket R2 não tem acesso anônimo; o arquivo passa pelo
Worker, que exige sessão.

**Escrita no banco sempre parametrizada.** Todo SQL usa `bind()` — não há
concatenação de entrada do usuário.

**Saída sempre escapada.** Todo texto que vai para o HTML passa por `esc()`,
inclusive título vindo do Stream e do arquivo de artigos.

**A IA não inventa conteúdo.** Todo id devolvido pelo modelo é validado contra o
acervo antes de virar trilha. O que não existe é descartado em silêncio.

## Ainda não está protegido

Vale saber antes de abrir para um público maior.

**Não há limite de tentativas no envio do link.** Alguém que conheça um e-mail
cadastrado pode pedir vários links seguidos e encher a caixa de entrada da
pessoa. Para turmas por convite o risco é baixo; num cadastro aberto, não seria.
A correção natural é um limite por e-mail e por IP, com Durable Objects ou KV.

**O token do AI Gateway dá acesso a todos os gateways da conta.** A permissão
*AI Gateway Run* não pode ser restrita a um gateway específico. Ele fica só como
segredo do Worker e nunca chega ao navegador — mas quem tiver o segredo tem esse
alcance.

**Sem LGPD formalizada.** O sistema guarda e-mail, nome e progresso. Não há
política de privacidade, consentimento registrado nem rotina de exclusão a
pedido. Para uma turma por convite isso costuma bastar; para venda aberta, não.

## Se um segredo vazar

1. Revogue o token na origem (Cloudflare → Perfil → Tokens de API; ou no
   provedor do modelo).
2. Gere outro e refaça `wrangler secret put`.
3. Republique. O Worker passa a usar o novo na próxima requisição.

Trocar o segredo **não** derruba as sessões dos alunos — são coisas separadas.
Para derrubar sessões, apague as linhas de `sessoes`.

## O que o CI verifica antes de publicar

O fluxo em `.github/workflows/deploy.yml` roda quatro checagens, e **nenhuma
publicação acontece se alguma falhar**:

| Checagem | O que pega |
|---|---|
| Varredura de segredos (gitleaks) | token ou chave commitado, inclusive no histórico |
| Busca por e-mail pessoal | cadastro de aluno vazando para o código |
| Conferência de tipos | código quebrado, import inexistente, chamada errada |
| `wrangler deploy --dry-run` | o que não empacota |

Depois de publicar, ele confere que a URL respondeu 200 e que a página de
entrada não expõe endereço de e-mail.

A auditoria de dependências roda, mas não bloqueia: uma vulnerabilidade em
pacote de terceiro não deve impedir uma correção urgente de subir.

### O que o CI ainda não faz

- **Não há teste automatizado.** Nenhum teste unitário ou de integração cobre
  login, progresso ou geração de trilha. A conferência de tipos e o dry-run
  pegam código quebrado, não comportamento errado.
- **A conferência de tipos está frouxa.** `strict` e `noImplicitAny` estão
  desligados, porque o código usa `any` em vários pontos de borda. Ligar isso é
  trabalho próprio, e vale fazer antes de a base crescer.
- **Não há ambiente de teste.** O push na `main` vai direto para produção. Para
  uma escola com turma ativa, o próximo passo natural é um Worker de staging e
  publicação em produção só por aprovação.
