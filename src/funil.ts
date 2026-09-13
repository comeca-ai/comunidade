// Funil de entrada na comunidade — do curso ao engajamento.
//
// Etapas (cada aluno fica na mais avançada que alcançou):
//   0 fez o curso   está na base (matrícula), com ou sem turma
//   1 deu o de acordo   consentiu_em na matrícula (página /quero, painel ou importação)
//   2 recebeu o convite   link tipo "convite" aceito pelo provedor
//   3 abriu o e-mail   pixel de abertura — sinal, não certeza
//   4 entrou   clicou no link e criou sessão
//   5 engajou   concluiu aula, leu uma leitura ou voltou em outro dia
//   6 concluiu   todas as aulas publicadas
//
// O que este módulo acrescenta ao banco entra sozinho (garantirEsquemaFunil):
// colunas turma/consentiu_em/consentimento em matriculas, tipo/criado_em/
// aberto_em em links_magicos, e as tabelas acessos (um registro por aluno e
// dia) e pedidos (quem pediu convite no /quero sem estar na base).

import { Hono } from "hono";
import { pagina, esc, jsStr } from "./ui";
import { enviarLinkMagico, VALIDADE_CONVITE } from "./acesso";
import { DIA, haQuanto, nomeOu, iniciais, diaLocal, emSegundoPlano } from "./apoio";
import { regrasDoEnv, moduloNaLeitura, listaDeModulos } from "../packages/conteudo/modulos";

/* ---------------- esquema ---------------- */

let esquemaPronto: Promise<void> | null = null;

// roda uma vez por isolate; se falhar, tenta de novo na próxima chamada
export function garantirEsquemaFunil(env: any): Promise<void> {
  if (!esquemaPronto) esquemaPronto = migrar(env).catch((e) => { esquemaPronto = null; throw e; });
  return esquemaPronto;
}

async function colunasDe(env: any, tabela: string): Promise<Set<string>> {
  const r: any = await env.DB.prepare(`PRAGMA table_info(${tabela})`).all();
  return new Set((r.results ?? []).map((c: any) => String(c.name)));
}

async function migrar(env: any) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS acessos (
      aluno_id INTEGER NOT NULL, dia INTEGER NOT NULL, PRIMARY KEY (aluno_id, dia))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, nome TEXT, turma TEXT, criado_em INTEGER NOT NULL)`),
  ]);
  const m = await colunasDe(env, "matriculas");
  const alteracoes: string[] = [];
  let legado = false;
  if (!m.has("turma")) alteracoes.push(`ALTER TABLE matriculas ADD COLUMN turma TEXT`);
  if (!m.has("consentiu_em")) { alteracoes.push(`ALTER TABLE matriculas ADD COLUMN consentiu_em INTEGER`); legado = true; }
  if (!m.has("consentimento")) alteracoes.push(`ALTER TABLE matriculas ADD COLUMN consentimento TEXT`);
  const l = await colunasDe(env, "links_magicos");
  if (!l.has("tipo")) alteracoes.push(`ALTER TABLE links_magicos ADD COLUMN tipo TEXT`);
  if (!l.has("criado_em")) alteracoes.push(`ALTER TABLE links_magicos ADD COLUMN criado_em INTEGER`);
  if (!l.has("aberto_em")) alteracoes.push(`ALTER TABLE links_magicos ADD COLUMN aberto_em INTEGER`);
  for (const sql of alteracoes) await env.DB.prepare(sql).run();
  // quem já estava na base foi cadastrado à mão pela equipe: conta como de
  // acordo na data da matrícula, marcado como "legado" para não se confundir
  if (legado) await env.DB.prepare(
    `UPDATE matriculas SET consentiu_em = criada_em, consentimento = 'legado' WHERE consentiu_em IS NULL`).run();
}

/* ---------------- acesso diário ---------------- */

// um registro por aluno e dia, e ultimo_acesso atualizado no máximo de hora
// em hora — sessão dura 30 dias, então o login sozinho não diz quem voltou
export async function registrarAcesso(env: any, alunoId: number, agora: number) {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO acessos (aluno_id, dia) VALUES (?,?)`).bind(alunoId, diaLocal(agora)),
    env.DB.prepare(`UPDATE alunos SET ultimo_acesso = ? WHERE id = ? AND (ultimo_acesso IS NULL OR ultimo_acesso < ?)`)
      .bind(agora, alunoId, agora - 3600),
  ]);
}

