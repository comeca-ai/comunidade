// Provas de módulo (checkpoints): ao terminar as aulas de um módulo, o aluno
// responde 5 questões — 4 de múltipla escolha e 1 aberta — geradas pela IA a
// partir das transcrições, revisadas e publicadas pela equipe no painel.
//
//   · geração: POST /admin/provas/gerar lê as transcrições das aulas do
//     módulo, pede as questões ao modelo (Model Studio; Workers AI como
//     reserva) e grava como rascunho. A equipe edita em /admin/provas/<módulo>
//     e publica; o aluno só vê prova publicada;
//   · aluno: /app/prova/<módulo>, liberada quando as aulas do módulo estão
//     concluídas. Aprova com 70%; pode refazer à vontade (ordem embaralhada);
//     cada erro aponta o minuto da aula onde o assunto foi tratado;
//   · aberta: corrigida pelo modelo com o gabarito da equipe. Sem modelo, a
//     resposta fica registrada para leitura no painel e não entra na nota;
//   · controles no painel: "exige para avançar" por módulo (tranca as aulas dos
//     módulos seguintes até aprovar) e, global, "certificado exige aprovação
//     nas provas publicadas" — ligado por padrão. O certificado mostra o
//     aproveitamento (média das melhores notas).
//
// Tabelas (criadas sob demanda): provas (uma por módulo), questoes,
// tentativas (respostas em JSON) e ajustes (chave/valor do painel).

import { Hono } from "hono";
import { pagina, esc, jsStr } from "./ui";
import { dataCurta } from "./apoio";
import { transcricaoDe } from "./transcricao";
import { temModelos, conversar, modeloCortes } from "./modelos";
import { textoDo, tempo } from "../packages/conteudo/transcricao";

export const APROVACAO = 0.7;
const N_ESCOLHA = 4, N_ABERTA = 1;
const ORCAMENTO_CHARS = 42_000;   // transcrição enviada ao modelo por módulo
const MODELO_IA = "@cf/meta/llama-4-scout-17b-16e-instruct";

/* ---------------- esquema ---------------- */

