// Transcrição de aula: formato compacto usado pelo Worker (busca, cortes,
// legendas) e pelo script local tools/transcrever.mjs. A fonte é a resposta
// da API pré-gravada do Deepgram (nova-3, pt-BR, diarize + paragraphs,
// sem smart_format); guardamos só o que é usado, com tempo por frase e por
// palavra, para o corte cair na fronteira certa e a legenda sincronizar.

export type Palavra = [texto: string, inicio: number, fim: number];
export type Frase = { t: string; i: number; f: number };
export type Paragrafo = { i: number; f: number; q: number | null; frases: Frase[]; p: Palavra[] };
export type Transcricao = {
  uid: string; modelo: string; idioma: string; duracao: number; falantes: number;
  criada_em: number; paragrafos: Paragrafo[];
};

// nomes e marcas que o modelo tende a errar — vão como keyterm para o Deepgram
export const KEYTERMS = ["Jhonata Emerick", "Datarisk", "ABRIA", "começa.ai", "Neomaril", "Sebrae", "João Pessoa", "iFood"];

const arred = (n: number) => Math.round(n * 100) / 100;

// Resposta do Deepgram (v1/listen) → Transcricao. Aceita a resposta inteira
// ou só o objeto results. Sem paragraphs (parâmetro desligado), cai em
// parágrafos artificiais de ~40 s a partir das palavras.
export function compactar(uid: string, resposta: any, criadaEm: number): Transcricao {
  const results = resposta?.results ?? resposta;
  const alt = results?.channels?.[0]?.alternatives?.[0];
  if (!alt) throw new Error("resposta do Deepgram sem alternatives");
  const palavras: any[] = alt.words ?? [];
  const modelo = String(resposta?.metadata?.model_info
    ? Object.values(resposta.metadata.model_info as Record<string, any>)[0]?.name ?? "deepgram" : resposta?.metadata?.models?.[0] ?? "deepgram");
  const idioma = String(alt.languages?.[0] ?? resposta?.metadata?.detected_language ?? "pt-BR");
  const duracao = arred(Number(resposta?.metadata?.duration ?? palavras.at(-1)?.end ?? 0));

  const brutos: any[] = alt.paragraphs?.paragraphs ?? [];
  const paragrafos: Paragrafo[] = brutos.length
    ? brutos.map((p) => ({
        i: arred(p.start), f: arred(p.end), q: typeof p.speaker === "number" ? p.speaker : null,
        frases: (p.sentences ?? []).map((s: any) => ({ t: String(s.text).trim(), i: arred(s.start), f: arred(s.end) })),
        p: [],
      }))
    : fatiar(palavras);

  // palavras entram no parágrafo em que caem (por tempo de início)
  let k = 0;
  for (const w of palavras) {
    while (k < paragrafos.length - 1 && w.start >= paragrafos[k + 1].i) k++;
    paragrafos[k].p.push([String(w.punctuated_word ?? w.word), arred(w.start), arred(w.end)]);
  }
  const falantes = new Set(palavras.map((w) => w.speaker).filter((s) => typeof s === "number")).size;
  return { uid, modelo, idioma, duracao, falantes, criada_em: criadaEm, paragrafos };
}

function fatiar(palavras: any[]): Paragrafo[] {
  const out: Paragrafo[] = [];
  let atual: Paragrafo | null = null;
  for (const w of palavras) {
    if (!atual || w.start - atual.i > 40) {
      atual = { i: arred(w.start), f: arred(w.end), q: typeof w.speaker === "number" ? w.speaker : null, frases: [], p: [] };
      out.push(atual);
    }
    atual.f = arred(w.end);
  }
  for (const p of out) p.frases = [{ t: "", i: p.i, f: p.f }];
  return out.map((p) => ({ ...p }));
}

// texto corrido de um parágrafo — as frases, ou as palavras se não houver
export const textoDo = (p: Paragrafo) =>
  p.frases.map((s) => s.t).filter(Boolean).join(" ") || p.p.map((w) => w[0]).join(" ");

// "3:07" ou "1:02:07"
export function tempo(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

// WebVTT para o player — uma legenda por frase, quebrada em linhas curtas
export function paraVtt(t: Transcricao): string {
  const ts = (seg: number) => {
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  };
  const linhas = ["WEBVTT", ""];
  let n = 0;
  for (const p of t.paragrafos) {
    const frases = p.frases.some((s) => s.t) ? p.frases : [{ t: textoDo(p), i: p.i, f: p.f }];
    for (const s of frases) {
      if (!s.t) continue;
      // frases longas viram legendas de até ~8 s usando o tempo das palavras
      const partes = quebrar(s, p.p);
      for (const q of partes) linhas.push(String(++n), `${ts(q.i)} --> ${ts(q.f)}`, q.t, "");
    }
  }
  return linhas.join("\n");
}

function quebrar(s: Frase, palavras: Palavra[]): Frase[] {
  const dentro = palavras.filter((w) => w[1] >= s.i - 0.05 && w[2] <= s.f + 0.05);
  if (s.f - s.i <= 8 || dentro.length < 4) return [s];
  const partes: Frase[] = [];
  let bloco: Palavra[] = [];
  for (const w of dentro) {
    bloco.push(w);
    const dur = w[2] - bloco[0][1];
    if (dur >= 6 && bloco.length >= 4) { partes.push({ t: bloco.map((x) => x[0]).join(" "), i: bloco[0][1], f: w[2] }); bloco = []; }
  }
  if (bloco.length) partes.push({ t: bloco.map((x) => x[0]).join(" "), i: bloco[0][1], f: bloco.at(-1)![2] });
  return partes;
}