/* ---------------- dados ---------------- */

export type LinhaFunil = {
  id: number; email: string; nome: string | null; ultimo_acesso: number | null;
  matricula_em: number; turma: string | null; consentiu_em: number | null; consentimento: string | null;
  feitas: number; primeira_aula: number | null; ultimo_progresso: number | null;
  lidas: number; primeira_leitura: number | null;
  links: number; primeiro_convite: number | null; ultimo_envio: number | null; ultimo_link: number | null;
  primeira_abertura: number | null; primeira_entrada: number | null;
  dias_acesso: number; segundo_dia: number | null;
};

export type Filtros = { turma: string; desde: number };   // turma "" = todas, "-" = sem turma; desde 0 = tudo

export function filtrosDe(q: Record<string, string | undefined>): Filtros {
  const desde = Number(q.desde ?? 0);
  return { turma: (q.turma ?? "").slice(0, 60), desde: [30, 90].includes(desde) ? desde : 0 };
}

export async function linhasFunil(env: any, f: Filtros, agora: number): Promise<LinhaFunil[]> {
  let sql = `SELECT a.id, a.email, a.nome, a.ultimo_acesso,
       m.criada_em AS matricula_em, m.turma, m.consentiu_em, m.consentimento,
       (SELECT COUNT(*) FROM progresso p JOIN aulas au ON au.uid = p.aula_uid
         WHERE p.aluno_id = a.id AND p.concluida_em IS NOT NULL AND au.publicada = 1) AS feitas,
       (SELECT MIN(p.concluida_em) FROM progresso p WHERE p.aluno_id = a.id AND p.concluida_em IS NOT NULL) AS primeira_aula,
       (SELECT MAX(p.concluida_em) FROM progresso p WHERE p.aluno_id = a.id) AS ultimo_progresso,
       (SELECT COUNT(*) FROM artigos_lidos l WHERE l.aluno_id = a.id) AS lidas,
       (SELECT MIN(l.lido_em) FROM artigos_lidos l WHERE l.aluno_id = a.id) AS primeira_leitura,
       (SELECT COUNT(*) FROM links_magicos lm WHERE lm.email = a.email) AS links,
       (SELECT MIN(lm.criado_em) FROM links_magicos lm WHERE lm.email = a.email AND lm.tipo = 'convite') AS primeiro_convite,
       (SELECT MAX(lm.criado_em) FROM links_magicos lm WHERE lm.email = a.email AND lm.tipo IN ('convite','lembrete')) AS ultimo_envio,
       (SELECT MAX(lm.expira_em) FROM links_magicos lm WHERE lm.email = a.email) AS ultimo_link,
       (SELECT MIN(lm.aberto_em) FROM links_magicos lm WHERE lm.email = a.email) AS primeira_abertura,
       (SELECT MIN(lm.usado_em) FROM links_magicos lm WHERE lm.email = a.email) AS primeira_entrada,
       (SELECT COUNT(*) FROM acessos ac WHERE ac.aluno_id = a.id) AS dias_acesso,
       (SELECT ac.dia FROM acessos ac WHERE ac.aluno_id = a.id ORDER BY ac.dia LIMIT 1 OFFSET 1) AS segundo_dia
     FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?`;
  const binds: any[] = [env.ESCOLA];
  if (f.turma === "-") sql += ` AND m.turma IS NULL`;
  else if (f.turma) { sql += ` AND m.turma = ?`; binds.push(f.turma); }
  if (f.desde) { sql += ` AND m.criada_em >= ?`; binds.push(agora - f.desde * DIA); }
  const r: any = await env.DB.prepare(sql + ` ORDER BY m.criada_em DESC, a.id DESC`).bind(...binds).all();
  return r.results ?? [];
}

