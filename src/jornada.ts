// "Sua jornada" — a home do aluno, no desenho aprovado em homologação:
// cartão Retomar como ação nº 1 (único amarelo da tela no CTA), progresso com
// três números, trilha em cartões por módulo com a prova fechando cada bloco,
// sumário sticky (desktop) / chips roláveis (mobile), leituras na lateral e o
// "No radar" no fim. Renderização pura: recebe os dados prontos e devolve
// HTML — o que permite testar a tela com dados de exemplo, fora do Worker.
//
// Regras herdadas do design (handoff v2):
// · amarelo #FAE047 só no CTA principal (Continuar / Ver certificado);
// · estado (concluída/próxima/trancada) sempre por ícone + texto, nunca só cor;
// · texto ≤13px sobre branco usa #636363 — #919191 é decorativo;
// · leituras abrem no navegador ("Ler"), nunca download;
// · alvo de toque mínimo 44px; linha de aula inteira é <a>.

import { esc, duracao } from "./ui";
import { haQuanto } from "./apoio";
import { M, PONTOS } from "../packages/identidade/marca";
import { bloqueioDe, type SituacaoProva, type ProvasCertificado, APROVACAO } from "./provas";
import type { Leitura } from "./leituras";
import type { Noticia } from "./noticias";

export type AulaJornada = {
  uid: string; titulo: string; modulo: string; duracao_seg: number; concluida_em: number | null;
};

export type DadosJornada = {
  nomeEscola: string;
  subtitulo: string;                       // ex.: "Imersão em IA para gestores"
  aluno: { nome: string | null; email: string };
  modulos: Map<string, AulaJornada[]>;     // já na ordem da trilha
  provas: Map<string, SituacaoProva>;
  cert: ProvasCertificado;
  leituras: Leitura[];
  noticias: Noticia[];
  admin: boolean;
  agora: number;
};

/* ---------------- ícones (estado sempre por ícone + texto) ---------------- */

const I = {
  feita: `<svg class="j-ico" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="${M.marca}"/><path d="M6.5 11.5l3 3 6-6.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  proxima: `<svg class="j-ico" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="none" stroke="${M.marca}" stroke-width="1.8"/><path d="M9 7.5v7l5.5-3.5z" fill="${M.marca}"/></svg>`,
  livre: `<svg class="j-ico" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="10" fill="none" stroke="${M.tinta35}" stroke-width="1.8"/></svg>`,
  tranca: `<svg class="j-ico" viewBox="0 0 22 22" aria-hidden="true"><rect x="4.5" y="9.5" width="13" height="9" rx="1.5" fill="none" stroke="${M.tinta60}" stroke-width="1.8"/><path d="M7.5 9.5V7a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="${M.tinta60}" stroke-width="1.8"/></svg>`,
  doc: `<svg class="j-ico" viewBox="0 0 22 22" aria-hidden="true"><path d="M6 2.5h7l4 4V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="none" stroke="${M.marca}" stroke-width="1.7"/><path d="M13 2.5V7h4.5" fill="none" stroke="${M.marca}" stroke-width="1.7"/></svg>`,
  fora: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2h7v7M12 2L5.5 8.5M6 3H2v9h9V8" fill="none" stroke="${M.marca}" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  play: `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5.5 3.5v11L15 9z" fill="currentColor"/></svg>`,
  check14: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.4" fill="${M.marca}"/><path d="M4 7.3l2 2 4-4.3" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
  tranca14: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.6" y="6" width="8.8" height="6" rx="1" fill="none" stroke="${M.tinta60}" stroke-width="1.5"/><path d="M4.6 6V4.5a2.4 2.4 0 0 1 4.8 0V6" fill="none" stroke="${M.tinta60}" stroke-width="1.5"/></svg>`,
};

/* ---------------- ajudantes ---------------- */

const primeiroNome = (a: { nome: string | null; email: string }) =>
  (a.nome || a.email.split("@")[0]).trim().split(/\s+/)[0];

// nome curto do módulo para os chips do mobile: primeira palavra com peso
export function nomeCurto(modulo: string): string {
  const p = modulo.split(/\s+/).filter((w) => !/^(a|o|as|os|de|da|do|e|em|para|na|no)$/i.test(w));
  if (/^sess(õ|o)es$/i.test(p[0] || "")) return p[1] || p[0];
  return (p[0] || modulo).replace(/[:,.]$/, "");
}