let esquemaOk = false;
export async function garantirTabelasProvas(env: any) {
  if (esquemaOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS provas (
      modulo TEXT PRIMARY KEY, estado TEXT NOT NULL DEFAULT 'rascunho',   -- rascunho | publicada
      exige INTEGER NOT NULL DEFAULT 0, modelo TEXT,
      gerada_em INTEGER, publicada_em INTEGER, atualizada_em INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS questoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, modulo TEXT NOT NULL, n INTEGER NOT NULL,
      tipo TEXT NOT NULL,                 -- escolha | aberta
      enunciado TEXT NOT NULL, opcoes TEXT, correta INTEGER, gabarito TEXT, explicacao TEXT,
      aula_uid TEXT, segundo INTEGER, ativa INTEGER NOT NULL DEFAULT 1)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS questoes_modulo ON questoes(modulo, n)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tentativas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, aluno_id INTEGER NOT NULL, modulo TEXT NOT NULL,
      feita_em INTEGER NOT NULL, acertos INTEGER NOT NULL, total INTEGER NOT NULL, aprovado INTEGER NOT NULL,
      respostas TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS tentativas_aluno ON tentativas(aluno_id, modulo)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ajustes (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`),
  ]);
  esquemaOk = true;
}

/* ---------------- tipos e leitura ---------------- */

export type Questao = {
  id: number; modulo: string; n: number; tipo: "escolha" | "aberta"; enunciado: string;
  opcoes: string[]; correta: number | null; gabarito: string | null; explicacao: string | null;
  aula_uid: string | null; segundo: number | null; ativa: boolean;
};
export type Prova = { modulo: string; estado: string; exige: boolean; modelo: string | null; gerada_em: number | null; publicada_em: number | null; questoes: Questao[] };
export type Resposta = { q: number; tipo: string; enunciado: string; resposta: string | number | null; correta: boolean | null; comentario: string | null };
export type Tentativa = { id: number; modulo: string; feita_em: number; acertos: number; total: number; aprovado: boolean; respostas: Resposta[] };
// o que o aluno vê de cada módulo
export type SituacaoProva = { publicada: boolean; exige: boolean; questoes: number; tentativas: number; melhor: Tentativa | null; ultima: Tentativa | null; aprovado: boolean };

const lerQuestao = (r: any): Questao => ({
  id: Number(r.id), modulo: String(r.modulo), n: Number(r.n), tipo: r.tipo === "aberta" ? "aberta" : "escolha",
  enunciado: String(r.enunciado ?? ""), opcoes: (() => { try { const o = JSON.parse(r.opcoes || "[]"); return Array.isArray(o) ? o.map(String) : []; } catch { return []; } })(),
  correta: r.correta == null ? null : Number(r.correta), gabarito: r.gabarito ?? null, explicacao: r.explicacao ?? null,
  aula_uid: r.aula_uid ?? null, segundo: r.segundo == null ? null : Number(r.segundo), ativa: Number(r.ativa ?? 1) === 1,
});
const lerTentativa = (r: any): Tentativa => ({
  id: Number(r.id), modulo: String(r.modulo), feita_em: Number(r.feita_em), acertos: Number(r.acertos), total: Number(r.total),
  aprovado: Number(r.aprovado) === 1, respostas: (() => { try { return JSON.parse(r.respostas || "[]"); } catch { return []; } })(),
});

export async function provaDe(env: any, modulo: string): Promise<Prova | null> {
  await garantirTabelasProvas(env);
  const p: any = await env.DB.prepare(`SELECT * FROM provas WHERE modulo = ?`).bind(modulo).first();
  if (!p) return null;
  const q: any = await env.DB.prepare(`SELECT * FROM questoes WHERE modulo = ? ORDER BY n, id`).bind(modulo).all();
  return { modulo, estado: String(p.estado), exige: Number(p.exige) === 1, modelo: p.modelo ?? null, gerada_em: p.gerada_em ?? null, publicada_em: p.publicada_em ?? null,
    questoes: (q.results ?? []).map(lerQuestao) };
}

export async function ajustesProvas(env: any): Promise<{ certificadoExige: boolean }> {
  await garantirTabelasProvas(env);
  const r: any = await env.DB.prepare(`SELECT valor FROM ajustes WHERE chave = 'certificado_exige_provas'`).first();
  return { certificadoExige: r ? r.valor === "1" : true };   // ligado por padrão
}

// situação das provas para um aluno, por módulo (só módulos com prova; os
// outros não entram no mapa)
export async function situacaoProvas(env: any, alunoId: number): Promise<Map<string, SituacaoProva>> {
  await garantirTabelasProvas(env);
  const out = new Map<string, SituacaoProva>();
  const ps: any = await env.DB.prepare(`SELECT p.modulo, p.estado, p.exige,
      (SELECT COUNT(*) FROM questoes q WHERE q.modulo = p.modulo AND q.ativa = 1) AS questoes FROM provas p`).all();
  for (const p of (ps.results ?? [])) out.set(String(p.modulo), { publicada: p.estado === "publicada" && Number(p.questoes) > 0, exige: Number(p.exige) === 1,
    questoes: Number(p.questoes), tentativas: 0, melhor: null, ultima: null, aprovado: false });
  if (!out.size) return out;
  const ts: any = await env.DB.prepare(`SELECT * FROM tentativas WHERE aluno_id = ? ORDER BY feita_em, id`).bind(alunoId).all();
  for (const r of (ts.results ?? [])) {
    const t = lerTentativa(r), s = out.get(t.modulo);
    if (!s) continue;
    s.tentativas++; s.ultima = t;
    const nota = (x: Tentativa) => x.total ? x.acertos / x.total : 0;
    if (!s.melhor || nota(t) > nota(s.melhor)) s.melhor = t;
    if (t.aprovado) s.aprovado = true;
  }
  return out;
}

// módulo (anterior na ordem) cuja prova exigida ainda não foi aprovada — o que
// tranca as aulas de `modulo`. null = livre.
export function bloqueioDe(sit: Map<string, SituacaoProva>, ordem: string[], modulo: string): string | null {
  const i = ordem.indexOf(modulo);
  for (let k = 0; k < (i === -1 ? ordem.length : i); k++) {
    const s = sit.get(ordem[k]);
    if (s && s.publicada && s.exige && !s.aprovado) return ordem[k];
  }
  return null;
}

// regra do certificado: com o ajuste ligado, todas as provas publicadas
// precisam estar aprovadas. Aproveitamento = média das melhores notas.
export type ProvasCertificado = { exige: boolean; publicadas: string[]; pendentes: string[]; aproveitamento: number | null };
export async function provasParaCertificado(env: any, alunoId: number): Promise<ProvasCertificado> {
  const [aj, sit] = await Promise.all([ajustesProvas(env), situacaoProvas(env, alunoId)]);
  const publicadas = [...sit.entries()].filter(([, s]) => s.publicada);
  const pendentes = aj.certificadoExige ? publicadas.filter(([, s]) => !s.aprovado).map(([m]) => m) : [];
  const notas = publicadas.map(([, s]) => s.melhor && s.melhor.total ? s.melhor.acertos / s.melhor.total : null).filter((n): n is number => n !== null);
  const aproveitamento = notas.length ? Math.round(notas.reduce((a, b) => a + b, 0) / notas.length * 100) : null;
  return { exige: aj.certificadoExige, publicadas: publicadas.map(([m]) => m), pendentes, aproveitamento };
}

/* ---------------- geração pela IA ---------------- */

const SISTEMA_GERAR = `Você é professor de uma escola de inteligência artificial para donos de negócio (começa.ai) e escreve a prova curta de fim de módulo a partir da transcrição das aulas. A prova mede se o aluno entendeu as ideias centrais do módulo — não decoreba de números nem detalhes de ferramenta. Regras: perguntas claras, em português do Brasil, que se entendem sem a transcrição; alternativas plausíveis, do mesmo tamanho, sem "todas as anteriores"; uma só correta; a explicação diz por que a correta está certa em 1–2 frases; a questão aberta pede aplicação ao negócio do aluno e o gabarito descreve o que uma boa resposta precisa conter. Cada questão aponta a aula (uid) e o segundo em que o assunto aparece. Responda SOMENTE com JSON válido.`;

function promptGerar(modulo: string, aulas: { uid: string; titulo: string }[], texto: string) {
  return `Módulo: ${modulo}
Aulas (uid — título):
${aulas.map((a) => `- ${a.uid} — ${a.titulo}`).join("\n")}

Transcrição (trechos, com marcação [uid @segundos]):
${texto}

Escreva ${N_ESCOLHA} questões de múltipla escolha (4 alternativas) e ${N_ABERTA} questão aberta, cobrindo aulas diferentes quando possível. Formato:
[
  {"tipo":"escolha","enunciado":"...","opcoes":["...","...","...","..."],"correta":0,"explicacao":"...","aula":"<uid>","segundo":123},
  {"tipo":"aberta","enunciado":"...","gabarito":"o que a resposta precisa conter","explicacao":"...","aula":"<uid>","segundo":123}
]`;
}

// texto das transcrições do módulo dentro do orçamento, repartido por aula
// (amostra parágrafos por igual quando não cabe tudo)
async function textoDoModulo(env: any, aulas: { uid: string; titulo: string }[]): Promise<{ texto: string; comTranscricao: number }> {
  const porAula = Math.floor(ORCAMENTO_CHARS / Math.max(1, aulas.length));
  const partes: string[] = []; let com = 0;
  for (const a of aulas) {
    const t = await transcricaoDe(env, a.uid).catch(() => null);
    if (!t?.paragrafos?.length) continue;
    com++;
    const linhas = t.paragrafos.map((p) => `[${a.uid} @${Math.floor(p.i)}] ${textoDo(p)}`);
    const total = linhas.reduce((s, l) => s + l.length + 1, 0);
    let escolhidas = linhas;
    if (total > porAula) {
      const passo = total / porAula, out: string[] = [];
      let acc = 0, gasto = 0;
      for (const l of linhas) { acc += 1; if (acc >= passo && gasto + l.length < porAula) { out.push(l); gasto += l.length + 1; acc -= passo; } }
      escolhidas = out.length ? out : linhas.slice(0, 20);
    }
    partes.push(`### ${a.titulo}\n${escolhidas.join("\n")}`);
  }
  return { texto: partes.join("\n\n"), comTranscricao: com };
}

async function gerarTexto(env: any, sistema: string, usuario: string, maxTokens: number): Promise<{ texto: string; modelo: string }> {
  if (temModelos(env)) return { texto: await conversar(env, { sistema, usuario, maxTokens }), modelo: modeloCortes(env) };
  if (env.AI?.run) {
    const r: any = await env.AI.run(MODELO_IA, { messages: [{ role: "system", content: sistema }, { role: "user", content: usuario }], max_tokens: maxTokens, temperature: 0.3 });
    return { texto: String(r?.choices?.[0]?.message?.content ?? r?.response ?? ""), modelo: MODELO_IA.replace("@cf/meta/", "") };
  }
  throw new Error("nenhum modelo configurado (MODELOS_API_KEY ou Workers AI)");
}

function jsonDe(bruto: string): any {
  const m = String(bruto).match(/[\[{][\s\S]*[\]}]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function interpretarQuestoes(bruto: string, uids: string[]): Omit<Questao, "id" | "modulo" | "n" | "ativa">[] {
  const arr = jsonDe(bruto);
  if (!Array.isArray(arr)) return [];
  const out: Omit<Questao, "id" | "modulo" | "n" | "ativa">[] = [];
  for (const x of arr) {
    const enunciado = String(x?.enunciado || "").trim().slice(0, 600);
    if (!enunciado) continue;
    const aula = uids.includes(String(x?.aula)) ? String(x.aula) : null;
    const segundo = aula && Number.isFinite(Number(x?.segundo)) ? Math.max(0, Math.floor(Number(x.segundo))) : null;
    const explicacao = String(x?.explicacao || "").trim().slice(0, 600) || null;
    if (x?.tipo === "aberta") {
      out.push({ tipo: "aberta", enunciado, opcoes: [], correta: null, gabarito: String(x?.gabarito || "").trim().slice(0, 800) || null, explicacao, aula_uid: aula, segundo });
    } else {
      const opcoes = Array.isArray(x?.opcoes) ? x.opcoes.map((o: any) => String(o).trim().slice(0, 300)).filter(Boolean) : [];
      const correta = Number(x?.correta);
      if (opcoes.length < 2 || !Number.isInteger(correta) || correta < 0 || correta >= opcoes.length) continue;
      out.push({ tipo: "escolha", enunciado, opcoes, correta, gabarito: null, explicacao, aula_uid: aula, segundo });
    }
  }
  return out;
}

// gera e grava como rascunho (substitui as questões que existiam; o estado de
// publicação e o "exige" ficam)
export async function gerarProva(env: any, modulo: string, aulas: { uid: string; titulo: string }[], agora: number): Promise<{ questoes: number; modelo: string; comTranscricao: number }> {
  await garantirTabelasProvas(env);
  const { texto, comTranscricao } = await textoDoModulo(env, aulas);
  if (!texto) throw new Error("nenhuma aula do módulo tem transcrição");
  const { texto: bruto, modelo } = await gerarTexto(env, SISTEMA_GERAR, promptGerar(modulo, aulas, texto), 3000);
  const qs = interpretarQuestoes(bruto, aulas.map((a) => a.uid));
  if (!qs.length) throw new Error("o modelo não devolveu questões válidas");
  const stmts = [
    env.DB.prepare(`INSERT INTO provas (modulo, estado, modelo, gerada_em, atualizada_em) VALUES (?,'rascunho',?,?,?)
      ON CONFLICT(modulo) DO UPDATE SET modelo = excluded.modelo, gerada_em = excluded.gerada_em, atualizada_em = excluded.atualizada_em`).bind(modulo, modelo, agora, agora),
    env.DB.prepare(`DELETE FROM questoes WHERE modulo = ?`).bind(modulo),
    ...qs.map((q, n) => env.DB.prepare(`INSERT INTO questoes (modulo, n, tipo, enunciado, opcoes, correta, gabarito, explicacao, aula_uid, segundo, ativa) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .bind(modulo, n, q.tipo, q.enunciado, JSON.stringify(q.opcoes), q.correta, q.gabarito, q.explicacao, q.aula_uid, q.segundo)),
  ];
  await env.DB.batch(stmts);
  return { questoes: qs.length, modelo, comTranscricao };
}

/* ---------------- correção ---------------- */

const SISTEMA_CORRIGIR = `Você corrige a questão aberta de uma prova curta de fim de módulo de uma escola de IA para donos de negócio. Compare a resposta do aluno com o gabarito: está correta se contém a ideia central do gabarito aplicada ao contexto pedido, mesmo com palavras diferentes ou texto curto. Resposta vazia, genérica ou fora do assunto está incorreta. Escreva um comentário de 1 a 3 frases, em português do Brasil, direto ao aluno (você), dizendo o que acertou e o que faltou. Responda SOMENTE com JSON: {"correta": true|false, "comentario": "..."}.`;

export async function corrigirAberta(env: any, q: Questao, resposta: string): Promise<{ correta: boolean | null; comentario: string | null }> {
  if (!resposta.trim()) return { correta: false, comentario: "Você deixou em branco." };
  if (!temModelos(env) && !env.AI?.run) return { correta: null, comentario: null };
  try {
    const { texto } = await gerarTexto(env, SISTEMA_CORRIGIR,
      `Pergunta: ${q.enunciado}\nGabarito: ${q.gabarito || q.explicacao || "(sem gabarito — avalie pela pertinência e profundidade)"}\nResposta do aluno: ${resposta.slice(0, 2000)}`, 400);
    const j = jsonDe(texto);
    if (!j || typeof j.correta !== "boolean") return { correta: null, comentario: null };
    return { correta: j.correta, comentario: String(j.comentario || "").slice(0, 600) || null };
  } catch { return { correta: null, comentario: null }; }
}

export async function corrigirProva(env: any, prova: Prova, respostas: Map<number, string>, alunoId: number, agora: number): Promise<Tentativa> {
  const ativas = prova.questoes.filter((q) => q.ativa);
  const linhas: Resposta[] = [];
  for (const q of ativas) {
    const bruto = respostas.get(q.id) ?? "";
    if (q.tipo === "escolha") {
      const i = bruto === "" ? null : Number(bruto);
      const ok = i !== null && Number.isInteger(i) && i === q.correta;
      linhas.push({ q: q.id, tipo: "escolha", enunciado: q.enunciado, resposta: i !== null && Number.isInteger(i) ? i : null, correta: ok, comentario: null });
    } else {
      const c = await corrigirAberta(env, q, bruto);
      linhas.push({ q: q.id, tipo: "aberta", enunciado: q.enunciado, resposta: bruto.slice(0, 2000), correta: c.correta, comentario: c.comentario });
    }
  }
  const avaliadas = linhas.filter((l) => l.correta !== null);
  const acertos = avaliadas.filter((l) => l.correta).length, total = avaliadas.length;
  const aprovado = total > 0 && acertos / total >= APROVACAO - 1e-9;
  const r: any = await env.DB.prepare(`INSERT INTO tentativas (aluno_id, modulo, feita_em, acertos, total, aprovado, respostas) VALUES (?,?,?,?,?,?,?) RETURNING id`)
    .bind(alunoId, prova.modulo, agora, acertos, total, aprovado ? 1 : 0, JSON.stringify(linhas)).first();
  return { id: Number(r?.id ?? 0), modulo: prova.modulo, feita_em: agora, acertos, total, aprovado, respostas: linhas };
}

/* ---------------- estatísticas para o painel ---------------- */

export type ResumoProva = { modulo: string; estado: string | null; exige: boolean; questoes: number; tentativas: number; alunos: number; aprovados: number; media: number | null; gerada_em: number | null; modelo: string | null };

export async function resumoProvas(env: any, modulos: string[]): Promise<Map<string, ResumoProva>> {
  await garantirTabelasProvas(env);
  const out = new Map<string, ResumoProva>();
  for (const m of modulos) out.set(m, { modulo: m, estado: null, exige: false, questoes: 0, tentativas: 0, alunos: 0, aprovados: 0, media: null, gerada_em: null, modelo: null });
  const ps: any = await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM questoes q WHERE q.modulo = p.modulo AND q.ativa = 1) AS questoes FROM provas p`).all();
  for (const p of (ps.results ?? [])) {
    const r = out.get(String(p.modulo)) ?? { modulo: String(p.modulo), estado: null, exige: false, questoes: 0, tentativas: 0, alunos: 0, aprovados: 0, media: null, gerada_em: null, modelo: null };
    Object.assign(r, { estado: String(p.estado), exige: Number(p.exige) === 1, questoes: Number(p.questoes), gerada_em: p.gerada_em ?? null, modelo: p.modelo ?? null });
    out.set(r.modulo, r);
  }
  const ts: any = await env.DB.prepare(`SELECT modulo, COUNT(*) AS n, COUNT(DISTINCT aluno_id) AS alunos,
      (SELECT COUNT(DISTINCT aluno_id) FROM tentativas x WHERE x.modulo = t.modulo AND x.aprovado = 1) AS aprovados,
      AVG(CASE WHEN total > 0 THEN acertos * 1.0 / total END) AS media FROM tentativas t GROUP BY modulo`).all();
  for (const t of (ts.results ?? [])) {
    const r = out.get(String(t.modulo)); if (!r) continue;
    r.tentativas = Number(t.n); r.alunos = Number(t.alunos); r.aprovados = Number(t.aprovados); r.media = t.media == null ? null : Math.round(Number(t.media) * 100);
  }
  return out;
}

// taxa de erro por questão (todas as tentativas do módulo)
export async function errosPorQuestao(env: any, modulo: string): Promise<Map<number, { n: number; erros: number }>> {
  const ts: any = await env.DB.prepare(`SELECT respostas FROM tentativas WHERE modulo = ?`).bind(modulo).all();
  const out = new Map<number, { n: number; erros: number }>();
  for (const t of (ts.results ?? [])) {
    for (const r of lerTentativa({ ...t, id: 0, modulo, feita_em: 0, acertos: 0, total: 0, aprovado: 0 }).respostas) {
      if (r.correta === null) continue;
      const e = out.get(r.q) ?? { n: 0, erros: 0 }; e.n++; if (!r.correta) e.erros++; out.set(r.q, e);
    }
  }
  return out;
}

/* ---------------- HTML: aluno ---------------- */

const pctDe = (t: Tentativa | null) => t && t.total ? Math.round(t.acertos / t.total * 100) : null;
const urlProva = (m: string) => `/app/prova/${encodeURIComponent(m)}`;

// linha ao fim de cada módulo na trilha do aluno
export function linhaProvaModulo(modulo: string, s: SituacaoProva | undefined, faltam: number): string {
  if (!s || !s.publicada) return "";
  const nota = pctDe(s.melhor);
  let estado = "", rotulo = "Fazer prova", tom = "btn-primario";
  if (s.aprovado) { estado = `Aprovado · ${nota}%${s.tentativas > 1 ? ` · ${s.tentativas} tentativas` : ""}`; rotulo = "Refazer"; tom = "btn-fantasma"; }
  else if (s.tentativas) { estado = `Última: ${pctDe(s.ultima)}% · precisa de ${Math.round(APROVACAO * 100)}%`; rotulo = "Tentar de novo"; }
  else if (faltam > 0) { estado = `Libera ao concluir ${faltam === 1 ? "a aula que falta" : `as ${faltam} aulas que faltam`}`; rotulo = ""; }
  else estado = `${s.questoes} questões · ${s.exige ? "necessária para avançar" : "rápida, vale para o certificado"}`;
  return `<a class="aula prova ${s.aprovado ? "feita" : ""}" href="${rotulo ? urlProva(modulo) : "#"}" ${rotulo ? "" : 'style="pointer-events:none;opacity:.6"'}>
    <span class="num-aula">✎</span><span class="check">✓</span>
    <span class="aula-txt"><b>Prova do módulo</b><span class="aula-meta">${esc(estado)}</span></span>
    ${rotulo ? `<span class="btn ${tom}" style="padding:8px 14px;font-size:13px">${rotulo}</span>` : ""}
  </a>`;
}

function embaralhar<T>(xs: T[]): T[] { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

type AulaDoModulo = { uid: string; titulo: string; modulo: string; concluida_em: number | null };
type DepsAluno = { exigeLogin: any; exigeAdmin: any; agora: () => number; aulasComProgresso: (c: any, alunoId: number) => Promise<AulaDoModulo[]> };

function paginaProva(o: { escola: string; aluno: any; prova: Prova; s: SituacaoProva; aulas: AulaDoModulo[]; bloqueio: boolean; temIA: boolean }) {
  const { prova, s } = o;
  const qs = embaralhar(prova.questoes.filter((q) => q.ativa));
  const corpo = `<main class="wrap" style="padding:32px 24px;max-width:820px">
    <a class="mono" href="/app">← todas as aulas</a>
    <div style="margin:20px 0 18px">
      <p class="mono">${esc(prova.modulo)}</p>
      <h1 style="font-size:clamp(26px,4vw,36px);margin-top:10px">Prova do módulo</h1>
      <p class="aula-meta" style="margin-top:8px">${qs.length} questões · aprova com ${Math.round(APROVACAO * 100)}% · pode refazer quantas vezes quiser</p>
    </div>
    ${o.bloqueio ? `<div class="aviso" style="margin-bottom:16px">As aulas do próximo módulo abrem depois que você for aprovado nesta prova.</div>` : ""}
    ${s.tentativas ? `<div class="card" style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center">
      <div><p class="mono">${s.aprovado ? "Aprovado" : "Ainda não aprovado"}</p>
        <p style="margin-top:4px">Melhor nota ${pctDe(s.melhor)}% · ${s.tentativas} tentativa${s.tentativas === 1 ? "" : "s"}</p></div>
      <a class="btn btn-fantasma" href="${urlProva(prova.modulo)}/resultado">Ver última correção</a></div>` : ""}
    <form method="post" action="${urlProva(prova.modulo)}" class="prova-form">
      ${qs.map((q, i) => `<fieldset class="card questao">
        <legend class="mono">Questão ${i + 1}${q.tipo === "aberta" ? " · aberta" : ""}</legend>
        <p class="enunciado">${esc(q.enunciado)}</p>
        ${q.tipo === "escolha"
          ? embaralhar(q.opcoes.map((o, k) => ({ o, k }))).map(({ o, k }) => `<label class="opcao"><input type="radio" name="q${q.id}" value="${k}" required> <span>${esc(o)}</span></label>`).join("")
          : `<textarea class="campo" name="q${q.id}" rows="4" maxlength="2000" required placeholder="Responda com suas palavras, pensando no seu negócio"></textarea>
             ${o.temIA ? `<p class="aula-meta" style="margin-top:6px">A resposta aberta é lida e comentada pela IA com base no gabarito do professor.</p>` : `<p class="aula-meta" style="margin-top:6px">A resposta aberta fica registrada para o professor e não entra na nota.</p>`}`}
      </fieldset>`).join("")}
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:8px">
        <button class="btn btn-primario" type="submit">Enviar respostas</button>
        <span class="aula-meta">A correção é imediata e mostra onde rever na aula.</span>
      </div>
    </form>
  </main>`;
  return pagina({ escola: o.escola, titulo: `Prova · ${prova.modulo}`, aluno: o.aluno, corpo });
}

function paginaResultado(o: { escola: string; aluno: any; prova: Prova; t: Tentativa; s: SituacaoProva; proxima: AulaDoModulo | null; aulas: AulaDoModulo[] }) {
  const { prova, t } = o;
  const nota = pctDe(t);
  const porId = new Map(prova.questoes.map((q) => [q.id, q]));
  const tituloAula = (uid: string | null) => o.aulas.find((a) => a.uid === uid)?.titulo ?? "";
  const corpo = `<main class="wrap" style="padding:32px 24px;max-width:820px">
    <a class="mono" href="/app">← todas as aulas</a>
    <div class="card ${t.aprovado ? "diploma" : ""}" style="margin:20px 0 18px;text-align:center">
      <p class="mono">${esc(prova.modulo)}</p>
      <h1 style="font-size:clamp(26px,4vw,36px);margin-top:8px">${t.aprovado ? "Aprovado!" : "Ainda não foi dessa vez"}</h1>
      <p style="margin-top:8px;color:var(--muted)">${t.total ? `${t.acertos} de ${t.total} · <b>${nota}%</b>` : "Sem questões corrigidas"}${t.aprovado ? "" : ` · precisa de ${Math.round(APROVACAO * 100)}%`} · ${dataCurta(t.feita_em)}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:16px">
        ${t.aprovado && o.proxima ? `<a class="btn btn-primario" href="/app/aula/${esc(o.proxima.uid)}">Próximo módulo: ${esc(o.proxima.titulo)} →</a>` : ""}
        <a class="btn ${t.aprovado ? "btn-fantasma" : "btn-primario"}" href="${urlProva(prova.modulo)}">${t.aprovado ? "Refazer" : "Tentar de novo"}</a>
        ${t.aprovado && !o.proxima ? `<a class="btn btn-fantasma" href="/app">Voltar ao programa</a>` : ""}
      </div>
    </div>
    ${t.respostas.map((r, i) => {
      const q = porId.get(r.q);
      const ok = r.correta === true, nulo = r.correta === null;
      const link = q?.aula_uid ? `<a href="/app/aula/${esc(q.aula_uid)}${q.segundo != null ? `?t=${q.segundo}` : ""}">rever ${q.segundo != null ? `aos ${tempo(q.segundo)} de` : ""} ${esc(tituloAula(q.aula_uid) || "a aula")}</a>` : "";
      return `<div class="card questao resultado ${ok ? "certa" : nulo ? "" : "errada"}">
        <p class="mono">Questão ${i + 1} · ${ok ? "✓ certa" : nulo ? "registrada" : "✗ errada"}</p>
        <p class="enunciado">${esc(r.enunciado)}</p>
        ${r.tipo === "escolha" && q
          ? q.opcoes.map((op, k) => `<p class="opcao ${k === q.correta ? "gabarito" : ""} ${k === r.resposta && k !== q.correta ? "marcada" : ""}">${k === q.correta ? "✓" : k === r.resposta ? "✗" : "·"} ${esc(op)}</p>`).join("")
          : `<p class="opcao" style="white-space:pre-wrap">${esc(String(r.resposta ?? "")) || "<i>em branco</i>"}</p>`}
        ${r.comentario ? `<p style="margin-top:8px"><b>Comentário:</b> ${esc(r.comentario)}</p>` : ""}
        ${q?.explicacao && (r.tipo === "escolha" || !r.comentario) ? `<p style="margin-top:8px;color:var(--muted)">${esc(q.explicacao)}</p>` : ""}
        ${link ? `<p class="aula-meta" style="margin-top:8px">${link}</p>` : ""}
      </div>`;
    }).join("")}
  </main>`;
  return pagina({ escola: o.escola, titulo: `Resultado · ${prova.modulo}`, aluno: o.aluno, corpo });
}

/* ---------------- HTML: painel ---------------- */

const urlAdmin = (m: string) => `/admin/provas/${encodeURIComponent(m)}`;

export function secaoProvas(o: { modulos: { nome: string; aulas: number; transcritas: number }[]; resumo: Map<string, ResumoProva>; certificadoExige: boolean; temIA: boolean; aviso?: string }) {
  const publicadas = [...o.resumo.values()].filter((r) => r.estado === "publicada" && r.questoes > 0).length;
  return `${o.aviso || ""}
  <div class="card" style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px">
    <div><p class="mono">Provas de módulo</p>
      <p style="margin-top:6px">${publicadas} publicada${publicadas === 1 ? "" : "s"} de ${o.modulos.length} módulos · aprova com ${Math.round(APROVACAO * 100)}% · o aluno pode refazer</p>
      <p class="aula-meta" style="margin-top:4px">${o.temIA ? "A IA escreve 4 questões de múltipla escolha e 1 aberta a partir das transcrições; você revisa e publica." : "Sem modelo configurado (MODELOS_API_KEY ou Workers AI): as questões precisam ser escritas à mão."}</p></div>
    <form method="post" action="/admin/provas/ajustes" style="display:flex;align-items:center;gap:10px">
      <label class="aula-meta" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" name="certificado_exige" value="1" ${o.certificadoExige ? "checked" : ""} onchange="this.form.submit()">
        Certificado exige aprovação nas provas publicadas</label>
    </form>
  </div>
  ${o.modulos.map((m) => {
    const r = o.resumo.get(m.nome)!;
    const estado = !r.estado || !r.questoes ? `<span class="etiqueta neutro">sem prova</span>` : r.estado === "publicada" ? `<span class="etiqueta ok">publicada</span>` : `<span class="etiqueta atencao">rascunho</span>`;
    return `<div class="card" style="margin-top:12px;display:grid;gap:10px">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px">
        <div><b>${esc(m.nome)}</b> ${estado}${r.exige ? ` <span class="etiqueta alerta">exigida para avançar</span>` : ""}
          <p class="aula-meta" style="margin-top:4px">${m.aulas} aula${m.aulas === 1 ? "" : "s"} · ${m.transcritas} com transcrição${r.questoes ? ` · ${r.questoes} questões` : ""}${r.gerada_em ? ` · gerada em ${dataCurta(r.gerada_em)}${r.modelo ? ` (${esc(r.modelo)})` : ""}` : ""}</p>
          ${r.tentativas ? `<p class="aula-meta">${r.tentativas} tentativa${r.tentativas === 1 ? "" : "s"} · ${r.alunos} aluno${r.alunos === 1 ? "" : "s"} · ${r.aprovados} aprovado${r.aprovados === 1 ? "" : "s"}${r.media != null ? ` · média ${r.media}%` : ""}</p>` : ""}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          ${r.questoes ? `<a class="btn btn-fantasma" href="${urlAdmin(m.nome)}">Revisar</a>` : ""}
          ${r.questoes ? `<form method="post" action="/admin/provas/publicar"><input type="hidden" name="modulo" value="${esc(m.nome)}">
            <input type="hidden" name="estado" value="${r.estado === "publicada" ? "rascunho" : "publicada"}">
            <button class="btn ${r.estado === "publicada" ? "btn-fantasma" : "btn-primario"}" type="submit">${r.estado === "publicada" ? "Despublicar" : "Publicar"}</button></form>` : ""}
          ${m.transcritas && o.temIA ? `<form method="post" action="/admin/provas/gerar" ${r.questoes ? `onsubmit="return confirm(${jsStr(`Gerar de novo substitui as ${r.questoes} questões de "${m.nome}". Continuar?`)})"` : ""}>
            <input type="hidden" name="modulo" value="${esc(m.nome)}">
            <button class="btn ${r.questoes ? "btn-fantasma" : "btn-primario"}" type="submit">${r.questoes ? "Gerar de novo" : "Gerar com IA"}</button></form>`
            : !r.questoes ? `<a class="btn btn-fantasma" href="${urlAdmin(m.nome)}">Escrever à mão</a>` : ""}
          ${r.questoes ? `<form method="post" action="/admin/provas/exigir" style="display:flex;align-items:center">
            <input type="hidden" name="modulo" value="${esc(m.nome)}">
            <label class="aula-meta" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="exige" value="1" ${r.exige ? "checked" : ""} onchange="this.form.submit()"> exige para avançar</label></form>` : ""}
        </div>
      </div>
    </div>`;
  }).join("")}`;
}

function paginaEditar(o: { escola: string; admin: any; prova: Prova | null; modulo: string; aulas: { uid: string; titulo: string }[]; erros: Map<number, { n: number; erros: number }>; aviso: string }) {
  const qs = o.prova?.questoes ?? [];
  const campoQ = (q: Questao | null, idx: number) => {
    const p = q ? `q${q.id}_` : "nova_";
    const tipo = q?.tipo ?? "escolha";
    const e = q ? o.erros.get(q.id) : undefined;
    return `<fieldset class="card questao" style="margin-top:12px">
      <legend class="mono">${q ? `Questão ${idx + 1} · ${tipo}` : "Nova questão (opcional)"}${e?.n ? ` · ${Math.round(e.erros / e.n * 100)}% de erro em ${e.n}` : ""}</legend>
      ${q ? "" : `<label class="aula-meta">Tipo <select class="campo" name="${p}tipo" style="width:auto"><option value="escolha">múltipla escolha</option><option value="aberta">aberta</option></select></label>`}
      <textarea class="campo" name="${p}enunciado" rows="2" maxlength="600" placeholder="Enunciado">${esc(q?.enunciado ?? "")}</textarea>
      ${tipo === "escolha" || !q ? `<div style="display:grid;gap:6px;margin-top:8px">
        ${[0, 1, 2, 3].map((k) => `<label style="display:flex;gap:8px;align-items:center"><input type="radio" name="${p}correta" value="${k}" ${(q?.correta ?? 0) === k ? "checked" : ""} title="correta">
          <input class="campo" type="text" name="${p}opcao${k}" maxlength="300" value="${esc(q?.opcoes[k] ?? "")}" placeholder="Alternativa ${k + 1}${q || k < 2 ? "" : " (opcional)"}"></label>`).join("")}
        <p class="aula-meta">Marque a alternativa correta.</p></div>` : ""}
      ${tipo === "aberta" || !q ? `<textarea class="campo" name="${p}gabarito" rows="2" maxlength="800" style="margin-top:8px" placeholder="Gabarito da questão aberta: o que uma boa resposta precisa conter">${esc(q?.gabarito ?? "")}</textarea>` : ""}
      <input class="campo" type="text" name="${p}explicacao" maxlength="600" style="margin-top:8px" value="${esc(q?.explicacao ?? "")}" placeholder="Explicação mostrada após a correção">
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center">
        <select class="campo" name="${p}aula" style="flex:1;min-width:200px"><option value="">— aula de referência —</option>
          ${o.aulas.map((a) => `<option value="${esc(a.uid)}" ${q?.aula_uid === a.uid ? "selected" : ""}>${esc(a.titulo)}</option>`).join("")}</select>
        <input class="campo" type="number" min="0" name="${p}segundo" style="width:130px" value="${q?.segundo ?? ""}" placeholder="segundo">
        ${q ? `<label class="aula-meta" style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="${p}ativa" value="1" ${q.ativa ? "checked" : ""}> ativa</label>
        <label class="aula-meta" style="display:flex;align-items:center;gap:6px;color:#8B2A20"><input type="checkbox" name="${p}excluir" value="1"> excluir</label>` : ""}
      </div>
    </fieldset>`;
  };
  const corpo = `<main class="wrap" style="padding:44px 24px;max-width:900px">
    <a class="mono" href="/admin#provas">← painel</a>
    <div style="margin:18px 0 8px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px">
      <div><p class="mono">Prova do módulo</p><h1 style="margin-top:6px">${esc(o.modulo)}</h1>
        <p class="aula-meta" style="margin-top:6px">${o.prova ? `${o.prova.estado === "publicada" ? "publicada" : "rascunho"} · ${qs.filter((q) => q.ativa).length} questões ativas${o.prova.modelo ? ` · geradas por ${esc(o.prova.modelo)}` : ""}` : "ainda sem questões"}</p></div>
      ${o.prova?.estado === "publicada" ? `<a class="btn btn-fantasma" href="${urlProva(o.modulo)}" target="_blank" rel="noopener">Ver como aluno</a>` : ""}
    </div>
    ${o.aviso}
    <form method="post" action="${urlAdmin(o.modulo)}/salvar">
      ${qs.map((q, i) => campoQ(q, i)).join("")}
      ${campoQ(null, qs.length)}
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;align-items:center">
        <button class="btn btn-primario" type="submit">Salvar</button>
        ${o.prova?.estado === "publicada" ? `<span class="aula-meta">A prova está publicada: as mudanças valem na hora para o aluno.</span>` : `<span class="aula-meta">Depois de revisar, publique na aba Provas do painel.</span>`}
      </div>
    </form>
  </main>`;
  return pagina({ escola: o.escola, titulo: `Prova · ${o.modulo}`, aluno: o.admin, corpo });
}

// ficha do aluno no painel
export function secaoProvasAluno(sit: Map<string, SituacaoProva>, ordem: string[]): string {
  const linhas = ordem.filter((m) => sit.get(m)?.publicada || sit.get(m)?.tentativas).map((m) => {
    const s = sit.get(m)!;
    const aberta = s.ultima?.respostas.find((r) => r.tipo === "aberta");
    return `<div class="aula ${s.aprovado ? "feita" : ""}" style="cursor:default;align-items:flex-start">
      <span class="check">✓</span>
      <span class="aula-txt"><b>${esc(m)}</b>
        <span class="aula-meta">${s.tentativas ? `${s.aprovado ? "aprovado" : "não aprovado"} · melhor ${pctDe(s.melhor)}% · ${s.tentativas} tentativa${s.tentativas === 1 ? "" : "s"} · última em ${dataCurta(s.ultima!.feita_em)}` : s.publicada ? "não fez" : "prova em rascunho"}</span>
        ${aberta && aberta.resposta ? `<span class="aula-meta" style="white-space:pre-wrap;margin-top:6px"><i>Resposta aberta:</i> ${esc(String(aberta.resposta))}${aberta.correta === null ? " <b>(sem correção automática)</b>" : ""}</span>` : ""}
      </span></div>`;
  });
  if (!linhas.length) return "";
  return `<section class="modulo"><div class="modulo-topo"><h2>Provas</h2><span class="mono">${linhas.length}</span></div>${linhas.join("")}</section>`;
}

/* ---------------- rotas ---------------- */

export function rotasProvas(d: DepsAluno) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  const contexto = async (c: any, modulo: string) => {
    const aluno = c.get("aluno");
    const aulas: AulaDoModulo[] = await d.aulasComProgresso(c, aluno.id);
    const doModulo = aulas.filter((a) => a.modulo === modulo);
    if (!doModulo.length) return null;
    const [prova, sit] = await Promise.all([provaDe(c.env, modulo), situacaoProvas(c.env, aluno.id)]);
    const s = sit.get(modulo);
    if (!prova || !s?.publicada) return null;
    const ordem = [...new Set(aulas.map((a) => a.modulo))];
    const i = ordem.indexOf(modulo);
    const proxima = i >= 0 && i + 1 < ordem.length ? aulas.find((a) => a.modulo === ordem[i + 1]) ?? null : null;
    return { aluno, aulas, doModulo, prova, s, proxima, faltam: doModulo.filter((a) => !a.concluida_em).length };
  };

  r.get("/app/prova/:modulo", d.exigeLogin, async (c) => {
    const modulo = c.req.param("modulo");
    const x = await contexto(c, modulo);
    if (!x) return c.notFound();
    if (x.faltam > 0 && !x.s.tentativas) {
      const corpo = `<main class="wrap" style="padding:70px 24px"><div class="card centro" style="text-align:center">
        <p class="mono">${esc(modulo)}</p><h2 style="margin:12px 0 10px">A prova abre ao concluir as aulas do módulo</h2>
        <p style="color:var(--muted);margin-bottom:22px">Falta${x.faltam === 1 ? "" : "m"} ${x.faltam} de ${x.doModulo.length}.</p>
        <a class="btn btn-primario" href="/app/aula/${esc(x.doModulo.find((a) => !a.concluida_em)!.uid)}">Ir para a próxima aula</a></div></main>`;
      return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Prova", aluno: x.aluno, corpo }));
    }
    return c.html(paginaProva({ escola: c.env.NOME_ESCOLA, aluno: x.aluno, prova: x.prova, s: x.s, aulas: x.aulas, bloqueio: c.req.query("bloqueio") === "1", temIA: temModelos(c.env) || !!c.env.AI?.run }));
  });

  r.post("/app/prova/:modulo", d.exigeLogin, async (c) => {
    const modulo = c.req.param("modulo");
    const x = await contexto(c, modulo);
    if (!x) return c.notFound();
    if (x.faltam > 0 && !x.s.tentativas) return c.redirect(urlProva(modulo));
    const form = await c.req.formData();
    const respostas = new Map<number, string>();
    for (const q of x.prova.questoes) respostas.set(q.id, String(form.get(`q${q.id}`) ?? ""));
    await corrigirProva(c.env, x.prova, respostas, x.aluno.id, d.agora());
    return c.redirect(`${urlProva(modulo)}/resultado`);
  });

  r.get("/app/prova/:modulo/resultado", d.exigeLogin, async (c) => {
    const modulo = c.req.param("modulo");
    const x = await contexto(c, modulo);
    if (!x || !x.s.ultima) return c.redirect(urlProva(modulo));
    return c.html(paginaResultado({ escola: c.env.NOME_ESCOLA, aluno: x.aluno, prova: x.prova, t: x.s.ultima, s: x.s, proxima: x.proxima, aulas: x.aulas }));
  });

  /* ---- painel ---- */

  const aulasDoModulo = async (c: any, modulo: string) => {
    const aulas: AulaDoModulo[] = await d.aulasComProgresso(c, 0);
    return aulas.filter((a) => a.modulo === modulo).map((a) => ({ uid: a.uid, titulo: a.titulo }));
  };
  const volta = (c: any, msg: string) => c.redirect(`/admin?provas=${encodeURIComponent(msg)}#provas`);

  r.post("/admin/provas/gerar", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const modulo = String(form.get("modulo") || "").trim();
    const aulas = await aulasDoModulo(c, modulo);
    if (!aulas.length) return volta(c, "Módulo não encontrado.");
    try {
      const r = await gerarProva(c.env, modulo, aulas, d.agora());
      return c.redirect(`${urlAdmin(modulo)}?gerada=${r.questoes}`);
    } catch (e: any) { return volta(c, `Não deu para gerar a prova de "${modulo}": ${String(e?.message ?? e).slice(0, 160)}`); }
  });

  r.post("/admin/provas/publicar", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const modulo = String(form.get("modulo") || "").trim(), estado = form.get("estado") === "publicada" ? "publicada" : "rascunho";
    const p = await provaDe(c.env, modulo);
    if (!p) return volta(c, "Módulo sem prova.");
    if (estado === "publicada" && !p.questoes.some((q) => q.ativa)) return volta(c, "A prova não tem questões ativas.");
    await c.env.DB.prepare(`UPDATE provas SET estado = ?, publicada_em = CASE WHEN ? = 'publicada' THEN ? ELSE publicada_em END, atualizada_em = ? WHERE modulo = ?`)
      .bind(estado, estado, d.agora(), d.agora(), modulo).run();
    return volta(c, estado === "publicada" ? `Prova de "${modulo}" publicada — já aparece para os alunos que concluíram o módulo.` : `Prova de "${modulo}" despublicada.`);
  });

  r.post("/admin/provas/exigir", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const modulo = String(form.get("modulo") || "").trim(), exige = form.get("exige") === "1" ? 1 : 0;
    await garantirTabelasProvas(c.env);
    await c.env.DB.prepare(`UPDATE provas SET exige = ?, atualizada_em = ? WHERE modulo = ?`).bind(exige, d.agora(), modulo).run();
    return volta(c, exige ? `"${modulo}": as aulas seguintes só abrem depois da aprovação.` : `"${modulo}": prova opcional para avançar.`);
  });

  r.post("/admin/provas/ajustes", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const v = form.get("certificado_exige") === "1" ? "1" : "0";
    await garantirTabelasProvas(c.env);
    await c.env.DB.prepare(`INSERT INTO ajustes (chave, valor) VALUES ('certificado_exige_provas', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).bind(v).run();
    return volta(c, v === "1" ? "Certificado só para quem for aprovado em todas as provas publicadas." : "Certificado liberado ao concluir as aulas, sem exigir as provas.");
  });

  r.get("/admin/provas/:modulo", d.exigeAdmin, async (c) => {
    const modulo = c.req.param("modulo");
    const aulas = await aulasDoModulo(c, modulo);
    if (!aulas.length) return c.notFound();
    const [prova, erros] = await Promise.all([provaDe(c.env, modulo), errosPorQuestao(c.env, modulo)]);
    const q = c.req.query();
    const aviso = q.gerada ? `<div class="aviso">${q.gerada} questões geradas. Revise enunciados, alternativas e a referência de aula antes de publicar.</div>`
      : q.salva ? `<div class="aviso">Prova salva.</div>` : "";
    return c.html(paginaEditar({ escola: c.env.NOME_ESCOLA, admin: c.get("aluno"), prova, modulo, aulas, erros, aviso }));
  });

  r.post("/admin/provas/:modulo/salvar", d.exigeAdmin, async (c) => {
    const modulo = c.req.param("modulo");
    const aulas = await aulasDoModulo(c, modulo);
    if (!aulas.length) return c.notFound();
    const form = await c.req.formData();
    const g = (k: string) => String(form.get(k) ?? "").trim();
    const prova = await provaDe(c.env, modulo);
    const agora = d.agora();
    const stmts: any[] = [];
    const uids = aulas.map((a) => a.uid);
    const ref = (p: string) => ({ aula: uids.includes(g(`${p}aula`)) ? g(`${p}aula`) : null, segundo: g(`${p}segundo`) === "" ? null : Math.max(0, Math.floor(Number(g(`${p}segundo`)) || 0)) });
    for (const q of prova?.questoes ?? []) {
      const p = `q${q.id}_`;
      if (form.get(`${p}excluir`) === "1") { stmts.push(c.env.DB.prepare(`DELETE FROM questoes WHERE id = ?`).bind(q.id)); continue; }
      const { aula, segundo } = ref(p);
      if (q.tipo === "escolha") {
        const opcoes = [0, 1, 2, 3].map((k) => g(`${p}opcao${k}`).slice(0, 300)).filter(Boolean);
        const correta = Math.min(opcoes.length - 1, Math.max(0, Number(g(`${p}correta`)) || 0));
        stmts.push(c.env.DB.prepare(`UPDATE questoes SET enunciado = ?, opcoes = ?, correta = ?, explicacao = ?, aula_uid = ?, segundo = ?, ativa = ? WHERE id = ?`)
          .bind(g(`${p}enunciado`).slice(0, 600) || q.enunciado, JSON.stringify(opcoes.length >= 2 ? opcoes : q.opcoes), opcoes.length >= 2 ? correta : q.correta,
            g(`${p}explicacao`).slice(0, 600) || null, aula, segundo, form.get(`${p}ativa`) === "1" ? 1 : 0, q.id));
      } else {
        stmts.push(c.env.DB.prepare(`UPDATE questoes SET enunciado = ?, gabarito = ?, explicacao = ?, aula_uid = ?, segundo = ?, ativa = ? WHERE id = ?`)
          .bind(g(`${p}enunciado`).slice(0, 600) || q.enunciado, g(`${p}gabarito`).slice(0, 800) || null, g(`${p}explicacao`).slice(0, 600) || null, aula, segundo, form.get(`${p}ativa`) === "1" ? 1 : 0, q.id));
      }
    }
    // questão nova
    if (g("nova_enunciado")) {
      const tipo = g("nova_tipo") === "aberta" ? "aberta" : "escolha";
      const opcoes = [0, 1, 2, 3].map((k) => g(`nova_opcao${k}`).slice(0, 300)).filter(Boolean);
      const { aula, segundo } = ref("nova_");
      const n = (prova?.questoes.length ?? 0);
      if (tipo === "aberta" || opcoes.length >= 2) {
        if (!prova) stmts.push(c.env.DB.prepare(`INSERT INTO provas (modulo, estado, atualizada_em) VALUES (?,'rascunho',?) ON CONFLICT(modulo) DO NOTHING`).bind(modulo, agora));
        stmts.push(c.env.DB.prepare(`INSERT INTO questoes (modulo, n, tipo, enunciado, opcoes, correta, gabarito, explicacao, aula_uid, segundo, ativa) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
          .bind(modulo, n, tipo, g("nova_enunciado").slice(0, 600), JSON.stringify(tipo === "escolha" ? opcoes : []),
            tipo === "escolha" ? Math.min(opcoes.length - 1, Math.max(0, Number(g("nova_correta")) || 0)) : null,
            tipo === "aberta" ? g("nova_gabarito").slice(0, 800) || null : null, g("nova_explicacao").slice(0, 600) || null, aula, segundo));
      }
    }
    if (prova) stmts.push(c.env.DB.prepare(`UPDATE provas SET atualizada_em = ? WHERE modulo = ?`).bind(agora, modulo));
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.redirect(`${urlAdmin(modulo)}?salva=1`);
  });

  return r;
}