export const ETAPAS_FUNIL = [
  { nome: "Fez o curso", dica: "está na base da comunidade", passo: "deram o de acordo", parado: "ainda sem de acordo" },
  { nome: "Deu o de acordo", dica: "topou receber o convite", passo: "receberam o convite", parado: "sem convite" },
  { nome: "Recebeu o convite", dica: "e-mail aceito pelo provedor", passo: "abriram o e-mail", parado: "nunca abriram" },
  { nome: "Abriu o e-mail", dica: "pixel de abertura — sinal, não certeza", passo: "entraram", parado: "abriram e não entraram" },
  { nome: "Entrou", dica: "clicou no link e criou sessão", passo: "engajaram", parado: "entraram e não fizeram nada" },
  { nome: "Engajou", dica: "concluiu aula, leu ou voltou outro dia", passo: "concluíram", parado: "em andamento" },
  { nome: "Concluiu", dica: "todas as aulas · certificado", passo: "", parado: "" },
];

export function etapaFunil(l: LinhaFunil, totalAulas: number): number {
  if (totalAulas > 0 && l.feitas >= totalAulas) return 6;
  if (l.feitas > 0 || l.lidas > 0 || l.dias_acesso >= 2) return 5;
  if (l.ultimo_acesso || l.primeira_entrada) return 4;
  if (l.primeira_abertura) return 3;
  if (l.links > 0) return 2;
  if (l.consentiu_em) return 1;
  return 0;
}

// instante em que o aluno chegou a cada etapa (null = não se sabe)
function marcos(l: LinhaFunil, totalAulas: number): (number | null)[] {
  const eng = [l.primeira_aula, l.primeira_leitura, l.segundo_dia ? l.segundo_dia * DIA + 3 * 3600 : null]
    .filter((x): x is number => !!x);
  return [
    l.matricula_em, l.consentiu_em, l.primeiro_convite, l.primeira_abertura, l.primeira_entrada,
    eng.length ? Math.min(...eng) : null,
    totalAulas > 0 && l.feitas >= totalAulas ? l.ultimo_progresso : null,
  ];
}

const mediana = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const intervalo = (seg: number) =>
  seg < 3600 ? "< 1 h" : seg < DIA ? `${Math.round(seg / 3600)} h` : `${Math.round(seg / DIA)} d`;

// quem está parado na etapa i e já está parado há tempo suficiente para
// receber outro e-mail (3 dias) — evita virar spam
const PARADO_HA = 3 * DIA;
export function elegiveisLote(linhas: LinhaFunil[], totalAulas: number, etapa: number, agora: number): LinhaFunil[] {
  return linhas.filter((l) => etapaFunil(l, totalAulas) === etapa).filter((l) => {
    if (etapa === 1) return !!l.consentiu_em;
    if (etapa === 2 || etapa === 3) return (l.ultimo_envio ?? 0) <= agora - PARADO_HA;
    if (etapa === 4) return (l.ultimo_acesso ?? 0) <= agora - PARADO_HA && (l.ultimo_envio ?? 0) <= agora - PARADO_HA;
    return false;
  });
}

export async function turmasDe(env: any): Promise<string[]> {
  const r: any = await env.DB.prepare(
    `SELECT turma, MAX(criada_em) u FROM matriculas WHERE escola = ? AND turma IS NOT NULL GROUP BY turma ORDER BY u DESC`
  ).bind(env.ESCOLA).all();
  return (r.results ?? []).map((x: any) => String(x.turma));
}

// primeira aula da trilha — destino do lembrete
export async function primeiraAula(env: any): Promise<{ uid: string; titulo: string; minutos: number } | null> {
  const r: any = await env.DB.prepare(`SELECT uid, titulo, modulo, ordem, duracao_seg, criada_em FROM aulas WHERE publicada = 1`).all();
  const regras = regrasDoEnv(env);
  const ordem = listaDeModulos(env.ORDEM_MODULOS);
  const peso = (m: string) => { const i = ordem.indexOf(m); return i === -1 ? ordem.length + 1 : i; };
  const [a] = (r.results ?? []).map((l: any) => ({ ...l, ...moduloNaLeitura(l, regras) }))
    .sort((x: any, y: any) => peso(x.modulo) - peso(y.modulo) || x.ordem - y.ordem || (x.criada_em ?? 0) - (y.criada_em ?? 0) || x.titulo.localeCompare(y.titulo, "pt-BR"));
  return a ? { uid: a.uid, titulo: a.titulo, minutos: Math.max(1, Math.round(a.duracao_seg / 60)) } : null;
}

/* ---------------- tela do painel ---------------- */

const qs = (f: Filtros, extra = "") =>
  `turma=${encodeURIComponent(f.turma)}&desde=${f.desde}${extra}`;