const pctMelhor = (s: SituacaoProva) => s.melhor && s.melhor.total ? Math.round(s.melhor.acertos / s.melhor.total * 100) : null;
const urlProva = (m: string) => `/app/prova/${encodeURIComponent(m)}`;

/* ---------------- cartão Retomar (e estados especiais) ---------------- */

function cartaoRetomar(d: DadosJornada, trilha: AulaJornada[], proxima: AulaJornada | undefined, posProxima: number): string {
  const total = trilha.length;
  const feitas = trilha.filter((a) => a.concluida_em).length;

  // 100% + todas as provas exigidas aprovadas → celebração
  if (total > 0 && feitas === total && !d.cert.pendentes.length) {
    return `<section class="j-hero" aria-label="Curso concluído">
      <p class="j-over">Curso concluído · ${total} de ${total}</p>
      <p class="j-hero-num">100%<span> de aproveitamento</span></p>
      <div class="j-hero-barra"><i style="width:100%"></i></div>
      <h2 class="j-hero-t">Parabéns, ${esc(primeiroNome(d.aluno))}. Você completou o curso.</h2>
      <p class="j-hero-p">${total} aula${total === 1 ? "" : "s"}${d.cert.publicadas.length ? ` · ${d.cert.publicadas.length} prova${d.cert.publicadas.length === 1 ? "" : "s"} aprovada${d.cert.publicadas.length === 1 ? "" : "s"}` : ""} · ${duracao(trilha.reduce((s, a) => s + a.duracao_seg, 0))} de conteúdo. Seu certificado já está disponível.</p>
      <div class="j-hero-acoes">
        <a class="j-cta" href="/app/certificado">Ver certificado</a>
        <form method="post" action="/app/relatorio"><button class="j-btn-claro" type="submit">Receber relatório por e-mail</button></form>
      </div>
    </section>`;
  }

  // aulas 100%, provas pendentes → o que falta para o certificado
  if (total > 0 && feitas === total && d.cert.pendentes.length) {
    const n = d.cert.pendentes.length;
    return `<section class="j-hero" aria-label="Provas pendentes">
      <p class="j-over">Aulas concluídas · ${total} de ${total}</p>
      <h2 class="j-hero-t">Falta${n === 1 ? "" : "m"} ${n === 1 ? "1 prova" : `${n} provas`} para o seu certificado</h2>
      <p class="j-hero-p">Você assistiu todas as aulas. Aprove a${n === 1 ? "" : "s"} prova${n === 1 ? "" : "s"} de ${d.cert.pendentes.map(esc).join(" e ")} para concluir o curso.</p>
      <div class="j-hero-lista">${d.cert.pendentes.map((m) =>
        `<div><span>Prova do módulo · ${esc(m)}</span><span class="j-over" style="margin:0">Pendente</span></div>`).join("")}</div>
      <div class="j-hero-acoes">
        <a class="j-btn-branco" href="${urlProva(d.cert.pendentes[0])}">Fazer prova de ${esc(nomeCurto(d.cert.pendentes[0]))}</a>
      </div>
    </section>`;
  }

  if (!proxima) return "";

  // texto de contexto: última concluída + prova que esta aula libera
  const concluidas = trilha.filter((a) => a.concluida_em).sort((a, b) => (b.concluida_em! - a.concluida_em!));
  const ultima = concluidas[0];
  const doModulo = d.modulos.get(proxima.modulo) || [];
  const restantes = doModulo.filter((a) => !a.concluida_em).length;
  const sp = d.provas.get(proxima.modulo);
  const liberaProva = restantes === 1 && sp?.publicada && !sp.aprovado;
  const contexto = [
    ultima ? `Você concluiu <i>${esc(ultima.titulo)}</i>.` : "",
    liberaProva ? `Depois desta aula, a prova de ${esc(nomeCurto(proxima.modulo))} é liberada.` : "",
  ].filter(Boolean).join(" ");
  const idxModulo = [...d.modulos.keys()].indexOf(proxima.modulo) + 1;

  return `<section class="j-hero" aria-label="Retomar de onde parou">
    <p class="j-over">Retomar de onde parou · Aula ${posProxima} de ${total}</p>
    <h2 class="j-hero-t">${esc(proxima.titulo)}</h2>
    <p class="j-hero-m">Módulo ${idxModulo} · ${esc(proxima.modulo)} · ${duracao(proxima.duracao_seg)}</p>
    ${contexto ? `<p class="j-hero-p">${contexto}</p>` : ""}
    <div class="j-hero-acoes"><a class="j-cta" href="/app/aula/${esc(proxima.uid)}">${I.play} Continuar</a></div>
  </section>`;
}

