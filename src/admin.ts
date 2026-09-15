// Painel de administração da comunidade: quem são os alunos, como cada um
// está indo, e as ações do dia a dia — convidar, reenviar acesso, corrigir
// nome, remover. Tudo atrás de exigeAdmin.

import { Hono } from "hono";
import { pagina, esc, duracao, jsStr } from "./ui";
import { enviarLinkMagico, VALIDADE_CONVITE } from "./acesso";
import { secaoAdminLeituras, garantirTabelasLeituras, leiturasDoAluno } from "./leituras";
import { DIA, haQuanto, dataCurta, nomeOu, iniciais, contatosDe, textoDoCsv } from "./apoio";
import { garantirEsquemaFunil, secaoFunil, linhasFunil, filtrosDe, turmasDe, pedidosPendentes, secaoPedidos, voltaDe } from "./funil";
import { garantirTabelasTranscricao, semearDoBundle, estadoDasAulas, buscarTrechos, secaoInteligencia } from "./transcricao";
import { garantirTabelaCortes, cortesRecentes, secaoCortes, temAcionador, urlAcoesCortador, modeloEditor } from "./cortes";
import { temModelos, modeloCortes } from "./modelos";
import { dadosDesempenho, secaoDesempenho } from "./desempenho";
import { adminsDe, secaoEquipe } from "./equipe";
import { noticiasParaAdmin, secaoNoticiasAdmin } from "./noticias";
import { resumoProvas, ajustesProvas, secaoProvas, situacaoProvas, secaoProvasAluno, provasParaCertificado } from "./provas";
import { regrasDoEnv, moduloNaLeitura, listaDeModulos } from "../packages/conteudo/modulos";
import { fatosHoje, briefingParaExibir, secaoHoje } from "./hoje";

type Deps = {
  exigeAdmin: any;
  agora: () => number;
  aulasComProgresso: (c: any, alunoId: number) => Promise<any[]>;
  codigoCertificado: (escola: string, alunoId: number) => Promise<string>;
};

export type LinhaAluno = {
  id: number; email: string; nome: string | null; criado_em: number;
  ultimo_acesso: number | null; matricula_em: number; turma: string | null; consentiu_em: number | null;
  feitas: number; ultimo_progresso: number | null; lidas: number; links: number; ultimo_link: number | null;
};

export async function alunosComEstatisticas(env: any): Promise<LinhaAluno[]> {
  const r: any = await env.DB.prepare(
    `SELECT a.id, a.email, a.nome, a.criado_em, a.ultimo_acesso, m.criada_em AS matricula_em, m.turma, m.consentiu_em,
       (SELECT COUNT(*) FROM progresso p JOIN aulas au ON au.uid = p.aula_uid
         WHERE p.aluno_id = a.id AND p.concluida_em IS NOT NULL AND au.publicada = 1) AS feitas,
       (SELECT MAX(p.concluida_em) FROM progresso p WHERE p.aluno_id = a.id) AS ultimo_progresso,
       (SELECT COUNT(*) FROM artigos_lidos l WHERE l.aluno_id = a.id) AS lidas,
       (SELECT COUNT(*) FROM links_magicos lm WHERE lm.email = a.email) AS links,
       (SELECT MAX(lm.expira_em) FROM links_magicos lm WHERE lm.email = a.email) AS ultimo_link
     FROM alunos a
     JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
     ORDER BY (a.ultimo_acesso IS NULL), a.ultimo_acesso DESC, a.criado_em DESC`
  ).bind(env.ESCOLA).all();
  return r.results ?? [];
}

// situação de cada aluno — vira flag de filtro e etiqueta
type Situacao = { flags: string[]; rotulo: string; tom: "ok" | "neutro" | "atencao" | "alerta" };
function situacaoDe(a: LinhaAluno, totalAulas: number, agora: number): Situacao {
  const flags: string[] = [];
  const concluiu = totalAulas > 0 && a.feitas >= totalAulas;
  if (concluiu) flags.push("concluiu");
  if (!a.ultimo_acesso) {
    flags.push("nunca");
    if (!a.links) return { flags, rotulo: a.consentiu_em ? "nenhum link enviado" : "sem de acordo", tom: "alerta" };
    if ((a.ultimo_link ?? 0) > agora) return { flags, rotulo: "link enviado · não abriu", tom: "atencao" };
    return { flags, rotulo: "link expirou · não abriu", tom: "alerta" };
  }
  const ativo = agora - a.ultimo_acesso < 7 * DIA;
  flags.push(ativo ? "ativo" : "inativo");
  if (concluiu) return { flags, rotulo: "concluiu", tom: "ok" };
  return ativo ? { flags, rotulo: "ativo", tom: "ok" } : { flags, rotulo: "parado", tom: "neutro" };
}

// funil: cada aluno está em exatamente uma etapa, decidida só pelo que o banco
// sabe — link enviado pelo sistema, entrada registrada, aulas concluídas
export const ETAPAS = [
  { id: "cadastrado", nome: "Cadastrado", dica: "matriculado · nenhum link enviado" },
  { id: "convidado", nome: "Convidado", dica: "recebeu link · não abriu" },
  { id: "entrou", nome: "Entrou", dica: "abriu o link · nenhuma aula concluída" },
  { id: "assistindo", nome: "Assistindo", dica: "concluiu ao menos uma aula" },
  { id: "concluiu", nome: "Concluiu", dica: "todas as aulas concluídas" },
];
export function etapaDe(a: LinhaAluno, totalAulas: number): number {
  if (totalAulas > 0 && a.feitas >= totalAulas) return 4;
  if (a.feitas > 0) return 3;
  if (a.ultimo_acesso) return 2;
  if (a.links) return 1;
  return 0;
}

// anel de progresso em SVG — circunferência ≈ 100, então dasharray é a porcentagem
const anel = (pct: number, tamanho = 56) =>
  `<svg class="anel" width="${tamanho}" height="${tamanho}" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="15.9" fill="none" stroke="#EDEAE3" stroke-width="3.2"/>
    <circle cx="18" cy="18" r="15.9" fill="none" stroke="#1F1BE4" stroke-width="3.2"
      stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="25" stroke-linecap="round"/>
    <text x="18" y="18" text-anchor="middle" dominant-baseline="central"
      font-size="9.5" font-weight="600" fill="#1F1BE4">${pct}%</text>
  </svg>`;

// aulas publicadas, agrupadas por módulo na ordem oficial — o que o aluno vê
async function aulasPorModulo(env: any) {
  const r: any = await env.DB.prepare(
    `SELECT uid, titulo, modulo, ordem, duracao_seg, criada_em FROM aulas WHERE publicada = 1`).all();
  const regras = regrasDoEnv(env);
  const ordem = listaDeModulos(env.ORDEM_MODULOS);
  const peso = (m: string) => { const i = ordem.indexOf(m); return i === -1 ? ordem.length + 1 : i; };
  const linhas = (r.results ?? []).map((l: any) => ({ ...l, ...moduloNaLeitura(l, regras) }))
    .sort((a: any, b: any) => peso(a.modulo) - peso(b.modulo) || a.ordem - b.ordem || (a.criada_em ?? 0) - (b.criada_em ?? 0) || a.titulo.localeCompare(b.titulo, "pt-BR"));
  const grupos = new Map<string, any[]>();
  for (const l of linhas) { if (!grupos.has(l.modulo)) grupos.set(l.modulo, []); grupos.get(l.modulo)!.push(l); }
  return grupos;
}

/* ---------------- rotas ---------------- */