const hidden = (f: Filtros) =>
  `<input type="hidden" name="turma" value="${esc(f.turma)}"><input type="hidden" name="desde" value="${f.desde}"><input type="hidden" name="volta" value="funil">`;

export function secaoFunil(o: { linhas: LinhaFunil[]; totalAulas: number; agora: number; turmas: string[]; f: Filtros; aberta?: number }): string {
  const { linhas, totalAulas, agora, f } = o;
  const etapas = linhas.map((l) => etapaFunil(l, totalAulas));
  const total = linhas.length;
  const chegaram = ETAPAS_FUNIL.map((_, i) => etapas.filter((e) => e >= i).length);
  const marcosDe = linhas.map((l) => marcos(l, totalAulas));

  const chipT = (rotulo: string, valor: string) =>
    `<a class="chip ${f.turma === valor ? "ativa" : ""}" href="/admin?${qs({ ...f, turma: valor })}#funil">${esc(rotulo)}</a>`;
  const chipD = (rotulo: string, valor: number) =>
    `<a class="chip ${f.desde === valor ? "ativa" : ""}" href="/admin?${qs({ ...f, desde: valor })}#funil">${rotulo}</a>`;
  const semTurma = linhas.some((l) => !l.turma) || f.turma === "-";

  const filtros = `<div class="funil-filtros">
    <div class="chips"><span class="mono">Turma</span>${chipT("Todas", "")}${o.turmas.map((t) => chipT(t, t)).join("")}${semTurma || o.turmas.length ? chipT("Sem turma", "-") : ""}</div>
    <div class="chips"><span class="mono">Na base há</span>${chipD("30 d", 30)}${chipD("90 d", 90)}${chipD("tudo", 0)}</div>
  </div>`;

  const corpo = ETAPAS_FUNIL.map((e, i) => {
    const aqui = linhas.filter((_, k) => etapas[k] === i);
    const pct = total ? Math.round(chegaram[i] / total * 100) : 0;
    // conversão desta etapa para a próxima — é o que a linha de queda descreve
    const prox = i < 6 ? (chegaram[i] ? Math.round(chegaram[i + 1] / chegaram[i] * 100) : 0) : null;
    // tempo típico da etapa anterior até esta
    const deltas = linhas.flatMap((_, k) => {
      if (i === 0 || etapas[k] < i) return [];
      const a = marcosDe[k][i - 1], b = marcosDe[k][i];
      return a && b && b >= a ? [b - a] : [];
    });
    const med = mediana(deltas);
    const tempo = i === 0 ? "base" : med === null ? "" : `mediana ${intervalo(med)}`;
    const elegiveis = elegiveisLote(linhas, totalAulas, i, agora).length;

    const linha = `<button type="button" class="funil-etapa" data-etapa="${i}" aria-expanded="${o.aberta === i ? "true" : "false"}"
        title="${chegaram[i]} de ${total} chegaram até aqui · ${aqui.length} parado${aqui.length === 1 ? "" : "s"} nesta etapa">
      <span class="n mono">0${i + 1}</span>
      <span class="nome"><b>${esc(e.nome)}</b><small>${esc(e.dica)}</small></span>
      <span class="fbarra"><i style="width:${pct}%"></i></span>
      <span class="num">${chegaram[i]}</span>
      <span class="pct">${pct}%</span>
      <span class="tempo">${tempo}</span>
    </button>`;

    const acaoLote = i >= 1 && i <= 4 && elegiveis
      ? `<form method="post" action="/admin/funil/lote" class="funil-lote"
          onsubmit="return confirm('${i === 1 ? `Enviar convite (48 h) para ${elegiveis} aluno${elegiveis === 1 ? "" : "s"} com de acordo?`
            : i === 4 ? `Enviar lembrete da primeira aula para ${elegiveis} aluno${elegiveis === 1 ? "" : "s"} parado${elegiveis === 1 ? "" : "s"} há 3+ dias?`
            : `Reenviar link (48 h) para ${elegiveis} aluno${elegiveis === 1 ? "" : "s"} parado${elegiveis === 1 ? "" : "s"} há 3+ dias?`}')">
          <input type="hidden" name="etapa" value="${i}">${hidden(f)}
          <button class="btn btn-fantasma" type="submit">${i === 1 ? `Enviar convite ${elegiveis === 1 ? "a esse" : `aos ${elegiveis}`}`
            : i === 4 ? `Lembrete da 1ª aula ${elegiveis === 1 ? "a esse" : `aos ${elegiveis}`}`
            : `Reenviar ${elegiveis === 1 ? "a esse" : `aos ${elegiveis}`} parado${elegiveis === 1 ? "" : "s"} há 3+ d`}</button>
        </form>`
      : i === 0 && aqui.length
      ? `<button type="button" class="btn btn-fantasma" data-copiar="${esc(aqui.map((l) => `${nomeOu(l)} <${l.email}>`).join("\n")).replace(/\n/g, "&#10;")}">Copiar ${aqui.length === 1 ? "contato" : `${aqui.length} contatos`}</button>`
      : "";

    const queda = i < 6 ? `<div class="queda" data-etapa="${i}">
      <span class="seta">↓</span>
      <span><b>${prox}%</b> ${esc(e.passo)}</span>
      <span class="perdeu">${aqui.length ? `${aqui.length} ${esc(e.parado)}` : "ninguém parado aqui"}</span>
      <span class="acao">${acaoLote}</span>
    </div>` : "";

    const lista = `<div class="funil-lista" data-lista="${i}" ${o.aberta === i ? "" : "hidden"}>
      ${aqui.length ? aqui.map((l) => itemFunil(l, i, totalAulas, agora, f)).join("")
        : `<p class="vazio" style="padding:18px">Ninguém parado nesta etapa.</p>`}
    </div>`;
    return linha + queda + lista;
  }).join("");

  const nota = `<p class="aula-meta" style="margin-top:16px;max-width:70ch">A barra é acumulada (quem passou pela etapa); a lista, ao clicar,
    é de quem está parado nela. Convite e reenvio em massa só vão para quem tem de acordo registrado e, no reenvio, está parado há 3 dias ou mais.
    "Abriu o e-mail" vem de um pixel: Apple Mail costuma marcar como aberto sem ninguém abrir, e clientes corporativos bloqueiam a imagem.</p>`;

  return `${filtros}
    <div class="funil-v">${total ? corpo : `<p class="vazio">Ninguém na base com esse filtro.</p>`}</div>
    ${nota}`;
}

