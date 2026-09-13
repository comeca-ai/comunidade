// Notícias: "No radar" — o que está acontecendo em IA, empreendedorismo e
// estratégia, abaixo das aulas. O fluxo em três passos:
//
//   1. coleta: o cron busca os feeds RSS/Atom das FONTES (título, link,
//      resumo do próprio feed, data) e grava em `noticias`. Só metadados e
//      link com crédito — o texto integral fica na fonte, como o RSS prevê;
//   2. triagem por IA: cada item novo é classificado nos temas da escola
//      (MODELOS_* quando há chave; senão Workers AI; senão fica "geral").
//      O que não é de nenhum tema morre como "fora" e não aparece a ninguém;
//   3. curadoria: a aba Notícias do painel mostra o que passou na triagem e
//      o admin aprova ou oculta. Só o aprovado aparece no /app.
//
// Fontes são código (versionadas) — mudar a lista é um PR, não um ajuste.

import { Hono } from "hono";
import { esc } from "./ui";
import { haQuanto, dataCurta } from "./apoio";
import { temModelos, conversar } from "./modelos";

export const TEMAS = ["inteligência artificial", "empreendedorismo", "estratégia"];

const FONTES: { nome: string; url: string }[] = [
  { nome: "MIT Technology Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { nome: "The Verge · IA", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { nome: "Ars Technica · IA", url: "https://arstechnica.com/ai/feed/" },
  { nome: "NeoFeed", url: "https://neofeed.com.br/feed/" },
  { nome: "Brazil Journal", url: "https://braziljournal.com/feed/" },
  { nome: "Startups.com.br", url: "https://startups.com.br/feed/" },
  { nome: "Exame", url: "https://exame.com/feed/" },
];

const POR_FONTE = 10;          // itens mais recentes considerados por feed
const DIAS_VALIDADE = 21;      // notícia mais velha que isso não entra
const LOTE_TRIAGEM = 12;       // itens classificados por passada (cron ou botão)
const INTERVALO_COLETA = 55 * 60; // o cron roda a cada 15 min; os feeds, ~1x/h

let esquemaOk = false;
export async function garantirTabelaNoticias(env: any) {
  if (esquemaOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS noticias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escola TEXT NOT NULL, fonte TEXT NOT NULL, url TEXT NOT NULL,
    titulo TEXT NOT NULL, resumo TEXT, tema TEXT,
    publicada_em INTEGER, coletada_em INTEGER NOT NULL,
    estado TEXT NOT NULL DEFAULT 'nova',  -- nova → pendente | fora → aprovada | oculta
    avaliada_por TEXT, avaliada_em INTEGER,
    UNIQUE (escola, url))`).run();
  esquemaOk = true;
}

/* ---------------- coleta ---------------- */

// RSS 2.0 e Atom sem parser de XML: os feeds reais dessas fontes são
// regulares o bastante para extração por padrão, e um item malformado é
// simplesmente pulado — nunca derruba a coleta.
type Item = { titulo: string; url: string; resumo: string; publicada_em: number | null };

const semTags = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const entidades = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/&nbsp;/g, " ");
const campo = (bloco: string, tag: string) => {
  const m = bloco.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? entidades(semTags(m[1])) : "";
};

export function itensDoFeed(xml: string): Item[] {
  const blocos = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const itens: Item[] = [];
  for (const b of blocos.slice(0, POR_FONTE)) {
    const titulo = campo(b, "title").slice(0, 300);
    // RSS: <link>url</link> · Atom: <link href="url"/> (o alternate, quando marcado)
    let url = campo(b, "link");
    if (!/^https?:\/\//.test(url)) {
      const href = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = href ? entidades(href[1]) : "";
    }
    const data = campo(b, "pubDate") || campo(b, "published") || campo(b, "updated") || campo(b, "dc:date");
    const seg = Math.round(Date.parse(data) / 1000);
    const resumo = (campo(b, "description") || campo(b, "summary") || campo(b, "content")).slice(0, 500);
    if (titulo && /^https?:\/\//.test(url)) itens.push({ titulo, url, resumo, publicada_em: Number.isFinite(seg) ? seg : null });
  }
  return itens;
}

async function coletarFonte(env: any, fonte: { nome: string; url: string }, agora: number): Promise<number> {
  const r = await fetch(fonte.url, {
    headers: { "user-agent": "Mozilla/5.0 (comunidade.comeca.ai leitor RSS)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`${fonte.nome}: HTTP ${r.status}`);
  const itens = itensDoFeed(await r.text())
    .filter((i) => !i.publicada_em || agora - i.publicada_em < DIAS_VALIDADE * 86400);
  if (!itens.length) return 0;
  const stmts = itens.map((i) => env.DB.prepare(
    `INSERT OR IGNORE INTO noticias (escola, fonte, url, titulo, resumo, publicada_em, coletada_em)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(env.ESCOLA, fonte.nome, i.url, i.titulo, i.resumo || null, i.publicada_em, agora));
  const res = await env.DB.batch(stmts);
  return res.reduce((s: number, x: any) => s + (x?.meta?.changes ?? 0), 0);
}

