// Link mágico — o único jeito de entrar. Usado pela tela de entrada (20 min),
// pelo painel e pelo /quero, que convidam com validade maior, e pelo lembrete
// de primeira aula. Cada link guarda o tipo e quando foi criado; convite e
// lembrete levam um pixel de abertura (sinal de "abriu o e-mail", não prova).

import { esc } from "./ui";

export const VALIDADE_ENTRADA = 20 * 60;          // pedido pelo próprio aluno
export const VALIDADE_CONVITE = 48 * 60 * 60;     // enviado pelo admin ou pelo /quero

export type TipoLink = "entrada" | "convite" | "lembrete";

const agora = () => Math.floor(Date.now() / 1000);
const novoToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function enviarLinkMagico(
  env: any, origem: string, email: string,
  o: { validadeSeg: number; convite?: boolean; tipo?: TipoLink; destino?: string; aula?: { titulo: string; minutos: number } | null },
): Promise<void> {
  const tipo: TipoLink = o.tipo ?? (o.convite ? "convite" : "entrada");
  const token = novoToken();
  await env.DB.prepare(`INSERT INTO links_magicos (token, email, expira_em, tipo, criado_em) VALUES (?,?,?,?,?)`)
    .bind(token, email, agora() + o.validadeSeg, tipo, agora()).run();

  const destino = o.destino && /^\/app(\/|$)/.test(o.destino) ? `&para=${encodeURIComponent(o.destino)}` : "";
  const link = `${origem}/verificar?t=${token}${destino}`;
  const escola = String(env.NOME_ESCOLA || "");
  const validade = o.validadeSeg >= 3600
    ? `${Math.round(o.validadeSeg / 3600)} horas` : `${Math.round(o.validadeSeg / 60)} minutos`;

  const titulo = tipo === "convite" ? "Seu acesso está liberado"
    : tipo === "lembrete" ? "Sua primeira aula te espera" : "Seu acesso está pronto";
  const corpo = tipo === "convite"
    ? `Você foi liberado na ${escola}. Clique no botão para entrar — o link vale por ${validade} e funciona uma vez. Depois disso, entre em ${origem} com este e-mail.`
    : tipo === "lembrete"
    ? `Você já entrou na ${escola}, mas ainda não começou.${o.aula ? ` A primeira aula é "${o.aula.titulo}" (${o.aula.minutos} min).` : ""} Clique no botão para ir direto para ela — o link vale por ${validade}.`
    : `Clique no botão para entrar. O link vale por ${validade}.`;
  const assunto = tipo === "convite" ? `Seu acesso à ${escola} está liberado`
    : tipo === "lembrete" ? `Sua primeira aula na ${escola}` : `Seu acesso à ${escola}`;
  const botao = tipo === "lembrete" ? "Ir para a primeira aula" : "Entrar nas aulas";
  // pixel só em e-mail que a escola manda por iniciativa própria
  const pixel = tipo === "entrada" ? "" : `<img src="${origem}/c/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px">`;

  try {
    await env.EMAIL.send({
    to: email,
    from: env.EMAIL_REMETENTE,
    subject: assunto,
    text: `${corpo}\n\n${link}`,
    html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#1F1BE4;color:#FFFFFF;padding:44px 40px;border-radius:5px">
      <p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.72);margin:0 0 18px">${esc(escola)}</p>
      <h1 style="font-size:30px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;color:#FFFFFF">${titulo}</h1>
      <p style="color:rgba(255,255,255,.78);margin:0 0 28px;font-size:16px">${esc(corpo)}</p>
      <a href="${link}" style="display:inline-block;background:#FAE047;color:#000000;font-weight:700;padding:15px 30px;border-radius:5px;text-decoration:none;font-size:15px">${botao}</a>
      <p style="color:rgba(255,255,255,.55);font-size:12px;margin:30px 0 0">Se você não pediu esse acesso, ignore este e-mail.</p>
    </div>${pixel}`,
    });
  } catch (e) {
    // sem e-mail não há link: apaga para o painel não mostrar "convite válido"
    await env.DB.prepare(`DELETE FROM links_magicos WHERE token = ?`).bind(token).run().catch(() => {});
    throw e;
  }
}