function itemFunil(l: LinhaFunil, etapa: number, totalAulas: number, agora: number, f: Filtros): string {
  const envios = l.links > 1 ? ` · ${l.links}º envio` : "";
  const meta = etapa === 0 ? `na base ${haQuanto(l.matricula_em, agora)}${l.turma ? ` · ${esc(l.turma)}` : ""} · sem de acordo`
    : etapa === 1 ? `de acordo ${haQuanto(l.consentiu_em, agora)}${l.consentimento ? ` (${esc(l.consentimento)})` : ""} · sem convite`
    : etapa === 2 ? `convite ${haQuanto(l.ultimo_envio ?? l.ultimo_link, agora)}${envios} · não abriu${(l.ultimo_link ?? 0) > agora ? "" : " · link vencido"}`
    : etapa === 3 ? `abriu ${haQuanto(l.primeira_abertura, agora)} · não entrou${(l.ultimo_link ?? 0) > agora ? " · link ainda vale" : " · link vencido"}`
    : etapa === 4 ? `entrou ${haQuanto(l.ultimo_acesso ?? l.primeira_entrada, agora)} · nenhuma aula`
    : etapa === 5 ? `${l.feitas}/${totalAulas} aulas${l.lidas ? ` · ${l.lidas} leitura${l.lidas === 1 ? "" : "s"}` : ""} · ativo ${haQuanto(l.ultimo_acesso, agora)}`
    : `concluiu ${haQuanto(l.ultimo_progresso, agora)}`;
  const acao = etapa === 0 ? { rota: "consentir", rotulo: "Marcar de acordo e convidar",
      confirma: `Registrar o de acordo de ${nomeOu(l)} (dado a você) e enviar o convite?` }
    : etapa === 1 ? { rota: "convite", rotulo: "Enviar convite" }
    : etapa === 2 || etapa === 3 ? { rota: "convite", rotulo: "Reenviar link" }
    : etapa === 4 ? { rota: "lembrete", rotulo: "Lembrete da 1ª aula" }
    : null;
  return `<div class="aula funil-item" style="cursor:default">
    <span class="avatar">${esc(iniciais(l))}</span>
    <span class="aula-txt"><b>${esc(nomeOu(l))}</b><span class="aula-meta">${esc(l.email)} · ${meta}</span></span>
    <span class="acoes">
      <a class="btn btn-fantasma" href="/admin/aluno/${l.id}">Ver</a>
      ${acao ? `<form method="post" action="/admin/aluno/${l.id}/${acao.rota}"${acao.confirma ? ` onsubmit="return confirm(${jsStr(acao.confirma)})"` : ""}>
        ${hidden(f)}<button class="btn btn-fantasma" type="submit">${acao.rotulo}</button></form>` : ""}
    </span>
  </div>`;
}