/* ---------------- triagem por IA ---------------- */

const PROMPT_TRIAGEM = `Você tria notícias para os alunos de uma escola de IA para gestores e empreendedores brasileiros.
Os temas que interessam: (1) inteligência artificial, (2) empreendedorismo, (3) estratégia de negócios.
Para cada notícia numerada, responda com uma linha no formato:
N|tema|resumo
onde tema é "ia", "empreendedorismo", "estrategia" ou "fora" (não é de nenhum tema, é fofoca, esporte, política partidária ou irrelevante para quem estuda IA e negócios), e resumo é UMA frase em português (máx. 160 caracteres) dizendo o que aconteceu e por que importa. Para "fora", deixe o resumo vazio.
Responda só as linhas, sem mais nada.`;

const TEMA_ROTULO: Record<string, string> = { ia: "IA", empreendedorismo: "Empreendedorismo", estrategia: "Estratégia" };

async function classificarLote(env: any, itens: { id: number; fonte: string; titulo: string; resumo: string | null }[]): Promise<Map<number, { tema: string; resumo: string }>> {
  const lista = itens.map((i, n) => `${n + 1}. [${i.fonte}] ${i.titulo}${i.resumo ? ` — ${i.resumo.slice(0, 200)}` : ""}`).join("\n");
  let texto = "";
  if (temModelos(env)) {
    texto = await conversar(env, { sistema: PROMPT_TRIAGEM, usuario: lista, maxTokens: 1800 });
  } else if (env.AI) {
    const r: any = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "system", content: PROMPT_TRIAGEM }, { role: "user", content: lista }], max_tokens: 1800,
    });
    texto = String(r?.response ?? "");
  } else {
    // sem modelo nenhum: tudo vira "geral" e o admin decide sozinho
    return new Map(itens.map((i, n) => [n + 1, { tema: "geral", resumo: "" }]));
  }
  const out = new Map<number, { tema: string; resumo: string }>();
  for (const linha of texto.split("\n")) {
    const m = linha.match(/^\s*(\d+)\s*\|\s*(ia|empreendedorismo|estrategia|fora)\s*\|?\s*(.*)$/i);
    if (m) out.set(Number(m[1]), { tema: m[2].toLowerCase(), resumo: m[3].trim().slice(0, 200) });
  }
  return out;
}

async function triarNovas(env: any, agora: number): Promise<number> {
  const r: any = await env.DB.prepare(
    `SELECT id, fonte, titulo, resumo FROM noticias WHERE escola = ? AND estado = 'nova'
     ORDER BY publicada_em DESC LIMIT ?`).bind(env.ESCOLA, LOTE_TRIAGEM).all();
  const itens: any[] = r.results ?? [];
  if (!itens.length) return 0;
  let veredito: Map<number, { tema: string; resumo: string }>;
  try { veredito = await classificarLote(env, itens); }
  catch (e) { console.error("triagem de notícias:", e); return 0; }
  const stmts = itens.map((i, n) => {
    const v = veredito.get(n + 1);
    // sem veredito legível o item fica "nova" e tenta de novo na próxima passada
    if (!v) return null;
    const fora = v.tema === "fora";
    return env.DB.prepare(`UPDATE noticias SET estado = ?, tema = ?, resumo = COALESCE(NULLIF(?, ''), resumo) WHERE id = ?`)
      .bind(fora ? "fora" : "pendente", fora ? null : v.tema, v.resumo, i.id);
  }).filter(Boolean);
  if (stmts.length) await env.DB.batch(stmts as any[]);
  return stmts.length;
}

