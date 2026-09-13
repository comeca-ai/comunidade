// Transcrições das aulas: guarda, busca e mantém.
//
// Duas origens, mesmo formato (packages/conteudo/transcricao.ts):
//   1. arquivos versionados em apps/classica/transcricoes/ (gerados por
//      tools/transcrever.mjs) — semeados no banco pelo cron e pelo painel;
//   2. o próprio Worker, para vídeo novo, quando existe o segredo
//      DEEPGRAM_API_KEY: liga o download em MP4 no Stream, manda a URL para a
//      API pré-gravada do Deepgram com callback, e recebe o resultado em
//      POST /deepgram/retorno (chave aleatória por pedido).
//
// O JSON compacto fica no R2 (transcricoes/<uid>.json); o D1 guarda o estado
// por aula e os trechos (um por parágrafo) que alimentam a busca e os cortes.
// De brinde, sobe a legenda (VTT) no Stream — o aluno ganha CC no player.

import { Hono } from "hono";
import { esc } from "./ui";
import { avancarVetores } from "./modelos";
import { emSegundoPlano } from "./apoio";
import { compactar, paraVtt, textoDo, tempo, KEYTERMS, type Transcricao } from "../packages/conteudo/transcricao";
import { TRANSCRICOES } from "../transcricoes/index";

export const PARAMS_DEEPGRAM = "model=nova-3&language=pt-BR&punctuate=true&diarize=true&paragraphs=true&" +
  KEYTERMS.map((k) => `keyterm=${encodeURIComponent(k)}`).join("&");

/* ---------------- esquema ---------------- */

