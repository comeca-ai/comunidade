// Desempenho das aulas: o que a turma vê de verdade em cada vídeo, e onde
// ela some. A pergunta do professor é "esta turma travou onde?".
//
// Fonte dos números: o SDK do player do Stream avisa o navegador enquanto o
// vídeo roda; a página junta a reprodução em faixas de 10 s e manda um pulso
// para POST /app/aula/:uid/pulso a cada 20 s, ao pausar, ao terminar e ao
// sair (sendBeacon). Só conta daqui para frente — aula assistida antes não
// tem curva.
//
//   aberturas   quem abriu a página, deu play, pulou, onde parou (retomar)
//   assistencia faixas de 10 s vistas, por aluno e aula (conjunto, não soma)
//   pulos       salto para frente de mais de 15 s (de → para)
//   avaliacoes  "essa aula foi útil?" — 👍 😐 👎 e comentário opcional
//
// De brinde para o aluno: a aula volta de onde parou, e marca concluída
// sozinha ao chegar a 90% do vídeo (o botão continua existindo).

import { Hono } from "hono";
import { esc } from "./ui";
import { DIA, diaLocal, nomeOu } from "./apoio";
import type { Filtros } from "./funil";

export const FAIXA = 10;            // segundos por faixa
const PULO_MIN = 15;                // salto para frente que conta como pulo
const CONCLUI_EM = 0.9;             // cobertura que marca a aula como concluída
const SEM_VER = 0.3;                // "concluiu sem ver": marcou concluída com cobertura abaixo disto

let esquemaPronto = false;
export async function garantirTabelasDesempenho(env: any) {
  if (esquemaPronto) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS aberturas (
      aluno_id INTEGER NOT NULL, aula_uid TEXT NOT NULL,
      primeira_em INTEGER NOT NULL, ultima_em INTEGER NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0, pulos INTEGER NOT NULL DEFAULT 0,
      posicao REAL NOT NULL DEFAULT 0, terminou_em INTEGER,
      PRIMARY KEY (aluno_id, aula_uid))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS assistencia (
      aluno_id INTEGER NOT NULL, aula_uid TEXT NOT NULL, faixa INTEGER NOT NULL, dia INTEGER NOT NULL,
      PRIMARY KEY (aluno_id, aula_uid, faixa))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_assistencia_aula ON assistencia(aula_uid, faixa)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pulos (
      aluno_id INTEGER NOT NULL, aula_uid TEXT NOT NULL, de INTEGER NOT NULL, para INTEGER NOT NULL, em INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS avaliacoes (
      aluno_id INTEGER NOT NULL, aula_uid TEXT NOT NULL, nota INTEGER NOT NULL, comentario TEXT, em INTEGER NOT NULL,
      PRIMARY KEY (aluno_id, aula_uid))`),
  ]);
  esquemaPronto = true;
}

/* ---------------- pulso do player ---------------- */

export type Pulso = { abriu?: boolean; faixas?: number[]; pulos?: [number, number][]; posicao?: number; plays?: number; terminou?: boolean };

export function lerPulso(bruto: any): Pulso {
  const o = bruto && typeof bruto === "object" ? bruto : {};
  const inteiros = (v: any, max: number) => Array.isArray(v) ? [...new Set(v.map((x) => Math.floor(Number(x))).filter((x) => Number.isFinite(x) && x >= 0 && x < max))].slice(0, 2000) : [];
  const pulos = Array.isArray(o.pulos) ? o.pulos.map((p: any) => [Math.floor(Number(p?.[0])), Math.floor(Number(p?.[1]))] as [number, number])
    .filter(([de, para]: [number, number]) => Number.isFinite(de) && Number.isFinite(para) && de >= 0 && para > de + PULO_MIN - 1 && para < 100000).slice(0, 50) : [];
  const posicao = Number(o.posicao); const plays = Math.floor(Number(o.plays));
  return { abriu: !!o.abriu, faixas: inteiros(o.faixas, 100000), pulos, posicao: Number.isFinite(posicao) && posicao >= 0 ? posicao : 0,
    plays: Number.isFinite(plays) && plays > 0 ? Math.min(plays, 50) : 0, terminou: !!o.terminou };
}

// grava o pulso; devolve a cobertura e se a aula ficou concluída agora
export async function registrarPulso(env: any, alunoId: number, uid: string, duracaoSeg: number, p: Pulso, agora: number): Promise<{ cobertura: number; concluida: boolean }> {
  const stmts: any[] = [
    env.DB.prepare(`INSERT INTO aberturas (aluno_id, aula_uid, primeira_em, ultima_em, plays, pulos, posicao, terminou_em)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(aluno_id, aula_uid) DO UPDATE SET ultima_em = excluded.ultima_em, plays = aberturas.plays + excluded.plays,
        pulos = aberturas.pulos + excluded.pulos, posicao = CASE WHEN excluded.posicao > 0 THEN excluded.posicao ELSE aberturas.posicao END,
        terminou_em = COALESCE(aberturas.terminou_em, excluded.terminou_em)`)
      .bind(alunoId, uid, agora, agora, p.plays ?? 0, (p.pulos ?? []).length, p.posicao ?? 0, p.terminou ? agora : null),
  ];
  const dia = diaLocal(agora);
  for (const f of p.faixas ?? []) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO assistencia (aluno_id, aula_uid, faixa, dia) VALUES (?,?,?,?)`).bind(alunoId, uid, f, dia));
  for (const [de, para] of p.pulos ?? []) stmts.push(env.DB.prepare(`INSERT INTO pulos (aluno_id, aula_uid, de, para, em) VALUES (?,?,?,?,?)`).bind(alunoId, uid, de, para, agora));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));

  const totalFaixas = Math.max(1, Math.ceil(duracaoSeg / FAIXA));
  const v: any = await env.DB.prepare(`SELECT COUNT(*) n FROM assistencia WHERE aluno_id = ? AND aula_uid = ?`).bind(alunoId, uid).first();
  const cobertura = Math.min(1, Number(v?.n ?? 0) / totalFaixas);
  let concluida = false;
  if (cobertura >= CONCLUI_EM || p.terminou) {
    const j: any = await env.DB.prepare(`SELECT concluida_em FROM progresso WHERE aluno_id = ? AND aula_uid = ?`).bind(alunoId, uid).first();
    if (!j?.concluida_em) {
      await env.DB.prepare(`INSERT INTO progresso (aluno_id, aula_uid, concluida_em) VALUES (?,?,?)
        ON CONFLICT(aluno_id, aula_uid) DO UPDATE SET concluida_em = excluded.concluida_em`).bind(alunoId, uid, agora).run();
      concluida = true;
    }
  }
  return { cobertura, concluida };
}