// chamada pelo cron (a cada 15 min) e pelo botão do painel; os feeds só são
// buscados quando a última coleta tem mais de INTERVALO_COLETA
export async function atualizarNoticias(env: any, agora: number, forcar = false): Promise<{ novas: number; triadas: number }> {
  await garantirTabelaNoticias(env);
  let novas = 0;
  const ult: any = await env.DB.prepare(`SELECT MAX(coletada_em) m FROM noticias WHERE escola = ?`).bind(env.ESCOLA).first();
  if (forcar || !ult?.m || agora - Number(ult.m) > INTERVALO_COLETA) {
    const rs = await Promise.allSettled(FONTES.map((f) => coletarFonte(env, f, agora)));
    for (const x of rs) {
      if (x.status === "fulfilled") novas += x.value;
      else console.error("coleta de notícias:", x.reason?.message ?? x.reason);
    }
  }
  const triadas = await triarNovas(env, agora);
  return { novas, triadas };
}

/* ---------------- exibição ---------------- */

export type Noticia = { id: number; fonte: string; url: string; titulo: string; resumo: string | null; tema: string | null; publicada_em: number | null; estado: string };

export async function noticiasAprovadas(env: any, limite = 9): Promise<Noticia[]> {
  try {
    await garantirTabelaNoticias(env);
    const r: any = await env.DB.prepare(
      `SELECT id, fonte, url, titulo, resumo, tema, publicada_em, estado FROM noticias
       WHERE escola = ? AND estado = 'aprovada'
       ORDER BY COALESCE(publicada_em, coletada_em) DESC LIMIT ?`).bind(env.ESCOLA, limite).all();
    return r.results ?? [];
  } catch { return []; }
}

const rotuloTema = (t: string | null) => (t && TEMA_ROTULO[t]) || null;

// bloco "No radar" na jornada do aluno — só links com crédito; abre na fonte
export function secaoNoticias(itens: Noticia[], agora: number): string {
  if (!itens.length) return "";
  return `<section class="modulo" id="noticias">
    <div class="modulo-topo"><h2>No radar</h2><span class="mono">IA e negócios</span></div>
    <p class="aula-meta" style="margin:-6px 0 8px">O que está acontecendo lá fora, escolhido pela equipe. Cada link abre na fonte.</p>
    ${itens.map((i) => `<a class="aula" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">
      <span class="check">↗</span>
      <span class="aula-txt"><b>${esc(i.titulo)}</b>
        ${i.resumo ? `<span class="aula-meta">${esc(i.resumo)}</span>` : ""}
        <span class="aula-meta">${esc(i.fonte)}${rotuloTema(i.tema) ? ` · ${rotuloTema(i.tema)}` : ""}${i.publicada_em ? ` · ${haQuanto(i.publicada_em, agora)}` : ""}</span></span>
    </a>`).join("")}
  </section>`;
}

/* ---------------- painel ---------------- */