/* ---------------- pedidos pelo site ---------------- */

export async function pedidosPendentes(env: any): Promise<any[]> {
  const r: any = await env.DB.prepare(`SELECT id, email, nome, turma, criado_em FROM pedidos ORDER BY criado_em DESC`).all();
  return r.results ?? [];
}

export function secaoPedidos(pedidos: any[], agora: number): string {
  if (!pedidos.length) return "";
  return `<div class="card" style="margin-top:14px" id="pedidos">
    <p class="mono">Pedidos pelo site</p>
    <p style="margin-top:8px;color:var(--muted);max-width:62ch">${pedidos.length} pessoa${pedidos.length === 1 ? "" : "s"} pedi${pedidos.length === 1 ? "u" : "ram"} o convite em
      <b>/quero</b> sem estar na base. Cadastrar já registra o de acordo e envia o convite.</p>
    <div style="margin-top:8px">${pedidos.map((p) => `<div class="aula funil-item" style="cursor:default">
      <span class="avatar">${esc(iniciais(p))}</span>
      <span class="aula-txt"><b>${esc(nomeOu(p))}</b><span class="aula-meta">${esc(p.email)}${p.turma ? ` · ${esc(p.turma)}` : ""} · pediu ${haQuanto(p.criado_em, agora)}</span></span>
      <span class="acoes">
        <form method="post" action="/admin/pedidos/${p.id}/aprovar"><button class="btn btn-primario" type="submit">Cadastrar e convidar</button></form>
        <form method="post" action="/admin/pedidos/${p.id}/descartar" onsubmit="return confirm(${jsStr(`Descartar o pedido de ${p.email}?`)})">
          <button class="btn btn-fantasma" type="submit">Descartar</button></form>
      </span>
    </div>`).join("")}</div>
  </div>`;
}

/* ---------------- rotas ---------------- */

const GIF = new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);

type Deps = { exigeAdmin: any; agora: () => number };