export function rotasAdmin(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  r.get("/admin", d.exigeAdmin, async (c) => {
    const admin = c.get("aluno");
    await Promise.all([garantirTabelasLeituras(c.env), garantirEsquemaFunil(c.env), garantirTabelasTranscricao(c.env), garantirTabelaCortes(c.env)]);
    const agora = d.agora();
    const q = c.req.query();
    const filtros = filtrosDe(q);
    const consulta = String(q.q || "").trim().slice(0, 120);
    // transcrições que vieram no deploy entram no banco na primeira abertura do painel
    await semearDoBundle(c.env, agora).catch(() => 0);
    const [alunos, tot, leituras, grupos, funilLinhas, turmas, pedidos, aulasTranscricao, achados, cortes] = await Promise.all([
      alunosComEstatisticas(c.env),
      c.env.DB.prepare(`SELECT COUNT(*) n FROM aulas WHERE publicada = 1`).first(),
      secaoAdminLeituras(c.env, regrasDoEnv(c.env).conhecidos, c.req.query("leitura")),
      aulasPorModulo(c.env),
      linhasFunil(c.env, filtros, agora),
      turmasDe(c.env),
      pedidosPendentes(c.env),
      estadoDasAulas(c.env),
      consulta ? buscarTrechos(c.env, consulta) : Promise.resolve([]),
      cortesRecentes(c.env),
    ]);
    const totalAulas = Number(tot?.n ?? 0);
    // desempenho das aulas: na ordem da trilha (os grupos já vêm ordenados)
    const trilha = [...grupos.values()].flat();
    const [desempenho, provas, ajustes] = await Promise.all([
      dadosDesempenho(c.env, trilha, filtros, agora),
      resumoProvas(c.env, [...grupos.keys()]),
      ajustesProvas(c.env),
    ]);
    const equipe = await adminsDe(c.env);
    const noticias = await noticiasParaAdmin(c.env);
    const fatos = await fatosHoje(c.env, agora);
    const briefing = await briefingParaExibir(c.env, fatos);
    const transcritas = new Set(aulasTranscricao.filter((a) => a.estado === "pronto").map((a) => a.uid));

    const ativos = alunos.filter((a) => a.ultimo_acesso && agora - a.ultimo_acesso < 7 * DIA).length;
    const nunca = alunos.filter((a) => !a.ultimo_acesso).length;
    const nuncaAcordo = alunos.filter((a) => !a.ultimo_acesso && a.consentiu_em).length;
    const concluiram = alunos.filter((a) => totalAulas && a.feitas >= totalAulas).length;
    const media = alunos.length && totalAulas
      ? Math.round(alunos.reduce((s, a) => s + a.feitas / totalAulas, 0) / alunos.length * 100) : 0;

    const plural = (n: string | undefined, um: string, mais: string) => (n === "1" ? um : mais);
    const aviso = q.liberados === "0"
      ? `<div class="aviso">${q.convites} e-mail${plural(q.convites, "", "s")} enviado${plural(q.convites, "", "s")}${
          q.falhas && q.falhas !== "0" ? ` · <b>${q.falhas} falhou</b>` : ""}${q.convites === "0" && (!q.falhas || q.falhas === "0") ? " — ninguém elegível" : ""}.</div>`
      : q.liberados
      ? `<div class="aviso">${q.liberados} cadastrado${plural(q.liberados, "", "s")}${
          q.convites ? ` · ${q.convites} convite${plural(q.convites, "", "s")} enviado${plural(q.convites, "", "s")}` : ""}${
          q.falhas && q.falhas !== "0" ? ` · <b>${q.falhas} e-mail${plural(q.falhas, "", "s")} falhou</b>` : ""}${
          q.semacordo && q.semacordo !== "0" ? ` · ${q.semacordo} sem de acordo, não convidado${plural(q.semacordo, "", "s")}` : ""}.</div>`
      : q.convite === "ok" ? `<div class="aviso">Convite enviado — vale 48 horas.</div>`
      : q.convite === "erro" ? `<div class="erro">O e-mail não saiu. Confere o endereço e o log de envio na Cloudflare.</div>`
      : q.lembrete === "ok" ? `<div class="aviso">Lembrete da primeira aula enviado.</div>`
      : q.lembrete === "erro" ? `<div class="erro">O lembrete não saiu. Confere o endereço e o log de envio na Cloudflare.</div>`
      : q.removido ? `<div class="aviso">Aluno removido da comunidade.</div>`
      : q.excluido ? `<div class="aviso">Aluno excluído.</div>`
      : q.descartado ? `<div class="aviso">Pedido descartado.</div>`
      : "";

    const cartoes = alunos.map((a) => cartaoAluno(a, totalAulas, agora)).join("");
    const linhas = alunos.map((a) => linhaAluno(a, totalAulas, agora)).join("");
    const funil = kanbanAlunos(alunos, totalAulas, agora);
    const minutosTotais = [...grupos.values()].flat().reduce((s: number, a: any) => s + a.duracao_seg, 0);

    // fila do cockpit: provas em rascunho, cortes sugeridos, 3 notícias mais recentes
    const provasRascunho = [...provas.values()].filter((p) => p.estado === "rascunho" && p.questoes > 0);
    const cortesSugeridos = cortes.filter((x: any) => x.estado === "sugerido");
    const avisoHoje = q.corte && q.volta === "hoje" ? `<div class="aviso" style="margin-bottom:14px">${esc(q.corte)}</div>`
      : q.noticias && q.volta === "hoje" ? `<div class="aviso" style="margin-bottom:14px">${esc(q.noticias)}</div>` : "";

    const corpo = `<main class="wrap painel">
      <div class="painel-topo">
        <p class="mono">Painel · Administração</p>
        <p class="aula-meta">${alunos.length} aluno${alunos.length === 1 ? "" : "s"} · ${totalAulas} aula${totalAulas === 1 ? "" : "s"} · ${duracao(minutosTotais)} de conteúdo · ${ativos} ativo${ativos === 1 ? "" : "s"} esta semana</p>
      </div>
      ${aviso ? `<div style="margin-bottom:18px">${aviso}</div>` : ""}

<style>
.abas{display:none!important}
.gnav{display:flex;gap:4px;border-bottom:1px solid var(--linha)}
.gtab{display:block;padding:10px 16px 12px;border-bottom:2px solid transparent;margin-bottom:-1px}
.gtab b{font-size:15px;font-weight:600;display:flex;align-items:center;gap:7px;color:inherit}
.gtab .gdica{display:block;font-size:12px;color:var(--muted);margin-top:2px}
.gtab.ativa{border-bottom-color:#1F1BE4}
.gtab.ativa b{color:#1F1BE4}
.snav{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.schip{border:1px solid var(--linha);border-radius:99px;padding:6px 15px;font-size:13px;display:flex;align-items:center;gap:6px}
.schip.ativa{background:#1F1BE4;border-color:#1F1BE4;color:#fff}
.schip.ativa .aba-n{background:#fff;color:#000}
</style>
<nav class="gnav" role="tablist">
<a href="#hoje" class="gtab" data-grupo="hoje"><b>Hoje</b><span class="gdica">o que precisa de você</span></a>
<a href="#alunos" class="gtab" data-grupo="alunos"><b>Alunos <span class="aba-n">${alunos.length}</span></b><span class="gdica">pessoas, funil e pulso</span></a>
<a href="#aulas" class="gtab" data-grupo="conteudo"><b>Conteúdo${provasRascunho.length + cortesSugeridos.length + noticias.pendentes.length ? ` <span class="aba-n">${provasRascunho.length + cortesSugeridos.length + noticias.pendentes.length}</span>` : ""}</b><span class="gdica">aulas, leituras, provas, notícias</span></a>
<a href="#equipe" class="gtab" data-grupo="config"><b>Configurações</b><span class="gdica">equipe e acesso</span></a>
</nav>
<div class="snav" data-snav="alunos" hidden>
<a href="#alunos" class="schip">Visão geral</a>
<a href="#funil" class="schip">Funil de entrada</a>
<a href="#convidar" class="schip">Convidar${pedidos.length ? ` <span class="aba-n">${pedidos.length}</span>` : ""}</a>
</div>
<div class="snav" data-snav="conteudo" hidden>
<a href="#aulas" class="schip">Aulas</a>
<a href="#desempenho" class="schip">Desempenho${desempenho.kpi.alertas ? ` <span class="aba-n">${desempenho.kpi.alertas}</span>` : ""}</a>
<a href="#leituras" class="schip">Leituras</a>
<a href="#provas" class="schip">Provas${provasRascunho.length ? ` <span class="aba-n">${provasRascunho.length}</span>` : ""}</a>
<a href="#noticias" class="schip">Notícias${noticias.pendentes.length ? ` <span class="aba-n">${noticias.pendentes.length}</span>` : ""}</a>
<a href="#inteligencia" class="schip">Inteligência${cortesSugeridos.length ? ` <span class="aba-n">${cortesSugeridos.length}</span>` : ""}</a>
</div>
<div class="snav" data-snav="config" hidden>
<a href="#equipe" class="schip">Equipe</a>
</div>
      <nav class="abas" role="tablist">
        <a href="#hoje" class="aba" role="tab" data-aba="hoje">Hoje</a>
        <a href="#alunos" class="aba" role="tab" data-aba="alunos">Alunos <span class="aba-n">${alunos.length}</span></a>
        <a href="#funil" class="aba" role="tab" data-aba="funil">Funil</a>
        <a href="#desempenho" class="aba" role="tab" data-aba="desempenho">Desempenho${desempenho.kpi.alertas ? ` <span class="aba-n" title="aulas com alerta">${desempenho.kpi.alertas}</span>` : ""}</a>
        <a href="#provas" class="aba" role="tab" data-aba="provas">Provas${provasRascunho.length ? ` <span class="aba-n" title="provas em rascunho aguardando revisão">${provasRascunho.length}</span>` : ""}</a>
        <a href="#convidar" class="aba" role="tab" data-aba="convidar">Convidar${pedidos.length ? ` <span class="aba-n" title="pedidos pelo site">${pedidos.length}</span>` : ""}</a>
        <a href="#aulas" class="aba" role="tab" data-aba="aulas">Aulas</a>
        <a href="#leituras" class="aba" role="tab" data-aba="leituras">Leituras</a>
        <a href="#inteligencia" class="aba" role="tab" data-aba="inteligencia">Inteligência${cortesSugeridos.length ? ` <span class="aba-n" title="cortes sugeridos aguardando aprovação">${cortesSugeridos.length}</span>` : ""}</a>
        <a href="#noticias" class="aba" role="tab" data-aba="noticias">Notícias${noticias.pendentes.length ? ` <span class="aba-n" title="para revisar">${noticias.pendentes.length}</span>` : ""}</a>
        <a href="#equipe" class="aba" role="tab" data-aba="equipe">Equipe</a>
      </nav>

      <section id="hoje" class="painel-aba" role="tabpanel">
        ${secaoHoje({ f: fatos, briefing, agora, provas: provasRascunho, cortes: cortesSugeridos,
          noticias: noticias.pendentes.slice(0, 3), alertas: desempenho.kpi.alertas,
          alertasDe: desempenho.aulas.length, retencao: desempenho.kpi.retencao,
          terminam: desempenho.kpi.terminam, aviso: avisoHoje })}
      </section>

      <section id="alunos" class="painel-aba" role="tabpanel" hidden>
        <div class="grade grade-4 resumo">
          <button class="card stat filtro-card" data-filtro="todos" type="button"><p class="mono">Alunos</p><p class="num">${alunos.length}</p></button>
          <button class="card stat filtro-card" data-filtro="ativo" type="button"><p class="mono">Ativos · 7d</p><p class="num">${ativos}</p></button>
          <button class="card stat filtro-card" data-filtro="nunca" type="button"><p class="mono">Nunca entraram</p><p class="num">${nunca}</p></button>
          <button class="card stat filtro-card" data-filtro="concluiu" type="button"><p class="mono">Concluíram</p><p class="num">${concluiram}<span> · média ${media}%</span></p></button>
        </div>

        <div class="ferramentas">
          <input class="campo busca" type="search" id="busca" placeholder="Buscar por nome ou e-mail" autocomplete="off">
          <div class="chips" id="chips">
            <button type="button" class="chip ativa" data-filtro="todos">Todos</button>
            <button type="button" class="chip" data-filtro="ativo">Ativos</button>
            <button type="button" class="chip" data-filtro="inativo">Parados</button>
            <button type="button" class="chip" data-filtro="nunca">Nunca entraram</button>
            <button type="button" class="chip" data-filtro="concluiu">Concluíram</button>
          </div>
          <div class="visao" id="visao">
            <button type="button" class="chip ativa" data-visao="cartoes" title="Cartões">▦ Cartões</button>
            <button type="button" class="chip" data-visao="lista" title="Lista">☰ Lista</button>
            <button type="button" class="chip" data-visao="kanban" title="Kanban por etapa">▥ Kanban</button>
          </div>
        </div>

        ${nunca ? `<form method="post" action="/admin/convidar-pendentes" class="card convite-massa" id="convite-massa"
            onsubmit="return confirm('Enviar link de entrada (48 h) para ${nuncaAcordo} aluno${nuncaAcordo === 1 ? "" : "s"} que nunca entr${nuncaAcordo === 1 ? "ou" : "aram"}?')">
          <div><p class="mono">Nunca entraram</p>
            <p style="margin-top:4px">${nunca} aluno${nunca === 1 ? "" : "s"} sem nenhum acesso${nunca > nuncaAcordo ? ` · ${nunca - nuncaAcordo} sem de acordo, fica${nunca - nuncaAcordo === 1 ? "" : "m"} de fora` : ""}.
              <span class="aula-meta">O painel só conta convites que o sistema enviou — convite por WhatsApp não aparece aqui.</span></p></div>
          ${nuncaAcordo ? `<button class="btn btn-primario" type="submit">Enviar link para ${nuncaAcordo === 1 ? "esse" : "os " + nuncaAcordo}</button>` : ""}
        </form>` : ""}

        <div class="alunos-cartoes" id="cartoes">${cartoes || `<p class="vazio">Nenhum aluno ainda.</p>`}</div>
        <div class="alunos-lista" id="lista" hidden>${linhas}</div>
        <div class="funil" id="kanban" hidden>${funil}</div>
        <p class="vazio" id="sem-resultado" hidden>Ninguém com esse filtro.</p>
      </section>

      <section id="funil" class="painel-aba" role="tabpanel" hidden>
        ${secaoFunil({ linhas: funilLinhas, totalAulas, agora, turmas, f: filtros, aberta: q.funil !== undefined ? Number(q.funil) : undefined })}
      </section>

      <section id="desempenho" class="painel-aba" role="tabpanel" hidden>
        ${secaoDesempenho({ d: desempenho, turmas, f: filtros, ordemTrilha: trilha.map((a: any) => a.uid), agora })}
      </section>

      <section id="provas" class="painel-aba" role="tabpanel" hidden>
        ${secaoProvas({ modulos: [...grupos.entries()].map(([nome, lista]: [string, any[]]) => ({ nome, aulas: lista.length, transcritas: lista.filter((a: any) => transcritas.has(a.uid)).length })),
          resumo: provas, certificadoExige: ajustes.certificadoExige, temIA: temModelos(c.env) || !!c.env.AI,
          aviso: q.provas ? `<div class="aviso" style="margin-bottom:14px">${esc(q.provas)}</div>` : "" })}
      </section>

      <section id="convidar" class="painel-aba" role="tabpanel" hidden>
        <div class="card">
          <p class="mono">Cadastrar alunos</p>
          <p style="margin-top:8px;color:var(--muted);max-width:66ch">Cola a lista (um e-mail por linha, "Nome &lt;e-mail&gt;", ou duas colunas
            copiadas da planilha) ou envia o CSV da turma. Quem já existe não duplica. Com o de acordo marcado, o convite sai na hora —
            um link de entrada válido por 48 horas, de uso único.</p>
          <form method="post" action="/admin/alunos" enctype="multipart/form-data" style="display:grid;gap:12px;margin-top:18px" id="form-cadastro">
            <textarea class="campo" name="email" rows="4"
              placeholder="maria@empresa.com&#10;João Silva &lt;joao@empresa.com&gt;&#10;Ana Lima&#9;ana@empresa.com"></textarea>
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
              <label class="aula-meta" style="display:flex;align-items:center;gap:8px;flex:1;min-width:220px">
                <span style="white-space:nowrap">ou CSV:</span><input type="file" name="arquivo" accept=".csv,text/csv,text/plain" style="min-width:0"></label>
              <input class="campo" style="flex:1;min-width:180px" type="text" name="turma" list="turmas" maxlength="60" placeholder="Turma (ex.: Imersão 12/09)">
              <datalist id="turmas">${turmas.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
              <input class="campo" style="flex:1;min-width:160px" type="text" name="nome" maxlength="80" placeholder="Nome (só quando for um)">
            </div>
            <label class="aula-meta" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="consentiu" value="1" id="chk-acordo" checked> Já deram o de acordo para receber o convite
            </label>
            <label class="aula-meta" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="convite" value="1" id="chk-convite" checked> Enviar convite por e-mail agora
            </label>
            <div><button class="btn btn-primario" type="submit" id="btn-cadastrar">Cadastrar e convidar</button></div>
          </form>
        </div>
        ${secaoPedidos(pedidos, agora)}
        <div class="card" style="margin-top:14px">
          <p class="mono">Como o aluno entra</p>
          <p style="margin-top:8px;color:var(--muted);max-width:62ch">Pelo link do convite, ou a qualquer momento em
            <b>comunidade.comeca.ai</b> digitando o e-mail cadastrado. Quem pede link sem estar matriculado vê
            "enviado" e não recebe nada — se um aluno reclamar, a ficha dele mostra se algum link foi gerado.</p>
          <p style="margin-top:10px;color:var(--muted);max-width:62ch">Para colher o de acordo no próprio curso, divulgue
            <b>comunidade.comeca.ai/quero</b> (aceita <code>?turma=Nome</code> para já classificar a turma). Quem está na base recebe o
            convite na hora; quem não está aparece aqui como pedido.</p>
        </div>
      </section>

      <section id="aulas" class="painel-aba" role="tabpanel" hidden>
        <div class="card" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px">
          <div><p class="mono">Biblioteca</p>
            <p style="margin-top:6px">${totalAulas} aula${totalAulas === 1 ? "" : "s"} em ${grupos.size} módulo${grupos.size === 1 ? "" : "s"} · ${duracao(minutosTotais)}
              <span class="aula-meta">· o Stream sincroniza sozinho a cada 15 min</span></p></div>
          <form method="post" action="/admin/sincronizar">
            <button class="btn btn-fantasma" type="submit">Sincronizar agora</button>
          </form>
        </div>
        ${(() => { let n = 0; return [...grupos.entries()].map(([nome, lista]: [string, any[]]) => `<section class="modulo">
          <div class="modulo-topo"><h2>${esc(nome)}</h2><span class="mono">${lista.length} aula${lista.length === 1 ? "" : "s"} · ${duracao(lista.reduce((s: number, a: any) => s + a.duracao_seg, 0))}</span></div>
          ${lista.map((a: any) => `<a class="aula" href="/app/aula/${esc(a.uid)}" target="_blank" rel="noopener">
            <span class="num-aula">${String(++n).padStart(2, "0")}</span>
            <span class="aula-txt"><b>${esc(a.titulo)}</b><span class="aula-meta">${duracao(a.duracao_seg)}</span></span>
          </a>`).join("")}
        </section>`).join(""); })() || `<p class="vazio">Nenhuma aula publicada. Sincronize com o Stream.</p>`}
        <p class="aula-meta" style="margin-top:18px">O módulo sai do título do vídeo no Stream: <code>[Módulo] Título</code>,
          <code>Título [Parte 2]</code>, <code>[Sessão Prática] - Título</code>. Sem convenção, cai em
          <b>${esc(regrasDoEnv(c.env).padrao || "módulo próprio")}</b>.</p>
      </section>

      <section id="leituras" class="painel-aba" role="tabpanel" hidden>${leituras}</section>

      <section id="inteligencia" class="painel-aba" role="tabpanel" hidden>
        ${secaoInteligencia({ aulas: aulasTranscricao, consulta, achados, temChave: !!c.env.DEEPGRAM_API_KEY,
          aviso: q.transcricao ? `<div class="aviso" style="margin-bottom:14px">${esc(q.transcricao)}</div>` : "" })}
        ${secaoCortes({ pedido: String(q.pedido || ""), cortes, agora, temToken: !!(c.env.STREAM_API_TOKEN && c.env.CF_ACCOUNT_ID), temFila: !!c.env.CORTES_CHAVE, acionador: temAcionador(c.env), urlAcoes: urlAcoesCortador(c.env), temIA: !!c.env.AI,
          rotuloIA: temModelos(c.env) ? `IA: ${modeloCortes(c.env)} (Model Studio) · busca por significado` : "",
          rotuloRapido: modeloCortes(c.env), editor: temModelos(c.env) ? modeloEditor(c.env) : "",
          aviso: q.corte ? `<div class="aviso" style="margin-bottom:14px">${esc(q.corte)}</div>` : "" })}
      </section>

      <section id="noticias" class="painel-aba" role="tabpanel" hidden>
        ${secaoNoticiasAdmin({ ...noticias, agora, aviso: q.noticias ? `<div class="aviso" style="margin-bottom:14px">${esc(q.noticias)}</div>` : "" })}
      </section>

      <section id="equipe" class="painel-aba" role="tabpanel" hidden>
        ${secaoEquipe({ admins: equipe, eu: String(admin.email).toLowerCase(), agora, aviso: q.equipe ? `<div class="aviso" style="margin-bottom:14px">${esc(q.equipe)}</div>` : "" })}
      </section>
    </main>
    <script>
    // uma linha de contexto no topo de cada aba — o painel se explica sozinho
    (function(){
    var EXPL = {
    hoje: "O que precisa de você agora: briefing do dia, fila de aprovações e os números que importam.",
    alunos: "Todos os matriculados. Busque por nome ou e-mail, filtre por situação e abra a ficha de cada um.",
    funil: "Onde cada aluno está entre o convite e a conclusão — quem parou, em qual etapa, e a ação para destravar.",
    desempenho: "Como as aulas performam: quedas de audiência, pulos e avaliações dos alunos. Alertas pedem sua atenção.",
    provas: "Provas por módulo geradas pela IA. Revise as questões, publique e defina se o certificado exige aprovação.",
    convidar: "Cadastre alunos (lista colada ou CSV) e envie o link de acesso. Pedidos feitos pelo site chegam aqui.",
    aulas: "A biblioteca de vídeo, sincronizada do Stream a cada 15 min. O módulo sai do título do vídeo.",
    leituras: "PDFs de apoio por módulo, servidos com proteção. Veja quem já leu o quê.",
    inteligencia: "Busca por significado nas transcrições das aulas e cortes de vídeo sugeridos pela IA para as redes.",
    noticias: "Curadoria do bloco No radar que os alunos veem: aprove ou oculte o que a IA triou.",
    equipe: "Quem administra este painel além de você. Adicione ou remova admins."
    };
    document.querySelectorAll(".painel-aba").forEach(function(s){
    var t = EXPL[s.id]; if (!t) return;
    var p = document.createElement("p");
    p.className = "aula-meta";
    p.style.cssText = "margin:2px 0 16px;max-width:78ch";
    p.textContent = t;
    s.insertBefore(p, s.firstChild);
    });
    })();
    </script>
    <script>${PAINEL_JS}</script>`;
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: "Painel", aluno: admin, corpo }));
  });

  // cadastrar (texto colado e/ou CSV) + de acordo + (opcional) convidar
  r.post("/admin/alunos", d.exigeAdmin, async (c) => {
    const form = await c.req.formData();
    const nomeUnico = String(form.get("nome") || "").trim().slice(0, 80) || null;
    const turma = String(form.get("turma") || "").trim().slice(0, 60) || null;
    const acordo = form.get("consentiu") === "1";
    const convidar = form.get("convite") === "1";
    let texto = String(form.get("email") || "");
    const arquivo = form.get("arquivo");
    if (arquivo && typeof arquivo === "object" && "arrayBuffer" in arquivo && (arquivo as File).size) {
      if ((arquivo as File).size > 2_000_000) return c.text("CSV acima de 2 MB — divide o arquivo.", 413);
      texto += "\n" + textoDoCsv(await (arquivo as File).arrayBuffer());
    }
    const contatos = contatosDe(texto);
    if (!contatos.length) return c.redirect("/admin#convidar");
    if (contatos.length === 1 && !contatos[0].nome) contatos[0].nome = nomeUnico;
    const agora = d.agora();

    await c.env.DB.batch(contatos.map((k) =>
      c.env.DB.prepare(`INSERT INTO alunos (email, nome, criado_em) VALUES (?,?,?)
        ON CONFLICT(email) DO UPDATE SET nome = COALESCE(alunos.nome, excluded.nome)`).bind(k.email, k.nome, agora)));
    await c.env.DB.batch(contatos.map((k) =>
      c.env.DB.prepare(`INSERT OR IGNORE INTO matriculas (aluno_id, escola, criada_em, turma, consentiu_em, consentimento)
        SELECT id, ?, ?, ?, ?, ? FROM alunos WHERE email = ?`)
        .bind(c.env.ESCOLA, agora, turma, acordo ? agora : null, acordo ? "importacao" : null, k.email)));
    // quem já estava: ganha turma se não tinha, e o de acordo se veio marcado
    await c.env.DB.batch(contatos.map((k) =>
      c.env.DB.prepare(`UPDATE matriculas SET turma = COALESCE(turma, ?),
          consentiu_em = CASE WHEN ? = 1 THEN COALESCE(consentiu_em, ?) ELSE consentiu_em END,
          consentimento = CASE WHEN ? = 1 THEN COALESCE(consentimento, 'importacao') ELSE consentimento END
        WHERE escola = ? AND aluno_id = (SELECT id FROM alunos WHERE email = ?)`)
        .bind(turma, acordo ? 1 : 0, agora, acordo ? 1 : 0, c.env.ESCOLA, k.email)));

    let convites = 0, falhas = 0, semAcordo = 0;
    if (convidar) {
      const origem = new URL(c.req.url).origin;
      const r0: any = await c.env.DB.prepare(
        `SELECT a.email, m.consentiu_em FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
         WHERE a.email IN (${contatos.map(() => "?").join(",")})`).bind(c.env.ESCOLA, ...contatos.map((k) => k.email)).all();
      for (const { email, consentiu_em } of (r0.results ?? [])) {
        if (!consentiu_em) { semAcordo++; continue; }
        try { await enviarLinkMagico(c.env, origem, email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" }); convites++; }
        catch { falhas++; }
      }
    }
    return c.redirect(`/admin?liberados=${contatos.length}&convites=${convites}&falhas=${falhas}&semacordo=${semAcordo}#convidar`);
  });

  // convite em massa para quem nunca entrou e tem de acordo. grupo (opcional,
  // do kanban): "sem-link" = nunca recebeu link; "expirados" = o último venceu
  r.post("/admin/convidar-pendentes", d.exigeAdmin, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const grupo = String(form?.get("grupo") || "todos");
    let sql = `SELECT a.email FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
       WHERE a.ultimo_acesso IS NULL AND m.consentiu_em IS NOT NULL`;
    const binds: any[] = [c.env.ESCOLA];
    if (grupo === "sem-link") sql += ` AND NOT EXISTS (SELECT 1 FROM links_magicos lm WHERE lm.email = a.email)`;
    if (grupo === "expirados") { sql += ` AND (SELECT MAX(lm.expira_em) FROM links_magicos lm WHERE lm.email = a.email) <= ?`; binds.push(d.agora()); }
    const r0: any = await c.env.DB.prepare(sql + ` ORDER BY a.criado_em`).bind(...binds).all();
    const origem = new URL(c.req.url).origin;
    let convites = 0, falhas = 0;
    for (const { email } of (r0.results ?? [])) {
      try { await enviarLinkMagico(c.env, origem, email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" }); convites++; }
      catch { falhas++; }
    }
    return c.redirect(`/admin?liberados=0&convites=${convites}&falhas=${falhas}`);
  });

  // ficha do aluno
  r.get("/admin/aluno/:id", d.exigeAdmin, async (c) => {
    const admin = c.get("aluno");
    const id = Number(c.req.param("id"));
    const a: any = await c.env.DB.prepare(
      `SELECT a.*, m.criada_em AS matricula_em, m.turma, m.consentiu_em, m.consentimento FROM alunos a
       JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ? WHERE a.id = ?`
    ).bind(c.env.ESCOLA, id).first();
    if (!a) return c.notFound();
    const agora = d.agora();

    const [aulas, leituras, links, sessoes, provas, cert] = await Promise.all([
      d.aulasComProgresso(c, id),
      leiturasDoAluno(c.env, id),
      c.env.DB.prepare(`SELECT expira_em, usado_em FROM links_magicos WHERE email = ? ORDER BY expira_em DESC LIMIT 6`).bind(a.email).all(),
      c.env.DB.prepare(`SELECT COUNT(*) n FROM sessoes WHERE aluno_id = ? AND expira_em > ?`).bind(id, agora).first(),
      situacaoProvas(c.env, id),
      provasParaCertificado(c.env, id),
    ]);
    const total = aulas.length;
    const feitas = aulas.filter((x) => x.concluida_em).length;
    const pct = total ? Math.round(feitas / total * 100) : 0;
    const assistido = aulas.filter((x) => x.concluida_em).reduce((s, x) => s + x.duracao_seg, 0);
    const lidas = leituras.filter((l) => l.lido_em).length;
    const certificado = pct === 100 && !cert.pendentes.length;
    const codigo = certificado ? await d.codigoCertificado(c.env.ESCOLA, id) : "";

    const modulos = new Map<string, any[]>();
    for (const x of aulas) { if (!modulos.has(x.modulo)) modulos.set(x.modulo, []); modulos.get(x.modulo)!.push(x); }

    const q = c.req.query();
    const aviso = q.convite === "ok" ? `<div class="aviso">Convite enviado para ${esc(a.email)} — vale 48 horas.</div>`
      : q.convite === "erro" ? `<div class="erro">O e-mail não saiu. Confere o endereço e o log de envio na Cloudflare.</div>`
      : q.lembrete === "ok" ? `<div class="aviso">Lembrete da primeira aula enviado para ${esc(a.email)}.</div>`
      : q.lembrete === "erro" ? `<div class="erro">O lembrete não saiu. Confere o endereço e o log de envio na Cloudflare.</div>`
      : q.nome === "ok" ? `<div class="aviso">Cadastro atualizado.</div>` : "";
    const acordo = a.consentiu_em ? `de acordo em ${dataCurta(a.consentiu_em)}${a.consentimento ? ` (${esc(a.consentimento)})` : ""}` : "sem de acordo";

    const corpo = `<main class="wrap" style="padding:44px 24px">
      <a class="mono" href="/admin">← painel</a>
      <div style="margin:18px 0 22px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px">
        <div style="display:flex;gap:16px;align-items:center">
          <span class="avatar" style="width:56px;height:56px;font-size:18px">${esc(iniciais(a))}</span>
          <div>
          <p class="mono">Aluno</p>
          <h1 style="margin-top:6px">${esc(nomeOu(a))}</h1>
          <p class="aula-meta" style="margin-top:6px">${esc(a.email)} · matriculado em ${dataCurta(a.matricula_em)}${a.turma ? ` · ${esc(a.turma)}` : ""} · ${acordo} ·
            último acesso ${haQuanto(a.ultimo_acesso, agora)}${sessoes?.n ? ` · ${sessoes.n} sessão${sessoes.n === 1 ? "" : "ões"} ativa${sessoes.n === 1 ? "" : "s"}` : ""}</p>
          </div>
        </div>
        <form method="post" action="/admin/aluno/${a.id}/convite">
          <button class="btn btn-primario" type="submit">${a.ultimo_acesso ? "Enviar link de acesso" : "Reenviar convite"}</button>
        </form>
      </div>
      ${aviso}

      <section class="grade grade-4" style="margin-top:${aviso ? 18 : 0}px">
        <div class="card stat"><p class="mono">Aproveitamento</p><p class="num">${pct}<span>%</span></p>
          <div class="barra" style="margin-top:12px"><i style="width:${pct}%"></i></div></div>
        <div class="card stat"><p class="mono">Aulas</p><p class="num">${feitas}<span> / ${total}</span></p></div>
        <div class="card stat"><p class="mono">Leituras</p><p class="num">${lidas}<span> / ${leituras.length}</span></p></div>
        <div class="card stat"><p class="mono">Assistido</p><p class="num">${duracao(assistido)}</p></div>
      </section>

      ${certificado ? `<section class="card diploma" style="margin-top:14px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px">
        <div><p class="mono">Curso concluído</p><p style="margin-top:4px">Certificado emitido · código ${esc(codigo)}${cert.aproveitamento != null ? ` · aproveitamento ${cert.aproveitamento}%` : ""}</p></div>
        <a class="btn btn-fantasma" href="/certificado/${esc(codigo)}" target="_blank" rel="noopener">Ver certificado</a>
      </section>` : pct === 100 ? `<section class="card" style="margin-top:14px">
        <p class="mono">Aulas concluídas</p><p style="margin-top:4px">Certificado aguarda aprovação na${cert.pendentes.length === 1 ? "" : "s"} prova${cert.pendentes.length === 1 ? "" : "s"} de ${esc(cert.pendentes.join(", "))}.
          <span class="aula-meta">Regra na aba Provas do painel.</span></p>
      </section>` : ""}

      <section class="modulo">
        <div class="modulo-topo"><h2>Progresso por módulo</h2><span class="mono">${modulos.size} módulos</span></div>
        ${[...modulos.entries()].map(([nome, lista]) => {
          const ok = lista.filter((x) => x.concluida_em).length;
          const p = Math.round(ok / lista.length * 100);
          return `<div class="aula" style="cursor:default;align-items:flex-start;flex-direction:column;gap:8px;padding:14px 6px">
            <div style="display:flex;justify-content:space-between;width:100%;gap:12px">
              <b style="font-weight:500">${esc(nome)}</b><span class="mono">${ok} de ${lista.length}</span></div>
            <div class="barra" style="width:100%"><i style="width:${p}%"></i></div>
            <div class="aula-meta" style="display:flex;flex-wrap:wrap;gap:6px 14px">
              ${lista.map((x) => `<span style="${x.concluida_em ? "" : "opacity:.55"}">${x.concluida_em ? "✓" : "○"} ${esc(x.titulo)}${
                x.concluida_em ? ` <span style="opacity:.7">· ${dataCurta(x.concluida_em)}</span>` : ""}</span>`).join("")}
            </div>
          </div>`;
        }).join("") || `<p class="vazio">Nenhuma aula publicada.</p>`}
      </section>

      ${secaoProvasAluno(provas, [...modulos.keys()])}

      ${leituras.length ? `<section class="modulo">
        <div class="modulo-topo"><h2>Leituras</h2><span class="mono">${lidas} de ${leituras.length}</span></div>
        ${leituras.map((l) => `<div class="aula ${l.lido_em ? "feita" : ""}" style="cursor:default">
          <span class="check">✓</span>
          <span class="aula-txt"><b>${esc(l.titulo)}</b>
            <span class="aula-meta">${l.lido_em ? `lida em ${dataCurta(l.lido_em)}` : "não lida"}</span></span></div>`).join("")}
      </section>` : ""}

      <section class="modulo">
        <div class="modulo-topo"><h2>Links de acesso</h2><span class="mono">últimos ${(links.results ?? []).length}</span></div>
        ${(links.results ?? []).map((l: any) => {
          const estado = l.usado_em ? `usado em ${dataCurta(l.usado_em)}` : l.expira_em > agora ? "válido, ainda não usado" : "expirou sem uso";
          return `<div class="aula ${l.usado_em ? "feita" : ""}" style="cursor:default"><span class="check ${l.usado_em ? "" : "oculto"}">✓</span>
            <span class="aula-txt"><b style="font-weight:500">válido até ${dataCurta(l.expira_em)}</b><span class="aula-meta">${estado}</span></span></div>`;
        }).join("") || `<p class="vazio">Nenhum link gerado ainda — o aluno nunca pediu acesso e não recebeu convite.</p>`}
      </section>

      <section class="card" style="margin-top:26px">
        <p class="mono">Cadastro</p>
        <form method="post" action="/admin/aluno/${a.id}/nome" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px">
          <input class="campo" style="flex:1;min-width:200px" type="text" name="nome" maxlength="80"
                 value="${esc(a.nome || "")}" placeholder="Nome do aluno">
          <input class="campo" style="flex:1;min-width:160px" type="text" name="turma" maxlength="60"
                 value="${esc(a.turma || "")}" placeholder="Turma">
          <button class="btn btn-fantasma" type="submit">Salvar</button>
        </form>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--linha)">
          <form method="post" action="/admin/aluno/${a.id}/remover"
                onsubmit="return confirm(${jsStr(`Tirar ${nomeOu(a)} da comunidade? O cadastro e o progresso ficam; só o acesso sai.`)})">
            <button class="btn btn-fantasma" type="submit">Remover da comunidade</button>
          </form>
          <form method="post" action="/admin/aluno/${a.id}/excluir"
                onsubmit="return confirm(${jsStr(`Excluir ${nomeOu(a)} de vez? Apaga cadastro, progresso, leituras e links. Não tem volta.`)})">
            <button class="btn btn-fantasma" type="submit" style="color:#8B2A20">Excluir aluno</button>
          </form>
        </div>
      </section>
    </main>`;
    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: nomeOu(a), aluno: admin, corpo }));
  });

  // convite individual. O clique do admin vale como de acordo (fonte "painel")
  // quando ainda não havia um registrado — é ele quem está afirmando que tem.
  r.post("/admin/aluno/:id/convite", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const a: any = await c.env.DB.prepare(
      `SELECT a.email FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ? WHERE a.id = ?`
    ).bind(c.env.ESCOLA, id).first();
    if (!a) return c.notFound();
    await c.env.DB.prepare(`UPDATE matriculas SET consentiu_em = COALESCE(consentiu_em, ?), consentimento = COALESCE(consentimento, 'painel')
      WHERE aluno_id = ? AND escola = ?`).bind(d.agora(), id, c.env.ESCOLA).run();
    const volta = await voltaDe(c, id);
    try {
      await enviarLinkMagico(c.env, new URL(c.req.url).origin, a.email, { validadeSeg: VALIDADE_CONVITE, tipo: "convite" });
      return c.redirect(volta("convite=ok"));
    } catch { return c.redirect(volta("convite=erro")); }
  });

  r.post("/admin/aluno/:id/nome", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const form = await c.req.formData();
    const nome = String(form.get("nome") || "").trim().slice(0, 80) || null;
    const turma = String(form.get("turma") || "").trim().slice(0, 60) || null;
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE alunos SET nome = ? WHERE id = ?`).bind(nome, id),
      c.env.DB.prepare(`UPDATE matriculas SET turma = ? WHERE aluno_id = ? AND escola = ?`).bind(turma, id, c.env.ESCOLA),
    ]);
    return c.redirect(`/admin/aluno/${id}?nome=ok`);
  });

  r.post("/admin/aluno/:id/remover", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    await c.env.DB.prepare(`DELETE FROM matriculas WHERE aluno_id = ? AND escola = ?`).bind(id, c.env.ESCOLA).run();
    return c.redirect("/admin?removido=1");
  });

  // exclusão completa — as tabelas de produção não têm chave estrangeira, então
  // cada dependência sai explicitamente
  r.post("/admin/aluno/:id/excluir", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const admin = c.get("aluno");
    if (id === admin.id) return c.text("Você não pode excluir a si mesmo.", 400);
    const a: any = await c.env.DB.prepare(`SELECT email FROM alunos WHERE id = ?`).bind(id).first();
    if (!a) return c.notFound();
    const stmts = [
      `DELETE FROM sessoes WHERE aluno_id = ?`, `DELETE FROM progresso WHERE aluno_id = ?`,
      `DELETE FROM acervo_progresso WHERE aluno_id = ?`, `DELETE FROM trilhas WHERE aluno_id = ?`,
      `DELETE FROM artigos_lidos WHERE aluno_id = ?`, `DELETE FROM acessos WHERE aluno_id = ?`,
      `DELETE FROM matriculas WHERE aluno_id = ?`,
    ].map((sql) => c.env.DB.prepare(sql).bind(id));
    stmts.push(c.env.DB.prepare(`DELETE FROM links_magicos WHERE email = ?`).bind(a.email));
    stmts.push(c.env.DB.prepare(`DELETE FROM alunos WHERE id = ?`).bind(id));
    await c.env.DB.batch(stmts);
    return c.redirect("/admin?excluido=1");
  });

  return r;
}

function cartaoAluno(a: LinhaAluno, totalAulas: number, agora: number): string {
  const pct = totalAulas ? Math.round(a.feitas / totalAulas * 100) : 0;
  const sit = situacaoDe(a, totalAulas, agora);
  return `<a class="cartao-aluno" href="/admin/aluno/${a.id}" data-flags="${sit.flags.join(" ")}"
      data-busca="${esc((a.nome || "") + " " + a.email).toLowerCase()}">
    <span class="avatar">${esc(iniciais(a))}</span>
    <span class="cartao-txt">
      <b>${esc(nomeOu(a))}</b>
      <span class="aula-meta">${esc(a.email)}</span>
      <span class="etiqueta ${sit.tom}">${esc(sit.rotulo)}</span>
    </span>
    ${anel(pct)}
    <span class="cartao-pe aula-meta">${a.feitas}/${totalAulas} aulas${a.lidas ? ` · ${a.lidas} leit.` : ""}${
      a.ultimo_acesso ? ` · ${haQuanto(a.ultimo_acesso, agora)}` : ""}</span>
  </a>`;
}

function linhaAluno(a: LinhaAluno, totalAulas: number, agora: number): string {
  const pct = totalAulas ? Math.round(a.feitas / totalAulas * 100) : 0;
  const entrou = !!a.ultimo_acesso;
  const sit = situacaoDe(a, totalAulas, agora);
  const situacao = entrou
    ? `último acesso ${haQuanto(a.ultimo_acesso, agora)}`
    : !a.links ? (a.consentiu_em ? "nunca entrou · o sistema nunca enviou link" : "nunca entrou · sem de acordo, sem link")
    : (a.ultimo_link ?? 0) > agora ? "link enviado, ainda válido · não abriu"
    : "link enviado expirou · não abriu";
  return `<div class="aula aluno-linha ${entrou ? "feita" : ""}" style="cursor:default"
      data-flags="${sit.flags.join(" ")}" data-busca="${esc((a.nome || "") + " " + a.email).toLowerCase()}">
    <span class="check">✓</span>
    <span class="aula-txt">
      <b>${esc(nomeOu(a))}</b>
      <span class="aula-meta">${esc(a.email)} · ${situacao}</span>
      <span class="mini-barra"><i style="width:${pct}%"></i></span>
      <span class="aula-meta">${a.feitas} de ${totalAulas} aulas · ${pct}%${a.lidas ? ` · ${a.lidas} leitura${a.lidas === 1 ? "" : "s"}` : ""}${
        a.ultimo_progresso ? ` · progrediu ${haQuanto(a.ultimo_progresso, agora)}` : ""}</span>
    </span>
    <span class="acoes">
      <a class="btn btn-fantasma" href="/admin/aluno/${a.id}">Ver</a>
      <form method="post" action="/admin/aluno/${a.id}/convite">
        <button class="btn btn-fantasma" type="submit">${entrou ? "Link de acesso" : "Reenviar convite"}</button>
      </form>
    </span>
  </div>`;
}

// kanban: uma coluna por etapa. O topo mostra quantos estão ali agora e a
// barra quantos passaram por ali (chegaram até a etapa ou além) — o funil de
// verdade. Colunas de quem nunca entrou têm a ação em massa correspondente.
function kanbanAlunos(alunos: LinhaAluno[], totalAulas: number, agora: number): string {
  const etapas = alunos.map((a) => etapaDe(a, totalAulas));
  const total = alunos.length;
  return ETAPAS.map((e, i) => {
    const aqui = alunos.filter((_, k) => etapas[k] === i);
    const chegaram = etapas.filter((k) => k >= i).length;
    const pct = total ? Math.round(chegaram / total * 100) : 0;
    const expirados = i === 1 ? aqui.filter((a) => (a.ultimo_link ?? 0) <= agora).length : 0;
    const n = i === 0 ? aqui.filter((a) => a.consentiu_em).length : expirados;
    const acao = n && (i === 0 || i === 1) ? `<form method="post" action="/admin/convidar-pendentes" class="funil-acao"
        onsubmit="return confirm('${i === 0
          ? `Enviar link de entrada (48 h) para ${n === 1 ? "esse aluno" : `esses ${n} alunos`}?`
          : `Reenviar link de entrada (48 h) para ${n === 1 ? "o aluno com link vencido" : `os ${n} alunos com link vencido`}?`}')">
        <input type="hidden" name="grupo" value="${i === 0 ? "sem-link" : "expirados"}">
        <button class="btn btn-fantasma" type="submit">${i === 0
          ? `Enviar link para ${n === 1 ? "esse" : "os " + n}`
          : `Reenviar ${n === 1 ? "ao expirado" : `aos ${n} expirados`}`}</button>
      </form>` : "";
    return `<section class="funil-col" data-etapa="${e.id}" aria-label="${esc(e.nome)}">
      <div class="funil-topo">
        <p class="mono">${esc(e.nome)}</p>
        <p class="num"><span class="col-n">${aqui.length}</span></p>
        <span class="aula-meta dica">${esc(e.dica)}</span>
        <span class="funil-barra" title="${chegaram} de ${total} chegaram até aqui"><i style="width:${pct}%"></i></span>
        <span class="aula-meta">${chegaram} de ${total} chegaram até aqui</span>
      </div>
      ${aqui.map((a) => cartaoFunil(a, totalAulas, agora, i)).join("")}
      <p class="funil-vazio aula-meta" ${aqui.length ? "hidden" : ""}>ninguém aqui</p>
      ${acao}
    </section>`;
  }).join("");
}

function cartaoFunil(a: LinhaAluno, totalAulas: number, agora: number, etapa: number): string {
  const sit = situacaoDe(a, totalAulas, agora);
  const pct = totalAulas ? Math.round(a.feitas / totalAulas * 100) : 0;
  const meta = etapa === 0 ? `cadastrado ${haQuanto(a.matricula_em, agora)}`
    : etapa === 1 ? ((a.ultimo_link ?? 0) > agora ? `link vale até ${dataCurta(a.ultimo_link!)}` : `link expirou ${haQuanto(a.ultimo_link, agora)}`)
    : etapa === 2 ? `entrou ${haQuanto(a.ultimo_acesso, agora)} · nenhuma aula`
    : etapa === 3 ? `${a.feitas}/${totalAulas} aulas · ${haQuanto(a.ultimo_progresso ?? a.ultimo_acesso, agora)}`
    : `100% · ${haQuanto(a.ultimo_progresso ?? a.ultimo_acesso, agora)}`;
  const parado = (etapa === 2 || etapa === 3) && sit.flags.includes("inativo");
  return `<a class="cartao-funil" href="/admin/aluno/${a.id}" data-flags="${sit.flags.join(" ")}"
      data-busca="${esc((a.nome || "") + " " + a.email).toLowerCase()}" title="${esc(a.email)}">
    <span class="avatar">${esc(iniciais(a))}</span>
    <span class="cartao-txt"><b>${esc(nomeOu(a))}</b><span class="aula-meta">${meta}</span></span>
    ${etapa === 3 ? `<span class="mini-barra"><i style="width:${pct}%"></i></span>` : ""}
    ${parado ? `<span class="etiqueta neutro">parado</span>` : ""}
  </a>`;
}

// abas por hash (sem recarregar), filtros e busca sobre cartões, lista e
// funil, e a visão escolhida lembrada no navegador do admin
const PAINEL_JS = `
(function(){
  var abas=[].slice.call(document.querySelectorAll(".aba")), paineis=[].slice.call(document.querySelectorAll(".painel-aba"));
  // o hash pode ser uma aba (#funil) ou um elemento dentro dela (#cortes):
  // abre a aba que contém o elemento e rola até ele
  function abrir(id){ var alvo=document.getElementById(id), sec=alvo&&alvo.closest?alvo.closest(".painel-aba"):null;
    if(sec) id=sec.id; if(!document.getElementById(id)) id="hoje";
    abas.forEach(function(a){ a.classList.toggle("ativa", a.dataset.aba===id); });
    paineis.forEach(function(p){ p.hidden = p.id!==id; });
        var G={hoje:"hoje",alunos:"alunos",funil:"alunos",convidar:"alunos",aulas:"conteudo",desempenho:"conteudo",leituras:"conteudo",provas:"conteudo",noticias:"conteudo",inteligencia:"conteudo",equipe:"config"}, g=G[id]||"hoje";
            document.querySelectorAll(".gtab").forEach(function(t){ t.classList.toggle("ativa", t.dataset.grupo===g); });
                document.querySelectorAll("[data-snav]").forEach(function(s){ s.hidden = s.dataset.snav!==g; });
                    document.querySelectorAll(".schip").forEach(function(s){ s.classList.toggle("ativa", (s.getAttribute("href")||"").slice(1)===id); });
    if(sec && alvo!==sec) setTimeout(function(){ alvo.scrollIntoView({block:"start"}); }, 0); }
  abas.forEach(function(a){ a.addEventListener("click", function(e){ e.preventDefault(); history.replaceState(null,"","#"+a.dataset.aba); abrir(a.dataset.aba); }); });
    document.querySelectorAll(".gtab,.schip").forEach(function(a){ a.addEventListener("click", function(e){ e.preventDefault(); var id=(a.getAttribute("href")||"#hoje").slice(1); history.replaceState(null,"","#"+id); abrir(id); }); });
  abrir((location.hash||("#"+(new URLSearchParams(location.search).get("aba")||"hoje"))).slice(1));
  window.addEventListener("hashchange", function(){ abrir(location.hash.slice(1)); });

  var filtro="todos", termo="", visao=null;
  try{ visao=localStorage.getItem("painel-visao"); }catch(e){}
  if(visao!=="lista" && visao!=="kanban") visao="cartoes";
  var cartoes=document.getElementById("cartoes"), lista=document.getElementById("lista"), funil=document.getElementById("kanban"),
      vazio=document.getElementById("sem-resultado"), massa=document.getElementById("convite-massa");
  function aplicar(){
    var alvo=visao==="lista"?lista:visao==="kanban"?funil:cartoes;
    var itens=[].slice.call(document.querySelectorAll("[data-flags]")), vis=0;
    itens.forEach(function(el){
      var ok=(filtro==="todos"||el.dataset.flags.split(" ").indexOf(filtro)>-1) && (!termo||el.dataset.busca.indexOf(termo)>-1);
      el.hidden=!ok; if(ok && alvo.contains(el)) vis++;
    });
    cartoes.hidden = visao!=="cartoes"; lista.hidden = visao!=="lista"; funil.hidden = visao!=="kanban"; vazio.hidden = vis>0;
    if(massa) massa.hidden = visao==="kanban";
    [].slice.call(funil.querySelectorAll(".funil-col")).forEach(function(col){
      var n=[].slice.call(col.querySelectorAll("[data-flags]")).filter(function(e){ return !e.hidden; }).length;
      col.querySelector(".col-n").textContent=n; col.querySelector(".funil-vazio").hidden=n>0;
    });
    document.querySelectorAll("#chips .chip").forEach(function(c){ c.classList.toggle("ativa", c.dataset.filtro===filtro); });
    document.querySelectorAll(".filtro-card").forEach(function(c){ c.classList.toggle("ativa", c.dataset.filtro===filtro); });
    document.querySelectorAll("#visao .chip").forEach(function(c){ c.classList.toggle("ativa", c.dataset.visao===visao); });
  }
  document.querySelectorAll("[data-filtro]").forEach(function(b){ b.addEventListener("click", function(){ filtro=b.dataset.filtro; aplicar(); }); });
  document.querySelectorAll("[data-visao]").forEach(function(b){ b.addEventListener("click", function(){ visao=b.dataset.visao; try{ localStorage.setItem("painel-visao", visao); }catch(e){} aplicar(); }); });
  var busca=document.getElementById("busca"); if(busca) busca.addEventListener("input", function(){ termo=busca.value.trim().toLowerCase(); aplicar(); });
  aplicar();

  // funil: clicar na etapa (ou na linha de queda) abre a lista de quem está parado ali
  document.querySelectorAll(".funil-etapa,.queda").forEach(function(el){
    el.addEventListener("click", function(e){
      if(e.target.closest("form,button.btn,a")) return;
      var i=el.dataset.etapa, lista=document.querySelector('[data-lista="'+i+'"]'); if(!lista) return;
      var abrir=lista.hidden;
      document.querySelectorAll("[data-lista]").forEach(function(l){ l.hidden=true; });
      document.querySelectorAll(".funil-etapa").forEach(function(b){ b.setAttribute("aria-expanded","false"); });
      lista.hidden=!abrir; if(abrir){ var b=document.querySelector('.funil-etapa[data-etapa="'+i+'"]'); if(b) b.setAttribute("aria-expanded","true"); }
    });
  });
  document.querySelectorAll("[data-copiar]").forEach(function(b){
    b.addEventListener("click", function(){
      var txt=b.dataset.copiar, feito=function(){ var t=b.textContent; b.textContent="Copiado ✓"; setTimeout(function(){ b.textContent=t; }, 1800); };
      if(navigator.clipboard) navigator.clipboard.writeText(txt).then(feito, function(){ window.prompt("Copie:", txt); });
      else window.prompt("Copie:", txt);
    });
  });
  // pedir corte demora uns 15 s (busca + IA): o botão avisa em vez de parecer travado
  document.querySelectorAll('form[action="/admin/cortes/sugerir"]').forEach(function(f){
    f.addEventListener("submit", function(){ var b=f.querySelector("button[type=submit]"), m=f.querySelector("select[name=modo]");
      if(b){ b.disabled=true; b.textContent = m && m.value==="editor" ? "Chamando o editor-chefe…" : "Procurando e escolhendo… ~15 s"; } });
  });
  // cadastro: sem de acordo não há convite
  var acordo=document.getElementById("chk-acordo"), convite=document.getElementById("chk-convite"), btn=document.getElementById("btn-cadastrar");
  function ajustaCadastro(){ if(!acordo||!convite||!btn) return;
    if(!acordo.checked){ convite.checked=false; convite.disabled=true; } else convite.disabled=false;
    btn.textContent = convite.checked ? "Cadastrar e convidar" : "Cadastrar"; }
  if(acordo){ acordo.addEventListener("change", ajustaCadastro); convite.addEventListener("change", ajustaCadastro); ajustaCadastro(); }
})();`;
