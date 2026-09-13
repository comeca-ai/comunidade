// Leituras em PDF — o admin sobe, o aluno lê dentro da escola.
//
// O arquivo fica no R2 (bucket compartilhado, prefixo artigos/) e só sai pelo
// Worker, com sessão válida. O aluno vê as páginas desenhadas em canvas por
// PDF.js, com o e-mail dele em marca-d'água: não há visualizador nativo, botão
// de download nem URL pública. Isso é dissuasão, não DRM — quem abre a aba de
// rede do navegador ainda consegue os bytes. É o mesmo teto de qualquer
// plataforma de curso; o que muda é que o nome de quem vazou vai junto.

import { Hono } from "hono";
import { ehAdmin as ehAdminEquipe } from "./equipe";
import { pagina, esc } from "./ui";

export type Leitura = {
  id: number; titulo: string; descricao: string | null; modulo: string | null;
  chave: string; paginas: number | null; ordem: number; publicado: number;
  criado_em: number; lido_em?: number | null;
};

type Deps = {
  exigeLogin: any; exigeAdmin: any;
  agora: () => number;
};

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
const TAMANHO_MAX = 25 * 1024 * 1024;

export async function garantirTabelasLeituras(env: any) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS artigos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo    TEXT NOT NULL,
      descricao TEXT,
      modulo    TEXT,
      chave     TEXT NOT NULL,
      paginas   INTEGER,
      ordem     INTEGER NOT NULL DEFAULT 0,
      publicado INTEGER NOT NULL DEFAULT 1,
      criado_em INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS artigos_lidos (
      aluno_id  INTEGER NOT NULL,
      artigo_id INTEGER NOT NULL,
      lido_em   INTEGER NOT NULL,
      PRIMARY KEY (aluno_id, artigo_id)
    )`),
  ]);
}

// Lista para o aluno: só publicadas, com o estado de leitura dele.
// Antes da primeira tabela existir, devolve vazio em vez de quebrar o /app.
export async function leiturasDoAluno(env: any, alunoId: number): Promise<Leitura[]> {
  try {
    const r: any = await env.DB.prepare(
      `SELECT a.*, l.lido_em FROM artigos a
       LEFT JOIN artigos_lidos l ON l.artigo_id = a.id AND l.aluno_id = ?
       WHERE a.publicado = 1
       ORDER BY a.ordem, a.criado_em, a.titulo`
    ).bind(alunoId).all();
    return r.results ?? [];
  } catch { return []; }
}

async function todasLeituras(env: any): Promise<Leitura[]> {
  try {
    const r: any = await env.DB.prepare(
      `SELECT * FROM artigos ORDER BY ordem, criado_em, titulo`).all();
    return r.results ?? [];
  } catch { return []; }
}

// Heurística sem parser: conta objetos /Type /Page e o /Count da raiz.
// PDFs com object streams comprimidos escondem os dois — aí fica null.
export function paginasDoPdf(bytes: ArrayBuffer): number | null {
  const s = new TextDecoder().decode(new Uint8Array(bytes)); // não-fatal por padrão: bytes inválidos viram U+FFFD, os marcadores ASCII sobrevivem
  const objetos = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  let count = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)) count = Math.max(count, Number(m[1]));
  return Math.max(objetos, count) || null;
}

export const minutosDeLeitura = (paginas: number | null) =>
  paginas ? Math.max(2, Math.round(paginas * 2)) : null;

const chaveAleatoria = () =>
  "artigos/" + [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, "0")).join("") + ".pdf";

const metaDe = (l: Leitura) =>
  [l.modulo, l.paginas ? `${l.paginas} página${l.paginas === 1 ? "" : "s"}` : null,
   minutosDeLeitura(l.paginas) ? `~${minutosDeLeitura(l.paginas)} min` : null]
    .filter(Boolean).map((x) => esc(x)).join(" · ");

/* ---------------- trechos de HTML usados pelo index ---------------- */

// seção "Leituras" no /app do aluno
export function secaoLeituras(leituras: Leitura[]): string {
  if (!leituras.length) return "";
  const lidas = leituras.filter((l) => l.lido_em).length;
  return `<section class="modulo" id="leituras">
    <div class="modulo-topo"><h2>Leituras</h2><span class="mono">${lidas} de ${leituras.length}</span></div>
    ${leituras.map((l, i) => `<a class="aula ${l.lido_em ? "feita" : ""}" href="/app/leitura/${l.id}">
      <span class="num-aula">L${i + 1}</span>
      <span class="check">✓</span>
      <span class="aula-txt"><b>${esc(l.titulo)}</b>
        <span class="aula-meta">${metaDe(l) || "PDF"}</span></span>
    </a>`).join("")}
  </section>`;
}

// bloco de administração: upload + lista com publicar/ocultar/excluir
export async function secaoAdminLeituras(env: any, modulos: string[], aviso?: string): Promise<string> {
  const lista = await todasLeituras(env);
  const msgs: Record<string, string> = {
    ok: `<div class="aviso">Leitura publicada.</div>`,
    formato: `<div class="erro">O arquivo não é um PDF.</div>`,
    tamanho: `<div class="erro">PDF acima de 25 MB.</div>`,
    arquivo: `<div class="erro">Escolha um arquivo.</div>`,
    excluida: `<div class="aviso">Leitura excluída.</div>`,
  };
  return `<section class="card" style="margin-top:26px">
    <p class="mono">Leituras em PDF</p>
    ${aviso && msgs[aviso] ? `<div style="margin-top:12px">${msgs[aviso]}</div>` : ""}
    <form method="post" action="/admin/leituras" enctype="multipart/form-data"
          style="display:grid;gap:10px;margin-top:14px">
      <input class="campo" type="text" name="titulo" required maxlength="140" placeholder="Título da leitura">
      <input class="campo" type="text" name="descricao" maxlength="240" placeholder="Uma linha sobre o texto (opcional)">
      <div style="display:flex;flex-wrap:wrap;gap:10px">
        <select class="campo" name="modulo" style="flex:1;min-width:200px">
          <option value="">Leitura geral</option>
          ${modulos.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}
        </select>
        <input class="campo" type="file" name="arquivo" accept="application/pdf,.pdf" required
               style="flex:2;min-width:220px">
        <button class="btn btn-primario" type="submit">Publicar</button>
      </div>
      <p class="aula-meta">Só PDF, até 25 MB. O aluno lê dentro da escola, com o e-mail dele
        em marca-d'água — não há link de download.</p>
    </form>
  </section>

  <section class="modulo">
    <div class="modulo-topo"><h2>Leituras</h2><span class="mono">${lista.length} no acervo</span></div>
    ${lista.map((l) => `
      <div class="aula ${l.publicado ? "feita" : ""}" style="cursor:default">
        <span class="check ${l.publicado ? "" : "oculto"}">✓</span>
        <span class="aula-txt">
          <b>${esc(l.titulo)}</b>
          <span class="aula-meta">${metaDe(l) || "PDF"} · ${l.publicado ? "publicada" : "oculta"}</span>
        </span>
        <span class="acoes">
          <a class="btn btn-fantasma" href="/app/leitura/${l.id}">Ver</a>
          <form method="post" action="/admin/leituras/${l.id}/publicar">
            <button class="btn btn-fantasma" type="submit">${l.publicado ? "Ocultar" : "Publicar"}</button>
          </form>
          <form method="post" action="/admin/leituras/${l.id}/excluir"
                onsubmit="return confirm('Excluir esta leitura? O PDF sai do acervo.')">
            <button class="btn btn-fantasma" type="submit">Excluir</button>
          </form>
        </span>
      </div>`).join("") || `<p class="vazio">Nenhuma leitura ainda.</p>`}
  </section>`;
}

/* ---------------- rotas ---------------- */

export function rotasLeituras(d: Deps) {
  const r = new Hono<{ Bindings: any; Variables: { aluno: any } }>();

  // página de leitura
  r.get("/app/leitura/:id", d.exigeLogin, async (c) => {
    const aluno = c.get("aluno");
    const id = Number(c.req.param("id"));
    const l: any = await c.env.DB.prepare(
      `SELECT a.*, x.lido_em FROM artigos a
       LEFT JOIN artigos_lidos x ON x.artigo_id = a.id AND x.aluno_id = ?
       WHERE a.id = ? AND (a.publicado = 1 OR ? = 1)`
    ).bind(aluno.id, id, (await ehAdmin(c, aluno)) ? 1 : 0).first().catch(() => null);
    if (!l) return c.notFound();

    const corpo = `<main class="wrap" style="padding:32px 24px">
      <a class="mono" href="/app#leituras">← todas as leituras</a>
      <div style="margin:20px 0 18px">
        <p class="mono">Leitura${l.modulo ? ` · ${esc(l.modulo)}` : ""}</p>
        <h1 style="font-size:clamp(24px,4vw,34px);margin-top:10px">${esc(l.titulo)}</h1>
        ${l.descricao ? `<p style="color:var(--muted);margin-top:8px;max-width:64ch">${esc(l.descricao)}</p>` : ""}
        <p class="aula-meta" style="margin-top:6px">${metaDe(l) || "PDF"}</p>
      </div>

      <div class="leitor" id="leitor" data-src="/app/leitura/${l.id}/arquivo" data-marca="${esc(aluno.email)}">
        <div class="leitor-barra">
          <span class="mono" id="leitor-pg">Carregando…</span>
          <span class="leitor-zoom">
            <button type="button" id="leitor-menos" aria-label="Diminuir">−</button>
            <button type="button" id="leitor-mais" aria-label="Aumentar">+</button>
          </span>
        </div>
        <div class="leitor-paginas" id="leitor-paginas"></div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-top:22px">
        <form method="post" action="/app/leitura/${l.id}/lida">
          <button class="btn ${l.lido_em ? "btn-fantasma" : "btn-primario"}" type="submit">
            ${l.lido_em ? "✓ Lida — desmarcar" : "Marcar como lida"}
          </button>
        </form>
        <a class="btn btn-fantasma" href="/app#leituras">Voltar às leituras</a>
      </div>
    </main>
    <script src="${PDFJS}/pdf.min.js"></script>
    <script>${VISOR}</script>`;

    return c.html(pagina({ escola: c.env.NOME_ESCOLA, titulo: l.titulo, aluno, corpo }));
  });

  // o PDF em si — só com sessão, inline, sem cache
  r.get("/app/leitura/:id/arquivo", d.exigeLogin, async (c) => {
    const aluno = c.get("aluno");
    const id = Number(c.req.param("id"));
    const l: any = await c.env.DB.prepare(
      `SELECT chave FROM artigos WHERE id = ? AND (publicado = 1 OR ? = 1)`
    ).bind(id, (await ehAdmin(c, aluno)) ? 1 : 0).first().catch(() => null);
    if (!l) return c.notFound();
    const obj = await c.env.SLIDES.get(l.chave);
    if (!obj) return c.notFound();
    return new Response(obj.body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "inline",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
      },
    });
  });

  r.post("/app/leitura/:id/lida", d.exigeLogin, async (c) => {
    const aluno = c.get("aluno");
    const id = Number(c.req.param("id"));
    const j: any = await c.env.DB.prepare(
      `SELECT lido_em FROM artigos_lidos WHERE aluno_id = ? AND artigo_id = ?`).bind(aluno.id, id).first();
    if (j) {
      await c.env.DB.prepare(`DELETE FROM artigos_lidos WHERE aluno_id = ? AND artigo_id = ?`).bind(aluno.id, id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO artigos_lidos (aluno_id, artigo_id, lido_em) VALUES (?,?,?)`).bind(aluno.id, id, d.agora()).run();
    }
    return c.redirect(`/app/leitura/${id}`);
  });

  // ── administração ──
  r.post("/admin/leituras", d.exigeAdmin, async (c) => {
    await garantirTabelasLeituras(c.env);
    const form = await c.req.formData();
    const titulo = String(form.get("titulo") || "").trim().slice(0, 140);
    const descricao = String(form.get("descricao") || "").trim().slice(0, 240) || null;
    const modulo = String(form.get("modulo") || "").trim() || null;
    const arquivo = form.get("arquivo");
    if (!titulo || !(arquivo instanceof File) || !arquivo.size) return c.redirect("/admin?leitura=arquivo");
    if (arquivo.size > TAMANHO_MAX) return c.redirect("/admin?leitura=tamanho");
    const bytes = await arquivo.arrayBuffer();
    const cabeca = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
    if (cabeca !== "%PDF-") return c.redirect("/admin?leitura=formato");

    const chave = chaveAleatoria();
    await c.env.SLIDES.put(chave, bytes, { httpMetadata: { contentType: "application/pdf" } });
    await c.env.DB.prepare(
      `INSERT INTO artigos (titulo, descricao, modulo, chave, paginas, ordem, publicado, criado_em)
       VALUES (?,?,?,?,?,0,1,?)`
    ).bind(titulo, descricao, modulo, chave, paginasDoPdf(bytes), d.agora()).run();
    return c.redirect("/admin?leitura=ok#leituras");
  });

  r.post("/admin/leituras/:id/publicar", d.exigeAdmin, async (c) => {
    await c.env.DB.prepare(`UPDATE artigos SET publicado = 1 - publicado WHERE id = ?`)
      .bind(Number(c.req.param("id"))).run();
    return c.redirect("/admin#leituras");
  });

  r.post("/admin/leituras/:id/excluir", d.exigeAdmin, async (c) => {
    const id = Number(c.req.param("id"));
    const l: any = await c.env.DB.prepare(`SELECT chave FROM artigos WHERE id = ?`).bind(id).first();
    if (l) {
      await c.env.SLIDES.delete(l.chave).catch(() => {});
      await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM artigos_lidos WHERE artigo_id = ?`).bind(id),
        c.env.DB.prepare(`DELETE FROM artigos WHERE id = ?`).bind(id),
      ]);
    }
    return c.redirect("/admin?leitura=excluida#leituras");
  });

  return r;
}

const ehAdmin = (c: any, aluno: { email: string }) => ehAdminEquipe(c.env, aluno.email);

// ── visualizador: páginas em canvas, marca-d'água, zoom, sem menu de contexto ──
const VISOR = `
(function(){
  var el=document.getElementById("leitor"), cx=document.getElementById("leitor-paginas"),
      pg=document.getElementById("leitor-pg"), src=el.dataset.src, marca=el.dataset.marca;
  var doc=null, escala=1, ratio=Math.min(window.devicePixelRatio||1,2), larguraBase=0, renderizadas={};
  pdfjsLib.GlobalWorkerOptions.workerSrc="${PDFJS}/pdf.worker.min.js";

  function marcaDagua(ctx,w,h){
    ctx.save(); ctx.globalAlpha=.11; ctx.fillStyle="#000";
    ctx.font=(13*ratio)+"px ui-sans-serif,system-ui,sans-serif";
    ctx.translate(w/2,h/2); ctx.rotate(-Math.PI/7);
    var passo=Math.max(220*ratio, ctx.measureText(marca).width+90*ratio);
    for(var y=-h;y<h;y+=110*ratio) for(var x=-w;x<w;x+=passo) ctx.fillText(marca,x,y);
    ctx.restore();
  }
  function desenhar(n,slot){
    if(renderizadas[n]===escala) return; renderizadas[n]=escala;
    doc.getPage(n).then(function(p){
      var vp=p.getViewport({scale:escala*(larguraBase/p.getViewport({scale:1}).width)});
      var cv=slot.querySelector("canvas")||document.createElement("canvas");
      cv.width=Math.floor(vp.width*ratio); cv.height=Math.floor(vp.height*ratio);
      cv.style.width=Math.floor(vp.width)+"px"; cv.style.height=Math.floor(vp.height)+"px";
      cv.draggable=false; slot.style.height="auto"; if(!cv.parentNode) slot.appendChild(cv);
      var ctx=cv.getContext("2d",{alpha:false});
      p.render({canvasContext:ctx,viewport:vp,transform:[ratio,0,0,ratio,0,0]}).promise.then(function(){ marcaDagua(ctx,cv.width,cv.height); });
    });
  }
  function montar(){
    cx.innerHTML=""; renderizadas={};
    larguraBase=Math.min(cx.clientWidth-2, 980);
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting) desenhar(Number(e.target.dataset.n),e.target); }); },{rootMargin:"600px 0px"});
    doc.getPage(1).then(function(p1){
      var v1=p1.getViewport({scale:1}); var alt=Math.round(larguraBase*escala*v1.height/v1.width);
      for(var n=1;n<=doc.numPages;n++){ var s=document.createElement("div"); s.className="pagina-pdf"; s.dataset.n=n; s.style.height=alt+"px"; cx.appendChild(s); io.observe(s); }
      var vis=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting) pg.textContent="Página "+e.target.dataset.n+" de "+doc.numPages; }); },{threshold:.5});
      cx.querySelectorAll(".pagina-pdf").forEach(function(s){ vis.observe(s); });
    });
  }
  document.getElementById("leitor-mais").onclick=function(){ escala=Math.min(2.2,escala+.2); montar(); };
  document.getElementById("leitor-menos").onclick=function(){ escala=Math.max(.6,escala-.2); montar(); };
  var t; window.addEventListener("resize",function(){ clearTimeout(t); t=setTimeout(function(){ if(doc) montar(); },200); });
  cx.addEventListener("contextmenu",function(e){ e.preventDefault(); });
  pdfjsLib.getDocument({url:src,withCredentials:true}).promise.then(function(d){ doc=d; pg.textContent="Página 1 de "+d.numPages; montar(); })
    .catch(function(){ pg.textContent="Não foi possível abrir a leitura."; });
})();`;