export function rotasFunil(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  // pixel de abertura: marca o link como aberto e devolve um gif transparente
  r.get("/c/:arquivo", async (c) => {
    const token = c.req.param("arquivo").replace(/\.gif$/, "");
    if (/^[0-9a-f]{64}$/.test(token)) {
      await emSegundoPlano(c, c.env.DB.prepare(`UPDATE links_magicos SET aberto_em = COALESCE(aberto_em, ?) WHERE token = ?`)
        .bind(d.agora(), token).run());
    }
    return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store, private", "content-length": String(GIF.length) } });
  });

  // opt-in público: quem fez o curso deixa o e-mail e o de acordo
  r.get("/quero", async (c) => c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Quero o convite", corpo: paginaQuero(c.req.query()) })));

  r.post("/quero", async (c) => {
    const form = await c.req.formData();
    const turma = String(form.get("turma") || "").trim().slice(0, 60);
    const volta = turma ? `&turma=${encodeURIComponent(turma)}` : "";
    if (String(form.get("site") || "")) return c.redirect(`/quero?ok=1${volta}`);   // isca para robô
    const email = String(form.get("email") || "").trim().toLowerCase();
    const nome = String(form.get("nome") || "").trim().slice(0, 80) || null;
    if (!/^[^@\s'"()<>\[\]]+@[^@\s'"()<>\[\]]+\.[^@\s'"()<>\[\]]+$/.test(email) || form.get("aceite") !== "1") return c.redirect(`/quero?erro=1${volta}`);
    const agora = d.agora();

    const aluno: any = await c.env.DB.prepare(
      `SELECT a.id, a.nome FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ? WHERE a.email = ?`
    ).bind(c.env.ESCOLA, email).first();

    if (aluno) {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE matriculas SET consentiu_em = COALESCE(consentiu_em, ?), consentimento = COALESCE(consentimento, 'quero'),
            turma = COALESCE(turma, ?) WHERE aluno_id = ? AND escola = ?`).bind(agora, turma || null, aluno.id, c.env.ESCOLA),
        c.env.DB.prepare(`UPDATE alunos SET nome = COALESCE(nome, ?) WHERE id = ?`).bind(nome, aluno.id),
      ]);
      // no máximo um convite por hora por e-mail, mesmo que peça de novo
      const ultimo: any = await c.env.DB.prepare(
        `SELECT MAX(criado_em) t FROM links_magicos WHERE email = ? AND tipo = 'convite'`).bind(email).first();
      if (!ultimo?.t || ultimo.t < agora - 3600) {
        try { await enviarLinkMagico(c.env, new URL(c.req.url).origin, email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" }); }
        catch { /* resposta igual: não revela nada */ }
      }
    } else {
      await c.env.DB.prepare(`INSERT INTO pedidos (email, nome, turma, criado_em) VALUES (?,?,?,?)
        ON CONFLICT(email) DO UPDATE SET criado_em = excluded.criado_em, nome = COALESCE(excluded.nome, pedidos.nome), turma = COALESCE(excluded.turma, pedidos.turma)`)
        .bind(email, nome, turma || null, agora).run();
    }
    return c.redirect(`/quero?ok=1${volta}`);
  });

  // e-mail em massa para quem está parado numa etapa (respeita filtro e regra dos 3 dias)
  r.post("/admin/funil/lote", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const f = filtrosDe({ turma: String(form.get("turma") || ""), desde: String(form.get("desde") || "0") });
    const etapa = Number(form.get("etapa"));
    const agora = d.agora();
    const [linhas, tot, aula] = await Promise.all([
      linhasFunil(c.env, f, agora),
      c.env.DB.prepare(`SELECT COUNT(*) n FROM aulas WHERE publicada = 1`).first(),
      primeiraAula(c.env),
    ]);
    const origem = new URL(c.req.url).origin;
    let ok = 0, falhas = 0;
    for (const l of elegiveisLote(linhas, Number(tot?.n ?? 0), etapa, agora)) {
      try {
        if (etapa === 4) await enviarLinkMagico(c.env, origem, l.email, { validadeSeg: VALIDADE_CONVITE, tipo: "lembrete", destino: aula ? `/app/aula/${aula.uid}` : "/app", aula });
        else await enviarLinkMagico(c.env, origem, l.email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" });
        ok++;
      } catch { falhas++; }
    }
    return c.redirect(`/admin?liberados=0&convites=${ok}&falhas=${falhas}&funil=${etapa}&${qs(f)}#funil`);
  });

  // o admin registra o de acordo que recebeu (WhatsApp, papel, formulário) e convida
  r.post("/admin/aluno/:id/consentir", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const a: any = await c.env.DB.prepare(
      `SELECT a.email FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ? WHERE a.id = ?`).bind(c.env.ESCOLA, id).first();
    if (!a) return c.notFound();
    await c.env.DB.prepare(`UPDATE matriculas SET consentiu_em = COALESCE(consentiu_em, ?), consentimento = COALESCE(consentimento, 'painel')
      WHERE aluno_id = ? AND escola = ?`).bind(d.agora(), id, c.env.ESCOLA).run();
    const volta = await voltaDe(c, id);
    try {
      await enviarLinkMagico(c.env, new URL(c.req.url).origin, a.email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" });
      return c.redirect(volta("convite=ok"));
    } catch { return c.redirect(volta("convite=erro")); }
  });

  // lembrete individual: "sua primeira aula", com link direto para ela
  r.post("/admin/aluno/:id/lembrete", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const a: any = await c.env.DB.prepare(
      `SELECT a.email FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ? WHERE a.id = ?`).bind(c.env.ESCOLA, id).first();
    if (!a) return c.notFound();
    const aula = await primeiraAula(c.env);
    const volta = await voltaDe(c, id);
    try {
      await enviarLinkMagico(c.env, new URL(c.req.url).origin, a.email,
        { validadeSeg: VALIDADE_CONVITE, tipo: "lembrete", destino: aula ? `/app/aula/${aula.uid}` : "/app", aula });
      return c.redirect(volta("lembrete=ok"));
    } catch { return c.redirect(volta("lembrete=erro")); }
  });

  r.post("/admin/pedidos/:id/aprovar", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const p: any = await c.env.DB.prepare(`SELECT * FROM pedidos WHERE id = ?`).bind(id).first();
    if (!p) return c.notFound();
    const agora = d.agora();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO alunos (email, nome, criado_em) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET nome = COALESCE(alunos.nome, excluded.nome)`).bind(p.email, p.nome, agora),
      c.env.DB.prepare(`INSERT OR IGNORE INTO matriculas (aluno_id, escola, criada_em, turma, consentiu_em, consentimento)
        SELECT id, ?, ?, ?, ?, 'quero' FROM alunos WHERE email = ?`).bind(c.env.ESCOLA, agora, p.turma, p.criado_em, p.email),
      c.env.DB.prepare(`DELETE FROM pedidos WHERE id = ?`).bind(id),
    ]);
    let convites = 0, falhas = 0;
    try { await enviarLinkMagico(c.env, new URL(c.req.url).origin, p.email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" }); convites = 1; }
    catch { falhas = 1; }
    return c.redirect(`/admin?liberados=1&convites=${convites}&falhas=${falhas}#convidar`);
  });

  r.post("/admin/pedidos/:id/descartar", d.exigeAdmin, async (c) => {
    await c.env.DB.prepare(`DELETE FROM pedidos WHERE id = ?`).bind(Number(c.req.param("id"))).run();
    return c.redirect(`/admin?descartado=1#convidar`);
  });

  return r;
}

