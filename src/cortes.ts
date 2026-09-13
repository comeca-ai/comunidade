// Cortes para redes: a equipe pede um tema, o sistema acha os melhores
// trechos nas transcrições, a IA escolhe e delimita 3 cortes em fronteira de
// frase, alguém aprova, e o corte vira vídeo. Quem gera o vídeo:
//
//   1. o cortador (tools/cortar.mjs no GitHub Actions: acionado ao aprovar, se
//      há GH_TOKEN_CORTES, e de hora em hora) — pede a fila em POST /cortes/fila
//      com o segredo CORTES_CHAVE, corta com ffmpeg a partir do HLS público e
//      devolve em POST /cortes/retorno: vertical 1080×1920 com título e legenda
//      (Reels), LinkedIn 4:5 sem título, horizontal 16:9 e SRT, guardados no
//      R2 em cortes/<id>/…; o painel serve em /admin/cortes/:id/video.mp4;
//   2. ou o Stream (clipe + MP4 pela API REST) quando existe STREAM_API_TOKEN;
//   3. sem nenhum dos dois, o corte fica "aprovado" com início, fim, SRT e
//      texto do post — dá para cortar em qualquer editor.
//
// Etapas de um pedido: sugerido → aprovado → gerando → pronto | erro (ou
// descartado, que apaga). Tudo fica em `cortes` — é o histórico de pedidos.

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { esc, jsStr } from "./ui";
import { haQuanto, emSegundoPlano } from "./apoio";
import { transcricaoDe } from "./transcricao";
import { temModelos, modeloCortes, conversar, parecidos, avancarVetores } from "./modelos";
import { tempo, type Transcricao, type Frase } from "../packages/conteudo/transcricao";

const MODELO_IA = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MIN_SEG = 15, MAX_SEG = 120, ALVO_SEG = 75;
// um corte "gerando" há mais que isso sem retorno volta para a fila
const GERANDO_EXPIRA = 45 * 60;
const FORMATOS: Record<string, { ext: string; tipo: string }> = {
  vertical: { ext: "mp4", tipo: "video/mp4" }, linkedin: { ext: "mp4", tipo: "video/mp4" }, horizontal: { ext: "mp4", tipo: "video/mp4" },
  srt: { ext: "srt", tipo: "application/x-subrip; charset=utf-8" },
};
const chaveR2 = (id: number, formato: string) => `cortes/${id}/${formato}.${FORMATOS[formato].ext}`;

let esquemaCortesPronto = false;
export async function garantirTabelaCortes(env: any) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cortes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido TEXT NOT NULL, lote INTEGER NOT NULL,
    aula_uid TEXT NOT NULL, inicio REAL NOT NULL, fim REAL NOT NULL,
    titulo TEXT, gancho TEXT, porque TEXT, legenda TEXT, texto TEXT,
    estado TEXT NOT NULL, clip_uid TEXT, mp4 TEXT, erro TEXT,
    criado_em INTEGER NOT NULL, por TEXT, gerando_em INTEGER, modelo TEXT)`).run();
  if (esquemaCortesPronto) return;
  // tabela criada antes: ganha as colunas novas
  const info: any = await env.DB.prepare(`PRAGMA table_info(cortes)`).all();
  const colunas = new Set((info.results ?? []).map((r: any) => r.name));
  if (!colunas.has("gerando_em")) await env.DB.prepare(`ALTER TABLE cortes ADD COLUMN gerando_em INTEGER`).run();
  if (!colunas.has("modelo")) await env.DB.prepare(`ALTER TABLE cortes ADD COLUMN modelo TEXT`).run();
  esquemaCortesPronto = true;
}

// o cortador se identifica com o segredo CORTES_CHAVE (comparação em tempo constante)
export function chaveDoCortadorOk(env: any, cabecalho: string | undefined): boolean {
  const esperado = String(env.CORTES_CHAVE || ""), dado = String(cabecalho || "").replace(/^Bearer\s+/i, "");
  if (!esperado || esperado.length < 16 || dado.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < esperado.length; i++) dif |= esperado.charCodeAt(i) ^ dado.charCodeAt(i);
  return dif === 0;
}

// palavras da transcrição no intervalo — o cortador monta a legenda com elas
export function palavrasDoCorte(t: Transcricao, inicio: number, fim: number) {
  return t.paragrafos.flatMap((p) => p.p).filter((w) => w[1] >= inicio - 0.05 && w[2] <= fim + 0.05);
}

// vertical: entrevista/bancada fica melhor com as laterais cortadas (pessoa
// maior); aula com slide precisa do quadro inteiro
export function enquadramentoPara(modulo?: string | null, titulo?: string | null): "4x3" | "cheio" {
  return /entrevista|talks?\b|podcast|bate-papo|live\b|conversa|papo/i.test(`${modulo ?? ""} ${titulo ?? ""}`) ? "4x3" : "cheio";
}

// pede ao GitHub Actions para rodar o cortador agora (workflow_dispatch). Sem
// GH_TOKEN_CORTES (token fino, só Actions:write neste repositório) fica a
// rodada de hora em hora do próprio workflow.
export const temAcionador = (env: any) => !!(env.GH_TOKEN_CORTES && env.CORTES_REPOSITORIO);
export async function acionarCortador(env: any): Promise<boolean> {
  if (!temAcionador(env)) return false;
  try {
    const r = await fetch(`https://api.github.com/repos/${env.CORTES_REPOSITORIO}/actions/workflows/cortes.yml/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: "main" }),
      headers: { authorization: `Bearer ${env.GH_TOKEN_CORTES}`, accept: "application/vnd.github+json", "content-type": "application/json",
        "user-agent": "escola-classica (cortes)", "x-github-api-version": "2022-11-28" },
    });
    return r.status === 204;
  } catch { return false; }
}
export const urlAcoesCortador = (env: any) => env.CORTES_REPOSITORIO ? `https://github.com/${env.CORTES_REPOSITORIO}/actions/workflows/cortes.yml` : "";