// onde o aluno parou nesta aula (para o player retomar)
export async function posicaoSalva(env: any, alunoId: number, uid: string, duracaoSeg: number): Promise<number> {
  try {
    const r: any = await env.DB.prepare(`SELECT posicao FROM aberturas WHERE aluno_id = ? AND aula_uid = ?`).bind(alunoId, uid).first();
    const p = Number(r?.posicao ?? 0);
    return p > 20 && (!duracaoSeg || p < duracaoSeg * 0.95) ? Math.floor(p) : 0;
  } catch { return 0; }
}

export async function avaliacaoDe(env: any, alunoId: number, uid: string): Promise<{ nota: number; comentario: string | null } | null> {
  try { return (await env.DB.prepare(`SELECT nota, comentario FROM avaliacoes WHERE aluno_id = ? AND aula_uid = ?`).bind(alunoId, uid).first()) ?? null; }
  catch { return null; }
}

/* ---------------- na página da aula ---------------- */

// bloco "essa aula foi útil?" + script do player (SDK do Stream)
export function blocoAvaliacao(uid: string, ja: { nota: number; comentario: string | null } | null, concluida: boolean): string {
  const rosto = (n: number) => n > 0 ? "👍" : n < 0 ? "👎" : "😐";
  return `<div id="avaliacao" class="card" style="margin-top:22px" ${ja || concluida ? "" : "hidden"}>
    ${ja ? `<p class="aula-meta">Sua avaliação: ${rosto(ja.nota)} — obrigado! <a href="#" data-reavaliar style="margin-left:6px">mudar</a></p>` : ""}
    <form method="post" action="/app/aula/${esc(uid)}/avaliar" id="form-avaliacao" ${ja ? "hidden" : ""}>
      <p class="mono">Essa aula foi útil?</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        <button class="btn btn-fantasma" type="submit" name="nota" value="1">👍 Sim</button>
        <button class="btn btn-fantasma" type="submit" name="nota" value="0">😐 Mais ou menos</button>
        <button class="btn btn-fantasma" type="submit" name="nota" value="-1">👎 Não</button>
      </div>
      <input class="campo" type="text" name="comentario" maxlength="300" placeholder="Quer dizer algo? (opcional)" style="margin-top:10px;width:100%">
    </form>
  </div>`;
}

