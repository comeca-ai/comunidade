import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { pagina, esc, duracao } from "./ui";
import { LOGO, M } from "../packages/identidade/marca";
import { classificar, moduloNaLeitura, regrasDoEnv, listaDeModulos } from "../packages/conteudo/modulos";
import { rotasLeituras, leiturasDoAluno, secaoLeituras, garantirTabelasLeituras } from "./leituras";
import { MIDIA } from "./midia";
import { enviarLinkMagico, VALIDADE_ENTRADA } from "./acesso";
import { rotasAdmin } from "./admin";
import { rotasFunil, garantirEsquemaFunil, registrarAcesso } from "./funil";
import { rotasTranscricao, garantirTabelasTranscricao, semearDoBundle, avancarTranscricoes, transcricaoDe, secaoTranscricaoAula } from "./transcricao";
import { rotasCortes } from "./cortes";
import { avancarVetores } from "./modelos";
import { rotasDesempenho, posicaoSalva, avaliacaoDe, blocoAvaliacao, SCRIPT_PLAYER } from "./desempenho";
import { emSegundoPlano } from "./apoio";
import { rotasProvas, situacaoProvas, bloqueioDe, linhaProvaModulo, provasParaCertificado } from "./provas";
import { rotasEquipe, ehAdmin as ehAdminEquipe } from "./equipe";
import { rotasNoticias, atualizarNoticias, noticiasAprovadas } from "./noticias";
import { corpoJornada } from "./jornada";

type Env = {
  DB: D1Database;
  STREAM: any;
  SLIDES: R2Bucket;
  EMAIL: { send(m: { to: string; from: string; subject: string; html: string; text: string }): Promise<void> };
  ESCOLA: string;
  DOMINIO?: string;
  DOMINIOS_ANTIGOS?: string;
  ESCOLA_TITULO: string;
  ESCOLA_SUBTITULO: string;
  NOME_ESCOLA: string;
  STREAM_SUBDOMINIO: string;
  EMAIL_REMETENTE: string;
  ADMINS: string;
  ORDEM_MODULOS: string;
  MODULO_PADRAO?: string;
  MINUTOS_HORA_AULA?: string;
  DEEPGRAM_API_KEY?: string;   // segredo: transcrição automática de vídeo novo
  AI?: any;                    // Workers AI: escolha dos cortes
  STREAM_API_TOKEN?: string;   // segredo (Stream:Edit): clipe do corte pela API REST
  CF_ACCOUNT_ID?: string;
  CORTES_CHAVE?: string;       // segredo: autentica o cortador (GitHub Actions) em /cortes/fila e /cortes/retorno
  CORTES_REPOSITORIO?: string; // "org/repo" onde roda o workflow cortes.yml
  GH_TOKEN_CORTES?: string;    // segredo opcional (Actions:write só nesse repositório): aciona o cortador na hora
  MODELOS_BASE?: string;       // API compatível com OpenAI (Model Studio): busca por significado + escolha dos cortes
  MODELOS_API_KEY?: string;    // segredo
  MODELO_CORTES?: string;      // ex.: qwen3.8-max (responde no clique)
  MODELO_CORTES_EDITOR?: string; // ex.: kimi-k3 (pensa uns 3 min; aba aberta esperando)
  MODELO_EMBED?: string;       // ex.: text-embedding-v4
};

type Aluno = { id: number; email: string; nome: string | null };

const app = new Hono<{ Bindings: Env; Variables: { aluno: Aluno } }>();

const agora = () => Math.floor(Date.now() / 1000);
const novoToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/* ---------------- domínio ---------------- */

// A escola mudou de endereço (classica → comunidade). O antigo continua
// apontando para o Worker e responde 301 para o atual, preservando caminho e
// query — link mágico, validação de certificado e favoritos seguem valendo.
app.use("*", async (c, next) => {
  const alvo = (c.env.DOMINIO || "").trim();
  const antigos = (c.env.DOMINIOS_ANTIGOS || "").split(",").map((h: string) => h.trim()).filter(Boolean);
  const url = new URL(c.req.url);
  if (alvo && antigos.includes(url.hostname)) {
    url.hostname = alvo; url.protocol = "https:"; url.port = "";
    return c.redirect(url.toString(), 301);
  }
  // colunas e tabelas do funil entram sozinhas (uma vez por isolate); um erro
  // aqui não pode derrubar o site — só o que depende delas falharia depois
  try { await garantirEsquemaFunil(c.env); } catch (e) { console.error("esquema do funil:", e); }
  await next();
});

/* ---------------- sessão ---------------- */