/* ---------------- candidatos ---------------- */

export type Candidato = {
  n: number; uid: string; titulo: string; modulo: string; inicio: number; fim: number;
  frases: (Frase & { k: number })[]; pontos: number;
};

const normalizar = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const PARADAS = new Set(["sobre", "para", "corte", "cortes", "video", "trecho", "fala", "falando", "quero", "sobre", "como", "mais", "menos", "muito", "isso", "esse", "essa", "dele", "dela", "aula", "entrevista", "instagram", "reels", "reel", "post"]);

export function termosDe(pedido: string): string[] {
  return [...new Set(normalizar(pedido).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !PARADAS.has(t)))].slice(0, 8)
    // raiz simples: "precificacao" casa "precific"; "dados" casa "dado"
    .map((t) => t.length > 6 ? t.slice(0, Math.max(5, t.length - 2)) : t.replace(/s$/, ""));
}

// parágrafos mais próximos do pedido — por significado (vetores, quando há
// MODELOS_API_KEY) somado às palavras-chave — expandidos para janelas de até ~90 s
const SIM_MINIMA = 0.24; // abaixo disso o parágrafo não fala do assunto
export async function candidatosPara(env: any, pedido: string, maximo = 8): Promise<Candidato[]> {
  const termos = termosDe(pedido);
  let sim = new Map<string, number>();
  if (temModelos(env)) {
    try {
      await avancarVetores(env, Math.floor(Date.now() / 1000));
      sim = new Map((await parecidos(env, pedido, 30)).map((p) => [`${p.uid}:${p.n}`, p.sim]));
    } catch { sim = new Map(); }
  }
  if (!termos.length && !sim.size) return [];
  const r: any = await env.DB.prepare(
    `SELECT x.aula_uid AS uid, a.titulo, a.modulo, x.n, x.inicio, x.fim, x.texto
     FROM trechos x JOIN aulas a ON a.uid = x.aula_uid AND a.publicada = 1
     ORDER BY x.aula_uid, x.n`).all();
  const linhas: any[] = (r.results ?? []).map((l: any) => ({ ...l, norm: normalizar(String(l.texto)) }));
  // significado vale mais que a palavra literal: 0,30 de similaridade ≈ 3 termos casados
  const pontosDe = (l: any) => {
    const palavras = termos.reduce((s, t) => s + (l.norm.includes(t) ? 1 + Math.min(2, l.norm.split(t).length - 2) * 0.25 : 0), 0);
    const proximo = sim.get(`${l.uid}:${l.n}`) ?? 0;
    return (proximo >= SIM_MINIMA ? proximo * 10 : 0) + palavras;
  };
  const marcados = linhas.map((l) => ({ ...l, pontos: pontosDe(l) })).filter((l) => l.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || (b.fim - b.inicio) - (a.fim - a.inicio));
  if (!marcados.length) return [];

  // janela: o parágrafo e vizinhos (mesma aula) até ~90 s; evita sobreposição
  const porAula = new Map<string, any[]>();
  for (const l of linhas) { if (!porAula.has(l.uid)) porAula.set(l.uid, []); porAula.get(l.uid)!.push(l); }
  const usados = new Set<string>();
  const janelas: { uid: string; titulo: string; modulo: string; inicio: number; fim: number; ns: number[]; pontos: number }[] = [];
  for (const m of marcados) {
    if (janelas.length >= maximo) break;
    const lista = porAula.get(m.uid)!; const i = lista.findIndex((l) => l.n === m.n);
    let a = i, b = i;
    while (lista[b].fim - lista[a].inicio < 90) {
      const antes = a > 0 ? lista[a - 1] : null, depois = b < lista.length - 1 ? lista[b + 1] : null;
      const cabeAntes = antes && lista[b].fim - antes.inicio <= 90, cabeDepois = depois && depois.fim - lista[a].inicio <= 90;
      if (cabeDepois && (!cabeAntes || (depois.pontos ?? pontosDe(depois)) >= (antes.pontos ?? pontosDe(antes)))) b++;
      else if (cabeAntes) a--;
      else break;
    }
    const chave = `${m.uid}:${lista[a].n}-${lista[b].n}`;
    if ([...usados].some((u) => u.startsWith(m.uid + ":") && sobrepoe(u, chave))) continue;
    usados.add(chave);
    janelas.push({ uid: m.uid, titulo: m.titulo, modulo: m.modulo, inicio: lista[a].inicio, fim: lista[b].fim, ns: lista.slice(a, b + 1).map((l) => l.n), pontos: m.pontos });
  }

  // frases com tempo, da transcrição completa (R2 ou bundle)
  const cache = new Map<string, Transcricao | null>();
  const out: Candidato[] = [];
  for (const [n, j] of janelas.entries()) {
    if (!cache.has(j.uid)) cache.set(j.uid, await transcricaoDe(env, j.uid));
    const t = cache.get(j.uid);
    const frases: (Frase & { k: number })[] = [];
    if (t) for (const p of j.ns.map((k) => t.paragrafos[k]).filter(Boolean)) for (const f of p.frases) if (f.t) frases.push({ ...f, k: frases.length });
    if (!frases.length) frases.push({ t: "(sem frases com tempo)", i: j.inicio, f: j.fim, k: 0 });
    out.push({ n, uid: j.uid, titulo: j.titulo, modulo: j.modulo, inicio: j.inicio, fim: j.fim, frases, pontos: j.pontos });
  }
  return out;
}