export const SCRIPT_PLAYER = `
(function(){
  var iframe=document.querySelector(".player iframe"); var raiz=document.querySelector("[data-aula]"); if(!iframe||!raiz||!window.Stream) return;
  var uid=raiz.getAttribute("data-aula"), url="/app/aula/"+uid+"/pulso";
  var p=Stream(iframe), vistas={}, novas=[], pulos=[], plays=0, ultimo=null, terminou=false, mandando=false;
  function envia(corpo, beacon){
    if(beacon && navigator.sendBeacon){ navigator.sendBeacon(url, new Blob([JSON.stringify(corpo)],{type:"application/json"})); return; }
    return fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(corpo),keepalive:true})
      .then(function(r){ return r.ok?r.json():null; }).then(function(j){ if(j&&j.concluida) concluiu(); }).catch(function(){});
  }
  function manda(beacon){
    if(!novas.length && !pulos.length && !plays && !terminou) return;
    var corpo={faixas:novas, pulos:pulos, posicao:ultimo||0, plays:plays, terminou:terminou};
    novas=[]; pulos=[]; plays=0; terminou=false; envia(corpo, beacon);
  }
  function concluiu(){
    var b=document.querySelector('form[action$="/concluir"] button'); if(b && !/Concluída/.test(b.textContent)){ b.textContent="✓ Concluída — desmarcar"; b.className="btn btn-fantasma"; }
    var av=document.getElementById("avaliacao"); if(av) av.hidden=false;
  }
  p.addEventListener("play", function(){ plays++; });
  p.addEventListener("timeupdate", function(){
    var t=p.currentTime; if(typeof t!=="number"||isNaN(t)) return;
    if(ultimo!==null){ var d=t-ultimo;
      if(d>${PULO_MIN}) pulos.push([Math.floor(ultimo),Math.floor(t)]);
      else if(d>=0){ var f=Math.floor(t/${FAIXA}); if(!vistas[f]){ vistas[f]=1; novas.push(f); } } }
    ultimo=t;
  });
  p.addEventListener("pause", function(){ manda(false); });
  p.addEventListener("ended", function(){ terminou=true; manda(false); concluiu(); });
  setInterval(function(){ manda(false); }, 20000);
  document.addEventListener("visibilitychange", function(){ if(document.hidden) manda(true); });
  window.addEventListener("pagehide", function(){ manda(true); });
  envia({abriu:true}, false);
  // avaliação sem recarregar a página
  var form=document.getElementById("form-avaliacao");
  if(form){ form.addEventListener("submit", function(e){
    var botao=e.submitter; if(!botao) return; e.preventDefault();
    var dados=new FormData(form); dados.set("nota", botao.value);
    fetch(form.action,{method:"POST",body:dados}).then(function(r){ if(r.ok){ form.hidden=true; var ok=document.createElement("p"); ok.className="aula-meta"; ok.textContent="Obrigado! Sua resposta ajuda a melhorar a aula."; form.parentNode.insertBefore(ok, form); } });
  }); }
  var re=document.querySelector("[data-reavaliar]"); if(re) re.addEventListener("click", function(e){ e.preventDefault(); if(form) form.hidden=false; re.parentNode.hidden=true; });
})();`;

/* ---------------- números para o painel ---------------- */

export type AulaDesempenho = {
  uid: string; titulo: string; modulo: string; duracao: number;
  abriram: number; play: number; terminaram: number; retencao: number;     // retenção = cobertura média de quem deu play (0–1)
  curva: number[];                                                          // % de quem deu play que viu cada faixa (0–1)
  pulos: number; pulosPorAluno: number; concluiramSemVer: number; concluiram: number;
  util: { sim: number; meh: number; nao: number } | null; utilPct: number | null;
  comentarios: { nome: string; nota: number; texto: string; em: number }[];
  saltos: { de: number; para: number; n: number }[];                        // pulos agrupados por minuto
  alertas: { tipo: "queda" | "sem-ver" | "ninguem-abre" | "pulos"; texto: string }[];
  queda: { de: number; para: number; antes: number; depois: number } | null; // trecho da maior queda (segundos, e % antes/depois)
  indice: number;                                                           // engajamento (menor = pior)
};

export type Desempenho = { aulas: AulaDesempenho[]; kpi: { retencao: number | null; terminam: number | null; alertas: number; util: number | null; respostas: number; comentarios: number }; semDados: boolean };