async function alunoDaSessao(c: any): Promise<Aluno | null> {
  const t = getCookie(c, "sessao");
  if (!t) return null;
  const r: any = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.nome FROM sessoes s
     JOIN alunos a ON a.id = s.aluno_id
     JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
     WHERE s.token = ? AND s.expira_em > ?`
  ).bind(c.env.ESCOLA, t, agora()).first();
  return r ?? null;
}

const exigeLogin = async (c: any, next: any) => {
  const aluno = await alunoDaSessao(c);
  if (!aluno) return c.redirect("/");
  c.set("aluno", aluno);
  // registra o dia de acesso (sessão dura 30 dias; o login sozinho não diz quem voltou)
  await emSegundoPlano(c, registrarAcesso(c.env, aluno.id, agora()));
  await next();
};

/* ---------------- entrada ---------------- */

app.get("/", async (c) => {
  if (await alunoDaSessao(c)) return c.redirect("/app");
  const msg = c.req.query("enviado")
    ? `<div class="aviso">Link enviado. Confere teu e-mail — ele vale por 20 minutos.</div>`
    : c.req.query("erro")
      ? `<div class="erro">Esse link expirou ou já foi usado. Pede um novo abaixo.</div>`
      : "";

  // o programa sai da mesma lista que ordena a trilha — não duplica conteúdo
  const modulos = listaDeModulos(c.env.ORDEM_MODULOS);

  return c.html(pagina({
    escola: c.env.NOME_ESCOLA,
    titulo: "Entrar",
    corpo: `<main class="wrap entrada">
      <div class="centro" style="text-align:center">
        <p class="mono">Ambiente Virtual de Aprendizagem</p>
        <h1 style="margin:16px 0 12px">Acesso do aluno</h1>
        <p style="color:var(--muted);margin-bottom:30px">
          Informe o e-mail cadastrado na matrícula. Enviaremos um link de acesso.
        </p>
        ${msg}
        <form method="post" action="/entrar" style="margin-top:20px;display:grid;gap:12px">
          <input class="campo" type="email" name="email" required
                 placeholder="seu@email.com" autocomplete="email" autofocus>
          <button class="btn btn-primario" type="submit">Acessar</button>
        </form>
      </div>

      <section class="faixa perfil">
        <header class="perfil-topo">
          <p class="mono">Professor</p>
          <h2>Jhonata Emerick</h2>
          <p class="lead">
            IA de quem já construiu, vendeu e regulou. Mais de 500 soluções de
            inteligência artificial entregues pela Datarisk, uma startup vendida ao
            iFood e a presidência da associação que representa o setor no país.
          </p>
        </header>
        <figure class="retrato">
          <img src="${MIDIA.senado}" width="960" height="640"
               alt="Jhonata Emerick em audiência pública no Senado Federal">
          <figcaption>Audiência pública no Senado Federal, como presidente da ABRIA.</figcaption>
        </figure>
        <div>
          <dl class="trajetoria">
            <div><dt>Datarisk</dt><dd>Cofundador e CEO. Mais de 500 soluções de IA implantadas na América Latina.</dd></div>
            <div><dt>ABRIA</dt><dd>Fundador e primeiro presidente da Associação Brasileira de Inteligência Artificial.</dd></div>
            <div><dt>Rapiddo → iFood</dt><dd>Cofundador da startup de logística urbana, vendida ao iFood em 2018.</dd></div>
            <div><dt>RadSquare</dt><dd>Cofundador. IA aplicada à medicina; spin-off do Hospital Israelita Albert Einstein.</dd></div>
            <div><dt>Formação</dt><dd>Doutor em Engenharia da Computação (Poli-USP), Mestre em Finanças Quantitativas (FGV) e Engenheiro Aeronáutico (EESC-USP).</dd></div>
            <div><dt>Autor</dt><dd>“Econometria com EViews” (Saint Paul Editora) e da newsletter semanal O Joio do Trigo.</dd></div>
          </dl>
        </div>
      </section>

      <section class="faixa">
        <p class="mono">Prova social</p>
        <h2>Quem já passou pelo trabalho dele</h2>
        <div class="numeros">
          <div><b>1,4 mi</b><span>pessoas alcançadas em palestras e conteúdo</span></div>
          <div><b>500+</b><span>soluções de IA entregues pela Datarisk</span></div>
          <div><b>60+</b><span>artigos publicados</span></div>
          <div><b>22</b><span>veículos, entre eles Exame, Forbes e CNBC</span></div>
        </div>

        <p class="mono" style="margin-top:44px">Empresas e eventos que já receberam Jhonata</p>
        <div class="logos">
          ${[
            ["raizen", "Raízen"], ["ultra", "Ultra"], ["xerox", "Xerox"],
            ["sirio", "Hospital Sírio-Libanês"], ["einstein", "Hospital Israelita Albert Einstein"],
            ["crescera", "Crescera Capital"], ["antler", "Antler"], ["adium", "Adium"],
            ["kidy", "Kidy"], ["eretz", "eretz.bio"],
            ["cardiovascular", "Academia Brasileira de Cirurgia Cardiovascular"],
            ["gerar", "GERAR"], ["lts", "LTS Investments"],
          ].map(([k, nome]) => {
            const simbolo = ["sirio", "einstein", "gerar", "kidy", "cardiovascular", "adium", "ultra"].includes(k);
            return `<div><img src="${(MIDIA as any)[k]}" alt="${esc(nome)}"${simbolo ? ' class="simbolo"' : ""}></div>`;
          }).join("")}
        </div>

        <p class="mono" style="margin-top:44px">O que dizem quem já fez os cursos</p>
        <div class="depoimentos">
          <article class="dep">
            <blockquote>Os desafios para alcançar um desempenho diferenciado estarão sempre presentes. O Jhonata é um aliado estratégico que traz as soluções para uma performance competitiva.</blockquote>
            <footer><img src="${MIDIA.martins}" alt=""><div><b>Martins</b><span>Founder · Reembolsa</span></div></footer>
          </article>
          <article class="dep">
            <blockquote>Jhonata foi meu grande mestre para iniciar na jornada de IA. Hoje, na minha atividade — seja em automação de processos, análise de dados ou customer service — tem trazido um ganho muito grande de eficiência e inovação.</blockquote>
            <footer><img src="${MIDIA.lfa}" alt=""><div><b>Luiz Felipe Alves</b><span>Sócio · Head de Relações Institucionais · Galapagos Capital</span></div></footer>
          </article>
          <article class="dep">
            <blockquote>Trabalhei com o Jhon no desenvolvimento de modelos preditivos de IA no segmento de doenças raras e fiquei impressionado com o seu conhecimento da área da Saúde e com o seu método estruturado de trabalho.</blockquote>
            <footer><img src="${MIDIA.seraphim}" alt=""><div><b>Alexandre Seraphim</b><span>General Manager · Adium Brasil</span></div></footer>
          </article>
          <article class="dep">
            <blockquote>Trajetória que fala por si, didático como poucos, traduz temas complexos em exemplos simples e práticos, e prende a atenção da audiência do primeiro ao último minuto.</blockquote>
            <footer><img src="${MIDIA.odair}" alt=""><div><b>Odair Mofato</b><span>CRO &amp; Co-Founder · Liquid</span></div></footer>
          </article>
        </div>
      </section>

      ${modulos.length ? `<section class="faixa">
        <p class="mono">O programa</p>
        <h2>O que você vai aprender</h2>
        <p class="lead">
          Do conceito à prática: entender o que a tecnologia faz de fato, onde ela
          se aplica no seu negócio e o que passa a rodar na segunda-feira.
        </p>
        <ol class="programa">
          ${modulos.map((m, i) => `<li>
            <span class="n">${String(i + 1).padStart(2, "0")}</span>
            <span class="t">${esc(m)}</span>
          </li>`).join("")}
        </ol>
      </section>` : ""}
    </main>`,
  }));
});

app.post("/entrar", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  if (!email.includes("@")) return c.redirect("/?erro=1");

  // só quem já é aluno cadastrado recebe link
  const aluno: any = await c.env.DB.prepare(
    `SELECT a.id FROM alunos a
     JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
     WHERE a.email = ?`
  ).bind(c.env.ESCOLA, email).first();
  if (!aluno) {
    // resposta idêntica, para não revelar quem é aluno
    return c.redirect("/?enviado=1");
  }

  await enviarLinkMagico(c.env, new URL(c.req.url).origin, email, { validadeSeg: VALIDADE_ENTRADA });

  return c.redirect("/?enviado=1");
});

app.get("/verificar", async (c) => {
  const t = c.req.query("t") || "";
  const link: any = await c.env.DB.prepare(
    `SELECT email FROM links_magicos WHERE token = ? AND expira_em > ? AND usado_em IS NULL`
  ).bind(t, agora()).first();
  if (!link) return c.redirect("/?erro=1");

  const aluno: any = await c.env.DB.prepare(
    `SELECT a.id FROM alunos a
     JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
     WHERE a.email = ?`
  ).bind(c.env.ESCOLA, link.email).first();
  if (!aluno) return c.redirect("/?erro=1");

  const sessao = novoToken();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE links_magicos SET usado_em = ? WHERE token = ?`).bind(agora(), t),
    c.env.DB.prepare(`INSERT INTO sessoes (token, aluno_id, expira_em) VALUES (?,?,?)`)
      .bind(sessao, aluno.id, agora() + 60 * 60 * 24 * 30),
    c.env.DB.prepare(`UPDATE alunos SET ultimo_acesso = ? WHERE id = ?`).bind(agora(), aluno.id),
  ]);

  setCookie(c, "sessao", sessao, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  // o lembrete manda direto para a primeira aula; só caminhos internos do /app
  const para = c.req.query("para") || "";
  return c.redirect(/^\/app(\/[\w\-\/]*)?$/.test(para) ? para : "/app");
});