/* ---------------- progresso ---------------- */

function cartaoProgresso(d: DadosJornada, trilha: AulaJornada[]): string {
  const total = trilha.length;
  const feitas = trilha.filter((a) => a.concluida_em).length;
  const pct = total ? Math.round((feitas / total) * 100) : 0;
  const minutos = trilha.reduce((s, a) => s + a.duracao_seg, 0);
  const vistos = trilha.filter((a) => a.concluida_em).reduce((s, a) => s + a.duracao_seg, 0);
  const publicadas = [...d.provas.values()].filter((s) => s.publicada);
  const aprovadas = publicadas.filter((s) => s.aprovado).length;

  const stat3 = publicadas.length
    ? `<div><b>${aprovadas}</b> de ${publicadas.length}<span>prova${publicadas.length === 1 ? "" : "s"} aprovada${aprovadas === 1 ? "" : "s"}</span></div>`
    : `<div><b>${d.modulos.size}</b><span>módulo${d.modulos.size === 1 ? "" : "s"} na trilha</span></div>`;

  return `<section class="j-prog card" aria-label="Seu progresso">
    <p class="j-over-cinza">Seu progresso</p>
    <p class="j-prog-num">${pct}%<span> de aproveitamento</span></p>
    <div class="j-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <div class="j-stats">
      <div><b>${feitas}</b> de ${total}<span>aula${total === 1 ? "" : "s"} cursada${feitas === 1 ? "" : "s"}</span></div>
      <div><b>${duracao(vistos)}</b> de ${duracao(minutos)}<span>conteúdo concluído</span></div>
      ${stat3}
    </div>
    ${d.cert.exige && publicadas.length ? `<p class="j-nota">O certificado é emitido ao aprovar ${publicadas.length === 1 ? "a prova publicada" : `as ${publicadas.length} provas`}.</p>` : ""}
  </section>`;
}

/* ---------------- sumário (desktop) e chips (mobile) ---------------- */

function sumario(d: DadosJornada, moduloAtivo: string | null, trancaDe: (m: string) => string | null): string {
  const nomes = [...d.modulos.keys()];
  const item = (m: string, i: number) => {
    const lista = d.modulos.get(m)!;
    const ok = lista.filter((a) => a.concluida_em).length;
    const tranca = trancaDe(m);
    const estado = ok === lista.length && lista.length ? I.check14 : tranca ? I.tranca14 : "";
    return `<li><a href="#m-${i + 1}" class="${m === moduloAtivo ? "ativo" : ""} ${tranca ? "trancado" : ""}"
      ><span class="j-cod">${String(i + 1).padStart(2, "0")}</span><span class="j-sum-nome">${esc(m)}</span>
      <span class="j-sum-n">${estado} ${ok} de ${lista.length}</span></a></li>`;
  };
  const chip = (m: string, i: number) => {
    const lista = d.modulos.get(m)!;
    const ok = lista.filter((a) => a.concluida_em).length;
    return `<li><a href="#m-${i + 1}" class="${m === moduloAtivo ? "ativo" : ""} ${trancaDe(m) ? "trancado" : ""}"
      ><span class="j-cod">${String(i + 1).padStart(2, "0")}</span> ${esc(nomeCurto(m))} <span class="j-chip-n">${ok}/${lista.length}</span></a></li>`;
  };
  return `<nav class="j-sum card so-desktop" aria-label="Sumário do curso">
      <p class="j-over-cinza" style="padding:0 20px">Sumário · ${nomes.length} módulos</p>
      <ol>${nomes.map(item).join("")}</ol>
    </nav>
    <nav class="j-chips so-mobile" aria-label="Módulos"><ol>${nomes.map(chip).join("")}</ol></nav>`;
}