function sobrepoe(a: string, b: string): boolean {
  const [a1, a2] = a.split(":")[1].split("-").map(Number), [b1, b2] = b.split(":")[1].split("-").map(Number);
  return a1 <= b2 && b1 <= a2;
}

/* ---------------- escolha pela IA ---------------- */

export type Sugestao = { candidato: number; primeira: number; ultima: number; titulo: string; gancho: string; porque: string; legenda: string };

const SISTEMA = `Você é editor de vídeo de uma escola de inteligência artificial para donos de negócio (começa.ai). Escolhe cortes de 30 a 90 segundos para Instagram Reels a partir de trechos transcritos de aulas e entrevistas. Um bom corte: começa numa frase que prende (pergunta, afirmação forte, história), tem uma ideia só e completa, termina numa frase de fechamento, e se entende sem contexto. Prefira opinião, história e provocação a tutorial de ferramenta, a não ser que o pedido peça tutorial. Título específico e verdadeiro, sem caça-clique. Responda SOMENTE com JSON válido.`;

function promptPara(pedido: string, cands: Candidato[]): string {
  const blocos = cands.map((c) => `### Candidato ${c.n} — "${c.titulo}" (${c.modulo}), ${tempo(c.inicio)}–${tempo(c.fim)}
${c.frases.map((f) => `[${f.k}] (${tempo(f.i)}) ${f.t}`).join("\n")}`).join("\n\n");
  return `Pedido da equipe: "${pedido}"

Escolha os 3 melhores cortes (ou menos, se só houver menos bons). Cada corte é um intervalo de frases de UM candidato: "primeira" e "ultima" são os números entre colchetes da primeira e da última frase, dentro do mesmo candidato, somando entre 30 e 90 segundos.

Responda com um array JSON, nesta forma exata:
[{"candidato":0,"primeira":2,"ultima":9,"titulo":"título curto para o corte","gancho":"a frase que abre","porque":"por que funciona, em uma linha","legenda":"texto do post para Instagram em português, 2 a 4 linhas, com 3 a 5 hashtags no fim"}]

${blocos}`;
}

// o editor-chefe é o modelo que pensa à vontade (Kimi K3: uns 3 min); só faz
// sentido com a aba aberta esperando — ver a resposta em stream na rota
export const modeloEditor = (env: any) => String(env.MODELO_CORTES_EDITOR || "");

export async function sugerirCortes(env: any, pedido: string, cands: Candidato[], o: { editor?: boolean; aoReceber?: (t: string) => void } = {}): Promise<{ sugestoes: Sugestao[]; ia: boolean; modelo: string }> {
  if (!cands.length) return { sugestoes: [], ia: false, modelo: "" };
  const prompt = promptPara(pedido, cands);
  let lidas: Sugestao[] = [], usado = "";
  // 1º o modelo externo (Model Studio), 2º o Workers AI, 3º sem IA
  if (temModelos(env)) {
    const editor = !!o.editor && !!modeloEditor(env);
    const modelo = editor ? modeloEditor(env) : modeloCortes(env);
    try {
      const bruto = editor
        ? await conversar(env, { sistema: SISTEMA, usuario: prompt, maxTokens: 9000, modelo, raciocinio: true, aoReceber: o.aoReceber })
        : await conversar(env, { sistema: SISTEMA, usuario: prompt, maxTokens: 1600, modelo });
      lidas = interpretar(bruto, cands);
      if (lidas.length) usado = modelo;
    } catch { lidas = []; }
  }
  if (!lidas.length && env.AI?.run) {
    try {
      const r: any = await env.AI.run(MODELO_IA, { messages: [{ role: "system", content: SISTEMA }, { role: "user", content: prompt }], max_tokens: 1400, temperature: 0.3 });
      lidas = interpretar(r?.choices?.[0]?.message?.content ?? r?.response ?? "", cands);
      if (lidas.length) usado = MODELO_IA.replace("@cf/meta/", "");
    } catch { lidas = []; }
  }
  if (lidas.length) return { sugestoes: lidas, ia: true, modelo: usado };
  // sem IA (ou resposta inválida): os 3 candidatos mais fortes, inteiros
  return { sugestoes: cands.slice(0, 3).map((c) => ({ candidato: c.n, primeira: 0, ultima: c.frases.length - 1,
    titulo: c.titulo, gancho: c.frases[0]?.t ?? "", porque: "trecho com mais menções ao tema (sem IA)", legenda: "" })), ia: false, modelo: "" };
}