// aulas: lista na ordem da trilha ({uid, titulo, modulo, duracao_seg})
export async function dadosDesempenho(env: any, aulas: { uid: string; titulo: string; modulo: string; duracao_seg: number }[], f: Filtros, agora: number): Promise<Desempenho> {
  await garantirTabelasDesempenho(env);
  const desdeSeg = f.desde ? agora - f.desde * DIA : 0, desdeDia = f.desde ? diaLocal(agora) - f.desde : -1;
  // alunos no escopo (turma)
  let alunoSql = `SELECT m.aluno_id AS id, al.nome, al.email FROM matriculas m JOIN alunos al ON al.id = m.aluno_id WHERE m.escola = ?`;
  const args: any[] = [String(env.ESCOLA || "classica")];
  if (f.turma === "-") alunoSql += ` AND (m.turma IS NULL OR m.turma = '')`;
  else if (f.turma) { alunoSql += ` AND m.turma = ?`; args.push(f.turma); }
  const alunosR: any = await env.DB.prepare(alunoSql).bind(...args).all();
  const alunos = new Map<number, { nome: string | null; email: string }>((alunosR.results ?? []).map((a: any) => [Number(a.id), { nome: a.nome, email: a.email }]));
  const dentro = (id: number) => alunos.has(Number(id));

  const [ab, asst, pu, av, pr] = await Promise.all([
    env.DB.prepare(`SELECT * FROM aberturas WHERE ultima_em >= ?`).bind(desdeSeg).all(),
    env.DB.prepare(`SELECT aluno_id, aula_uid, faixa FROM assistencia WHERE dia >= ?`).bind(desdeDia).all(),
    env.DB.prepare(`SELECT aluno_id, aula_uid, de, para FROM pulos WHERE em >= ?`).bind(desdeSeg).all(),
    env.DB.prepare(`SELECT aluno_id, aula_uid, nota, comentario, em FROM avaliacoes WHERE em >= ?`).bind(desdeSeg).all(),
    env.DB.prepare(`SELECT aluno_id, aula_uid, concluida_em FROM progresso WHERE concluida_em >= ?`).bind(desdeSeg).all(),
  ]);
  const porAula = <T extends { aula_uid: string; aluno_id: number }>(r: any) => {
    const m = new Map<string, T[]>();
    for (const l of (r.results ?? []) as T[]) { if (!dentro(l.aluno_id)) continue; if (!m.has(l.aula_uid)) m.set(l.aula_uid, []); m.get(l.aula_uid)!.push(l); }
    return m;
  };
  const aberturas = porAula<any>(ab), assistencia = porAula<any>(asst), pulos = porAula<any>(pu), avaliacoes = porAula<any>(av), progresso = porAula<any>(pr);

  const out: AulaDesempenho[] = aulas.map((a) => {
    const abs = aberturas.get(a.uid) ?? [], faixasVistas = assistencia.get(a.uid) ?? [], ps = pulos.get(a.uid) ?? [], avs = avaliacoes.get(a.uid) ?? [], prs = progresso.get(a.uid) ?? [];
    const totalFaixas = Math.max(1, Math.ceil((a.duracao_seg || 0) / FAIXA));
    // cobertura por aluno (faixas distintas / total) e curva (alunos por faixa)
    const porAluno = new Map<number, Set<number>>();
    for (const x of faixasVistas) { if (!porAluno.has(x.aluno_id)) porAluno.set(x.aluno_id, new Set()); porAluno.get(x.aluno_id)!.add(Number(x.faixa)); }
    const jogadores = new Set<number>([...abs.filter((x: any) => Number(x.plays) > 0).map((x: any) => Number(x.aluno_id)), ...porAluno.keys()]);
    const play = jogadores.size;
    const coberturas = [...jogadores].map((id) => Math.min(1, (porAluno.get(id)?.size ?? 0) / totalFaixas));
    const retencao = play ? coberturas.reduce((s, c) => s + c, 0) / play : 0;
    const curvaN = new Array(totalFaixas).fill(0);
    for (const s of porAluno.values()) for (const fx of s) if (fx < totalFaixas) curvaN[fx]++;
    const curva = curvaN.map((n) => (play ? n / play : 0));
    const terminaram = [...jogadores].filter((id) => (porAluno.get(id)?.size ?? 0) / totalFaixas >= CONCLUI_EM || abs.some((x: any) => Number(x.aluno_id) === id && x.terminou_em)).length;
    // só conclusões de quem abriu a aula com o player medido (antes disso não há como saber o que viu)
    const medidas = prs.filter((x: any) => abs.some((y: any) => Number(y.aluno_id) === Number(x.aluno_id) && Number(y.primeira_em) <= Number(x.concluida_em ?? 0)));
    const concluiramSemVer = medidas.filter((x: any) => (porAluno.get(Number(x.aluno_id))?.size ?? 0) / totalFaixas < SEM_VER).length;
    // pulos agrupados por minuto de saída e de chegada
    const grupos = new Map<string, { de: number; para: number; n: number }>();
    for (const x of ps) { const k = `${Math.floor(x.de / 60)}:${Math.floor(x.para / 60)}`; const g = grupos.get(k) ?? { de: Math.floor(x.de / 60) * 60, para: Math.floor(x.para / 60) * 60, n: 0 }; g.n++; grupos.set(k, g); }
    const saltos = [...grupos.values()].sort((x, y) => y.n - x.n).slice(0, 5);
    const util = avs.length ? { sim: avs.filter((x: any) => x.nota > 0).length, meh: avs.filter((x: any) => x.nota === 0).length, nao: avs.filter((x: any) => x.nota < 0).length } : null;
    const utilPct = util ? util.sim / avs.length : null;
    const comentarios = avs.filter((x: any) => x.comentario).map((x: any) => ({ nome: nomeOu(alunos.get(Number(x.aluno_id)) ?? { nome: null, email: "aluno" }), nota: Number(x.nota), texto: String(x.comentario), em: Number(x.em) }))
      .sort((x, y) => y.em - x.em).slice(0, 8);
    // maior queda: trecho de até 3 min em que a curva mais cai (partindo de
    // pelo menos 40% de gente); o início é onde a descida começa de fato
    let queda: AulaDesempenho["queda"] = null;
    const janela = Math.max(1, Math.round(180 / FAIXA));
    if (play >= 3) {
      for (let i = 0; i + 1 < curva.length; i++) {
        const antes = curva[i];
        if (antes < 0.4 || curva[i + 1] >= antes) continue;          // só onde começa a cair
        let j = i + 1;
        for (let k = i + 1; k <= Math.min(curva.length - 1, i + janela); k++) if (curva[k] < curva[j]) j = k;
        const depois = curva[j];
        // de/para em segundos: da primeira faixa com menos gente até a faixa mais vazia
        if (antes - depois >= 0.3 && (!queda || antes - depois > queda.antes - queda.depois + 1e-9)) queda = { de: (i + 1) * FAIXA, para: (j + 1) * FAIXA, antes, depois };
      }
    }
    const alertas: AulaDesempenho["alertas"] = [];
    if (queda) alertas.push({ tipo: "queda", texto: `${Math.round((1 - queda.depois / Math.max(queda.antes, 0.01)) * 100)}% de quem estava assistindo sai entre ${tempoCurto(queda.de)} e ${tempoCurto(queda.para)}` });
    if (concluiramSemVer >= 3 || (medidas.length >= 4 && concluiramSemVer / medidas.length >= 0.5)) alertas.push({ tipo: "sem-ver", texto: `${concluiramSemVer} de ${medidas.length} marcaram "concluída" tendo visto menos de ${Math.round(SEM_VER * 100)}%` });
    if (abs.length >= 5 && play / abs.length < 0.4) alertas.push({ tipo: "ninguem-abre", texto: `${abs.length} abriram, só ${play} deram play` });
    if (play >= 3 && ps.length / play >= 1.5 && saltos[0]) alertas.push({ tipo: "pulos", texto: `${ps.length} pulos em ${play} alunos — o mais comum de ${tempoCurto(saltos[0].de)} para ${tempoCurto(saltos[0].para)}` });
    const indice = play ? retencao * (0.5 + 0.5 * (terminaram / play)) : (abs.length ? 0 : 1);
    return { uid: a.uid, titulo: a.titulo, modulo: a.modulo, duracao: a.duracao_seg || 0, abriram: abs.length, play, terminaram, retencao, curva,
      pulos: ps.length, pulosPorAluno: play ? ps.length / play : 0, concluiramSemVer, concluiram: medidas.length, util, utilPct, comentarios, saltos, alertas, queda, indice };
  });

  const comPlay = out.filter((a) => a.play > 0);
  const respostas = out.reduce((s, a) => s + (a.util ? a.util.sim + a.util.meh + a.util.nao : 0), 0);
  const sim = out.reduce((s, a) => s + (a.util?.sim ?? 0), 0);
  return {
    aulas: out,
    kpi: {
      retencao: comPlay.length ? comPlay.reduce((s, a) => s + a.retencao, 0) / comPlay.length : null,
      terminam: comPlay.length ? comPlay.reduce((s, a) => s + a.terminaram, 0) / comPlay.reduce((s, a) => s + a.play, 0) : null,
      alertas: out.filter((a) => a.alertas.length).length,
      util: respostas ? sim / respostas : null, respostas, comentarios: out.reduce((s, a) => s + a.comentarios.length, 0),
    },
    semDados: !out.some((a) => a.abriram || a.play),
  };
}