app.get("/sair", async (c) => {
  const t = getCookie(c, "sessao");
  if (t) await c.env.DB.prepare(`DELETE FROM sessoes WHERE token = ?`).bind(t).run();
  deleteCookie(c, "sessao", { path: "/" });
  return c.redirect("/");
});

/* ---------------- painel do aluno ---------------- */

type LinhaAula = {
  uid: string; titulo: string; modulo: string; ordem: number;
  duracao_seg: number; criada_em: number; concluida_em: number | null;
};

async function aulasComProgresso(c: any, alunoId: number): Promise<LinhaAula[]> {
  const r: any = await c.env.DB.prepare(
    `SELECT a.uid, a.titulo, a.modulo, a.ordem, a.duracao_seg, a.criada_em, p.concluida_em
     FROM aulas a
     LEFT JOIN progresso p ON p.aula_uid = a.uid AND p.aluno_id = ?
     WHERE a.publicada = 1
     ORDER BY a.modulo, a.ordem, a.titulo`
  ).bind(alunoId).all();
  // O módulo é derivado do título/uid na leitura, não do que ficou gravado na
  // sincronização: uma regra nova em packages/conteudo/modulos.ts vale no
  // deploy seguinte, sem esperar ressincronizar. A coluna aulas.modulo vira
  // cache — o cron abaixo a mantém alinhada.
  const linhas: LinhaAula[] = (r.results ?? []).map((l: any) => ({ ...l, ...moduloNaLeitura(l, regrasDoEnv(c.env)) }));
  const ordem = listaDeModulos(c.env.ORDEM_MODULOS);
  const peso = (m: string) => {
    const i = ordem.indexOf(m);
    return i === -1 ? ordem.length + 1 : i;
  };
  return linhas.sort((a, b) =>
    peso(a.modulo) - peso(b.modulo) ||
    a.modulo.localeCompare(b.modulo, "pt-BR") ||
    a.ordem - b.ordem ||
    (a.criada_em ?? 0) - (b.criada_em ?? 0) ||   // sem [Parte N]: ordem de publicação no Stream
    a.titulo.localeCompare(b.titulo, "pt-BR")
  );
}

