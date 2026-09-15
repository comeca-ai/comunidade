// Pulso da turma — o Activity Score do painel. Uma nota de 1 a 10 por aluno,
// calculada só do que o banco já sabe, na janela de 30 dias: dias em que
// entrou (acessos), aulas concluídas (progresso), leituras abertas
// (artigos_lidos) e a recência do último acesso. Nada novo é coletado.
//
// A nota ordena a atenção do admin, não pune aluno: pulso baixo (3 ou menos)
// sinaliza risco de abandono antes de ele acontecer; pulso alto (8+) aponta
// os embaixadores — depoimento, indicação, case. Quem nunca entrou não
// pontua: o funil de entrada já cuida deles.

import { esc } from "./ui";
import { DIA, diaLocal, nomeOu, iniciais } from "./apoio";

export type AlunoPulso = {
  id: number; nome: string; iniciais: string; score: number;
  tendencia: -1 | 0 | 1; // dias de acesso vs. os 30 dias anteriores
  detalhe: string;       // "sem acesso há 12 dias · 3/14 aulas"
};

export type PulsoTurma = {
  medio: number;                       // média de quem já entrou
  comPulso: number;                    // quantos já entraram (têm nota)
  emRisco: number; embaixadores: number;
  risco: AlunoPulso[];                 // até 5, do mais crítico para cima
  topo: AlunoPulso[];                  // até 3, do melhor para baixo
};

// componentes da nota, sempre dos últimos 30 dias: recência do último acesso
// (0–3) + constância em dias distintos de acesso (0–3) + avanço em aulas
// concluídas (0–3) + leituras (0–1). Soma até 10; quem já entrou parte de 1.
const nota = (d: { recencia: number; dias30: number; feitas30: number; lidas30: number }) => {
  let s = 0;
  s += d.recencia <= 2 ? 3 : d.recencia <= 7 ? 2 : d.recencia <= 14 ? 1 : 0;
  s += d.dias30 >= 12 ? 3 : d.dias30 >= 6 ? 2 : d.dias30 >= 2 ? 1 : 0;
  s += d.feitas30 >= 6 ? 3 : d.feitas30 >= 3 ? 2 : d.feitas30 >= 1 ? 1 : 0;
  s += d.lidas30 >= 1 ? 1 : 0;
  return Math.max(1, Math.min(10, s));
};

