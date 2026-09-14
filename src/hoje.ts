// Cockpit "Hoje" — a primeira tela do painel. Responde "o que precisa de mim
// agora" em três blocos, nesta ordem de peso: (1) briefing no topo, gerado por
// IA a partir dos números reais (com fallback determinístico quando não há
// modelo ou o texto guardado envelheceu); (2) fila de trabalho unificada —
// provas em rascunho, cortes sugeridos e notícias triadas, com aprovar/
// descartar inline; (3) os números, com hierarquia: o card em alerta domina,
// o vazio explica quando vai aparecer.
//
// Design aprovado no Claude Design (set/2026): editorial suíço, azul elétrico,
// amarelo (M.destaque) EXCLUSIVO do CTA principal dentro do briefing.

import { esc } from "./ui";
import { haQuanto, DIA, diaLocal } from "./apoio";
import { temModelos, conversar } from "./modelos";
import type { Noticia } from "./noticias";
import type { ResumoProva } from "./provas";

/* ---------------- fatos: a mesma fonte para o briefing e para a tela ---------------- */

// Números que o briefing comenta. Calculados com consultas próprias e leves
// para o cron poder gerar o texto sem carregar o painel inteiro; o hash diz
// se o texto guardado ainda descreve os dados de agora.
export type FatosHoje = {
  alunos: number; ativos: number; media: number; concluiram: number; totalAulas: number;
  nunca: number; nuncaAcordo: number;
  novos7d: number; entraram7d: number; concluidas7d: number; leituras7d: number; pedidos: number;
  etapas: number[];       // quantos estão em cada etapa do funil (0..4)
  provasRascunho: string[]; cortesSugeridos: number; noticiasPendentes: number; noticiasNovas: number;
  piorAula: { titulo: string; nao: number; n: number } | null;
};