const tempoCurto = (seg: number) => { const s = Math.max(0, Math.floor(seg)); const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, "0")}`; };
const pct = (x: number | null | undefined) => x == null ? "—" : `${Math.round(x * 100)}%`;

/* ---------------- tela ---------------- */

// curva de retenção em SVG (largura w, altura h); destaca a queda
function svgCurva(a: AulaDesempenho, w: number, h: number, detalhe = false): string {
  const n = a.curva.length; if (!n || !a.play) return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h - 1}" x2="${w}" y2="${h - 1}" stroke="#ccc"/></svg>`;
  const x = (i: number) => (i / Math.max(1, n - 1)) * w, y = (v: number) => h - 2 - v * (h - 4);
  const pontos = a.curva.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const faixa = a.queda ? `<rect x="${x(a.queda.de / FAIXA).toFixed(1)}" y="0" width="${(x(a.queda.para / FAIXA) - x(a.queda.de / FAIXA)).toFixed(1)}" height="${h}" fill="#B42318" opacity="${detalhe ? 0.08 : 0.15}"/>` : "";
  const eixo = detalhe ? [0, 0.25, 0.5, 0.75, 1].map((k) => `<text x="${(k * w).toFixed(0)}" y="${h + 14}" font-size="11" fill="#777" text-anchor="${k === 0 ? "start" : k === 1 ? "end" : "middle"}">${tempoCurto(k * a.duracao)}</text>`).join("") : "";
  return `<svg width="${w}" height="${h + (detalhe ? 18 : 0)}" viewBox="0 0 ${w} ${h + (detalhe ? 18 : 0)}" role="img" aria-label="curva de retenção">${faixa}
    <polyline points="${pontos}" fill="none" stroke="${a.queda ? "#B42318" : "#333"}" stroke-width="${detalhe ? 2 : 1.5}"/>${eixo}</svg>`;
}