// para onde voltar depois de uma ação individual: ficha, funil (com filtros) ou painel
export async function voltaDe(c: any, id: number): Promise<(q: string) => string> {
  const form = await c.req.formData().catch(() => null);
  if (form?.get("volta") === "funil") {
    const f = filtrosDe({ turma: String(form.get("turma") || ""), desde: String(form.get("desde") || "0") });
    return (q) => `/admin?${q}&${qs(f)}#funil`;
  }
  if (c.req.header("referer")?.includes("/admin/aluno/")) return (q) => `/admin/aluno/${id}?${q}`;
  return (q) => `/admin?${q}`;
}

function paginaQuero(q: Record<string, string | undefined>): string {
  const turma = (q.turma || "").slice(0, 60);
  const msg = q.ok
    ? `<div class="aviso">Recebemos! Se o seu e-mail está na lista do curso, o convite já está a caminho — vale 48 horas.
        Se não estiver, a equipe olha seu pedido e te avisa.</div>`
    : q.erro ? `<div class="erro">Confere o e-mail e marca a caixa do de acordo.</div>` : "";
  return `<main class="wrap entrada">
    <div class="centro">
      <p class="mono" style="text-align:center">Comunidade começa.ai</p>
      <h1 style="margin:16px 0 12px;text-align:center">Quero entrar na comunidade</h1>
      <p style="color:var(--muted);margin-bottom:26px;text-align:center">Se você fez o curso, deixa seu e-mail e o convite chega em instantes.
        O acesso é por link — sem senha.</p>
      ${msg}
      ${q.ok ? "" : `<form method="post" action="/quero" style="margin-top:20px;display:grid;gap:12px">
        <input type="hidden" name="turma" value="${esc(turma)}">
        <input type="text" name="site" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
        <input class="campo" type="text" name="nome" placeholder="Seu nome" autocomplete="name" maxlength="80">
        <input class="campo" type="email" name="email" required placeholder="seu@email.com" autocomplete="email">
        <label class="aula-meta" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;line-height:1.45">
          <input type="checkbox" name="aceite" value="1" required style="margin-top:3px">
          <span>Quero receber por e-mail o convite e os avisos da comunidade começa.ai. Para sair, é só avisar a equipe.</span>
        </label>
        <button class="btn btn-primario" type="submit">Quero o convite</button>
      </form>`}
      ${turma ? `<p class="aula-meta" style="margin-top:18px;text-align:center">Turma: ${esc(turma)}</p>` : ""}
    </div>
  </main>`;
}