export async function fatosHoje(env: any, agora: number): Promise<FatosHoje> {
  const d7 = agora - 7 * DIA;
  const [al, tot, mov, fila, ava] = await Promise.all([
    env.DB.prepare(
      `SELECT a.ultimo_acesso, m.criada_em AS matricula_em, m.consentiu_em,
         (SELECT COUNT(*) FROM progresso p JOIN aulas au ON au.uid = p.aula_uid
           WHERE p.aluno_id = a.id AND p.concluida_em IS NOT NULL AND au.publicada = 1) AS feitas,
         (SELECT COUNT(*) FROM links_magicos lm WHERE lm.email = a.email) AS links
       FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?`).bind(env.ESCOLA).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM aulas WHERE publicada = 1`).first(),
    Promise.all([
      env.DB.prepare(`SELECT COUNT(*) n FROM (SELECT aluno_id, MIN(dia) d FROM acessos GROUP BY aluno_id) WHERE d >= ?`)
        .bind(diaLocal(agora) - 7).first().catch(() => null),
      env.DB.prepare(`SELECT COUNT(*) n FROM progresso WHERE concluida_em >= ?`).bind(d7).first().catch(() => null),
      env.DB.prepare(`SELECT COUNT(*) n FROM artigos_lidos WHERE lido_em >= ?`).bind(d7).first().catch(() => null),
      env.DB.prepare(`SELECT COUNT(*) n FROM pedidos`).first().catch(() => null),
    ]),
    Promise.all([
      env.DB.prepare(`SELECT p.modulo FROM provas p WHERE p.estado = 'rascunho'
         AND (SELECT COUNT(*) FROM questoes q WHERE q.modulo = p.modulo AND q.ativa = 1) > 0`).all().catch(() => ({ results: [] })),
      env.DB.prepare(`SELECT COUNT(*) n FROM cortes WHERE estado = 'sugerido'`).first().catch(() => null),
      env.DB.prepare(`SELECT COUNT(*) n FROM noticias WHERE escola = ? AND estado = 'pendente'`).bind(env.ESCOLA).first().catch(() => null),
      env.DB.prepare(`SELECT COUNT(*) n FROM noticias WHERE escola = ? AND estado = 'nova'`).bind(env.ESCOLA).first().catch(() => null),
    ]),
    env.DB.prepare(
      `SELECT au.titulo, SUM(CASE WHEN av.nota < 0 THEN 1 ELSE 0 END) nao, COUNT(*) n
       FROM avaliacoes av JOIN aulas au ON au.uid = av.aula_uid
       GROUP BY av.aula_uid HAVING nao > 0 ORDER BY nao DESC, n DESC LIMIT 1`).first().catch(() => null),
  ]);
  const linhas: any[] = al.results ?? [];
  const totalAulas = Number(tot?.n ?? 0);
  const etapas = [0, 0, 0, 0, 0];
  let ativos = 0, nunca = 0, nuncaAcordo = 0, concluiram = 0, novos7d = 0, soma = 0;
  for (const a of linhas) {
    const feitas = Number(a.feitas);
    const etapa = totalAulas > 0 && feitas >= totalAulas ? 4 : feitas > 0 ? 3 : a.ultimo_acesso ? 2 : Number(a.links) ? 1 : 0;
    etapas[etapa]++;
    if (a.ultimo_acesso && agora - Number(a.ultimo_acesso) < 7 * DIA) ativos++;
    if (!a.ultimo_acesso) { nunca++; if (a.consentiu_em) nuncaAcordo++; }
    if (etapa === 4) concluiram++;
    if (Number(a.matricula_em) >= d7) novos7d++;
    if (totalAulas) soma += feitas / totalAulas;
  }
  const [ent, conc, leit, ped] = mov as any[];
  const [pr, co, np, nn] = fila as any[];
  return {
    alunos: linhas.length, ativos, concluiram, totalAulas,
    media: linhas.length && totalAulas ? Math.round(soma / linhas.length * 100) : 0,
    nunca, nuncaAcordo, novos7d,
    entraram7d: Number(ent?.n ?? 0), concluidas7d: Number(conc?.n ?? 0),
    leituras7d: Number(leit?.n ?? 0), pedidos: Number(ped?.n ?? 0), etapas,
    provasRascunho: (pr.results ?? []).map((x: any) => String(x.modulo)),
    cortesSugeridos: Number(co?.n ?? 0), noticiasPendentes: Number(np?.n ?? 0), noticiasNovas: Number(nn?.n ?? 0),
    piorAula: ava?.titulo ? { titulo: String(ava.titulo), nao: Number(ava.nao), n: Number(ava.n) } : null,
  };
}

// o hash ignora o que muda sozinho sem mudar a história (leituras, média):
// briefing guardado continua válido enquanto os fatos que ele cita não mudam
export const hashDosFatos = (f: FatosHoje) => [
  f.alunos, f.ativos, f.nunca, f.nuncaAcordo, f.concluiram, f.novos7d,
  f.provasRascunho.length, f.cortesSugeridos, f.noticiasPendentes,
  f.piorAula ? `${f.piorAula.titulo}:${f.piorAula.nao}` : "",
].join("|");

/* ---------------- briefing: determinístico sempre, IA quando há modelo ---------------- */

// frases construídas dos fatos — é o fallback e também o material que a IA
// reescreve. Sem invenção possível: tudo que a IA recebe está aqui.
export function frasesDosFatos(f: FatosHoje): string[] {
  const out: string[] = [];
  if (f.novos7d) out.push(`${f.novos7d} aluno${f.novos7d === 1 ? " novo entrou" : "s novos entraram"} esta semana.`);
  if (f.entraram7d) out.push(`${f.entraram7d} ${f.entraram7d === 1 ? "acessou" : "acessaram"} pela primeira vez nos últimos 7 dias.`);
  out.push(`${f.ativos} de ${f.alunos} aluno${f.alunos === 1 ? "" : "s"} ativos na semana.`);
  if (f.nunca) out.push(`${f.nunca} nunca ${f.nunca === 1 ? "abriu" : "abriram"} o link — ${f.nuncaAcordo ? `${f.nuncaAcordo} ${f.nuncaAcordo === 1 ? "tem" : "têm"} de acordo e ${f.nuncaAcordo === 1 ? "está pronto" : "estão prontos"} para o reenvio` : "nenhum tem de acordo ainda"}.`);
  if (f.piorAula) out.push(`A aula "${f.piorAula.titulo}" acumula ${f.piorAula.nao} avaliaç${f.piorAula.nao === 1 ? "ão" : "ões"} "não útil" em ${f.piorAula.n} e pede uma olhada.`);
  const fila: string[] = [];
  if (f.noticiasPendentes) fila.push(`${f.noticiasPendentes} notícia${f.noticiasPendentes === 1 ? "" : "s"} triada${f.noticiasPendentes === 1 ? "" : "s"}`);
  if (f.provasRascunho.length) fila.push(`${f.provasRascunho.length} prova${f.provasRascunho.length === 1 ? "" : "s"} em rascunho`);
  if (f.cortesSugeridos) fila.push(`${f.cortesSugeridos} corte${f.cortesSugeridos === 1 ? "" : "s"} sugerido${f.cortesSugeridos === 1 ? "" : "s"}`);
  if (fila.length) out.push(`Na fila: ${fila.join(", ")}.`);
  if (out.length <= 1 && !f.alunos) out.push("Nenhum aluno na base ainda — comece cadastrando a turma na aba Convidar.");
  return out;
}

const PROMPT_BRIEFING = `Você escreve o briefing do dia para o administrador de uma escola online de IA para gestores brasileiros.
Receberá fatos numerados sobre a escola. Reescreva-os como um parágrafo corrido de 2 a 4 frases em português do Brasil, direto e sem floreio, do mais urgente para o menos urgente.
Regras: use SOMENTE os fatos recebidos, sem inventar números nem causas; não use bullet points, markdown nem emojis; não cumprimente; máximo 420 caracteres.`;

let tabelaOk = false;
export async function garantirTabelaBriefing(env: any) {
  if (tabelaOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS briefing_hoje (
    escola TEXT PRIMARY KEY, texto TEXT NOT NULL, hash TEXT NOT NULL, gerado_em INTEGER NOT NULL)`).run();
  tabelaOk = true;
}

// chamada pelo cron: gera com IA quando os fatos mudaram desde o último texto.
// Sem modelo nenhum não grava nada — a tela usa o determinístico.
export async function atualizarBriefing(env: any, agora: number): Promise<boolean> {
  if (!temModelos(env) && !env.AI) return false;
  await garantirTabelaBriefing(env);
  const f = await fatosHoje(env, agora);
  const hash = hashDosFatos(f);
  const atual: any = await env.DB.prepare(`SELECT hash FROM briefing_hoje WHERE escola = ?`).bind(env.ESCOLA).first();
  if (atual?.hash === hash) return false;
  const fatos = frasesDosFatos(f).map((s, i) => `${i + 1}. ${s}`).join("\n");
  let texto = "";
  try {
    if (temModelos(env)) texto = await conversar(env, { sistema: PROMPT_BRIEFING, usuario: fatos, maxTokens: 400 });
    else {
      const r: any = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "system", content: PROMPT_BRIEFING }, { role: "user", content: fatos }], max_tokens: 400,
      });
      texto = String(r?.response ?? "");
    }
  } catch (e) { console.error("briefing:", e); return false; }
  texto = texto.trim().replace(/\s+/g, " ").slice(0, 600);
  if (texto.length < 40) return false;
  await env.DB.prepare(`INSERT INTO briefing_hoje (escola, texto, hash, gerado_em) VALUES (?,?,?,?)
    ON CONFLICT(escola) DO UPDATE SET texto = excluded.texto, hash = excluded.hash, gerado_em = excluded.gerado_em`)
    .bind(env.ESCOLA, texto, hash, agora).run();
  return true;
}