export async function noticiasParaAdmin(env: any): Promise<{ pendentes: Noticia[]; aprovadas: Noticia[]; novas: number }> {
  await garantirTabelaNoticias(env);
  const [p, a, n] = await Promise.all([
    env.DB.prepare(`SELECT id, fonte, url, titulo, resumo, tema, publicada_em, estado FROM noticias
      WHERE escola = ? AND estado = 'pendente' ORDER BY COALESCE(publicada_em, coletada_em) DESC LIMIT 60`).bind(env.ESCOLA).all(),
    env.DB.prepare(`SELECT id, fonte, url, titulo, resumo, tema, publicada_em, estado FROM noticias
      WHERE escola = ? AND estado = 'aprovada' ORDER BY COALESCE(publicada_em, coletada_em) DESC LIMIT 30`).bind(env.ESCOLA).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM noticias WHERE escola = ? AND estado = 'nova'`).bind(env.ESCOLA).first(),
  ]);
  return { pendentes: p.results ?? [], aprovadas: a.results ?? [], novas: Number(n?.n ?? 0) };
}

const linhaAdmin = (i: Noticia, agora: number, acoes: string) => `<div class="aula" style="cursor:default">
  <span class="check">${i.estado === "aprovada" ? "✓" : "•"}</span>
  <span class="aula-txt"><b><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.titulo)}</a></b>
    ${i.resumo ? `<span class="aula-meta">${esc(i.resumo)}</span>` : ""}
    <span class="aula-meta">${esc(i.fonte)}${rotuloTema(i.tema) ? ` · ${rotuloTema(i.tema)}` : ""}${i.publicada_em ? ` · ${dataCurta(i.publicada_em)}` : ""}</span></span>
  <div style="display:flex;gap:8px;flex:0 0 auto">${acoes}</div>
</div>`;

const botao = (acao: string, id: number, rotulo: string, primario = false) =>
  `<form method="post" action="/admin/noticias/${acao}"><input type="hidden" name="id" value="${id}">
   <button class="btn ${primario ? "btn-primario" : "btn-fantasma"}" type="submit">${rotulo}</button></form>`;

export function secaoNoticiasAdmin(o: { pendentes: Noticia[]; aprovadas: Noticia[]; novas: number; agora: number; aviso?: string }): string {
  return `${o.aviso || ""}
  <div class="card">
    <p class="mono">No radar</p>
    <p style="margin-top:8px;color:var(--muted);max-width:70ch">Notícias de IA, empreendedorismo e estratégia coletadas dos feeds das fontes
      e triadas por IA. O que você aprovar aparece para o aluno no fim da jornada, como link para a fonte.
      Fontes: ${FONTES.map((f) => esc(f.nome)).join(" · ")}.</p>
    <form method="post" action="/admin/noticias/atualizar" style="margin-top:14px">
      <button class="btn btn-fantasma" type="submit">Buscar e triar agora</button>
      ${o.novas ? `<span class="aula-meta" style="margin-left:10px">${o.novas} coletada${o.novas === 1 ? "" : "s"} aguardando triagem</span>` : ""}
    </form>
  </div>
  <section class="modulo">
    <div class="modulo-topo"><h2>Para revisar</h2><span class="mono">${o.pendentes.length}</span></div>
    ${o.pendentes.length
      ? o.pendentes.map((i) => linhaAdmin(i, o.agora, botao("aprovar", i.id, "Aprovar", true) + botao("ocultar", i.id, "Ocultar"))).join("")
      : `<p class="vazio">Nada para revisar. As fontes são checadas a cada hora.</p>`}
  </section>
  <section class="modulo">
    <div class="modulo-topo"><h2>No ar para os alunos</h2><span class="mono">${o.aprovadas.length}</span></div>
    ${o.aprovadas.length
      ? o.aprovadas.map((i) => linhaAdmin(i, o.agora, botao("ocultar", i.id, "Tirar do ar"))).join("")
      : `<p class="vazio">Nenhuma notícia aprovada ainda.</p>`}
  </section>`;
}

type Deps = { exigeAdmin: any; agora: () => number };

export function rotasNoticias(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();
  const volta = (c: any, msg: string) => c.redirect(`/admin?noticias=${encodeURIComponent(msg)}#noticias`);

  r.post("/admin/noticias/atualizar", d.exigeAdmin, async (c) => {
    const { novas, triadas } = await atualizarNoticias(c.env, d.agora(), true);
    return volta(c, `${novas} nova${novas === 1 ? "" : "s"} coletada${novas === 1 ? "" : "s"} · ${triadas} triada${triadas === 1 ? "" : "s"}.`);
  });

  const mudar = (estado: string, msg: string) => async (c: any) => {
    const eu = c.get("aluno");
    const form = await c.req.formData();
    const id = Number(form.get("id"));
    if (!Number.isInteger(id)) return volta(c, "Notícia não encontrada.");
    await garantirTabelaNoticias(c.env);
    await c.env.DB.prepare(`UPDATE noticias SET estado = ?, avaliada_por = ?, avaliada_em = ? WHERE id = ? AND escola = ?`)
      .bind(estado, String(eu.email).toLowerCase(), d.agora(), id, c.env.ESCOLA).run();
    return volta(c, msg);
  };
  r.post("/admin/noticias/aprovar", d.exigeAdmin, mudar("aprovada", "Notícia no ar para os alunos."));
  r.post("/admin/noticias/ocultar", d.exigeAdmin, mudar("oculta", "Notícia fora do ar."));

  return r;
}