export function interpretar(bruto: string, cands: Candidato[]): Sugestao[] {
  const m = bruto.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: any[];
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Sugestao[] = [];
  for (const x of arr) {
    const c = cands.find((k) => k.n === Number(x?.candidato));
    if (!c) continue;
    let a = Math.max(0, Math.min(c.frases.length - 1, Number(x.primeira) || 0));
    let b = Math.max(a, Math.min(c.frases.length - 1, Number(x.ultima) || a));
    // ajusta a duração para a faixa aceitável, esticando/encolhendo pelo fim
    while (c.frases[b].f - c.frases[a].i > MAX_SEG && b > a) b--;
    while (c.frases[b].f - c.frases[a].i < MIN_SEG && b < c.frases.length - 1) b++;
    if (c.frases[b].f - c.frases[a].i < MIN_SEG) continue;
    out.push({ candidato: c.n, primeira: a, ultima: b, titulo: String(x.titulo || c.titulo).slice(0, 120), gancho: String(x.gancho || c.frases[a].t).slice(0, 300),
      porque: String(x.porque || "").slice(0, 300), legenda: String(x.legenda || "").slice(0, 1500) });
    if (out.length >= 3) break;
  }
  return out;
}

/* ---------------- clipe no Stream ---------------- */

// cria o clipe pela API REST (o binding não tem clip) e pede o MP4 pelo binding
export async function gerarClipe(env: any, corte: any): Promise<{ clip_uid: string }> {
  if (!env.STREAM_API_TOKEN || !env.CF_ACCOUNT_ID) throw new Error("sem STREAM_API_TOKEN/CF_ACCOUNT_ID no Worker");
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/clip`, {
    method: "POST", headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clippedFromVideoUID: corte.aula_uid, startTimeSeconds: Math.floor(corte.inicio), endTimeSeconds: Math.ceil(corte.fim),
      meta: { name: `[corte] ${corte.titulo || corte.pedido}` } }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.result?.uid) throw new Error(`clip: ${r.status} ${JSON.stringify(j?.errors ?? "").slice(0, 200)}`);
  return { clip_uid: j.result.uid };
}

// quando o clipe está pronto, liga o download e devolve a URL do MP4
export async function mp4DoClipe(env: any, clipUid: string): Promise<string | null> {
  const v = env.STREAM.video(clipUid);
  const det: any = await v.details().catch(() => null);
  if (det && det.readyToStream === false) return null;
  let d: any = await v.downloads.get().catch(() => null);
  const padrao = d?.default ?? d?.result?.default;
  if (!padrao) { d = await v.downloads.generate(); }
  const p2 = d?.default ?? d?.result?.default ?? padrao;
  return p2?.status === "ready" && p2?.url ? String(p2.url) : null;
}

// SRT do corte: palavras da transcrição no intervalo, relativas ao início
export function srtDoCorte(t: Transcricao, inicio: number, fim: number): string {
  const palavras = palavrasDoCorte(t, inicio, fim);
  const ts = (seg: number) => { const s = Math.max(0, seg); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(r)).padStart(2, "0")},${String(Math.round((r % 1) * 1000)).padStart(3, "0")}`; };
  const linhas: string[] = []; let n = 0, bloco: typeof palavras = [];
  const fecha = () => { if (!bloco.length) return; linhas.push(String(++n), `${ts(bloco[0][1] - inicio)} --> ${ts(bloco.at(-1)![2] - inicio)}`, bloco.map((w) => w[0]).join(" "), ""); bloco = []; };
  for (const w of palavras) { bloco.push(w); if (bloco.length >= 6 || w[2] - bloco[0][1] >= 3 || /[.!?]$/.test(w[0])) fecha(); }
  fecha();
  return linhas.join("\n");
}

/* ---------------- tela ---------------- */