export async function pulsoDaTurma(env: any, agora: number): Promise<PulsoTurma | null> {
  const d30 = agora - 30 * DIA;
  const dia30 = diaLocal(agora) - 30, dia60 = diaLocal(agora) - 60;
  const [r, tot] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.email, a.nome, a.ultimo_acesso,
        (SELECT COUNT(*) FROM acessos ac WHERE ac.aluno_id = a.id AND ac.dia >= ?) AS dias30,
        (SELECT COUNT(*) FROM acessos ac WHERE ac.aluno_id = a.id AND ac.dia >= ? AND ac.dia < ?) AS dias_antes,
        (SELECT COUNT(*) FROM progresso p JOIN aulas au ON au.uid = p.aula_uid
          WHERE p.aluno_id = a.id AND p.concluida_em >= ? AND au.publicada = 1) AS feitas30,
        (SELECT COUNT(*) FROM progresso p JOIN aulas au ON au.uid = p.aula_uid
          WHERE p.aluno_id = a.id AND p.concluida_em IS NOT NULL AND au.publicada = 1) AS feitas,
        (SELECT COUNT(*) FROM artigos_lidos l WHERE l.aluno_id = a.id AND l.lido_em >= ?) AS lidas30
       FROM alunos a JOIN matriculas m ON m.aluno_id = a.id AND m.escola = ?
       WHERE a.ultimo_acesso IS NOT NULL`
    ).bind(dia30, dia60, dia30, d30, d30, env.ESCOLA).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM aulas WHERE publicada = 1`).first(),
  ]);
  const totalAulas = Number(tot?.n ?? 0);
  const linhas: any[] = r.results ?? [];
  if (!linhas.length) return null;
  const todos = linhas.map((a) => {
    const recencia = Math.floor((agora - Number(a.ultimo_acesso)) / DIA);
    const dias30 = Number(a.dias30), antes = Number(a.dias_antes);
    const concluiu = totalAulas > 0 && Number(a.feitas) >= totalAulas;
    return {
      id: Number(a.id), nome: nomeOu(a), iniciais: iniciais(a), concluiu,
      score: nota({ recencia, dias30, feitas30: Number(a.feitas30), lidas30: Number(a.lidas30) }),
      tendencia: (dias30 > antes + 1 ? 1 : dias30 < antes - 1 ? -1 : 0) as -1 | 0 | 1,
      detalhe: `${recencia <= 0 ? "entrou hoje" : `sem acesso há ${recencia} dia${recencia === 1 ? "" : "s"}`} · ${
        concluiu ? "concluiu o curso" : `${a.feitas}/${totalAulas} aulas`}`,
    };
  });
  const emRisco = todos.filter((t) => !t.concluiu && t.score <= 3);
  const altos = todos.filter((t) => t.score >= 8);
  return {
    medio: Math.round(todos.reduce((s, t) => s + t.score, 0) / todos.length * 10) / 10,
    comPulso: todos.length,
    emRisco: emRisco.length, embaixadores: altos.length,
    risco: emRisco.sort((x, y) => x.score - y.score).slice(0, 5),
    topo: altos.sort((x, y) => y.score - x.score).slice(0, 3),
  };
}

/* ---------------- a tela ---------------- */

// reusa o vocabulário visual do painel (card, mono, aula-meta, avatar) —
// nenhum CSS novo; as duas cores são as mesmas do anel e do botão de alerta
const pilula = (score: number) =>
  `<span class="mono" style="font-weight:600;white-space:nowrap;padding:2px 9px;border-radius:99px;border:1.5px solid ${
    score <= 3 ? "#8B2A20" : score >= 8 ? "#1F1BE4" : "var(--linha, #EDEAE3)"};color:${
    score <= 3 ? "#8B2A20" : score >= 8 ? "#1F1BE4" : "inherit"}">${score}/10</span>`;

const seta = (t: -1 | 0 | 1) => (t === 1 ? " · subindo ↗" : t === -1 ? " · caindo ↘" : "");

export function secaoPulso(p: PulsoTurma | null): string {
  if (!p) return "";
  const linha = (a: AlunoPulso) => `<div class="aula" style="cursor:default">
  <span class="avatar">${esc(a.iniciais)}</span>
  <span class="aula-txt"><b>${esc(a.nome)}</b><span class="aula-meta">${esc(a.detalhe)}${seta(a.tendencia)}</span></span>
  ${pilula(a.score)}
  <span class="acoes"><a class="btn btn-fantasma" href="/admin/aluno/${a.id}">Ver ficha</a></span>
  </div>`;
  const medio = String(p.medio).replace(".", ",");
  return `<section class="modulo" id="hoje-pulso">
  <div class="modulo-topo"><h2>Pulso da turma</h2>
  <span class="mono">média ${medio} · ${p.comPulso} aluno${p.comPulso === 1 ? "" : "s"} com nota · 30 dias</span></div>
  ${p.risco.length ? `<p class="aula-meta" style="margin-top:10px">Pulso 3 ou menos com o curso inacabado — um contato agora evita o abandono.</p>
  ${p.risco.map(linha).join("")}` : `<p class="vazio">Ninguém em risco com os dados de agora — quem cair para pulso 3 ou menos aparece aqui.</p>`}
  ${p.topo.length ? `<p class="aula-meta" style="margin-top:16px">Pulso 8 ou mais — candidatos a depoimento, indicação e case.</p>
  ${p.topo.map(linha).join("")}` : ""}
  </section>`;
}