export function secaoDesempenho(o: { d: Desempenho; turmas: string[]; f: Filtros; ordemTrilha: string[]; agora: number }): string {
  const { d, f } = o;
  const qs = (x: Record<string, any>) => new URLSearchParams(Object.fromEntries(Object.entries(x).filter(([, v]) => v !== "" && v !== 0 && v != null).map(([k, v]) => [k, String(v)]))).toString();
  const chipT = (rotulo: string, valor: string) => `<a class="chip ${f.turma === valor ? "ativa" : ""}" href="/admin?${qs({ ...f, turma: valor, aba: "desempenho" })}#desempenho">${esc(rotulo)}</a>`;
  const chipD = (rotulo: string, valor: number) => `<a class="chip ${f.desde === valor ? "ativa" : ""}" href="/admin?${qs({ ...f, desde: valor, aba: "desempenho" })}#desempenho">${rotulo}</a>`;
  const filtros = `<div class="funil-filtros">
    <div class="chips"><span class="mono">Turma</span>${chipT("Todas", "")}${o.turmas.map((t) => chipT(t, t)).join("")}${o.turmas.length ? chipT("Sem turma", "-") : ""}</div>
    <div class="chips"><span class="mono">Período</span>${chipD("30 d", 30)}${chipD("90 d", 90)}${chipD("tudo", 0)}</div>
  </div>`;

  const kpis = `<div class="kpis" style="margin-top:14px">
    ${kpi("Retenção média", pct(d.kpi.retencao), "quanto do vídeo quem dá play realmente vê")}
    ${kpi("Terminam a aula", pct(d.kpi.terminam), `chegam a ${Math.round(CONCLUI_EM * 100)}% do vídeo (não "marcou concluída")`)}
    ${kpi("Aulas com alerta", `${d.kpi.alertas}<span class="aula-meta"> de ${d.aulas.length}</span>`, "queda brusca, muito pulo, concluem sem ver ou ninguém dá play")}
    ${kpi("Foi útil?", d.kpi.util == null ? "—" : `${pct(d.kpi.util)} 👍`, d.kpi.respostas ? `${d.kpi.respostas} resposta${d.kpi.respostas === 1 ? "" : "s"} · ${d.kpi.comentarios} comentário${d.kpi.comentarios === 1 ? "" : "s"}` : "1 clique ao fim da aula — ninguém respondeu ainda")}
  </div>`;

  if (d.semDados) return `<div id="desempenho-topo">${filtros}${kpis}
    <p class="vazio" style="margin-top:18px">Ainda sem dados: a medição começa daqui para frente, a cada aula assistida com esta versão do player. Aulas vistas antes não têm curva.</p>
    ${rodape()}</div>`;

  const piores = [...d.aulas].sort((a, b) => (b.alertas.length ? 1 : 0) - (a.alertas.length ? 1 : 0) || a.indice - b.indice);
  const comAlerta = piores.filter((a) => a.alertas.length).slice(0, 3);
  const diagnostico = comAlerta.length ? `<div class="card" style="margin-top:18px;background:#FFF7EE;border-color:#F3D9B8">
    <p class="mono">Onde melhorar</p>
    ${comAlerta.map((a, i) => `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:${i ? "1px dashed var(--linha)" : "0"}">
      <span class="num-aula">${i + 1}</span>
      <div style="flex:1;min-width:0"><b>${esc(a.titulo)}</b><br><span class="aula-meta">${a.alertas.map((x) => esc(x.texto)).join(" · ")}</span></div>
      <a class="btn btn-fantasma" href="#desempenho-${esc(a.uid)}">ver curva</a>
    </div>`).join("")}
  </div>` : `<p class="aula-meta" style="margin-top:18px">Nenhum alerta com os dados de agora — bom sinal, ou pouca gente ainda.</p>`;

  const etiqueta = (a: AulaDesempenho) => a.alertas.map((x) => `<span class="etiqueta ${x.tipo === "queda" || x.tipo === "sem-ver" ? "alerta" : "atencao"}" title="${esc(x.texto)}">${x.tipo === "queda" ? `queda ${tempoCurto(a.queda!.de)}` : x.tipo === "sem-ver" ? "concluem sem ver" : x.tipo === "ninguem-abre" ? "abrem, não dão play" : "muito pulo"}</span>`).join(" ");
  const tabela = `<div style="overflow-x:auto;margin-top:18px"><table class="desempenho">
    <thead><tr><th>Aula</th><th>Abriram</th><th>Play</th><th>Terminaram</th><th>Retenção</th><th>Curva</th><th>Pulos</th><th title="marcaram concluída tendo visto menos de 30%">Concl. s/ ver</th><th>👍</th></tr></thead>
    <tbody>${piores.map((a) => `<tr class="${a.alertas.length ? "alerta" : ""}">
      <td><a href="#desempenho-${esc(a.uid)}">${esc(a.titulo)}</a> ${etiqueta(a)}</td>
      <td>${a.abriram}</td><td>${a.play}</td><td>${a.terminaram}</td><td>${a.play ? pct(a.retencao) : "—"}</td>
      <td>${svgCurva(a, 120, 26)}</td><td>${a.pulos}</td><td>${a.concluiramSemVer}</td><td>${a.utilPct == null ? "—" : pct(a.utilPct)}</td>
    </tr>`).join("")}</tbody></table></div>
    <p class="aula-meta" style="margin-top:6px">Ordenado das piores para as melhores (alerta primeiro, depois retenção × conclusão). Clique na aula para ver a curva.</p>`;

  const detalhes = piores.map((a) => `<details class="card" id="desempenho-${esc(a.uid)}" style="margin-top:12px" ${a.alertas.length && comAlerta[0]?.uid === a.uid ? "open" : ""}>
    <summary style="cursor:pointer"><b>${esc(a.titulo)}</b> <span class="aula-meta">· ${tempoCurto(a.duracao)} · ${a.play} deram play · retenção ${a.play ? pct(a.retencao) : "—"}</span></summary>
    <div style="margin-top:12px;overflow-x:auto">${svgCurva(a, 720, 120, true)}</div>
    <p class="aula-meta" style="margin-top:8px">% de quem deu play que viu cada trecho de ${FAIXA} s.
      ${a.queda ? ` · <b style="color:#B42318">queda de ${pct(a.queda.antes)} → ${pct(a.queda.depois)} entre ${tempoCurto(a.queda.de)} e ${tempoCurto(a.queda.para)}</b>` : ""}
      ${a.saltos.length ? ` · pulos mais comuns: ${a.saltos.map((s) => `${s.n}× de ~${tempoCurto(s.de)} para ~${tempoCurto(s.para)}`).join(", ")}` : ""}
      ${a.concluiramSemVer ? ` · ${a.concluiramSemVer} marcaram concluída com menos de ${Math.round(SEM_VER * 100)}% visto` : ""}
      ${a.util ? ` · útil: 👍 ${a.util.sim} 😐 ${a.util.meh} 👎 ${a.util.nao}` : ""}</p>
    ${a.comentarios.length ? `<ul style="margin:10px 0 0;padding-left:18px">${a.comentarios.map((c) => `<li><span class="aula-meta">${c.nota > 0 ? "👍" : c.nota < 0 ? "👎" : "😐"} <b>${esc(c.nome)}</b> · ${haQuantoDias(c.em, o.agora)}</span><br>${esc(c.texto)}</li>`).join("")}</ul>` : ""}
  </details>`).join("");

  // trilha: quantos terminaram cada aula, na ordem oficial; laranja = queda > 40% em relação à anterior
  const naOrdem = o.ordemTrilha.map((uid) => d.aulas.find((a) => a.uid === uid)).filter(Boolean) as AulaDesempenho[];
  const maxT = Math.max(1, ...naOrdem.map((a) => a.terminaram));
  const trilha = `<div class="card" style="margin-top:18px"><p class="mono">A trilha: quantos terminaram cada aula (onde a turma some)</p>
    <div style="display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:12px">${naOrdem.map((a, i) => {
      const ant = i ? naOrdem[i - 1].terminaram : a.terminaram; const cai = i > 0 && ant > 0 && a.terminaram < ant * 0.6;
      return `<div title="${esc(a.titulo)}: ${a.terminaram}" style="flex:1;min-width:6px;height:${Math.max(3, Math.round((a.terminaram / maxT) * 110))}px;background:${cai ? "#C2410C" : "#444"};border-radius:2px 2px 0 0"></div>`; }).join("")}</div>
    <p class="aula-meta" style="margin-top:8px">laranja = queda maior que 40% em relação à aula anterior · a ordem é a da trilha</p></div>`;

  return `<div id="desempenho-topo">${filtros}${kpis}${diagnostico}${tabela}${detalhes}${trilha}${rodape()}</div>`;
}

const kpi = (rotulo: string, valor: string, nota: string) => `<div class="card" style="flex:1;min-width:180px"><p class="mono">${esc(rotulo)}</p><p style="font-size:30px;font-weight:600;margin:6px 0 2px">${valor}</p><p class="aula-meta">${esc(nota)}</p></div>`;
const haQuantoDias = (em: number, agora: number) => { const dd = Math.floor((agora - em) / DIA); return dd <= 0 ? "hoje" : dd === 1 ? "ontem" : `há ${dd} dias`; };
const rodape = () => `<p class="aula-meta" style="margin-top:22px;max-width:80ch">De onde vem cada número: o player do Stream avisa o navegador a cada segundo de reprodução; a página junta em trechos de ${FAIXA} s e manda um pulso ao servidor a cada 20 s, ao pausar, ao terminar e ao sair. <b>Abriram</b> = página da aula carregada; <b>Play</b> = deu play; <b>Terminaram</b> = viu ${Math.round(CONCLUI_EM * 100)}% do vídeo; <b>Retenção</b> = cobertura média de quem deu play; <b>Pulos</b> = saltos para frente de mais de ${PULO_MIN} s; <b>Concl. s/ ver</b> = marcou concluída tendo visto menos de ${Math.round(SEM_VER * 100)}%; <b>👍</b> = "essa aula foi útil?" ao fim da aula. Para o aluno: a aula volta de onde parou e marca concluída sozinha aos ${Math.round(CONCLUI_EM * 100)}%. Só conta daqui para frente.</p>`;

/* ---------------- rotas ---------------- */

type Deps = { exigeLogin: any; agora: () => number };

export function rotasDesempenho(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  r.post("/app/aula/:uid/pulso", d.exigeLogin, async (c) => {
    const aluno = c.get("aluno"), uid = c.req.param("uid");
    if (uid.length > 64) return c.json({ ok: false }, 400);
    const aula: any = await c.env.DB.prepare(`SELECT duracao_seg FROM aulas WHERE uid = ? AND publicada = 1`).bind(uid).first();
    if (!aula) return c.json({ ok: false }, 404);
    let bruto: any = {};
    try { bruto = await c.req.json(); } catch { try { bruto = JSON.parse(await c.req.text()); } catch { bruto = {}; } }
    await garantirTabelasDesempenho(c.env);
    const res = await registrarPulso(c.env, aluno.id, uid, Number(aula.duracao_seg || 0), lerPulso(bruto), d.agora());
    return c.json({ ok: true, ...res });
  });

  r.post("/app/aula/:uid/avaliar", d.exigeLogin, async (c) => {
    const aluno = c.get("aluno"), uid = c.req.param("uid");
    const form = await c.req.formData();
    const nota = Math.max(-1, Math.min(1, Math.round(Number(form.get("nota")))));
    if (!Number.isFinite(nota)) return c.json({ ok: false }, 400);
    const comentario = String(form.get("comentario") || "").trim().slice(0, 300) || null;
    await garantirTabelasDesempenho(c.env);
    await c.env.DB.prepare(`INSERT INTO avaliacoes (aluno_id, aula_uid, nota, comentario, em) VALUES (?,?,?,?,?)
      ON CONFLICT(aluno_id, aula_uid) DO UPDATE SET nota = excluded.nota, comentario = COALESCE(excluded.comentario, avaliacoes.comentario), em = excluded.em`)
      .bind(aluno.id, uid, nota, comentario, d.agora()).run();
    const aceita = c.req.header("accept") || "";
    return aceita.includes("text/html") && !aceita.includes("application/json") && c.req.header("sec-fetch-mode") === "navigate"
      ? c.redirect(`/app/aula/${uid}`) : c.json({ ok: true });
  });

  return r;
}