export async function garantirTabelasTranscricao(env: any) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS transcricoes (
      aula_uid  TEXT PRIMARY KEY,
      estado    TEXT NOT NULL,          -- download | enviado | pronto | erro
      chave     TEXT,                   -- segredo do callback deste pedido
      modelo    TEXT, idioma TEXT, duracao REAL, falantes INTEGER,
      erro      TEXT,
      pedida_em INTEGER, criada_em INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS trechos (
      aula_uid TEXT NOT NULL, n INTEGER NOT NULL,
      inicio REAL NOT NULL, fim REAL NOT NULL, falante INTEGER, texto TEXT NOT NULL,
      PRIMARY KEY (aula_uid, n))`),
  ]);
}

/* ---------------- guardar e ler ---------------- */

const chaveR2 = (uid: string) => `transcricoes/${uid}.json`;

export async function guardarTranscricao(env: any, t: Transcricao, agora: number) {
  await env.SLIDES.put(chaveR2(t.uid), JSON.stringify(t), { httpMetadata: { contentType: "application/json" } });
  const stmts = [
    env.DB.prepare(`INSERT INTO transcricoes (aula_uid, estado, modelo, idioma, duracao, falantes, criada_em)
        VALUES (?,'pronto',?,?,?,?,?)
        ON CONFLICT(aula_uid) DO UPDATE SET estado='pronto', chave=NULL, erro=NULL, modelo=excluded.modelo,
          idioma=excluded.idioma, duracao=excluded.duracao, falantes=excluded.falantes, criada_em=excluded.criada_em`)
      .bind(t.uid, t.modelo, t.idioma, t.duracao, t.falantes, agora),
    env.DB.prepare(`DELETE FROM trechos WHERE aula_uid = ?`).bind(t.uid),
    ...t.paragrafos.map((p, n) => env.DB.prepare(
      `INSERT INTO trechos (aula_uid, n, inicio, fim, falante, texto) VALUES (?,?,?,?,?,?)`)
      .bind(t.uid, n, p.i, p.f, p.q, textoDo(p))),
  ];
  // D1 aceita lotes grandes, mas em fatias fica mais previsível
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

export async function transcricaoDe(env: any, uid: string): Promise<Transcricao | null> {
  try {
    const obj = await env.SLIDES.get(chaveR2(uid));
    if (obj) return await obj.json();
  } catch { /* R2 indisponível: cai no bundle */ }
  return TRANSCRICOES[uid] ?? null;
}

// o que está no bundle, existe como aula e ainda não está no banco entra
// agora — idempotente, barato (uma consulta quando não há nada a fazer)
export async function semearDoBundle(env: any, agora: number): Promise<number> {
  const uids = Object.keys(TRANSCRICOES);
  if (!uids.length) return 0;
  const marcas = uids.map(() => "?").join(",");
  const r: any = await env.DB.prepare(
    `SELECT a.uid FROM aulas a LEFT JOIN transcricoes t ON t.aula_uid = a.uid AND t.estado = 'pronto'
     WHERE a.uid IN (${marcas}) AND t.aula_uid IS NULL`).bind(...uids).all();
  let n = 0;
  for (const { uid } of (r.results ?? [])) { await guardarTranscricao(env, TRANSCRICOES[uid], agora); n++; }
  return n;
}

export type EstadoAula = { uid: string; titulo: string; modulo: string; duracao_seg: number; estado: string | null; erro: string | null; paragrafos: number };

export async function estadoDasAulas(env: any): Promise<EstadoAula[]> {
  const r: any = await env.DB.prepare(
    `SELECT a.uid, a.titulo, a.modulo, a.duracao_seg, t.estado, t.erro,
       (SELECT COUNT(*) FROM trechos x WHERE x.aula_uid = a.uid) AS paragrafos
     FROM aulas a LEFT JOIN transcricoes t ON t.aula_uid = a.uid
     WHERE a.publicada = 1 ORDER BY a.modulo, a.ordem, a.criada_em`).all();
  return r.results ?? [];
}

/* ---------------- pipeline no Worker (vídeo novo) ---------------- */

const novaChave = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Avança cada aula pendente um passo por chamada (o cron roda a cada 15 min):
// sem linha → pede o MP4 ao Stream; download pronto → manda ao Deepgram;
// enviado há mais de 1 h sem retorno → tenta de novo. Sem a chave, não faz nada.
export async function avancarTranscricoes(env: any, agora: number, limite = 4): Promise<string[]> {
  const feito: string[] = [];
  if (!env.DEEPGRAM_API_KEY || !env.STREAM || !env.DOMINIO) return feito;
  const r: any = await env.DB.prepare(
    `SELECT a.uid, t.estado, t.pedida_em FROM aulas a LEFT JOIN transcricoes t ON t.aula_uid = a.uid
     WHERE a.publicada = 1 AND (t.estado IS NULL OR t.estado IN ('download','enviado')) LIMIT ?`).bind(limite).all();
  for (const a of (r.results ?? [])) {
    try {
      const video = env.STREAM.video(a.uid);
      if (!a.estado) {
        await video.downloads.generate();
        await env.DB.prepare(`INSERT INTO transcricoes (aula_uid, estado, pedida_em) VALUES (?,'download',?)
          ON CONFLICT(aula_uid) DO UPDATE SET estado='download', erro=NULL, pedida_em=excluded.pedida_em`).bind(a.uid, agora).run();
        feito.push(`${a.uid}: download pedido`);
        continue;
      }
      if (a.estado === "enviado" && (a.pedida_em ?? 0) > agora - 3600) continue;
      const d: any = await video.downloads.get();
      const padrao = d?.default ?? d?.result?.default ?? d;
      if (padrao?.status !== "ready" || !padrao?.url) { feito.push(`${a.uid}: download ${padrao?.status ?? "?"}`); continue; }
      const chave = novaChave();
      const callback = `https://${env.DOMINIO}/deepgram/retorno?uid=${a.uid}&chave=${chave}`;
      const resp = await fetch(`https://api.deepgram.com/v1/listen?${PARAMS_DEEPGRAM}&callback=${encodeURIComponent(callback)}`, {
        method: "POST", headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: padrao.url }),
      });
      if (!resp.ok) throw new Error(`deepgram ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      await env.DB.prepare(`UPDATE transcricoes SET estado='enviado', chave=?, pedida_em=?, erro=NULL WHERE aula_uid=?`).bind(chave, agora, a.uid).run();
      feito.push(`${a.uid}: enviado ao Deepgram`);
    } catch (e: any) {
      await env.DB.prepare(`INSERT INTO transcricoes (aula_uid, estado, erro, pedida_em) VALUES (?,'erro',?,?)
        ON CONFLICT(aula_uid) DO UPDATE SET estado='erro', erro=excluded.erro`).bind(a.uid, String(e?.message ?? e).slice(0, 300), agora).run();
      feito.push(`${a.uid}: erro ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return feito;
}

// legenda no player do Stream — um brinde; qualquer falha é ignorada
async function subirLegenda(env: any, t: Transcricao) {
  try {
    const vtt = new Blob([paraVtt(t)], { type: "text/vtt" });
    await env.STREAM.video(t.uid).captions.upload(t.idioma.startsWith("pt") ? "pt-BR" : t.idioma, vtt.stream());
  } catch { /* sem legenda não é erro de transcrição */ }
}

/* ---------------- busca ---------------- */

