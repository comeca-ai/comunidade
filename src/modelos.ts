// Modelos externos por API compatível com OpenAI (hoje: Model Studio da
// Alibaba, workspace da começa.ai — mas serve qualquer endpoint no formato
// /chat/completions + /embeddings). Dois usos:
//
//   · busca por significado nas transcrições: cada parágrafo vira um vetor
//     (MODELO_EMBED); a pergunta da equipe vira outro; quem está mais perto
//     entra como candidato a corte. "já deu de hype" acha "modinha",
//     "promessa", "entrega" — coisa que a busca por palavra não acha;
//   · escolha do corte (MODELO_CORTES), no lugar do Workers AI quando existe
//     a chave. Kimi K3 escolhe melhor, mas pensa 3 min; qwen3.8-max responde
//     em ~10 s e cabe no clique do painel.
//
// Configuração: var MODELOS_BASE (…/compatible-mode/v1), segredo
// MODELOS_API_KEY, vars MODELO_CORTES e MODELO_EMBED. Sem a chave, tudo cai no
// caminho anterior (palavras-chave + Workers AI). Vetores ficam no R2 em
// vetores/<uid>.bin (Float32, DIM por parágrafo) com a tabela `vetores` de
// controle; o cron e a primeira busca completam o que falta.

export const DIM = 1024;
const LOTE_EMBED = 10;          // máximo de textos por chamada de embeddings no Model Studio
const PARALELO_EMBED = 4;

export const temModelos = (env: any) => !!(env.MODELOS_API_KEY && env.MODELOS_BASE);
export const modeloCortes = (env: any) => String(env.MODELO_CORTES || "qwen3.8-max");
const modeloEmbed = (env: any) => String(env.MODELO_EMBED || "text-embedding-v4");