export type Briefing = { texto: string; ia: boolean; geradoEm: number | null };

// o texto guardado só aparece enquanto ainda descreve os dados de agora;
// mudou um fato, a tela volta ao determinístico até o cron regenerar
export async function briefingParaExibir(env: any, f: FatosHoje): Promise<Briefing> {
  try {
    await garantirTabelaBriefing(env);
    const g: any = await env.DB.prepare(`SELECT texto, hash, gerado_em FROM briefing_hoje WHERE escola = ?`).bind(env.ESCOLA).first();
    if (g?.texto && g.hash === hashDosFatos(f)) return { texto: String(g.texto), ia: true, geradoEm: Number(g.gerado_em) };
  } catch { /* tabela pode não existir ainda */ }
  return { texto: frasesDosFatos(f).join(" "), ia: false, geradoEm: null };
}

/* ---------------- a tela ---------------- */

const horaLocal = (seg: number) => {
  const d = new Date((seg - 3 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const dataHoje = (seg: number) => {
  const d = new Date((seg - 3 * 3600) * 1000);
  return `${DIAS_SEMANA[d.getUTCDay()]}, ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
};

// nota por etapa: quantos estão PARADOS ali (f.etapas[i]) e o que fazer
const ETAPAS_FUNIL = [
  { nome: "Cadastrado", nota: (f: FatosHoje) => { const n = f.etapas[0], sem = Math.min(n, f.nunca - f.nuncaAcordo);
      return n ? `↓ ${n} sem link enviado${sem ? ` · ${sem} sem de acordo — nada a enviar` : ""}` : ""; } },
  { nome: "Convidado", nota: (f: FatosHoje) => f.etapas[1] ? `↓ ${f.etapas[1]} ${f.etapas[1] === 1 ? "recebeu" : "receberam"} o link e não ${f.etapas[1] === 1 ? "abriu" : "abriram"}` : "" },
  { nome: "Entrou", nota: (f: FatosHoje) => f.etapas[2] ? `↓ ${f.etapas[2]} ${f.etapas[2] === 1 ? "entrou" : "entraram"} e não ${f.etapas[2] === 1 ? "concluiu" : "concluíram"} aula` : "" },
  { nome: "Assistindo", nota: () => "" },
  { nome: "Concluiu", nota: () => "" },
];

export function secaoHoje(o: {
  f: FatosHoje; briefing: Briefing; agora: number;
  provas: ResumoProva[]; cortes: any[]; noticias: Noticia[];
  alertas: number; alertasDe: number; retencao: number | null; terminam: number | null;
  aviso?: string;
}): string {
  const { f, agora } = o;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const filaTotal = f.noticiasPendentes + f.provasRascunho.length + f.cortesSugeridos;

  /* briefing */
  const briefingHtml = `<section class="hj-briefing" aria-label="Briefing do dia">
    <div class="hj-briefing-meta"><span class="mono">Briefing · ${dataHoje(agora)}${o.briefing.ia && o.briefing.geradoEm ? ` · gerado pela IA às ${horaLocal(o.briefing.geradoEm)}` : " · dos dados de agora"}</span></div>
    <p class="hj-briefing-txt">${esc(o.briefing.texto)}</p>
    <div class="hj-acoes">
      ${f.nuncaAcordo ? `<form method="post" action="/admin/convidar-pendentes"
          onsubmit="return confirm('Enviar link de entrada (48 h) para ${f.nuncaAcordo} aluno${f.nuncaAcordo === 1 ? "" : "s"} que nunca ${f.nuncaAcordo === 1 ? "entrou" : "entraram"}?')">
        <button class="btn hj-btn-destaque" type="submit">Reenviar link para os ${f.nuncaAcordo}</button></form>` : ""}
      ${filaTotal ? `<a class="btn hj-btn-vazado" href="#hoje-fila">Ir para a fila · ${filaTotal}</a>` : ""}
    </div>
  </section>`;

  /* fila de trabalho */
  const filaMeta: string[] = [];
  if (f.provasRascunho.length) filaMeta.push(`${f.provasRascunho.length} prova${f.provasRascunho.length === 1 ? "" : "s"}`);
  if (f.cortesSugeridos) filaMeta.push(`${f.cortesSugeridos} corte${f.cortesSugeridos === 1 ? "" : "s"}`);
  if (f.noticiasPendentes) filaMeta.push(`${f.noticiasPendentes} notícia${f.noticiasPendentes === 1 ? "" : "s"}`);

  const item = (rotulo: string, corpo: string, acoes: string) => `<div class="hj-item">
    <span class="mono hj-item-tipo">${rotulo}</span>
    <span class="hj-item-txt">${corpo}</span>
    <span class="hj-item-acoes">${acoes}</span>
  </div>`;

  const provasHtml = o.provas.map((p) => item("prova",
    `<b>Prova de ${esc(p.modulo)} — ${p.questoes} quest${p.questoes === 1 ? "ão" : "ões"} em rascunho</b>
     <span class="aula-meta">gerada ${p.gerada_em ? haQuanto(p.gerada_em, agora) : "pela IA"}${p.modelo ? ` por ${esc(p.modelo)}` : ""} · precisa de revisão antes de ir para os alunos</span>`,
    `<a class="btn btn-fantasma" href="/admin/provas/${encodeURIComponent(p.modulo)}">Revisar</a>
     <form method="post" action="/admin/provas/publicar"><input type="hidden" name="modulo" value="${esc(p.modulo)}">
       <input type="hidden" name="estado" value="publicada"><button class="btn btn-primario" type="submit">Publicar</button></form>`)).join("");

  const cortesHtml = o.cortes.map((c: any) => item("corte",
    `<b>&ldquo;${esc(c.titulo || c.pedido || "corte sem título")}&rdquo;</b>
     <span class="aula-meta">${c.aula_titulo ? `${esc(c.aula_titulo)} · ` : ""}${mmss(Number(c.inicio || 0))} → ${mmss(Number(c.fim || 0))} · ${Math.max(0, Math.round(Number(c.fim || 0) - Number(c.inicio || 0)))} s · sugerido pela IA ${haQuanto(Number(c.criado_em) || null, agora)}</span>`,
    `<form method="post" action="/admin/cortes/${c.id}/descartar" onsubmit="return confirm('Descartar este corte?')">
       <input type="hidden" name="volta" value="hoje"><button class="btn btn-fantasma" type="submit">Descartar</button></form>
     <form method="post" action="/admin/cortes/${c.id}/aprovar"><input type="hidden" name="volta" value="hoje">
       <button class="btn btn-primario" type="submit">Aprovar e gerar</button></form>`)).join("");

  const noticiasHtml = o.noticias.map((n) => item("notícia",
    `<b><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.titulo)}</a></b>
     <span class="aula-meta">${esc(n.fonte)}${n.tema ? ` · ${esc(n.tema === "ia" ? "IA" : n.tema === "estrategia" ? "Estratégia" : "Empreendedorismo")}` : ""}${n.publicada_em ? ` · ${haQuanto(n.publicada_em, agora)}` : ""}${n.resumo ? ` · ${esc(n.resumo)}` : ""}</span>`,
    `<form method="post" action="/admin/noticias/ocultar"><input type="hidden" name="id" value="${n.id}">
       <input type="hidden" name="volta" value="hoje"><button class="btn btn-fantasma" type="submit">Ocultar</button></form>
     <form method="post" action="/admin/noticias/aprovar"><input type="hidden" name="id" value="${n.id}">
       <input type="hidden" name="volta" value="hoje"><button class="btn btn-primario" type="submit">Aprovar</button></form>`)).join("");

  const resto = f.noticiasPendentes - o.noticias.length;
  const filaHtml = `<section class="modulo" id="hoje-fila">
    <div class="modulo-topo"><h2>Fila de trabalho</h2><span class="mono">${filaTotal ? `${filaTotal} it${filaTotal === 1 ? "em" : "ens"}${filaMeta.length ? ` · ${filaMeta.join(" · ")}` : ""}` : "vazia"}</span></div>
    ${provasHtml}${cortesHtml}${noticiasHtml}
    ${resto > 0 ? `<div class="hj-item hj-item-mais">
      <span class="mono hj-item-tipo">+${resto}</span>
      <span class="hj-item-txt"><span class="aula-meta">Mais ${resto} notícia${resto === 1 ? "" : "s"} triada${resto === 1 ? "" : "s"} esperando a sua curadoria. Aqui só as ${o.noticias.length} mais recentes.</span></span>
      <span class="hj-item-acoes"><a href="#noticias">Abrir Notícias →</a></span>
    </div>` : ""}
    ${!filaTotal ? `<p class="vazio">Nada esperando você. Provas geradas, cortes sugeridos e notícias triadas aparecem aqui.</p>` : ""}
  </section>`;

  /* os números */
  const nuncaCard = f.nunca
    ? `<div class="card stat hj-alerta"><p class="mono">Nunca entraram</p>
        <p class="num hj-num-alerta">${f.nunca}<span> de ${f.alunos}</span></p>
        <p class="aula-meta" style="margin-top:8px">${f.nuncaAcordo ? `${f.nuncaAcordo} com de acordo, prontos para o reenvio` : "nenhum com de acordo ainda"}${f.nunca > f.nuncaAcordo ? ` · ${f.nunca - f.nuncaAcordo} sem de acordo fica${f.nunca - f.nuncaAcordo === 1 ? "" : "m"} de fora` : ""}. Convite por WhatsApp não conta aqui.</p></div>`
    : `<div class="card stat"><p class="mono">Nunca entraram</p><p class="num">0</p>
        <p class="aula-meta" style="margin-top:8px">Todo mundo já abriu o link ao menos uma vez.</p></div>`;

  const alertaCard = o.alertasDe
    ? `<div class="card stat"><p class="mono">Aulas com alerta</p>
        <p class="num">${o.alertas}<span> de ${o.alertasDe}</span></p>
        <p class="aula-meta" style="margin-top:8px">${o.alertas ? `<a href="#desempenho">queda brusca, muito pulo ou concluem sem ver — abrir Desempenho</a>` : "nenhum alerta com os dados de agora — bom sinal, ou pouca gente ainda"}</p></div>`
    : "";

  const concluiramCard = f.concluiram
    ? `<div class="card stat"><p class="mono">Concluíram</p><p class="num">${f.concluiram}<span> · média ${f.media}%</span></p></div>`
    : `<div class="card stat hj-vazio"><p class="mono">Concluíram</p>
        <p class="aula-meta" style="margin-top:8px">Ninguém ainda. A média de progresso da base é ${f.media}%.</p></div>`;

  const total = f.alunos;
  const chegaram = f.etapas.map((_, i) => f.etapas.slice(i).reduce((s, n) => s + n, 0));
  const funilHtml = `<div class="card hj-funil">
    <div class="hj-funil-topo"><span class="mono">Funil de entrada</span><a href="#funil" class="hj-link">Ver quem parou →</a></div>
    ${ETAPAS_FUNIL.map((e, i) => {
      const n = chegaram[i] ?? 0;
      const nota = e.nota(f);
      return `<div class="hj-funil-linha">
        <b>${e.nome}</b>
        <span class="hj-funil-barra"><i style="width:${total ? Math.round(n / total * 100) : 0}%"></i></span>
        <span class="hj-funil-n">${n}</span>
        ${nota ? `<span class="hj-funil-nota ${i > 0 ? "hj-perda" : "aula-meta"}">${nota}</span>` : ""}
      </div>`;
    }).join("")}
    <p class="aula-meta" style="margin-top:10px">em andamento · ${f.totalAulas} aula${f.totalAulas === 1 ? "" : "s"}</p>
  </div>`;

  const movimentoHtml = `<div class="card hj-mov">
    <p class="mono">Movimento · últimos 7 dias</p>
    <div class="hj-mov-linha"><span>Entraram pela primeira vez</span><b>${f.entraram7d || "—"}</b></div>
    <div class="hj-mov-linha"><span>Aulas concluídas</span><b>${f.concluidas7d || "—"}</b></div>
    <div class="hj-mov-linha"><span>Leituras abertas</span><b>${f.leituras7d || "—"}</b></div>
    <div class="hj-mov-linha"><span>${f.pedidos ? `<a href="#convidar">Pedidos pelo site</a>` : "Pedidos pelo site"}</span><b>${f.pedidos || "—"}</b></div>
    <p class="aula-meta" style="margin-top:12px">Pedidos aparecem quando <b>comunidade.comeca.ai/quero</b> for divulgado à turma.</p>
  </div>`;

  return `${o.aviso || ""}${briefingHtml}${filaHtml}
  <section class="modulo">
    <div class="modulo-topo"><h2>Os números</h2><span class="mono">${f.alunos} aluno${f.alunos === 1 ? "" : "s"} · ${f.ativos} ativo${f.ativos === 1 ? "" : "s"} · 7d</span></div>
    <div class="grade grade-4" style="margin-top:14px">
      ${nuncaCard}
      <div class="card stat"><p class="mono">Ativos · 7d</p><p class="num">${f.ativos}<span>${f.alunos ? ` · ${Math.round(f.ativos / f.alunos * 100)}%` : ""}</span></p>
        <p class="aula-meta" style="margin-top:8px">média de ${f.media}% da trilha por aluno</p></div>
      ${alertaCard}
      ${concluiramCard}
    </div>
    <div class="hj-2col">${funilHtml}${movimentoHtml}</div>
  </section>`;
}