function leiturasAside(leituras: Leitura[], classe: string): string {
  if (!leituras.length) return "";
  return `<section class="j-leituras card ${classe}" id="leituras" aria-label="Leituras em PDF">
    <p class="j-over-cinza" style="padding:0 20px">Leituras · PDF</p>
    ${leituras.map((l) => `<a href="/app/leitura/${l.id}">
      ${I.doc}
      <span class="j-leit-txt"><b>${esc(l.titulo)}</b>
        <span>PDF${l.paginas ? ` · ${l.paginas} página${l.paginas === 1 ? "" : "s"}` : ""}${l.modulo ? ` · ${esc(l.modulo)}` : ""} · leitura no navegador${l.lido_em ? " · lida" : ""}</span></span>
      <span class="j-ler">Ler ${I.fora}</span>
    </a>`).join("")}
  </section>`;
}

/* ---------------- trilha ---------------- */

function blocoModulo(d: DadosJornada, m: string, i: number, numGlobal: { n: number }, trancaDe: (m: string) => string | null): string {
  const lista = d.modulos.get(m)!;
  const ok = lista.filter((a) => a.concluida_em).length;
  const minutos = lista.reduce((s, a) => s + a.duracao_seg, 0);
  const tranca = trancaDe(m);
  const s = d.provas.get(m);
  const proxima = !tranca && lista.find((a) => !a.concluida_em);

  const status = tranca
    ? `Trancado · exige aprovação na prova de ${esc(nomeCurto(tranca))}`
    : ok === lista.length && lista.length
      ? (s?.aprovado ? "Módulo concluído · prova aprovada" : s?.publicada ? "Aulas concluídas · prova liberada" : "Módulo concluído")
      : `${lista.length - ok} aula${lista.length - ok === 1 ? "" : "s"} restante${lista.length - ok === 1 ? "" : "s"}${
          s?.publicada && proxima && lista.length - ok === 1 ? ` · prova liberada após esta aula` : ""}`;

  const linha = (a: AulaJornada) => {
    numGlobal.n++;
    const ehProxima = proxima && a.uid === proxima.uid;
    const ico = a.concluida_em ? I.feita : tranca ? I.tranca : ehProxima ? I.proxima : I.livre;
    const estadoTxt = a.concluida_em ? "Concluída" : tranca ? "Trancada" : "";
    const href = tranca ? `${urlProva(tranca)}?bloqueio=1` : `/app/aula/${esc(a.uid)}`;
    return `<a class="j-aula ${a.concluida_em ? "feita" : ""} ${tranca ? "trancada" : ""} ${ehProxima ? "proxima" : ""}" href="${href}"
      aria-label="Aula ${numGlobal.n}, ${esc(a.titulo)}, ${duracao(a.duracao_seg)}${estadoTxt ? `, ${estadoTxt.toLowerCase()}` : ehProxima ? ", próxima aula" : ""}">
      <span class="j-cod">${String(numGlobal.n).padStart(2, "0")}</span>${ico}
      <span class="j-aula-t">${esc(a.titulo)}${ehProxima ? ` <em class="j-tag">Próxima</em>` : ""}</span>
      <span class="j-aula-d">${estadoTxt ? `<span>${estadoTxt}</span>` : ""}<span class="j-cod">${duracao(a.duracao_seg)}</span></span>
    </a>`;
  };

  // linha da prova fecha o bloco
  let provaHtml = "";
  if (s?.publicada) {
    const idx = [...d.modulos.keys()].indexOf(m) + 1;
    const faltam = lista.length - ok;
    let estado = "", cor = "", href = "";
    if (s.aprovado) { estado = `Aprovada · ${pctMelhor(s)}%`; cor = "aprovada"; href = urlProva(m); }
    else if (tranca) { estado = `Trancada · após ${esc(nomeCurto(tranca))}`; }
    else if (faltam > 0) { estado = `Libera ao concluir ${faltam === 1 ? "a aula que falta" : `as ${faltam} aulas`}`; }
    else if (s.tentativas) { estado = `Última: ${s.ultima && s.ultima.total ? Math.round(s.ultima.acertos / s.ultima.total * 100) : 0}% · precisa de ${Math.round(APROVACAO * 100)}%`; href = urlProva(m); }
    else { estado = s.exige ? "Necessária para avançar" : "Vale para o certificado"; href = urlProva(m); }
    const ico = s.aprovado ? I.feita : (tranca || faltam > 0) ? I.tranca : I.doc;
    const inner = `<span class="j-cod">P${idx}</span>${ico}
      <span class="j-aula-t">Prova do módulo · ${s.questoes} questõe${s.questoes === 1 ? "" : "s"}</span>
      <span class="j-aula-d"><span class="${cor ? "j-ok" : ""}">${estado}</span></span>`;
    provaHtml = href
      ? `<a class="j-aula j-prova" href="${href}">${inner}</a>`
      : `<div class="j-aula j-prova" aria-disabled="true">${inner}</div>`;
  }

  return `<section class="j-mod card ${tranca ? "trancado" : ""}" id="m-${i + 1}">
    <header class="j-mod-topo">
      <div>
        <p class="j-over-cinza">Módulo ${String(i + 1).padStart(2, "0")}</p>
        <h3>${tranca ? I.tranca : ""}${esc(m)}</h3>
        <p class="j-mod-st">${status}</p>
      </div>
      <div class="j-mod-num">
        <span>${ok} de ${lista.length} aulas &nbsp;·&nbsp; ${duracao(minutos)}</span>
        <span class="j-minibarra"><i style="width:${lista.length ? Math.round(ok / lista.length * 100) : 0}%"></i></span>
      </div>
    </header>
    ${lista.map(linha).join("")}
    ${provaHtml}
    ${d.admin && !s?.publicada ? `<p class="j-so-adm">Só você vê: ${s ? "prova em rascunho — publique" : "sem prova ainda — gere e publique"} em <a href="/admin#provas">Provas</a>.</p>` : ""}
  </section>`;
}