app.get("/app", exigeLogin, async (c) => {
  const aluno = c.get("aluno");
  const [aulas, leituras, provas, cert, noticias] = await Promise.all([
    aulasComProgresso(c, aluno.id),
    leiturasDoAluno(c.env, aluno.id),
    situacaoProvas(c.env, aluno.id),
    provasParaCertificado(c.env, aluno.id),
    noticiasAprovadas(c.env),
  ]);

  const modulos = new Map<string, LinhaAula[]>();
  for (const a of aulas) {
    if (!modulos.has(a.modulo)) modulos.set(a.modulo, []);
    modulos.get(a.modulo)!.push(a);
  }
  const admin = await ehAdmin(c, aluno);

  const corpo = corpoJornada({
    nomeEscola: c.env.NOME_ESCOLA,
    subtitulo: c.env.ESCOLA_TITULO,
    aluno, modulos, provas, cert, leituras, noticias, admin,
    agora: agora(),
  });

  return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Sua jornada", aluno, corpo }));
});

/* ---------------- player ---------------- */

app.get("/app/aula/:uid", exigeLogin, async (c) => {
  const aluno = c.get("aluno");
  const uid = c.req.param("uid");
  const aulas = await aulasComProgresso(c, aluno.id);
  const i = aulas.findIndex((a) => a.uid === uid);
  if (i < 0) return c.notFound();
  const aula = aulas[i];
  const proxima = aulas[i + 1];
  // módulo trancado por prova exigida de módulo anterior
  const tranca = bloqueioDe(await situacaoProvas(c.env, aluno.id), [...new Set(aulas.map((a) => a.modulo))], aula.modulo);
  if (tranca) return c.redirect(`/app/prova/${encodeURIComponent(tranca)}?bloqueio=1`);

  // token assinado — o link do vídeo expira e não pode ser repassado
  let src = `https://${c.env.STREAM_SUBDOMINIO}/${uid}/iframe`;
  try {
    const token = await c.env.STREAM.video(uid).generateToken();
    src = `https://${c.env.STREAM_SUBDOMINIO}/${token}/iframe`;
  } catch { /* vídeo sem exigência de assinatura */ }
  // ?t=90 abre no segundo 90 — links da busca por fala e do lembrete; sem ?t,
  // volta de onde o aluno parou (posição salva pelo pulso do player)
  const t0 = Math.max(0, Math.floor(Number(c.req.query("t") || 0)) || 0) || await posicaoSalva(c.env, aluno.id, uid, aula.duracao_seg || 0);
  if (t0) src += `?startTime=${t0}s`;
  const [transcricao, avaliacao] = await Promise.all([transcricaoDe(c.env, uid).catch(() => null), avaliacaoDe(c.env, aluno.id, uid)]);

  const corpo = `<main class="wrap" style="padding:32px 24px">
    <a class="mono" href="/app">← todas as aulas</a>

    <div style="margin:20px 0 22px">
      <p class="mono">${esc(aula.modulo)}</p>
      <h1 style="font-size:clamp(26px,4vw,38px);margin-top:10px">${esc(aula.titulo)}</h1>
      <p class="aula-meta" style="margin-top:6px">${duracao(aula.duracao_seg)}</p>
    </div>

    <div class="player" data-aula="${esc(uid)}">
      <iframe src="${esc(src)}" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture"
              allowfullscreen loading="lazy"></iframe>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;
                align-items:center;margin-top:22px">
      <form method="post" action="/app/aula/${esc(uid)}/concluir">
        <button class="btn ${aula.concluida_em ? "btn-fantasma" : "btn-primario"}" type="submit">
          ${aula.concluida_em ? "✓ Concluída — desmarcar" : "Marcar como concluída"}
        </button>
      </form>
      ${proxima
        ? `<a class="btn btn-fantasma" href="/app/aula/${esc(proxima.uid)}">Próxima: ${esc(proxima.titulo)} →</a>`
        : `<span class="mono">Última aula da trilha</span>`}
    </div>
    ${blocoAvaliacao(uid, avaliacao, !!aula.concluida_em)}
    ${secaoTranscricaoAula(transcricao, uid)}
  </main>
  <script src="https://embed.cloudflarestream.com/embed/sdk.latest.js"></script>
  <script>${SCRIPT_PLAYER}</script>`;

  return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: aula.titulo, aluno, corpo }));
});