export type Achado = { uid: string; titulo: string; modulo: string; n: number; inicio: number; fim: number; falante: number | null; texto: string; pontos: number };

// busca simples por palavras (LIKE, sem acento-insensível): cada termo conta
// uma vez por trecho; trechos com mais termos sobem. Bom o bastante para
// dezenas de aulas; FTS entra se um dia passar de centenas.
export async function buscarTrechos(env: any, consulta: string, limite = 40): Promise<Achado[]> {
  const termos = consulta.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 6);
  if (!termos.length) return [];
  const where = termos.map(() => `LOWER(x.texto) LIKE ?`).join(" OR ");
  const r: any = await env.DB.prepare(
    `SELECT x.aula_uid AS uid, a.titulo, a.modulo, x.n, x.inicio, x.fim, x.falante, x.texto
     FROM trechos x JOIN aulas a ON a.uid = x.aula_uid AND a.publicada = 1
     WHERE ${where} LIMIT 400`).bind(...termos.map((t) => `%${t}%`)).all();
  const achados: Achado[] = (r.results ?? []).map((l: any) => {
    const baixo = String(l.texto).toLowerCase();
    const pontos = termos.reduce((s, t) => s + (baixo.includes(t) ? 1 : 0), 0) + Math.min(3, termos.reduce((s, t) => s + baixo.split(t).length - 1, 0)) / 10;
    return { ...l, pontos };
  });
  return achados.sort((a, b) => b.pontos - a.pontos || a.uid.localeCompare(b.uid) || a.n - b.n).slice(0, limite);
}

/* ---------------- telas ---------------- */

const destaque = (texto: string, termos: string[]) => {
  let h = esc(texto);
  for (const t of termos) if (t.length >= 3) h = h.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  return h;
};

export function secaoInteligencia(o: { aulas: EstadoAula[]; consulta: string; achados: Achado[]; temChave: boolean; aviso?: string }): string {
  const prontas = o.aulas.filter((a) => a.estado === "pronto").length;
  const pendentes = o.aulas.filter((a) => a.estado !== "pronto");
  const termos = o.consulta.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const min = Math.round(o.aulas.filter((a) => a.estado === "pronto").reduce((s, a) => s + a.duracao_seg, 0) / 60);
  return `${o.aviso ?? ""}
    <div class="card" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px">
      <div><p class="mono">Transcrições</p>
        <p style="margin-top:6px">${prontas} de ${o.aulas.length} aula${o.aulas.length === 1 ? "" : "s"} transcrita${prontas === 1 ? "" : "s"} · ${min} min de fala indexados
          <span class="aula-meta">· Deepgram nova-3, pt-BR, com identificação de quem fala</span></p>
        ${pendentes.length ? `<p class="aula-meta" style="margin-top:4px">Pendentes: ${pendentes.map((a) => `${esc(a.titulo)}${a.estado ? ` (${esc(a.estado)}${a.erro ? `: ${esc(a.erro)}` : ""})` : ""}`).join(" · ")}</p>` : ""}
      </div>
      ${pendentes.length ? `<form method="post" action="/admin/transcrever">
        <button class="btn btn-fantasma" type="submit" ${o.temChave ? "" : `title="Defina o segredo DEEPGRAM_API_KEY no Worker para transcrever daqui"`}>Transcrever pendentes</button>
      </form>` : ""}
    </div>
    ${!o.temChave && pendentes.length ? `<p class="aula-meta" style="margin-top:8px">Sem o segredo <code>DEEPGRAM_API_KEY</code> no Worker, vídeo novo é transcrito pelo script <code>tools/transcrever.mjs</code> e entra no próximo deploy.</p>` : ""}

    <form method="get" action="/admin" class="card" style="margin-top:14px">
      <input type="hidden" name="aba" value="inteligencia">
      <p class="mono">Buscar na fala</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">
        <input class="campo" style="flex:1;min-width:240px" type="search" name="q" value="${esc(o.consulta)}" placeholder="ex.: dados no varejo, LGPD, precificação" autocomplete="off">
        <button class="btn btn-primario" type="submit">Buscar</button>
      </div>
      <p class="aula-meta" style="margin-top:8px">Cada resultado abre a aula no minuto certo. É a base dos cortes: ache o trecho, confira, e o corte sai dali.</p>
    </form>

    ${o.consulta && !termos.length ? `<p class="vazio">Use palavras com pelo menos 3 letras.</p>` : o.consulta ? (o.achados.length ? `<section class="modulo">
      <div class="modulo-topo"><h2>${o.achados.length} trecho${o.achados.length === 1 ? "" : "s"} para "${esc(o.consulta)}"</h2>
        <span class="mono">${new Set(o.achados.map((a) => a.uid)).size} aula${new Set(o.achados.map((a) => a.uid)).size === 1 ? "" : "s"}</span></div>
      ${o.achados.map((a) => `<a class="aula" href="/app/aula/${esc(a.uid)}?t=${Math.floor(a.inicio)}" target="_blank" rel="noopener">
        <span class="num-aula">${tempo(a.inicio)}</span>
        <span class="aula-txt"><b>${esc(a.titulo)} <span class="aula-meta">· ${esc(a.modulo)}${a.falante !== null ? ` · falante ${a.falante + 1}` : ""} · ${tempo(a.inicio)}–${tempo(a.fim)}</span></b>
          <span class="aula-meta" style="display:block;color:var(--texto);margin-top:3px;line-height:1.5">${destaque(a.texto, termos)}</span></span>
      </a>`).join("")}
    </section>` : `<p class="vazio">Nada com "${esc(o.consulta)}" nas aulas transcritas.</p>`) : ""}`;
}

