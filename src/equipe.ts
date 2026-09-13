// Equipe: quem administra o painel. Dois lugares somam-se:
//   · a var ADMINS do wrangler.jsonc (fixos — só mudam com deploy);
//   · a tabela `administradores`, editada pela aba Equipe do painel.
// Admin entra como qualquer aluno (link mágico), então quem é adicionado
// ganha cadastro e matrícula na hora, com o de acordo do painel, e pode
// receber o link de acesso no mesmo clique. Ninguém remove a si mesmo nem os
// fixos pelo painel.

import { Hono } from "hono";
import { esc, jsStr } from "./ui";
import { enviarLinkMagico, VALIDADE_CONVITE } from "./acesso";
import { dataCurta, haQuanto, emailsDe } from "./apoio";

let esquemaOk = false;
export async function garantirTabelaEquipe(env: any) {
  if (esquemaOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS administradores (
    escola TEXT NOT NULL, email TEXT NOT NULL, adicionado_por TEXT, adicionado_em INTEGER NOT NULL,
    PRIMARY KEY (escola, email))`).run();
  esquemaOk = true;
}

export const adminsFixos = (env: any): string[] =>
  String(env.ADMINS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function ehAdmin(env: any, email: string): Promise<boolean> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (adminsFixos(env).includes(e)) return true;
  try {
    await garantirTabelaEquipe(env);
    const r = await env.DB.prepare(`SELECT 1 AS x FROM administradores WHERE escola = ? AND email = ?`).bind(env.ESCOLA, e).first();
    return !!r;
  } catch { return false; }
}

export type Admin = { email: string; nome: string | null; fixo: boolean; adicionado_por: string | null; adicionado_em: number | null; ultimo_acesso: number | null };

export async function adminsDe(env: any): Promise<Admin[]> {
  await garantirTabelaEquipe(env);
  const r: any = await env.DB.prepare(`SELECT email, adicionado_por, adicionado_em FROM administradores WHERE escola = ? ORDER BY adicionado_em`).bind(env.ESCOLA).all();
  const lista: Admin[] = adminsFixos(env).map((email) => ({ email, nome: null, fixo: true, adicionado_por: null, adicionado_em: null, ultimo_acesso: null }));
  for (const x of (r.results ?? [])) if (!lista.some((a) => a.email === x.email)) lista.push({ email: String(x.email), nome: null, fixo: false, adicionado_por: x.adicionado_por ?? null, adicionado_em: Number(x.adicionado_em), ultimo_acesso: null });
  for (const a of lista) {
    const d: any = await env.DB.prepare(`SELECT nome, ultimo_acesso FROM alunos WHERE email = ?`).bind(a.email).first();
    if (d) { a.nome = d.nome ?? null; a.ultimo_acesso = d.ultimo_acesso ?? null; }
  }
  return lista;
}

export function secaoEquipe(o: { admins: Admin[]; eu: string; agora: number; aviso?: string }) {
  return `${o.aviso || ""}
  <div class="card">
    <p class="mono">Equipe do painel</p>
    <p style="margin-top:8px;color:var(--muted);max-width:66ch">Quem está aqui abre o painel, convida alunos, publica provas e vê tudo.
      Entra pelo mesmo caminho do aluno — o link por e-mail em <b>comunidade.comeca.ai</b>.</p>
    <form method="post" action="/admin/equipe/adicionar" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;align-items:center">
      <input class="campo" style="flex:2;min-width:220px" type="email" name="email" required placeholder="e-mail de quem entra na equipe">
      <input class="campo" style="flex:1;min-width:160px" type="text" name="nome" maxlength="80" placeholder="Nome (opcional)">
      <label class="aula-meta" style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" name="convite" value="1" checked> Enviar link de acesso agora</label>
      <button class="btn btn-primario" type="submit">Adicionar à equipe</button>
    </form>
  </div>
  <section class="modulo">
    <div class="modulo-topo"><h2>Administradores</h2><span class="mono">${o.admins.length}</span></div>
    ${o.admins.map((a) => `<div class="aula" style="cursor:default">
      <span class="avatar" style="width:34px;height:34px;font-size:12px;flex:0 0 34px">${esc((a.nome || a.email).slice(0, 2).toUpperCase())}</span>
      <span class="aula-txt"><b>${esc(a.nome || a.email)}</b>${a.nome ? ` <span class="aula-meta">${esc(a.email)}</span>` : ""}
        <span class="aula-meta">${a.fixo ? "fixo (ADMINS no wrangler.jsonc)" : `adicionado em ${dataCurta(a.adicionado_em!)}${a.adicionado_por ? ` por ${esc(a.adicionado_por)}` : ""}`} · último acesso ${haQuanto(a.ultimo_acesso, o.agora)}${a.email === o.eu ? " · você" : ""}</span></span>
      ${!a.fixo && a.email !== o.eu ? `<form method="post" action="/admin/equipe/remover" onsubmit="return confirm(${jsStr(`Tirar ${a.nome || a.email} da equipe? O acesso como aluno continua.`)})">
        <input type="hidden" name="email" value="${esc(a.email)}"><button class="btn btn-fantasma" type="submit">Remover</button></form>` : ""}
    </div>`).join("")}
  </section>`;
}

type Deps = { exigeAdmin: any; agora: () => number };

export function rotasEquipe(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();
  const volta = (c: any, msg: string) => c.redirect(`/admin?equipe=${encodeURIComponent(msg)}#equipe`);

  r.post("/admin/equipe/adicionar", d.exigeAdmin, async (c) => {
    const eu = c.get("aluno");
    const form = await c.req.formData();
    const [email] = emailsDe(String(form.get("email") || ""));
    if (!email) return volta(c, "E-mail inválido.");
    const nome = String(form.get("nome") || "").trim().slice(0, 80) || null;
    const agora = d.agora();
    await garantirTabelaEquipe(c.env);
    if (await ehAdmin(c.env, email)) return volta(c, `${email} já está na equipe.`);
    // cadastro + matrícula (com de acordo do painel), como um convite individual
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO alunos (email, nome, criado_em) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET nome = COALESCE(alunos.nome, excluded.nome)`).bind(email, nome, agora),
      c.env.DB.prepare(`INSERT OR IGNORE INTO matriculas (aluno_id, escola, criada_em, consentiu_em, consentimento) SELECT id, ?, ?, ?, 'painel' FROM alunos WHERE email = ?`).bind(c.env.ESCOLA, agora, agora, email),
      c.env.DB.prepare(`INSERT OR IGNORE INTO administradores (escola, email, adicionado_por, adicionado_em) VALUES (?,?,?,?)`).bind(c.env.ESCOLA, email, eu.email, agora),
    ]);
    let msg = `${email} entrou na equipe.`;
    if (form.get("convite") === "1") {
      try { await enviarLinkMagico(c.env, new URL(c.req.url).origin, email, { validadeSeg: VALIDADE_CONVITE, convite: true }); msg += " Link de acesso enviado (vale 48 h)."; }
      catch { msg += " O e-mail com o link não saiu — reenvie pela ficha."; }
    }
    return volta(c, msg);
  });

  r.post("/admin/equipe/remover", d.exigeAdmin, async (c) => {
    const eu = c.get("aluno");
    const form = await c.req.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (email === String(eu.email).toLowerCase()) return volta(c, "Você não remove a si mesmo.");
    if (adminsFixos(c.env).includes(email)) return volta(c, "Esse admin é fixo no wrangler.jsonc — sai só por deploy.");
    await garantirTabelaEquipe(c.env);
    await c.env.DB.prepare(`DELETE FROM administradores WHERE escola = ? AND email = ?`).bind(c.env.ESCOLA, email).run();
    return volta(c, `${email} saiu da equipe. Continua com acesso de aluno.`);
  });

  return r;
}