/* ---------------- No radar ---------------- */

export function secaoRadar(noticias: Noticia[], agora: number): string {
  if (!noticias.length) return "";
  const TEMA: Record<string, string> = { ia: "IA", empreendedorismo: "Empreendedorismo", estrategia: "Estratégia" };
  return `<section class="j-radar" id="noticias" aria-label="No radar">
    <div class="j-secao-topo"><h2>No radar</h2><span class="j-mod-st">Notícias curadas pela equipe</span></div>
    <div class="j-radar-grade">
      ${noticias.map((n) => `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">
        ${n.tema && TEMA[n.tema] ? `<span class="j-over-azul">${TEMA[n.tema]}</span>` : ""}
        <b>${esc(n.titulo)}</b>
        ${n.resumo ? `<p>${esc(n.resumo)}</p>` : ""}
        <span class="j-radar-pe"><span>${esc(n.fonte)}${n.publicada_em ? ` · ${haQuanto(n.publicada_em, agora)}` : ""}</span>${I.fora}</span>
      </a>`).join("")}
    </div>
  </section>`;
}

/* ---------------- página ---------------- */

export function corpoJornada(d: DadosJornada): string {
  const trilha = [...d.modulos.values()].flat();
  const total = trilha.length;
  if (!total) return `<main class="wrap"><div class="vazio card" style="margin-top:40px"><h2>Nenhuma aula publicada</h2></div></main>`;

  const ordem = [...d.modulos.keys()];
  const trancaDe = (m: string) => bloqueioDe(d.provas, ordem, m);
  const proxima = trilha.find((a) => !a.concluida_em && !trancaDe(a.modulo));
  const posProxima = proxima ? trilha.indexOf(proxima) + 1 : 0;
  const moduloAtivo = proxima ? proxima.modulo : null;
  const minutos = trilha.reduce((s, a) => s + a.duracao_seg, 0);
  const numGlobal = { n: 0 };

  return `<style>${CSS_JORNADA}</style>
  <main class="wrap j-wrap">
    <div class="j-cabeca">
      <div><h1>Sua jornada</h1>
        <p class="j-sub">${esc(d.subtitulo)} · ${total} aula${total === 1 ? "" : "s"} · ${duracao(minutos)} de conteúdo</p></div>
    </div>

    <div class="j-topo-grade">
      ${cartaoRetomar(d, trilha, proxima, posProxima)}
      ${cartaoProgresso(d, trilha)}
    </div>

    <div class="j-corpo">
      <aside class="j-lateral">
        ${sumario(d, moduloAtivo, trancaDe)}
        ${leiturasAside(d.leituras, "so-desktop")}
      </aside>
      <div class="j-principal">
        <div class="j-secao-topo"><h2>Trilha de aulas</h2>
          ${[...d.provas.values()].some((s) => s.publicada && s.exige) ? `<span class="j-mod-st so-desktop">Módulos trancados abrem com a aprovação na prova do módulo anterior</span>` : ""}</div>
        ${ordem.map((m, i) => blocoModulo(d, m, i, numGlobal, trancaDe)).join("")}
        ${leiturasAside(d.leituras, "so-mobile")}
        ${secaoRadar(d.noticias, d.agora)}
      </div>
    </div>
  </main>`;
}