// página mostrada enquanto o editor-chefe pensa (a resposta fica aberta)
export function paginaEspera(modelo: string, pedido: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Editor-chefe pensando…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E0E0D;color:#fff;font:16px/1.5 system-ui,sans-serif}
.c{max-width:520px;padding:32px;text-align:center}.p{color:#C8F55A;font-size:40px;font-variant-numeric:tabular-nums}.m{color:#a6a6a6}
.b{height:4px;background:#222;border-radius:2px;overflow:hidden;margin:18px 0}.b i{display:block;height:100%;width:0;background:#C8F55A;transition:width 1s linear}</style></head>
<body><div class="c"><p class="m">Editor-chefe · ${esc(modelo)}</p><h1 style="font-weight:600;font-size:22px;margin:6px 0 4px">Lendo os trechos e escolhendo os cortes</h1>
<p class="m">"${esc(pedido)}"</p><div class="b"><i id="b"></i></div><div class="p" id="t">0:00</div>
<p class="m">Leva uns 3 a 5 minutos. Deixe esta aba aberta — fechar cancela o pedido. Ao terminar, você volta ao painel sozinho.</p></div>
<script>var s=0;setInterval(function(){s++;document.getElementById("t").textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");document.getElementById("b").style.width=Math.min(97,s/3)+"%";},1000);</script>
`;
}

export function secaoCortes(o: { pedido: string; cortes: any[]; temToken: boolean; temFila?: boolean; acionador?: boolean; urlAcoes?: string; temIA: boolean; rotuloIA?: string; rotuloRapido?: string; editor?: string; aviso?: string; agora: number }): string {
  const lotes = new Map<number, any[]>();
  for (const c of o.cortes) { if (!lotes.has(c.lote)) lotes.set(c.lote, []); lotes.get(c.lote)!.push(c); }
  const gera = o.temFila || o.temToken;
  const prazo = o.acionador ? "uns 3 min" : "até 1 h";
  const estado = (c: any) => c.estado === "pronto" ? `<span class="etiqueta ok">vídeo pronto</span>`
    : c.estado === "gerando" ? `<span class="etiqueta atencao">${c.clip_uid ? "gerando no Stream" : "gerando o vídeo · uns minutos"}</span>`
    : c.estado === "aprovado" ? `<span class="etiqueta ok">${o.temFila ? `aprovado · na fila do cortador · ${prazo}` : "aprovado"}</span>`
    : c.estado === "erro" ? `<span class="etiqueta alerta" title="${esc(c.erro || "")}">erro</span>`
    : `<span class="etiqueta neutro">sugerido</span>`;
  const acionar = o.temFila && !o.acionador && o.urlAcoes
    ? ` · o cortador roda de hora em hora — <a href="${esc(o.urlAcoes)}" target="_blank" rel="noopener">acionar agora no GitHub ↗</a> (Run workflow)` : "";
  const comoGera = o.temFila ? `ao aprovar, o cortador gera o vertical com legenda (Reels) e o horizontal em ${prazo}${acionar}`
    : o.temToken ? "clipe e MP4 pelo Stream ao aprovar"
    : "sem cortador configurado (CORTES_CHAVE): ao aprovar, fica com início/fim, SRT e texto — corte em qualquer editor";
  return `<div id="cortes" style="margin-top:26px">
    ${o.aviso ?? ""}
    <form method="post" action="/admin/cortes/sugerir" class="card">
      <p class="mono">Pedir um corte</p>
      <p style="margin-top:8px;color:var(--muted);max-width:66ch">Descreva o tema ou a mensagem. O sistema procura nas transcrições, a IA escolhe até 3 trechos
        de 30 a 90 s com início e fim em frase inteira, e escreve a legenda do post. Você confere no player e aprova.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">
        <input class="campo" style="flex:1;min-width:260px" type="text" name="pedido" required maxlength="200" value="${esc(o.pedido)}"
          placeholder="ex.: dados no varejo · por que a IA não substitui o dono · como começar com IA sem equipe">
        ${o.editor ? `<select class="campo" name="modo" style="flex:0 1 auto" title="Quem escolhe os cortes">
          <option value="rapido">Rápido · ${esc(o.rotuloRapido || "modelo rápido")} · ~15 s</option>
          <option value="editor">Editor-chefe · ${esc(o.editor)} · 3 a 5 min, aba aberta</option>
        </select>` : ""}
        <button class="btn btn-primario" type="submit">Sugerir cortes</button>
      </div>
      <p class="aula-meta" style="margin-top:8px">${o.rotuloIA ? esc(o.rotuloIA) : o.temIA ? "IA: Workers AI (Llama 4) · busca por palavra" : "sem IA no Worker: ordena por palavras-chave"} · ${comoGera}</p>
    </form>

    ${[...lotes.entries()].map(([lote, lista]) => `<section class="modulo">
      <div class="modulo-topo"><h2>"${esc(lista[0].pedido)}"</h2><span class="mono">${haQuanto(lista[0].criado_em, o.agora)} · ${lista.length} corte${lista.length === 1 ? "" : "s"}${lista[0].modelo ? ` · ${esc(lista[0].modelo)}` : ""}</span></div>
      ${lista.map((c: any) => `<div class="aula corte" style="cursor:default;align-items:flex-start;flex-wrap:wrap">
        <span class="num-aula">${tempo(c.inicio)}</span>
        <span class="aula-txt">
          <b>${esc(c.titulo || "Corte")} ${estado(c)}</b>
          <span class="aula-meta">${esc(c.aula_titulo || c.aula_uid)} · ${tempo(c.inicio)}–${tempo(c.fim)} · ${Math.round(c.fim - c.inicio)} s${c.por ? ` · pedido por ${esc(c.por)}` : ""}</span>
          ${c.gancho ? `<span class="aula-meta" style="display:block;margin-top:6px;color:var(--texto)">“${esc(c.gancho)}”</span>` : ""}
          ${c.porque ? `<span class="aula-meta" style="display:block;margin-top:4px">${esc(c.porque)}</span>` : ""}
          ${c.legenda ? `<details style="margin-top:6px"><summary class="aula-meta" style="cursor:pointer">texto do post</summary>
            <pre style="white-space:pre-wrap;font:inherit;font-size:14px;margin:6px 0 0;color:var(--texto)">${esc(c.legenda)}</pre></details>` : ""}
          ${c.estado === "erro" && c.erro ? `<span class="aula-meta" style="display:block;margin-top:4px;color:var(--alerta,#b42318)">${esc(c.erro)}</span>` : ""}
        </span>
        <span class="acoes" style="flex:0 0 100%;margin-left:50px;display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${c.estado === "pronto" && c.mp4 ? (c.mp4.startsWith("/admin/")
            ? `<a class="btn btn-primario" href="/admin/cortes/${c.id}/video.mp4?f=vertical">Baixar vertical (Reels)</a>
               <a class="btn btn-fantasma" href="/admin/cortes/${c.id}/video.mp4?f=linkedin">Baixar LinkedIn (4:5)</a>
               <a class="btn btn-fantasma" href="/admin/cortes/${c.id}/video.mp4?f=horizontal">Baixar horizontal</a>`
            : `<a class="btn btn-primario" href="${esc(c.mp4)}" target="_blank" rel="noopener">Baixar MP4 ↗</a>`) : ""}
          <a class="btn btn-fantasma" href="/app/aula/${esc(c.aula_uid)}?t=${Math.floor(c.inicio)}" target="_blank" rel="noopener">Ver no player</a>
          <a class="btn btn-fantasma" href="/admin/cortes/${c.id}/legenda.srt">Legenda SRT</a>
          ${c.estado === "sugerido" ? `<form method="post" action="/admin/cortes/${c.id}/aprovar"><button class="btn btn-primario" type="submit">Aprovar${gera ? " e gerar" : ""}</button></form>` : ""}
          ${(c.estado === "aprovado" || c.estado === "erro") && o.temToken && !o.temFila ? `<form method="post" action="/admin/cortes/${c.id}/gerar"><button class="btn btn-fantasma" type="submit">Gerar MP4</button></form>` : ""}
          ${c.estado === "erro" && o.temFila ? `<form method="post" action="/admin/cortes/${c.id}/refazer"><button class="btn btn-fantasma" type="submit">Tentar de novo</button></form>` : ""}
          ${c.estado === "pronto" && o.temFila && !c.clip_uid ? `<form method="post" action="/admin/cortes/${c.id}/refazer" onsubmit="return confirm(${jsStr("Gerar de novo substitui os arquivos deste corte. Continuar?")})"><button class="btn btn-fantasma" type="submit">Gerar de novo</button></form>` : ""}
          ${c.estado === "gerando" && c.clip_uid ? `<form method="post" action="/admin/cortes/${c.id}/gerar"><button class="btn btn-fantasma" type="submit">Conferir</button></form>` : ""}
          <form method="post" action="/admin/cortes/${c.id}/descartar" onsubmit="return confirm(${jsStr(`Descartar o corte "${c.titulo || ""}"?`)})"><button class="btn btn-fantasma" type="submit">Descartar</button></form>
        </span>
      </div>`).join("")}
    </section>`).join("") || `<p class="vazio">Nenhum pedido de corte ainda.</p>`}
  </div>`;
}

export async function cortesRecentes(env: any, limite = 30): Promise<any[]> {
  const r: any = await env.DB.prepare(
    `SELECT c.*, a.titulo AS aula_titulo FROM cortes c LEFT JOIN aulas a ON a.uid = c.aula_uid
     ORDER BY c.lote DESC, c.id ASC LIMIT ?`).bind(limite).all();
  return r.results ?? [];
}

/* ---------------- rotas ---------------- */

type Deps = { exigeAdmin: any; agora: () => number };

export function rotasCortes(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();
  const volta = (msg: string) => `/admin?aba=inteligencia&corte=${encodeURIComponent(msg)}#cortes`;

  r.post("/admin/cortes/sugerir", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const pedido = String(form.get("pedido") || "").trim().slice(0, 200);
    if (!pedido) return c.redirect(volta("Descreva o tema do corte."));
    const editor = String(form.get("modo") || "") === "editor" && temModelos(c.env) && !!modeloEditor(c.env);
    await garantirTabelaCortes(c.env);
    const admin = c.get("aluno");

    // acha, escolhe e grava; devolve a mensagem para o painel
    const rodar = async (aoReceber?: (t: string) => void): Promise<string> => {
      const agora = d.agora(), lote = Date.now(); // lote em ms: dois pedidos no mesmo segundo não se misturam
      const cands = await candidatosPara(c.env, pedido);
      if (!cands.length) return `Nada nas transcrições sobre "${pedido}". Tente outras palavras.`;
      const { sugestoes, ia, modelo } = await sugerirCortes(c.env, pedido, cands, { editor, aoReceber });
      const stmts = sugestoes.map((s) => {
        const cand = cands.find((k) => k.n === s.candidato)!;
        const ini = cand.frases[s.primeira].i, fim = cand.frases[s.ultima].f;
        const texto = cand.frases.slice(s.primeira, s.ultima + 1).map((f) => f.t).join(" ");
        return c.env.DB.prepare(`INSERT INTO cortes (pedido, lote, aula_uid, inicio, fim, titulo, gancho, porque, legenda, texto, estado, criado_em, por, modelo)
          VALUES (?,?,?,?,?,?,?,?,?,?,'sugerido',?,?,?)`).bind(pedido, lote, cand.uid, ini, fim, s.titulo, s.gancho, s.porque, s.legenda, texto, agora, admin?.email ?? null, modelo || null);
      });
      await c.env.DB.batch(stmts);
      return `${sugestoes.length} corte${sugestoes.length === 1 ? "" : "s"} sugerido${sugestoes.length === 1 ? "" : "s"}${ia ? (modelo ? ` por ${modelo}` : "") : " (sem IA — ordenado por palavras-chave)"}`;
    };

    if (!editor) return c.redirect(volta(await rodar()));

    // editor-chefe: o modelo pensa uns minutos. A resposta começa na hora (página
    // de espera) e vai recebendo um sinal de vida enquanto o modelo escreve;
    // no fim, um redirecionamento para o painel. Fechar a aba cancela.
    return stream(c, async (s) => {
      c.header("content-type", "text/html; charset=utf-8");
      await s.write(paginaEspera(modeloEditor(c.env), pedido));
      let ultimo = Date.now();
      const sinal = async () => { if (Date.now() - ultimo > 8000) { ultimo = Date.now(); await s.write("<!-- pensando -->\n"); } };
      const pulso = setInterval(() => { sinal().catch(() => {}); }, 5000);
      let msg: string;
      try { msg = await rodar(() => { sinal().catch(() => {}); }); }
      catch (e: any) { msg = `Erro no editor-chefe: ${String(e?.message ?? e).slice(0, 120)}`; }
      finally { clearInterval(pulso); }
      await s.write(`<script>location.replace(${JSON.stringify(volta(msg))})</script></body></html>`);
    });
  });

  r.post("/admin/cortes/:id/aprovar", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    await c.env.DB.prepare(`UPDATE cortes SET estado='aprovado', erro=NULL WHERE id=? AND estado='sugerido'`).bind(id).run();
    if (c.env.CORTES_CHAVE) {
      await emSegundoPlano(c, acionarCortador(c.env));
      return c.redirect(volta(`Corte aprovado e na fila: o cortador gera o vertical com legenda e o horizontal em ${temAcionador(c.env) ? "uns 3 min" : "até 1 h"}. Os botões de baixar aparecem aqui.`));
    }
    if (c.env.STREAM_API_TOKEN && c.env.CF_ACCOUNT_ID) return gerar(c, id);
    return c.redirect(volta("Corte aprovado. Sem cortador configurado o vídeo não é gerado aqui — use início/fim e o SRT no editor."));
  });

  // corte com erro volta para a fila do cortador
  r.post("/admin/cortes/:id/refazer", d.exigeAdmin, async (c) => {
    await c.env.DB.prepare(`UPDATE cortes SET estado='aprovado', erro=NULL, gerando_em=NULL, mp4=NULL
      WHERE id=? AND clip_uid IS NULL AND estado IN ('erro','gerando','pronto')`).bind(Number(c.req.param("id"))).run();
    await emSegundoPlano(c, acionarCortador(c.env));
    return c.redirect(volta("Corte de volta na fila do cortador."));
  });

  r.post("/admin/cortes/:id/gerar", d.exigeAdmin, async (c) => gerar(c, Number(c.req.param("id"))));

  /* ---- cortador (GitHub Actions) — autenticado pelo segredo CORTES_CHAVE ---- */

  // entrega até 3 cortes aprovados e os marca como "gerando"; os que ficaram
  // gerando tempo demais (execução que morreu) voltam antes para a fila
  r.post("/cortes/fila", async (c) => {
    if (!chaveDoCortadorOk(c.env, c.req.header("authorization"))) return c.text("sem autorização", 401);
    await garantirTabelaCortes(c.env);
    const agora = d.agora();
    await c.env.DB.prepare(`UPDATE cortes SET estado='aprovado', gerando_em=NULL WHERE estado='gerando' AND clip_uid IS NULL AND (gerando_em IS NULL OR gerando_em < ?)`)
      .bind(agora - GERANDO_EXPIRA).run();
    const r0: any = await c.env.DB.prepare(`SELECT c.*, a.titulo AS aula_titulo, a.modulo AS aula_modulo FROM cortes c LEFT JOIN aulas a ON a.uid = c.aula_uid
      WHERE c.estado='aprovado' AND c.clip_uid IS NULL ORDER BY c.id LIMIT 3`).all();
    const lista: any[] = r0.results ?? [];
    const cortes: any[] = [];
    for (const k of lista) {
      const t = await transcricaoDe(c.env, k.aula_uid);
      cortes.push({ id: k.id, uid: k.aula_uid, inicio: k.inicio, fim: k.fim, titulo: k.titulo || "", legenda: k.legenda || "",
        enquadramento: enquadramentoPara(k.aula_modulo, k.aula_titulo), palavras: t ? palavrasDoCorte(t, k.inicio, k.fim) : [] });
    }
    if (lista.length) await c.env.DB.batch(lista.map((k) => c.env.DB.prepare(`UPDATE cortes SET estado='gerando', gerando_em=? WHERE id=?`).bind(agora, k.id)));
    return c.json({ cortes });
  });

  // recebe um arquivo do corte (vertical | horizontal | srt) ou um erro;
  // o vertical é o que marca o corte como pronto
  r.post("/cortes/retorno", async (c) => {
    if (!chaveDoCortadorOk(c.env, c.req.header("authorization"))) return c.text("sem autorização", 401);
    const id = Number(c.req.query("id"));
    const corte: any = id ? await c.env.DB.prepare(`SELECT id, estado, clip_uid FROM cortes WHERE id=?`).bind(id).first() : null;
    if (!corte || corte.clip_uid) return c.text("corte não encontrado", 404);
    const erro = c.req.query("erro");
    if (erro) {
      await c.env.DB.prepare(`UPDATE cortes SET estado='erro', erro=? WHERE id=?`).bind(String(erro).slice(0, 300), id).run();
      return c.json({ ok: true });
    }
    const formato = String(c.req.query("formato") || "");
    if (!FORMATOS[formato]) return c.text("formato inválido", 400);
    const corpo = await c.req.arrayBuffer();
    if (corpo.byteLength < 100) return c.text("arquivo vazio", 400);
    await c.env.SLIDES.put(chaveR2(id, formato), corpo, { httpMetadata: { contentType: FORMATOS[formato].tipo } });
    if (formato === "vertical") await c.env.DB.prepare(`UPDATE cortes SET estado='pronto', mp4=?, erro=NULL WHERE id=?`).bind(`/admin/cortes/${id}/video.mp4`, id).run();
    return c.json({ ok: true, bytes: corpo.byteLength });
  });

  // download do vídeo gerado pelo cortador (R2), só para admin
  r.get("/admin/cortes/:id/video.mp4", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id")), formato = String(c.req.query("f") || "vertical");
    if (formato !== "vertical" && formato !== "horizontal" && formato !== "linkedin") return c.text("formato inválido", 400);
    const corte: any = await c.env.DB.prepare(`SELECT id, titulo FROM cortes WHERE id=?`).bind(id).first();
    if (!corte) return c.notFound();
    const obj = await c.env.SLIDES.get(chaveR2(id, formato));
    if (!obj) return c.text("este formato ainda não foi gerado", 404);
    const nome = `corte-${id}-${String(corte.titulo || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "video"}-${formato}.mp4`;
    return new Response(obj.body, { headers: { "content-type": "video/mp4", "content-length": String(obj.size), "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${nome}"` } });
  });

  async function gerar(c: any, id: number) {
    const corte: any = await c.env.DB.prepare(`SELECT * FROM cortes WHERE id=?`).bind(id).first();
    if (!corte) return c.notFound();
    try {
      if (!corte.clip_uid) {
        const { clip_uid } = await gerarClipe(c.env, corte);
        await c.env.DB.prepare(`UPDATE cortes SET estado='gerando', clip_uid=?, erro=NULL WHERE id=?`).bind(clip_uid, id).run();
        return c.redirect(volta("Clipe pedido ao Stream — leva alguns minutos. Clique em Conferir para pegar o MP4."));
      }
      const mp4 = await mp4DoClipe(c.env, corte.clip_uid);
      if (!mp4) return c.redirect(volta("O Stream ainda está processando o clipe. Tente de novo em um minuto."));
      await c.env.DB.prepare(`UPDATE cortes SET estado='pronto', mp4=?, erro=NULL WHERE id=?`).bind(mp4, id).run();
      return c.redirect(volta("MP4 pronto."));
    } catch (e: any) {
      await c.env.DB.prepare(`UPDATE cortes SET estado='erro', erro=? WHERE id=?`).bind(String(e?.message ?? e).slice(0, 300), id).run();
      return c.redirect(volta(`Erro ao gerar: ${String(e?.message ?? e).slice(0, 120)}`));
    }
  }

  r.post("/admin/cortes/:id/descartar", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    await c.env.DB.prepare(`DELETE FROM cortes WHERE id=?`).bind(id).run();
    // arquivos gerados pelo cortador saem junto
    await c.env.SLIDES.delete(Object.keys(FORMATOS).map((f) => chaveR2(id, f))).catch(() => {});
    return c.redirect(volta("Corte descartado."));
  });

  r.get("/admin/cortes/:id/legenda.srt", d.exigeAdmin, async (c) => {
    const corte: any = await c.env.DB.prepare(`SELECT * FROM cortes WHERE id=?`).bind(Number(c.req.param("id"))).first();
    if (!corte) return c.notFound();
    const t = await transcricaoDe(c.env, corte.aula_uid);
    if (!t) return c.text("sem transcrição", 404);
    return new Response(srtDoCorte(t, corte.inicio, corte.fim), { headers: { "content-type": "application/x-subrip; charset=utf-8",
      "content-disposition": `attachment; filename="corte-${corte.id}.srt"` } });
  });

  return r;
}