// transcrição embaixo do vídeo — parágrafos com o minuto clicável
export function secaoTranscricaoAula(t: Transcricao | null, uid: string): string {
  if (!t) return "";
  const nomes = t.falantes > 1;
  return `<details class="transcricao" style="margin-top:26px">
    <summary class="mono" style="cursor:pointer">Transcrição · ${t.paragrafos.length} trechos${nomes ? ` · ${t.falantes} vozes` : ""}</summary>
    <div style="margin-top:12px;display:grid;gap:10px;max-width:74ch">
      ${t.paragrafos.map((p) => `<p style="display:grid;grid-template-columns:52px 1fr;gap:10px;font-size:15px;line-height:1.55">
        <a class="mono" href="/app/aula/${esc(uid)}?t=${Math.floor(p.i)}" data-t="${Math.floor(p.i)}" style="padding-top:3px">${tempo(p.i)}</a>
        <span>${nomes && p.q !== null ? `<b style="font-weight:600">Voz ${p.q + 1}:</b> ` : ""}${esc(textoDo(p))}</span></p>`).join("")}
    </div>
  </details>`;
}

/* ---------------- rotas ---------------- */

type Deps = { exigeAdmin: any; agora: () => number };

export function rotasTranscricao(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  // retorno do Deepgram (callback): confere a chave do pedido e guarda
  r.post("/deepgram/retorno", async (c) => {
    const uid = c.req.query("uid") || "", chave = c.req.query("chave") || "";
    if (!/^[0-9a-f]{32}$/.test(uid) || !/^[0-9a-f]{32}$/.test(chave)) return c.text("pedido inválido", 400);
    const linha: any = await c.env.DB.prepare(`SELECT chave, estado FROM transcricoes WHERE aula_uid = ?`).bind(uid).first();
    if (!linha || linha.estado !== "enviado" || linha.chave !== chave) return c.text("chave não confere", 403);
    let corpo: any;
    try { corpo = await c.req.json(); } catch { return c.text("corpo inválido", 400); }
    const agora = d.agora();
    try {
      const t = compactar(uid, corpo, agora);
      await guardarTranscricao(c.env, t, agora);
      await emSegundoPlano(c, subirLegenda(c.env, t));
      return c.text("ok");
    } catch (e: any) {
      await c.env.DB.prepare(`UPDATE transcricoes SET estado='erro', erro=? WHERE aula_uid=?`).bind(String(e?.message ?? e).slice(0, 300), uid).run();
      return c.text("erro ao guardar", 500);
    }
  });

  // botão do painel: semeia o bundle e avança o pipeline
  r.post("/admin/transcrever", d.exigeAdmin, async (c) => {
    const agora = d.agora();
    await garantirTabelasTranscricao(c.env);
    const semeadas = await semearDoBundle(c.env, agora);
    const passos = await avancarTranscricoes(c.env, agora);
    // índice da busca por significado (só com MODELOS_API_KEY)
    const vetores = await avancarVetores(c.env, agora).catch(() => [] as string[]);
    const q = new URLSearchParams({ aba: "inteligencia", transcricao: `${semeadas} do repositório · ${passos.length ? passos.join("; ") : c.env.DEEPGRAM_API_KEY ? "nada pendente" : "sem DEEPGRAM_API_KEY no Worker"}${vetores.length ? ` · vetores: ${vetores.length} aula(s)` : ""}` });
    return c.redirect(`/admin?${q}#inteligencia`);
  });

  return r;
}