/* ---------------- estilo ---------------- */

export const CSS_JORNADA = `
.j-wrap{padding:22px 0 8px}
.j-cabeca{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px;margin:14px 0 20px}
.j-cabeca h1{font-size:26px}
.j-sub{color:var(--muted);font-size:14px;margin-top:6px}
@media(min-width:900px){.j-wrap{padding-top:36px}.j-cabeca h1{font-size:32px}.j-sub{font-size:15px}}

.j-over{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(255,255,255,.85);margin-bottom:12px}
.j-over-cinza{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.j-over-azul{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--azul)}
.j-cod{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.05em;color:var(--muted)}
.j-ico{width:22px;height:22px;flex:0 0 22px}

/* faixa superior: Retomar + Progresso */
.j-topo-grade{display:grid;gap:16px;margin-bottom:28px}
@media(min-width:900px){.j-topo-grade{grid-template-columns:minmax(0,1fr) 420px;gap:24px;margin-bottom:40px}}

.j-hero{background:${M.marca};${PONTOS("rgba(255,255,255,.12)")};color:#fff;border-radius:var(--raio);
  padding:22px 20px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
@media(min-width:900px){.j-hero{padding:32px 36px}}
.j-hero-t{font-size:26px;line-height:1.15;letter-spacing:-.02em;color:#fff;margin:0}
@media(min-width:900px){.j-hero-t{font-size:34px;line-height:1.1}}
.j-hero-m{font-size:14px;margin-top:10px;color:#fff}
@media(min-width:900px){.j-hero-m{font-size:16px}}
.j-hero-p{font-size:14px;color:rgba(255,255,255,.85);margin-top:10px;max-width:56ch}
.j-hero-p i{font-style:italic}
.j-hero-acoes{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
.j-cta{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:${M.destaque};color:#000;
  font-weight:600;font-size:17px;min-height:52px;padding:0 28px;border-radius:var(--raio);border:0;cursor:pointer;
  box-shadow:0 1px 2px rgba(0,0,0,.15);transition:.15s;flex:1 1 auto}
@media(min-width:900px){.j-cta{font-size:18px;min-height:60px;padding:0 32px;flex:0 0 auto}}
.j-cta:hover{background:#fff;text-decoration:none}
.j-cta:focus-visible{outline:3px solid #fff;outline-offset:3px}
.j-btn-claro,.j-btn-branco{display:inline-flex;align-items:center;justify-content:center;font-family:inherit;
  font-weight:500;font-size:15px;min-height:48px;padding:0 22px;border-radius:var(--raio);cursor:pointer;transition:.15s;flex:1 1 auto}
.j-btn-claro{background:transparent;border:1px solid rgba(255,255,255,.55);color:#fff;width:100%}
.j-btn-claro:hover{background:rgba(255,255,255,.12);text-decoration:none}
.j-btn-branco{background:#fff;border:0;color:${M.marca};font-weight:600}
.j-btn-branco:hover{background:${M.destaque};color:#000;text-decoration:none}
.j-btn-claro:focus-visible,.j-btn-branco:focus-visible{outline:3px solid #fff;outline-offset:3px}
.j-hero form{flex:1 1 auto;display:contents}
.j-hero-num{font-size:44px;font-weight:600;letter-spacing:-.03em;color:#fff;line-height:1}
.j-hero-num span{font-size:15px;font-weight:400;letter-spacing:0;color:rgba(255,255,255,.85)}
.j-hero-barra{height:8px;background:rgba(255,255,255,.25);border-radius:5px;overflow:hidden;margin:14px 0 18px}
.j-hero-barra i{display:block;height:100%;background:#fff;border-radius:5px}
.j-hero-lista{display:grid;gap:2px;background:rgba(255,255,255,.1);border-radius:var(--raio);padding:12px 14px;margin-top:16px}
.j-hero-lista div{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:14px;padding:4px 0}

/* progresso */
.j-prog{padding:22px 24px!important;display:flex;flex-direction:column;gap:14px}
.j-prog-num{font-size:34px;font-weight:600;letter-spacing:-.03em;color:var(--azul);line-height:1}
@media(min-width:900px){.j-prog-num{font-size:44px}}
.j-prog-num span{font-size:15px;font-weight:400;letter-spacing:0;color:var(--muted)}
.j-barra{height:8px;background:var(--bg);border-radius:5px;overflow:hidden}
.j-barra i{display:block;height:100%;background:var(--azul);border-radius:5px}
.j-stats{display:grid;grid-template-columns:repeat(3,1fr);margin-top:2px}
.j-stats div{padding:2px 12px;border-left:1px solid #E6E6E6;font-size:14px;color:var(--muted);min-width:0}
.j-stats div:first-child{border-left:0;padding-left:0}
.j-stats b{font-size:19px;font-weight:600;color:var(--texto)}
.j-stats span{display:block;font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.35}
.j-nota{font-size:13px;color:var(--muted);border-top:1px solid #E6E6E6;padding-top:12px}

/* corpo: lateral + principal — min-width:0 deixa filhos de grid encolherem,
   senão a fileira de chips alarga a página inteira no mobile */
.j-corpo{display:grid;gap:20px}
.j-corpo>*,.j-lateral,.j-principal{min-width:0}
.j-lateral{max-width:100%}
@media(min-width:900px){.j-corpo{grid-template-columns:272px minmax(0,1fr);gap:32px;align-items:start}
  .j-lateral{position:sticky;top:24px;display:grid;gap:24px}}
.so-desktop{display:none}
@media(min-width:900px){.so-desktop{display:block}.so-mobile{display:none!important}}

/* sumário desktop */
.j-sum{padding:18px 0 10px!important}
.j-sum ol{list-style:none;margin:10px 0 0;padding:0}
.j-sum a{display:grid;grid-template-columns:28px 1fr;gap:2px 10px;align-items:center;min-height:48px;
  padding:8px 20px 8px 13px;border-left:3px solid transparent;color:var(--texto);font-size:14px}
.j-sum a:hover{background:var(--bg);text-decoration:none}
.j-sum a:focus-visible{outline:2px solid var(--azul);outline-offset:-2px}
.j-sum a.ativo{border-left-color:var(--azul);background:var(--bg);font-weight:600}
.j-sum a.trancado{color:var(--muted)}
.j-sum .j-sum-nome{line-height:1.3}
.j-sum .j-sum-n{grid-column:2;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-weight:400}

/* chips mobile */
.j-chips{margin:0 -16px;max-width:calc(100% + 32px)}
.j-chips ol{list-style:none;display:flex;gap:8px;overflow-x:auto;padding:2px 16px 8px;margin:0;
  max-width:100%;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.j-chips ol::-webkit-scrollbar{display:none}
.j-chips a{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:0 14px;border-radius:var(--raio);
  background:#fff;border:1px solid var(--linha);font-size:14px;font-weight:500;color:var(--texto);white-space:nowrap}
.j-chips a.ativo{background:var(--azul);border-color:var(--azul);color:#fff}
.j-chips a.ativo .j-cod,.j-chips a.ativo .j-chip-n{color:rgba(255,255,255,.85)}
.j-chips a.trancado{color:var(--muted)}
.j-chip-n{font-size:12px;color:var(--muted)}

/* leituras */
.j-leituras{padding:18px 0 8px!important}
.j-leituras a{display:flex;align-items:center;gap:12px;min-height:56px;padding:8px 20px;
  border-top:1px solid #E6E6E6;color:var(--texto)}
.j-leituras a:first-of-type{border-top:0;margin-top:10px}
.j-leituras a:hover{background:var(--bg);text-decoration:none}
.j-leituras a:focus-visible{outline:2px solid var(--azul);outline-offset:-2px}
.j-leit-txt{flex:1;min-width:0}
.j-leit-txt b{display:block;font-weight:500;font-size:14px}
.j-leit-txt span{display:block;font-size:12px;color:var(--muted);margin-top:1px}
.j-ler{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;color:var(--azul);white-space:nowrap}

/* trilha */
.j-secao-topo{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:14px}
.j-secao-topo h2{font-size:20px}
@media(min-width:900px){.j-secao-topo h2{font-size:22px}}
.j-mod{padding:0!important;margin-bottom:20px;overflow:hidden}
.j-mod-topo{display:grid;gap:10px;padding:16px 16px 14px}
@media(min-width:900px){.j-mod-topo{grid-template-columns:1fr 200px;padding:18px 24px 16px;align-items:start}}
.j-mod-topo h3{font-size:16px;display:flex;align-items:center;gap:8px;margin-top:4px}
@media(min-width:900px){.j-mod-topo h3{font-size:18px}}
.j-mod.trancado .j-mod-topo h3{color:var(--muted)}
.j-mod-st{font-size:13px;color:var(--muted);margin-top:3px}
.j-mod-num{font-size:12px;color:var(--muted)}
@media(min-width:900px){.j-mod-num{text-align:right}}
.j-minibarra{display:block;height:6px;background:var(--bg);border-radius:4px;overflow:hidden;margin-top:7px}
.j-minibarra i{display:block;height:100%;background:var(--azul);border-radius:4px}
.j-aula{display:grid;grid-template-columns:28px 22px minmax(0,1fr) auto;gap:10px;align-items:center;
  min-height:52px;padding:8px 16px;border-top:1px solid #E6E6E6;color:var(--texto)}
@media(min-width:900px){.j-aula{grid-template-columns:40px 22px minmax(0,1fr) auto;gap:14px;padding:8px 24px}}
.j-aula:hover{background:var(--bg);text-decoration:none}
.j-aula:focus-visible{outline:2px solid var(--azul);outline-offset:-2px}
.j-aula.proxima{background:var(--bg)}
.j-aula.proxima .j-aula-t{font-weight:600}
.j-aula.trancada .j-aula-t{color:var(--muted)}
.j-aula-t{font-size:14px;line-height:1.35}
@media(min-width:900px){.j-aula-t{font-size:15px}}
.j-tag{font-style:normal;font-size:12px;font-weight:500;color:var(--azul);margin-left:4px}
.j-aula-d{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted);white-space:nowrap}
.j-aula-d .j-cod{font-size:11px}
@media(min-width:900px){.j-aula-d .j-cod{font-size:12px}}
.j-prova{background:var(--bg);border-top:1px solid var(--linha)}
.j-prova .j-cod:first-child{color:var(--azul)}
.j-prova .j-aula-t{font-weight:500}
.j-prova[aria-disabled]{cursor:default}
.j-prova[aria-disabled]:hover{background:var(--bg)}
.j-ok{color:var(--azul);font-weight:500}
.j-so-adm{font-size:13px;color:var(--muted);padding:10px 16px;border-top:1px dashed var(--linha);opacity:.85}
@media(min-width:900px){.j-so-adm{padding:10px 24px}}

/* no radar */
.j-radar{margin-top:36px}
.j-radar-grade{display:grid;gap:14px}
@media(min-width:900px){.j-radar-grade{grid-template-columns:repeat(3,1fr);gap:16px}}
.j-radar-grade a{display:flex;flex-direction:column;gap:10px;background:#fff;border:1px solid var(--linha);
  border-radius:var(--raio);padding:16px;color:var(--texto);min-height:0;transition:box-shadow .15s}
@media(min-width:900px){.j-radar-grade a{padding:20px 22px;min-height:180px}}
.j-radar-grade a:hover{text-decoration:none;box-shadow:0 0 0 2px var(--azul)}
.j-radar-grade a:focus-visible{outline:2px solid var(--azul);outline-offset:2px}
.j-radar-grade b{font-weight:600;font-size:15px;line-height:1.3}
@media(min-width:900px){.j-radar-grade b{font-size:16px}}
.j-radar-grade p{font-size:14px;line-height:1.45;color:var(--muted);flex:1}
.j-radar-pe{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);
  border-top:1px solid #E6E6E6;padding-top:10px;margin-top:2px}
`;
