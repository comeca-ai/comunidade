// Digest semanal — "Sua semana na escola". Aluno sem tocar na escola por duas
// semanas raramente volta sozinho; o resumo de sexta de manhã é a alavanca de
// retenção mais barata que existe. Um e-mail por aluno por semana, montado do
// que o banco já sabe: progresso, próxima aula da trilha, um destaque do
// "No radar" — e, para quem o Pulso (pulso.ts) marca como em risco, o tom
// muda de resumo para resgate.
//
// Roda pelo cron de 15 min (index.ts): só age na janela de envio (sexta,
// 8h de Brasília) e a tabela digest_envios garante um envio por aluno por
// semana mesmo com o cron passando quatro vezes na hora. Quem concluiu o
// curso não recebe — não há o que retomar.

import { esc } from "./ui";
import { DIA } from "./apoio";
import { notasDaTurma, type NotaAluno } from "./pulso";
import { noticiasAprovadas } from "./noticias";
import { regrasDoEnv, moduloNaLeitura, listaDeModulos } from "../packages/conteudo/modulos";

const DIA_ENVIO = 5;  // sexta-feira
const HORA_ENVIO = 8; // 8h de Brasília (o cron de 15 min pega a janela de 1h)

let tabelaOk = false;
async function garantirTabelaDigest(env: any) {
  if (tabelaOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS digest_envios (
    aluno_id INTEGER NOT NULL, semana INTEGER NOT NULL, enviado_em INTEGER NOT NULL,
    PRIMARY KEY (aluno_id, semana))`).run();
  tabelaOk = true;
}

// aulas publicadas na ordem da trilha — a mesma leitura do painel do aluno
async function trilhaOrdenada(env: any): Promise<any[]> {
  const r: any = await env.DB.prepare(
    `SELECT uid, titulo, modulo, ordem, duracao_seg, criada_em FROM aulas WHERE publicada = 1`).all();
  const regras = regrasDoEnv(env);
  const ordem = listaDeModulos(env.ORDEM_MODULOS);
  const peso = (m: string) => { const i = ordem.indexOf(m); return i === -1 ? ordem.length + 1 : i; };
  return ((r.results ?? []) as any[]).map((l) => ({ ...l, ...moduloNaLeitura(l, regras) }))
    .sort((a, b) => peso(a.modulo) - peso(b.modulo) || a.ordem - b.ordem
      || (a.criada_em ?? 0) - (b.criada_em ?? 0) || a.titulo.localeCompare(b.titulo, "pt-BR"));
}

// chamada pelo cron. Devolve quantos e-mails saíram (0 fora da janela).
export async function enviarDigestSemanal(env: any, agora: number): Promise<number> {
  const local = new Date((agora - 3 * 3600) * 1000);
  if (local.getUTCDay() !== DIA_ENVIO || local.getUTCHours() !== HORA_ENVIO) return 0;
  await garantirTabelaDigest(env);
  const semana = Math.floor((agora - 3 * 3600) / (7 * DIA));

  const { totalAulas, notas } = await notasDaTurma(env, agora);
  if (!totalAulas || !notas.length) return 0;

  const [trilha, prog, enviados, destaque] = await Promise.all([
    trilhaOrdenada(env),
    env.DB.prepare(`SELECT aluno_id, aula_uid FROM progresso WHERE concluida_em IS NOT NULL`).all(),
    env.DB.prepare(`SELECT aluno_id FROM digest_envios WHERE semana = ?`).bind(semana).all(),
    noticiasAprovadas(env).then((ns: any[]) => (ns ?? [])[0] ?? null).catch(() => null),
  ]);
  const feitasDe = new Map<number, Set<string>>();
  for (const p of ((prog as any).results ?? []) as any[]) {
    const id = Number(p.aluno_id);
    if (!feitasDe.has(id)) feitasDe.set(id, new Set());
    feitasDe.get(id)!.add(String(p.aula_uid));
  }
  const ja = new Set((((enviados as any).results ?? []) as any[]).map((x) => Number(x.aluno_id)));

  // homolog não tem domínio próprio — cai na URL workers.dev
  const dominio = String(env.DOMINIO || "").trim();
  const origem = dominio ? `https://${dominio}` : "https://escola-classica-homolog.jhonata-emerick.workers.dev";

  let n = 0;
  for (const a of notas) {
    if (ja.has(a.id) || a.concluiu) continue;
    try {
      await env.EMAIL.send(emailDigest(env, origem, a, {
        totalAulas,
        proxima: trilha.find((t) => !(feitasDe.get(a.id) ?? new Set()).has(t.uid)) ?? null,
        destaque,
      }));
      await env.DB.prepare(`INSERT OR IGNORE INTO digest_envios (aluno_id, semana, enviado_em) VALUES (?,?,?)`)
        .bind(a.id, semana, agora).run();
      n++;
    } catch (e) { console.error("digest:", a.email, e); }
  }
  return n;
}

function emailDigest(env: any, origem: string, a: NotaAluno,
  o: { totalAulas: number; proxima: any | null; destaque: any | null }) {
  const escola = String(env.NOME_ESCOLA || "");
  const pct = o.totalAulas ? Math.round(a.feitas / o.totalAulas * 100) : 0;
  const emRisco = a.score <= 3;
  const primeiro = a.nome.split(/\s+/)[0];
  const minutos = o.proxima ? Math.max(1, Math.round(Number(o.proxima.duracao_seg || 0) / 60)) : 0;

  const assunto = emRisco
    ? `${primeiro}, sua trilha na ${escola} está esperando`
    : `Sua semana na ${escola} — ${pct}% da trilha`;
  const abertura = emRisco
    ? `Você está há ${a.recencia} dia${a.recencia === 1 ? "" : "s"} sem entrar, parado em ${a.feitas} de ${o.totalAulas} aulas (${pct}%). ${minutos ? `A próxima leva só ${minutos} min — dá para retomar hoje.` : "Dá para retomar hoje."}`
    : `Você já concluiu ${a.feitas} de ${o.totalAulas} aulas (${pct}% da trilha).${o.proxima ? ` A próxima é curta: ${minutos} min.` : ""}`;

  const linhaProxima = o.proxima
    ? `<p style="color:rgba(255,255,255,.78);margin:0 0 6px;font-size:14px">Próxima aula</p>
<p style="color:#FFFFFF;margin:0 0 24px;font-size:17px;font-weight:600">${esc(o.proxima.titulo)} <span style="color:rgba(255,255,255,.6);font-weight:400">· ${esc(o.proxima.modulo)} · ${minutos} min</span></p>`
    : "";
  const linhaDestaque = o.destaque?.titulo
    ? `<p style="color:rgba(255,255,255,.55);font-size:13px;margin:26px 0 0;border-top:1px solid rgba(255,255,255,.18);padding-top:16px">No radar esta semana: <a href="${esc(String(o.destaque.url || origem))}" style="color:#FAE047;text-decoration:none">${esc(String(o.destaque.titulo))}</a>${o.destaque.fonte ? ` — ${esc(String(o.destaque.fonte))}` : ""}</p>`
    : "";
  const link = o.proxima ? `${origem}/app/aula/${encodeURIComponent(String(o.proxima.uid))}` : `${origem}/app`;
  const botao = emRisco ? "Retomar de onde parei" : "Continuar a trilha";

  return {
    to: a.email,
    from: env.EMAIL_REMETENTE,
    subject: assunto,
    text: `${abertura}\n\n${o.proxima ? `Próxima aula: ${o.proxima.titulo} (${minutos} min)\n` : ""}${link}`,
    html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#1F1BE4;color:#FFFFFF;padding:44px 40px;border-radius:5px">
<p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.72);margin:0 0 18px">${esc(escola)} · sua semana</p>
<h1 style="font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px;color:#FFFFFF">${emRisco ? "Sentimos sua falta por aqui" : "Seu progresso na trilha"}</h1>
<p style="color:rgba(255,255,255,.78);margin:0 0 24px;font-size:16px">${esc(abertura)}</p>
${linhaProxima}
<a href="${esc(link)}" style="display:inline-block;background:#FAE047;color:#000000;font-weight:700;padding:15px 30px;border-radius:5px;text-decoration:none;font-size:15px">${botao}</a>
${linhaDestaque}
<p style="color:rgba(255,255,255,.55);font-size:12px;margin:30px 0 0">Você recebe este resumo por ser aluno da ${esc(escola)}. Sessões duram 30 dias — se pedir, o acesso chega por link no seu e-mail.</p>
</div>`,
  };
}