async function chamar(env: any, caminho: string, corpo: any): Promise<any> {
  const r = await fetch(`${String(env.MODELOS_BASE).replace(/\/$/, "")}${caminho}`, {
    method: "POST", body: JSON.stringify(corpo),
    headers: { authorization: `Bearer ${env.MODELOS_API_KEY}`, "content-type": "application/json" },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`modelos ${caminho}: ${r.status} ${String(j?.error?.message ?? "").slice(0, 200)}`);
  return j;
}

// resposta de texto do modelo escolhido. Sem `raciocinio`, o pensamento é
// desligado onde dá (qwen aceita enable_thinking; kimi não aceita
// temperature). Com `raciocinio`, o modelo pensa à vontade (Kimi K3 leva uns
// 3 min) e a resposta vem em stream para nenhuma conexão ficar 3 min muda.
export async function conversar(env: any, o: { sistema: string; usuario: string; maxTokens?: number; modelo?: string; raciocinio?: boolean; aoReceber?: (trecho: string) => void }): Promise<string> {
  const modelo = o.modelo || modeloCortes(env);
  const corpo: any = { model: modelo, messages: [{ role: "system", content: o.sistema }, { role: "user", content: o.usuario }], max_tokens: o.maxTokens ?? 1600 };
  if (!/^kimi/i.test(modelo)) corpo.temperature = 0.3;
  if (!o.raciocinio) {
    if (/^qwen/i.test(modelo)) corpo.enable_thinking = false;
    if (/^kimi/i.test(modelo)) corpo.enable_thinking = false;
    const j = await chamar(env, "/chat/completions", corpo);
    return String(j?.choices?.[0]?.message?.content ?? "");
  }
  corpo.stream = true;
  const r = await fetch(`${String(env.MODELOS_BASE).replace(/\/$/, "")}/chat/completions`, {
    method: "POST", body: JSON.stringify(corpo),
    headers: { authorization: `Bearer ${env.MODELOS_API_KEY}`, "content-type": "application/json" },
  });
  if (!r.ok || !r.body) throw new Error(`modelos /chat/completions: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  // SSE: "data: {json}" por linha; o conteúdo final vem em choices[0].delta.content
  const leitor = r.body.getReader(), dec = new TextDecoder();
  let resto = "", texto = "";
  for (;;) {
    const { value, done } = await leitor.read();
    if (done) break;
    resto += dec.decode(value, { stream: true });
    const linhas = resto.split("\n"); resto = linhas.pop() ?? "";
    for (const l of linhas) {
      const m = l.match(/^data:\s*(.+)$/); if (!m || m[1] === "[DONE]") continue;
      try {
        const d = JSON.parse(m[1]);
        if (d?.error) throw new Error(String(d.error.message ?? "erro do modelo"));
        const parte = d?.choices?.[0]?.delta?.content;
        if (parte) { texto += parte; o.aoReceber?.(parte); }
      } catch (e: any) { if (/erro do modelo|modelos/.test(String(e?.message))) throw e; /* linha parcial: ignora */ }
    }
  }
  return texto;
}

export async function embutir(env: any, textos: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(textos.length);
  const lotes: number[] = []; for (let i = 0; i < textos.length; i += LOTE_EMBED) lotes.push(i);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(PARALELO_EMBED, lotes.length) }, async () => {
    while (k < lotes.length) {
      const i = lotes[k++];
      const fatia = textos.slice(i, i + LOTE_EMBED).map((t) => t.slice(0, 2000));
      const j = await chamar(env, "/embeddings", { model: modeloEmbed(env), input: fatia, dimensions: DIM });
      for (const d of j.data ?? []) out[i + Number(d.index)] = Float32Array.from(d.embedding);
    }
  }));
  return out;
}

/* ---------------- índice de vetores das transcrições ---------------- */

const chaveR2 = (uid: string) => `vetores/${uid}.bin`;

export async function garantirTabelaVetores(env: any) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vetores (
    aula_uid TEXT PRIMARY KEY, n INTEGER NOT NULL, modelo TEXT NOT NULL, criado_em INTEGER NOT NULL)`).run();
}

// aulas transcritas cujo índice falta ou ficou com outro número de parágrafos
// (transcrição refeita) ganham vetores. Orçamento por chamada em parágrafos
// (cada 10 = uma chamada à API; o Worker tem limite de subpedidos por
// execução), então o índice completa em poucas passadas do cron ou do painel.
export async function avancarVetores(env: any, agora: number, orcamento = 300): Promise<string[]> {
  const feito: string[] = [];
  if (!temModelos(env)) return feito;
  await garantirTabelaVetores(env);
  const r: any = await env.DB.prepare(
    `SELECT t.aula_uid AS uid, (SELECT COUNT(*) FROM trechos x WHERE x.aula_uid = t.aula_uid) AS n, v.n AS vn, v.modelo
     FROM transcricoes t LEFT JOIN vetores v ON v.aula_uid = t.aula_uid
     WHERE t.estado = 'pronto' AND (v.aula_uid IS NULL OR v.n <> (SELECT COUNT(*) FROM trechos x WHERE x.aula_uid = t.aula_uid) OR v.modelo <> ?)
     ORDER BY n LIMIT 40`).bind(modeloEmbed(env)).all();
  let gasto = 0;
  for (const a of (r.results ?? [])) {
    if (gasto > 0 && gasto + Number(a.n) > orcamento) break;
    gasto += Number(a.n);
    try {
      const tr: any = await env.DB.prepare(`SELECT n, texto FROM trechos WHERE aula_uid = ? ORDER BY n`).bind(a.uid).all();
      const linhas: any[] = tr.results ?? [];
      const vetores = await embutir(env, linhas.map((l) => String(l.texto)));
      const bin = new Float32Array(linhas.length * DIM);
      linhas.forEach((_, i) => bin.set(vetores[i] ?? new Float32Array(DIM), i * DIM));
      await env.SLIDES.put(chaveR2(a.uid), bin.buffer, { httpMetadata: { contentType: "application/octet-stream" } });
      await env.DB.prepare(`INSERT INTO vetores (aula_uid, n, modelo, criado_em) VALUES (?,?,?,?)
        ON CONFLICT(aula_uid) DO UPDATE SET n=excluded.n, modelo=excluded.modelo, criado_em=excluded.criado_em`).bind(a.uid, linhas.length, modeloEmbed(env), agora).run();
      cacheVetores.delete(a.uid);
      feito.push(`${a.uid}: ${linhas.length} parágrafos`);
    } catch (e: any) { feito.push(`${a.uid}: erro ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  return feito;
}

// vetores de uma aula (cache por isolate; 3–4 MB no total para 26 aulas)
const cacheVetores = new Map<string, Float32Array | null>();
async function vetoresDe(env: any, uid: string): Promise<Float32Array | null> {
  if (cacheVetores.has(uid)) return cacheVetores.get(uid)!;
  let v: Float32Array | null = null;
  try {
    const obj = await env.SLIDES.get(chaveR2(uid));
    if (obj) { const buf = await obj.arrayBuffer(); if (buf.byteLength % (DIM * 4) === 0) v = new Float32Array(buf); }
  } catch { v = null; }
  cacheVetores.set(uid, v);
  return v;
}

export type Parecido = { uid: string; n: number; sim: number };

// parágrafos mais parecidos com a pergunta, em todas as aulas indexadas
// (cosseno; os vetores do Model Studio já vêm normalizados, mas normalizamos
// por garantia). Devolve vazio se não há índice ou a API falhou.
export async function parecidos(env: any, pergunta: string, limite = 24): Promise<Parecido[]> {
  if (!temModelos(env)) return [];
  const [q] = await embutir(env, [pergunta]);
  if (!q) return [];
  let nq = 0; for (let i = 0; i < DIM; i++) nq += q[i] * q[i]; nq = Math.sqrt(nq) || 1;
  const r: any = await env.DB.prepare(`SELECT aula_uid AS uid, n FROM vetores`).all();
  const out: Parecido[] = [];
  for (const a of (r.results ?? [])) {
    const v = await vetoresDe(env, a.uid);
    if (!v) continue;
    const n = Math.min(Number(a.n), v.length / DIM);
    for (let p = 0; p < n; p++) {
      let s = 0, nv = 0;
      const base = p * DIM;
      for (let i = 0; i < DIM; i++) { const x = v[base + i]; s += x * q[i]; nv += x * x; }
      out.push({ uid: a.uid, n: p, sim: s / ((Math.sqrt(nv) || 1) * nq) });
    }
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limite);
}