app.post("/app/aula/:uid/concluir", exigeLogin, async (c) => {
  const aluno = c.get("aluno");
  const uid = c.req.param("uid");
  const j: any = await c.env.DB.prepare(
    `SELECT concluida_em FROM progresso WHERE aluno_id = ? AND aula_uid = ?`
  ).bind(aluno.id, uid).first();

  if (j?.concluida_em) {
    await c.env.DB.prepare(`DELETE FROM progresso WHERE aluno_id = ? AND aula_uid = ?`)
      .bind(aluno.id, uid).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO progresso (aluno_id, aula_uid, concluida_em) VALUES (?,?,?)
       ON CONFLICT(aluno_id, aula_uid) DO UPDATE SET concluida_em = excluded.concluida_em`
    ).bind(aluno.id, uid, agora()).run();
  }
  return c.redirect(`/app/aula/${uid}`);
});

/* ---------------- certificado ---------------- */

// código verificável sem tabela nova: id do aluno em base36 + assinatura curta
async function codigoCertificado(escola: string, alunoId: number): Promise<string> {
  const dados = new TextEncoder().encode(`${escola}:${alunoId}:certificado-v1`);
  const hash = await crypto.subtle.digest("SHA-256", dados);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${alunoId.toString(36)}-${hex.slice(0, 6)}`.toUpperCase();
}

async function alunoDoCodigo(escola: string, codigo: string): Promise<number | null> {
  const [parte, ass] = String(codigo || "").toLowerCase().split("-");
  const id = parseInt(parte ?? "", 36);
  if (!Number.isInteger(id) || id <= 0 || !ass) return null;
  const esperado = await codigoCertificado(escola, id);
  return esperado.toLowerCase() === `${parte}-${ass}` ? id : null;
}

const dataLonga = (seg: number) =>
  new Date(seg * 1000).toLocaleDateString("pt-BR", {
    day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

// hora-aula = 60 min por padrão. Se a convenção da escola for 45 ou 50,
// basta ajustar MINUTOS_HORA_AULA no wrangler.jsonc.
function horasAula(segundos: number, minutosPorHoraAula: number): number {
  const min = segundos / 60;
  return Math.max(1, Math.round(min / (minutosPorHoraAula || 60)));
}

const plural = (n: number, um: string, muitos: string) => `${n} ${n === 1 ? um : muitos}`;

function folhaCertificado(o: {
  escola: string; nome: string; modulos: number; aulas: number;
  horas: number; carga: string; concluidoEm: number; codigo: string; aproveitamento?: number | null;
}) {
  return `<div class="folha"><div class="folha-in">
    <div class="selo">${LOGO(60, M.marca, "#FFFFFF")}</div>
    <p class="mono">${esc(o.escola)}</p>
    <h1>Certificado de conclusão</h1>
    <p class="texto" style="margin-top:14px">Certificamos que</p>
    <p class="nome">${esc(o.nome)}</p>
    <p class="texto">
      concluiu integralmente o programa de formação, composto por
      ${plural(o.modulos, "módulo", "módulos")} e ${plural(o.aulas, "aula", "aulas")},
      com carga horária total de ${plural(o.horas, "hora-aula", "horas-aula")}${o.aproveitamento != null ? `, com aproveitamento de ${o.aproveitamento}% nas avaliações de módulo` : ""}.
    </p>
    <div class="rodape">
      <div><span class="mono">Módulos</span><b>${o.modulos}</b></div>
      <div><span class="mono">Carga horária</span><b>${plural(o.horas, "hora-aula", "horas-aula")}</b></div>
      ${o.aproveitamento != null ? `<div><span class="mono">Aproveitamento</span><b>${o.aproveitamento}%</b></div>` : ""}
      <div><span class="mono">Conclusão</span><b>${esc(dataLonga(o.concluidoEm))}</b></div>
      <div><span class="mono">Código de validação</span><b>${esc(o.codigo)}</b></div>
    </div>
  </div></div>`;
}

app.get("/app/certificado", exigeLogin, async (c) => {
  const aluno = c.get("aluno");
  const [aulas, cert] = await Promise.all([aulasComProgresso(c, aluno.id), provasParaCertificado(c.env, aluno.id)]);
  const total = aulas.length;
  const feitas = aulas.filter((a) => a.concluida_em).length;

  if (!total || feitas < total || cert.pendentes.length) {
    const faltaProva = total && feitas >= total;
    const corpo = `<main class="wrap" style="padding:70px 24px">
      <div class="card centro" style="text-align:center">
        <p class="mono">Certificado</p>
        <h2 style="margin:12px 0 10px">${faltaProva ? "Falta a aprovação nas provas" : "Ainda falta concluir o curso"}</h2>
        <p style="color:var(--muted);margin-bottom:22px">
          ${faltaProva ? `As aulas estão concluídas. O certificado sai com a aprovação na${cert.pendentes.length === 1 ? "" : "s"} prova${cert.pendentes.length === 1 ? "" : "s"} de ${esc(cert.pendentes.join(", "))}.`
            : `Você concluiu ${feitas} de ${total} aulas. O certificado é liberado ao completar todas${cert.exige && cert.publicadas.length ? " e ser aprovado nas provas de módulo" : ""}.`}
        </p>
        ${faltaProva ? cert.pendentes.map((m) => `<a class="btn btn-primario" href="/app/prova/${encodeURIComponent(m)}" style="margin:4px">Prova: ${esc(m)}</a>`).join("")
          : `<a class="btn btn-primario" href="/app">Voltar ao programa</a>`}
      </div></main>`;
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Certificado", aluno, corpo }));
  }

  const codigo = await codigoCertificado(c.env.ESCOLA, aluno.id);
  const concluidoEm = Math.max(...aulas.map((a) => a.concluida_em ?? 0));
  const segundos = aulas.reduce((s, a) => s + a.duracao_seg, 0);
  const url = new URL(c.req.url);

  const corpo = `<main class="wrap" style="padding:34px 24px 10px">
    ${folhaCertificado({
      escola: c.env.NOME_ESCOLA,
      nome: aluno.nome || aluno.email,
      modulos: new Set(aulas.map((a) => a.modulo)).size,
      aulas: total,
      horas: horasAula(segundos, Number(c.env.MINUTOS_HORA_AULA ?? 60)),
      carga: duracao(segundos),
      concluidoEm,
      codigo,
      aproveitamento: cert.aproveitamento,
    })}
    <div class="so-tela">
      <button class="btn btn-primario" onclick="window.print()">Imprimir / salvar em PDF</button>
      <a class="btn btn-fantasma" href="/app">Voltar ao programa</a>
    </div>
    <p class="mono so-tela" style="justify-content:center;margin-top:14px">
      Validação pública: ${esc(url.origin)}/certificado/${esc(codigo)}
    </p>
  </main>`;

  return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Certificado", aluno, corpo }));
});

// validação pública — confere o código sem expor e-mail do aluno
app.get("/certificado/:codigo", async (c) => {
  const codigo = c.req.param("codigo");
  const id = await alunoDoCodigo(c.env.ESCOLA, codigo);

  const invalido = `<main class="wrap" style="padding:70px 24px">
    <div class="card centro" style="text-align:center">
      <p class="mono">Validação de certificado</p>
      <h2 style="margin:12px 0 10px">Código não encontrado</h2>
      <p style="color:var(--muted)">Confira o código impresso no certificado.</p>
    </div></main>`;

  if (!id) {
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Validação", corpo: invalido }), 404);
  }

  const dados: any = await c.env.DB.prepare(
    `SELECT a.nome, a.email FROM alunos a
     JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
     WHERE a.id = ?`
  ).bind(c.env.ESCOLA, id).first();
  if (!dados) {
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Validação", corpo: invalido }), 404);
  }

  // mesma leitura do painel e do certificado do aluno — módulos e carga
  // horária batem entre as três telas
  const [aulas, cert] = await Promise.all([aulasComProgresso(c, id), provasParaCertificado(c.env, id)]);
  const total = aulas.length;
  const feitas = aulas.filter((a) => a.concluida_em).length;
  if (!total || feitas < total || cert.pendentes.length) {
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Validação", corpo: invalido }), 404);
  }
  const segundos = aulas.reduce((s, a) => s + a.duracao_seg, 0);

  const corpo = `<main class="wrap" style="padding:34px 24px 10px">
    <div class="centro" style="max-width:520px;text-align:center;margin-bottom:26px">
      <p class="mono">Validação de certificado</p>
      <h2 style="margin:10px 0">Certificado autêntico</h2>
      <p style="color:var(--muted)">Emitido por ${esc(c.env.NOME_ESCOLA)}.</p>
    </div>
    ${folhaCertificado({
      escola: c.env.NOME_ESCOLA,
      nome: dados.nome || String(dados.email).replace(/(.).*(@.*)/, "$1•••$2"),
      modulos: new Set(aulas.map((a) => a.modulo)).size,
      aulas: total,
      horas: horasAula(segundos, Number(c.env.MINUTOS_HORA_AULA ?? 60)),
      carga: duracao(segundos),
      concluidoEm: Math.max(...aulas.map((a) => a.concluida_em ?? 0)),
      codigo: codigo.toUpperCase(),
      aproveitamento: cert.aproveitamento,
    })}
  </main>`;

  return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Validação", corpo }));
});

/* ---------------- relatório de progresso ---------------- */

app.post("/app/relatorio", exigeLogin, async (c) => {
  const aluno = c.get("aluno");
  const aulas = await aulasComProgresso(c, aluno.id);

  const total = aulas.length;
  const feitas = aulas.filter((a) => a.concluida_em).length;
  const pct = total ? Math.round((feitas / total) * 100) : 0;

  // só gera se 100% completo (e aprovado nas provas, quando exigidas)
  if (pct !== 100) {
    return c.text("Relatório disponível apenas ao completar 100% do curso.", 400);
  }
  if ((await provasParaCertificado(c.env, aluno.id)).pendentes.length) {
    return c.text("Relatório disponível após a aprovação nas provas de módulo.", 400);
  }

  // agrupar por módulo
  const modulos = new Map<string, LinhaAula[]>();
  for (const a of aulas) {
    if (!modulos.has(a.modulo)) modulos.set(a.modulo, []);
    modulos.get(a.modulo)!.push(a);
  }

  // calcular estatísticas por módulo
  const modulosStats = [...modulos.entries()].map(([nome, lista]) => {
    const completas = lista.filter((a) => a.concluida_em).length;
    const tempoTotal = lista.reduce((s, a) => s + a.duracao_seg, 0);
    const pct = lista.length > 0 ? Math.round((completas / lista.length) * 100) : 0;
    return {
      nome,
      total: lista.length,
      completas,
      pct,
      tempoTotal,
      aulas: lista,
    };
  });

  // tópicos dominados (100% completo)
  const dominados = modulosStats.filter((m) => m.pct === 100);

  // lacunas (< 100% completo)
  const lacunas = modulosStats.filter((m) => m.pct < 100);

  // tempo total investido em aulas completas
  const tempoTotalInvestido = aulas
    .filter((a) => a.concluida_em)
    .reduce((s, a) => s + a.duracao_seg, 0);

  // formatar duração
  const formatarDuracao = (seg: number) => {
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  };

  // certificado correspondente
  const codigo = await codigoCertificado(c.env.ESCOLA, aluno.id);
  const linkCertificado = `${new URL(c.req.url).origin}/certificado/${codigo}`;

  // gerar HTML do relatório
  const reportHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório de Progresso</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
    .header { background: linear-gradient(135deg, #1F1BE4 0%, #7C3AED 100%); color: #fff; padding: 40px; border-radius: 8px; text-align: center; margin-bottom: 30px; }
    .header h1 { margin: 0 0 10px; font-size: 28px; }
    .header p { margin: 0; opacity: 0.9; }
    .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-bottom: 30px; }
    .stat-box { background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; }
    .stat-box .label { font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: 0.1em; }
    .stat-box .value { font-size: 32px; font-weight: bold; color: #1F1BE4; margin-top: 8px; }
    .section { margin-bottom: 30px; }
    .section h2 { color: #1F1BE4; font-size: 18px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #FAE047; }
    .section-list { list-style: none; padding: 0; }
    .section-list li { padding: 12px; background: #f9f9f9; margin-bottom: 8px; border-radius: 4px; border-left: 4px solid #1F1BE4; }
    .section-list li .title { font-weight: 600; margin-bottom: 4px; }
    .section-list li .meta { font-size: 12px; color: #999; }
    .empty { color: #999; font-style: italic; }
    .footer { text-align: center; color: #999; font-size: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; }
    .progress-bar { width: 100%; height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; margin-top: 8px; }
    .progress-fill { height: 100%; background: #4CAF50; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Relatório de Progresso</h1>
      <p>${esc(c.env.NOME_ESCOLA)}</p>
    </div>

    <div class="stats">
      <div class="stat-box">
        <div class="label">Taxa de Conclusão</div>
        <div class="value">${pct}%</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="stat-box">
        <div class="label">Aulas Completadas</div>
        <div class="value">${feitas}/${total}</div>
      </div>
      <div class="stat-box">
        <div class="label">Tempo Investido</div>
        <div class="value">${formatarDuracao(tempoTotalInvestido)}</div>
      </div>
    </div>

    ${dominados.length > 0 ? `
    <div class="section">
      <h2>✅ Tópicos Dominados</h2>
      <ul class="section-list">
        ${dominados.map((m) => `
          <li>
            <div class="title">${esc(m.nome)}</div>
            <div class="meta">${m.completas} aulas · ${formatarDuracao(m.tempoTotal)}</div>
          </li>
        `).join("")}
      </ul>
    </div>
    ` : ""}

    ${lacunas.length > 0 ? `
    <div class="section">
      <h2>🎯 Próximas Metas</h2>
      <ul class="section-list">
        ${lacunas.map((m) => `
          <li>
            <div class="title">${esc(m.nome)}</div>
            <div class="meta">${m.completas}/${m.total} aulas completas (${m.pct}%) · ${formatarDuracao(m.tempoTotal)}</div>
            <div class="progress-bar"><div class="progress-fill" style="background:#FF9800;width:${m.pct}%"></div></div>
          </li>
        `).join("")}
      </ul>
    </div>
    ` : ""}

    <div class="section">
      <h2>💡 Recomendações</h2>
      <ul class="section-list">
        <li>
          <div class="title">Parabéns! 🎉</div>
          <div class="meta">Você completou com sucesso ${pct}% do programa. Continue acompanhando novos conteúdos e revisitando tópicos importantes.</div>
        </li>
        <li>
          <div class="title">Próximos Passos</div>
          <div class="meta">Explore recursos adicionais e coloque em prática o conhecimento adquirido. Boa sorte nos seus projetos!</div>
        </li>
      </ul>
    </div>

    <div class="section" style="text-align:center">
      <a href="${linkCertificado}" style="display:inline-block;background:#1F1BE4;color:#fff;
         font-weight:700;padding:14px 28px;border-radius:5px;text-decoration:none;font-size:15px">
        Ver meu certificado
      </a>
      <p style="font-size:12px;color:#999;margin-top:10px">Código de validação: ${esc(codigo)}</p>
    </div>

    <div class="footer">
      <p>Relatório gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}</p>
      <p>${esc(aluno.email)}</p>
    </div>
  </div>
</body>
</html>`;

  // enviar por email
  await c.env.EMAIL.send({
    to: aluno.email,
    from: c.env.EMAIL_REMETENTE,
    subject: `Seu relatório de progresso — ${c.env.NOME_ESCOLA}`,
    text: `Parabéns! Você concluiu ${pct}% do curso ${c.env.NOME_ESCOLA}.\n`
      + `Tempo investido: ${formatarDuracao(tempoTotalInvestido)} em ${feitas} aulas.\n\n`
      + `Certificado: ${linkCertificado}\nCódigo de validação: ${codigo}`,
    html: reportHtml,
  });

  // página de confirmação
  const corpo = `<main class="wrap" style="padding:80px 24px;text-align:center">
    <div class="card" style="max-width:500px;margin:0 auto">
      <h1 style="font-size:48px;margin:0">✅</h1>
      <h2 style="margin:16px 0 12px">Relatório enviado</h2>
      <p style="color:var(--muted);margin-bottom:24px">
        Um relatório completo do seu progresso foi enviado para<br><strong>${esc(aluno.email)}</strong>
      </p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
        <a class="btn btn-primario" href="/app/certificado">Ver certificado</a>
        <a class="btn btn-fantasma" href="/app">Voltar ao programa</a>
      </div>
    </div>
  </main>`;

  return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Relatório enviado", aluno, corpo }));
});

/* ---------------- administração ---------------- */

// ADMINS do wrangler.jsonc + tabela administradores (aba Equipe do painel)
const ehAdmin = (c: any, aluno: Aluno) => ehAdminEquipe(c.env, aluno.email);

const exigeAdmin = async (c: any, next: any) => {
  const aluno = await alunoDaSessao(c);
  if (!aluno || !(await ehAdmin(c, aluno))) return c.text("Sem permissão", 403);
  c.set("aluno", aluno);
  await next();
};


// Traz do Stream tudo que existe e reclassifica o que já estava. Idempotente:
// roda pelo botão do painel e pelo cron (triggers.crons no wrangler.jsonc),
// então vídeo novo aparece sozinho e regra nova de módulo se aplica sozinha.
async function sincronizarStream(env: Env): Promise<number> {
  const lista = await env.STREAM.videos.list({ limit: 1000 });
  const videos: any[] = Array.isArray(lista) ? lista : (lista?.result ?? lista?.videos ?? []);

  const stmts = videos
    .filter((v) => v?.id || v?.uid)
    .map((v) => {
      const uid = v.id ?? v.uid;
      const titulo = v.meta?.name || v.meta?.filename || uid;
      const { modulo, parte } = classificar(titulo, uid, regrasDoEnv(env));
      return env.DB.prepare(
        `INSERT INTO aulas (uid, titulo, modulo, parte, ordem, duracao_seg, thumbnail, publicada, criada_em)
         VALUES (?,?,?,?,?,?,?,1,?)
         ON CONFLICT(uid) DO UPDATE SET
           titulo = excluded.titulo, modulo = excluded.modulo,
           parte = excluded.parte, ordem = excluded.ordem,
           duracao_seg = excluded.duracao_seg, thumbnail = excluded.thumbnail,
           criada_em = excluded.criada_em`
      ).bind(
        uid, titulo, modulo, parte, parte,
        Math.round(v.duration ?? 0), v.thumbnail ?? null,
        // data de publicação no Stream (ISO) — vira a ordem dentro do módulo
        Math.round(Date.parse(v.created ?? v.uploaded ?? "") / 1000) || agora()
      );
    });

  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

app.post("/admin/sincronizar", exigeAdmin, async (c) => {
  await sincronizarStream(c.env);
  return c.redirect("/admin");
});

app.route("/", rotasLeituras({ exigeLogin, exigeAdmin, agora }));
app.route("/", rotasAdmin({ exigeAdmin, agora, aulasComProgresso, codigoCertificado }));
app.route("/", rotasFunil({ exigeAdmin, agora }));
app.route("/", rotasTranscricao({ exigeAdmin, agora }));
app.route("/", rotasCortes({ exigeAdmin, agora }));
app.route("/", rotasDesempenho({ exigeLogin, agora }));
app.route("/", rotasProvas({ exigeLogin, exigeAdmin, agora, aulasComProgresso }));
app.route("/", rotasEquipe({ exigeAdmin, agora }));
app.route("/", rotasNoticias({ exigeAdmin, agora }));

export default {
  fetch: app.fetch,
  scheduled: (_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(Promise.all([sincronizarStream(env), garantirTabelasLeituras(env), garantirEsquemaFunil(env)])
      // transcrições: o que veio no repositório entra no banco; vídeo novo segue o pipeline do Deepgram
      .then(() => garantirTabelasTranscricao(env)).then(() => semearDoBundle(env, agora()))
      .then(() => avancarTranscricoes(env, agora()))
      // vetores para a busca por significado (só com MODELOS_API_KEY)
      .then(() => avancarVetores(env, agora()))
      // notícias "No radar": coleta ~1x/h + triagem por IA do que chegou
      .then(() => atualizarNoticias(env, agora())).catch((e) => console.error("transcrições:", e))),
};
export type { Env, Aluno };
