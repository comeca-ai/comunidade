#!/usr/bin/env node
// Corta um trecho de uma aula do Stream em vídeo para redes, de qualquer
// máquina com ffmpeg (Mac, CI, sandbox). Baixa só os segmentos HLS públicos do
// intervalo — não precisa de token do Stream — e gera:
//   · vertical 1080×1920 (Reels, TikTok, Shorts): o vídeo no meio sobre o próprio
//     vídeo desfocado (ou fundo escuro da marca), título em cima, legenda palavra
//     a palavra com a palavra falada em verde-lima, voz limpa e nivelada;
//   · LinkedIn 1080×1350 (4:5): mesma composição sem barra de título — o texto
//     do post faz esse papel; legenda embaixo;
//   · horizontal 1280×720 limpo (YouTube, site), com o SRT ao lado;
//   · o texto do post (.txt), quando veio do painel.
//
//   node tools/cortar.mjs --uid <uid> --inicio 2381.04 --fim 2415.61 [--titulo "..."]
//   node tools/cortar.mjs --fila https://comunidade.comeca.ai --chave "$CORTES_CHAVE"
//
// No modo --fila o script pega no Worker os cortes aprovados, gera e devolve os
// arquivos (é o que .github/workflows/cortes.yml roda: ao aprovar, se o Worker
// tem GH_TOKEN_CORTES, e de hora em hora). No modo manual a legenda vem de
// transcricoes/<uid>.json, se existir.
//
// Opções: --saida <pasta> (padrão ./cortes) · --formato todos|vertical|horizontal|linkedin
//         --enquadramento cheio|4x3 (4x3 corta as laterais: pessoa maior, bom em
//         entrevista; cheio preserva slides) · --fundo desfoque|escuro
//         --sem-legenda · --rodape "texto pequeno no pé do vertical"

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONTES = join(RAIZ, "tools/fontes");
const SUBDOMINIO = process.env.STREAM_SUBDOMINIO || "customer-0b8qbusp05k8f01y.cloudflarestream.com";
const MARCA = { fundo: "0E0E0D", lima: "&H005AF5C8", branco: "&H00FFFFFF", cinza: "&H00A6A6A6" }; // ASS usa &HAABBGGRR

/* ---------------- argumentos ---------------- */

const args = process.argv.slice(2);
const opcao = (nome, padrao = "") => { const i = args.indexOf(nome); return i > -1 && args[i + 1] != null ? args[i + 1] : padrao; };
const tem = (nome) => args.includes(nome);
const saida = opcao("--saida", join(process.cwd(), "cortes"));
const formato = opcao("--formato", "todos");                // todos | vertical | horizontal | linkedin
const semLegenda = tem("--sem-legenda");
const rodape = opcao("--rodape", "");
const enquadramento = opcao("--enquadramento", "cheio");   // cheio | 4x3
const fundoVertical = opcao("--fundo", "desfoque");        // desfoque | escuro
const FOLGA_ANTES = 0.2, FOLGA_DEPOIS = 0.35;              // segundos de respiro nas pontas do corte
mkdirSync(saida, { recursive: true });

/* ---------------- modo fila: Worker → arquivos → Worker ---------------- */

async function modoFila(origem, chave) {
  if (!chave) { console.error("sem CORTES_CHAVE"); process.exit(1); }
  const cab = { authorization: `Bearer ${chave}` };
  const r = await fetch(`${origem}/cortes/fila`, { method: "POST", headers: cab });
  if (!r.ok) { console.error(`fila: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  const { cortes } = await r.json();
  if (!cortes?.length) { console.log("fila vazia"); return; }
  console.log(`${cortes.length} corte(s) na fila`);
  for (const c of cortes) {
    const devolver = async (params, corpo, tipo) => {
      const q = new URLSearchParams({ id: String(c.id), ...params });
      const resp = await fetch(`${origem}/cortes/retorno?${q}`, { method: "POST", headers: { ...cab, ...(tipo ? { "content-type": tipo } : {}) }, body: corpo });
      if (!resp.ok) throw new Error(`retorno ${q}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    };
    try {
      const arquivos = await cortar({ ...c, palavras: semLegenda ? [] : (c.palavras ?? []) });
      if (arquivos.horizontal) await devolver({ formato: "horizontal" }, readFileSync(arquivos.horizontal), "video/mp4");
      if (arquivos.linkedin) await devolver({ formato: "linkedin" }, readFileSync(arquivos.linkedin), "video/mp4");
      if (arquivos.srt) await devolver({ formato: "srt" }, readFileSync(arquivos.srt), "application/x-subrip");
      // o vertical por último: é ele que marca o corte como pronto
      if (arquivos.vertical) await devolver({ formato: "vertical" }, readFileSync(arquivos.vertical), "video/mp4");
      console.log(`corte ${c.id} devolvido`);
    } catch (e) {
      console.error(`corte ${c.id} falhou: ${e.message}`);
      await devolver({ erro: String(e.message).slice(0, 300) }, null).catch(() => {});
    }
  }
}

/* ---------------- corte ---------------- */

// c: { id, uid, inicio, fim, titulo, legenda, enquadramento?, palavras: [[texto, inicio, fim], ...] }
async function cortar(c) {
  // folga: a frase começa exatamente no primeiro fonema; sem respiro o corte
  // engole o ataque da palavra e termina seco
  const inicio = Math.max(0, c.inicio - FOLGA_ANTES), fim = c.fim + FOLGA_DEPOIS, dur = fim - inicio;
  const base = join(saida, `corte-${c.id}-${slug(c.titulo) || c.uid.slice(0, 8)}`);
  const tmp = join(saida, `.tmp-${c.id}`); mkdirSync(tmp, { recursive: true });
  console.log(`▸ ${c.titulo || c.uid} · ${hms(c.inicio)}–${hms(c.fim)} · ${dur.toFixed(1)} s`);

  const { video, audio } = await faixas(c.uid);
  const vid = await baixarTrecho(await playlist(video.url), inicio, fim, join(tmp, "video.mp4"));
  const aud = audio ? await baixarTrecho(await playlist(audio.url), inicio, fim, join(tmp, "audio.mp4")) : null;
  const entradas = ["-ss", (inicio - vid.comeco).toFixed(3), "-i", vid.arquivo];
  if (aud) entradas.push("-ss", (inicio - aud.comeco).toFixed(3), "-i", aud.arquivo);
  const mapaAudio = aud ? ["-map", "1:a:0"] : ["-map", "0:a:0?"];
  const som = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-af", await filtroDeVoz(entradas, aud ? 1 : 0, dur)];
  const h264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart"];
  const out = {};

  if (c.palavras?.length) { out.srt = `${base}.srt`; writeFileSync(out.srt, srt(c.palavras, inicio)); }
  if (c.legenda) { out.txt = `${base}.txt`; writeFileSync(out.txt, c.legenda.trim() + "\n"); }

  const quer = (f) => formato === "todos" || formato === "ambos" || formato === f;
  if (quer("horizontal")) {
    out.horizontal = `${base}-horizontal.mp4`;
    await ffmpeg([...entradas, "-t", dur.toFixed(3), "-map", "0:v:0", ...mapaAudio, ...h264, ...som, out.horizontal]);
  }
  // enquadramento: "cheio" mantém o quadro 16:9 inteiro (aulas com slide);
  // "4x3" corta as laterais e mostra a pessoa maior (entrevista, bancada)
  const larguraFonte = video.largura || 1280, alturaFonte = video.altura || 720;
  const modo = tem("--enquadramento") ? enquadramento : (c.enquadramento || enquadramento);
  const recorte = modo === "4x3" ? Math.min(larguraFonte, Math.round((alturaFonte * 4) / 3 / 2) * 2) : larguraFonte;
  const altura = Math.round((1080 * alturaFonte) / recorte / 2) * 2;

  // composição em pé: o vídeo sobre ele mesmo desfocado (ou fundo escuro), legenda
  // embaixo; o vertical (9:16, Reels/TikTok/Shorts) leva título em cima; o
  // LinkedIn (4:5) vai sem título — o texto do post já faz esse papel
  const compor = async (nome, largura, alturaQuadro, comTitulo) => {
    const arquivo = `${base}-${nome}.mp4`;
    const topo = comTitulo ? Math.max(300, Math.round((alturaQuadro - altura) / 2) - 136) : Math.max(40, Math.round((alturaQuadro - altura) / 2) - 70);
    const ass = join(tmp, `legenda-${nome}.ass`);
    writeFileSync(ass, assComposicao({ largura, alturaQuadro, titulo: comTitulo ? c.titulo : "", palavras: c.palavras ?? [], inicio, dur, rodape, topo, altura }));
    const fundo = fundoVertical === "escuro"
      ? [`color=c=0x${MARCA.fundo}:s=${largura}x${alturaQuadro}:r=30[fundo]`, `[0:v]null[aula0]`]
      : [`[0:v]split[aula0][fx]`, `[fx]scale=${largura}:${alturaQuadro}:force_original_aspect_ratio=increase,crop=${largura}:${alturaQuadro},gblur=sigma=28,eq=brightness=-0.28:saturation=0.75[fundo]`];
    const filtro = [
      ...fundo,
      `[aula0]crop=${recorte}:${alturaFonte}:(iw-${recorte})/2:0,scale=${largura}:-2:flags=lanczos,unsharp=5:5:0.45:5:5:0[aula]`,
      `[fundo][aula]overlay=0:${topo}:shortest=1[cena]`,
      `[cena]ass=${escapaFiltro(ass)}:fontsdir=${escapaFiltro(FONTES)}[v]`,
    ].join(";");
    await ffmpeg([...entradas, "-t", dur.toFixed(3), "-filter_complex", filtro, "-map", "[v]", ...mapaAudio, ...h264, ...som, arquivo]);
    return arquivo;
  };
  if (quer("vertical")) out.vertical = await compor("vertical", 1080, 1920, true);
  if (quer("linkedin")) out.linkedin = await compor("linkedin", 1080, 1350, false);
  return out;
}

/* ---------------- som ---------------- */

// voz de vídeo de aula/entrevista: tira o grave de ambiente, um pouco de
// ruído de sala, e nivela em duas passagens (mede, depois aplica ganho fixo —
// a passagem única do loudnorm "respira", subindo e descendo o volume)
async function filtroDeVoz(entradas, indiceAudio, dur) {
  const limpeza = "highpass=f=80,afftdn=nr=10:nf=-32";
  const alvo = "I=-16:TP=-1.5:LRA=11";
  let medido = null;
  try {
    const log = await saidaErro("ffmpeg", ["-hide_banner", "-nostats", ...entradas, "-t", dur.toFixed(3), "-map", `${indiceAudio}:a:0`,
      "-af", `${limpeza},loudnorm=${alvo}:print_format=json`, "-f", "null", "-"]);
    const m = log.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
    if (m) medido = JSON.parse(m[0]);
  } catch {}
  if (!medido || !Number.isFinite(Number(medido.input_i)) || Number(medido.input_i) < -70) return `${limpeza},loudnorm=${alvo}`;
  return `${limpeza},loudnorm=${alvo}:measured_I=${medido.input_i}:measured_TP=${medido.input_tp}:measured_LRA=${medido.input_lra}:measured_thresh=${medido.input_thresh}:offset=${medido.target_offset}:linear=true`;
}

/* ---------------- HLS público do Stream ---------------- */

async function texto(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} em ${url}`); return r.text(); }
const atributos = (linha) => Object.fromEntries([...linha.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)].map((m) => [m[1], m[3] ?? m[2]]));

// maior rendição de vídeo + faixa de áudio padrão do master
async function faixas(uid) {
  const master = `https://${SUBDOMINIO}/${uid}/manifest/video.m3u8`;
  const linhas = (await texto(master)).split(/\r?\n/);
  let video = null, audio = null;
  linhas.forEach((l, i) => {
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      const a = atributos(l.slice(l.indexOf(":") + 1)), larg = Number((a.RESOLUTION || "0x0").split("x")[0]);
      const alt = Number((a.RESOLUTION || "0x0").split("x")[1]);
      if (!video || larg > video.largura) video = { largura: larg, altura: alt, url: new URL(linhas[i + 1], master).href };
    } else if (l.startsWith("#EXT-X-MEDIA") && l.includes("TYPE=AUDIO")) {
      const a = atributos(l.slice(l.indexOf(":") + 1));
      if (a.URI && (!audio || a.DEFAULT === "YES")) audio = { url: new URL(a.URI, master).href };
    }
  });
  if (!video) throw new Error("master sem rendição de vídeo");
  return { video, audio };
}

// playlist de mídia → segmento inicial (init) e segmentos com início acumulado
async function playlist(url) {
  const linhas = (await texto(url)).split(/\r?\n/);
  let init = null, dur = null, acumulado = 0; const segs = [];
  for (const l of linhas) {
    if (l.startsWith("#EXT-X-MAP")) init = new URL(atributos(l.slice(l.indexOf(":") + 1)).URI, url).href;
    else if (l.startsWith("#EXTINF")) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith("#") && dur != null) { segs.push({ inicio: acumulado, dur, url: new URL(l, url).href }); acumulado += dur; dur = null; }
  }
  if (!init || !segs.length) throw new Error("playlist sem init/segmentos");
  return { init, segs };
}

// baixa init + segmentos que cobrem [inicio, fim] e cola num fMP4 local;
// devolve o instante real em que o arquivo começa (para o -ss do ffmpeg)
async function baixarTrecho(pl, inicio, fim, arquivo) {
  const escolhidos = pl.segs.filter((s) => s.inicio + s.dur > inicio - 0.25 && s.inicio < fim + 0.25);
  if (!escolhidos.length) throw new Error("intervalo fora do vídeo");
  const partes = await emParalelo([pl.init, ...escolhidos.map((s) => s.url)], 6, async (u) => {
    const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} em segmento`); return Buffer.from(await r.arrayBuffer());
  });
  writeFileSync(arquivo, Buffer.concat(partes));
  const sonda = await saidaDe("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", arquivo]);
  const comeco = Number.parseFloat(sonda);
  return { arquivo, comeco: Number.isFinite(comeco) ? comeco : escolhidos[0].inicio };
}

/* ---------------- legendas ---------------- */

// blocos de até 4 palavras / 26 letras, quebrando em pontuação e pausas
function blocos(palavras, inicio, fim) {
  const dentro = palavras.filter((w) => w[1] >= inicio - 0.05 && w[2] <= fim + 0.05)
    // gagueira ("um um,", "não não") vira uma palavra só, ficando com o tempo das duas
    .reduce((acc, w) => { const ant = acc.at(-1); if (ant && limpo(ant[0]) === limpo(w[0])) acc[acc.length - 1] = [w[0], ant[1], w[2]]; else acc.push([...w]); return acc; }, []);
  const out = []; let atual = [];
  const fecha = () => { if (atual.length) out.push(atual); atual = []; };
  for (const w of dentro) {
    const letras = atual.reduce((s, x) => s + x[0].length + 1, 0) + w[0].length;
    if (atual.length && (atual.length >= 5 || letras > 28 || w[1] - atual.at(-1)[2] > 0.7)) fecha();
    atual.push(w);
    if (/[.!?]$/.test(w[0])) fecha();
  }
  fecha();
  return out;
}
const limpo = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function srt(palavras, inicio) {
  const ts = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${p2(h)}:${p2(m)}:${p2(Math.floor(r))},${String(Math.round((r % 1) * 1000)).padStart(3, "0")}`; };
  const bs = blocos(palavras, inicio, Infinity);
  return bs.map((b, i) => `${i + 1}\n${ts(b[0][1] - inicio)} --> ${ts(b.at(-1)[2] - inicio)}\n${b.map((w) => w[0]).join(" ")}\n`).join("\n");
}

// ASS do vertical: título fixo em cima, legenda embaixo do vídeo com a palavra
// falada em verde-lima (uma linha de diálogo por palavra), rodapé opcional
function assComposicao({ largura, alturaQuadro, titulo, palavras, inicio, dur, rodape, topo, altura }) {
  const t = (s) => { s = Math.max(0, Math.min(dur, s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${h}:${p2(m)}:${p2(Math.floor(r))}.${String(Math.round((r % 1) * 100)).padStart(2, "0")}`; };
  const limpa = (s) => String(s).replace(/[{}\\]/g, "").replace(/\r?\n/g, "\\N");
  const linhas = [];
  if (titulo) linhas.push(`Dialogue: 0,${t(0)},${t(dur)},Titulo,,0,0,0,,${limpa(quebraTitulo(titulo))}`);
  if (rodape) linhas.push(`Dialogue: 0,${t(0)},${t(dur)},Rodape,,0,0,0,,${limpa(rodape)}`);
  const bs = blocos(palavras, inicio, inicio + dur);
  bs.forEach((b, i) => {
    const fimBloco = Math.min(bs[i + 1]?.[0][1] ?? Infinity, b.at(-1)[2] + 0.35) - inicio;
    b.forEach((w, k) => {
      const ini = (k === 0 ? b[0][1] : w[1]) - inicio, fim = k === b.length - 1 ? fimBloco : b[k + 1][1] - inicio;
      if (fim <= ini) return;
      const texto = b.map((x, j) => j === k ? `{\\c${MARCA.lima}}${limpa(x[0])}{\\c${MARCA.branco}}` : limpa(x[0])).join(" ");
      linhas.push(`Dialogue: 0,${t(ini)},${t(fim)},Legenda,,0,0,0,,${texto}`);
    });
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${largura}
PlayResY: ${alturaQuadro}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Titulo,IBM Plex Sans,66,${MARCA.branco},${MARCA.lima},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,90,90,${alturaQuadro - topo + 60},1
Style: Legenda,IBM Plex Sans,${alturaQuadro >= 1600 ? 74 : 62},${MARCA.branco},${MARCA.lima},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,70,70,${topo + altura + (alturaQuadro >= 1600 ? 80 : 44)},1
Style: Rodape,IBM Plex Sans,36,${MARCA.cinza},${MARCA.lima},&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,2,90,90,${alturaQuadro >= 1600 ? 120 : 40},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${linhas.join("\n")}
`;
}

// título em até 2 linhas equilibradas (o ASS quebra sozinho, mas fica torto)
function quebraTitulo(titulo) {
  const s = String(titulo).trim();
  if (s.length <= 26) return s;
  // 1ª opção: quebrar depois de vírgula, dois-pontos ou travessão, se as metades ficarem parecidas
  const pont = [...s.matchAll(/[,:;—–-]\s+/g)].map((m) => m.index + m[0].length)
    .map((i) => ({ a: s.slice(0, i).trim(), b: s.slice(i).trim() })).filter(({ a, b }) => a && b && Math.max(a.length, b.length) / Math.min(a.length, b.length) <= 1.8);
  if (pont.length) return `${pont[0].a}\n${pont[0].b}`;
  const palavras = s.split(/\s+/); let melhor = null;
  for (let i = 1; i < palavras.length; i++) {
    const a = palavras.slice(0, i).join(" "), b = palavras.slice(i).join(" ");
    const dif = Math.abs(a.length - b.length);
    if (!melhor || dif < melhor.dif) melhor = { dif, texto: `${a}\n${b}` };
  }
  return melhor?.texto ?? s;
}

/* ---------------- apoio ---------------- */

function palavrasLocais(uid, inicio, fim) {
  const arq = join(RAIZ, "transcricoes", `${uid}.json`);
  if (!existsSync(arq)) { console.log("(sem transcrição local — vídeo sai sem legenda)"); return []; }
  const t = JSON.parse(readFileSync(arq, "utf8"));
  return t.paragrafos.flatMap((p) => p.p).filter((w) => w[1] >= inicio - 0.05 && w[2] <= fim + 0.05);
}

async function emParalelo(itens, limite, fn) {
  const out = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) { const k = i++; out[k] = await fn(itens[k]); }
  }));
  return out;
}

const p2 = (n) => String(n).padStart(2, "0");
const hms = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`; };
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
// vírgula, dois-pontos e barras invertidas têm significado na sintaxe de filtros
const escapaFiltro = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\\'");

function ffmpeg(argv) {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg saiu com ${c}`))));
    p.on("error", rej);
  });
}
// stderr de um comando (o ffmpeg imprime as medições do loudnorm ali)
function saidaErro(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] }); let s = "";
    p.stderr.on("data", (d) => (s += d)); p.on("exit", (c) => (c === 0 ? res(s) : rej(new Error(`${cmd} saiu com ${c}`)))); p.on("error", rej);
  });
}
function saidaDe(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "inherit"] }); let s = "";
    p.stdout.on("data", (d) => (s += d)); p.on("exit", (c) => (c === 0 ? res(s.trim()) : rej(new Error(`${cmd} saiu com ${c}`)))); p.on("error", rej);
  });
}
function existe(cmd) { return saidaDe(cmd, ["-version"]).then(() => true, () => false); }

/* ---------------- fluxo principal (por último: os helpers acima são const) ---------------- */

async function principal() {
  if (!(await existe("ffmpeg")) || !(await existe("ffprobe"))) {
    console.error("precisa de ffmpeg e ffprobe no PATH (Mac: brew install ffmpeg)"); process.exit(1);
  }

  if (opcao("--fila")) await modoFila(opcao("--fila").replace(/\/$/, ""), opcao("--chave") || process.env.CORTES_CHAVE || "");
  else if (opcao("--uid")) {
    const uid = opcao("--uid"), inicio = Number(opcao("--inicio")), fim = Number(opcao("--fim"));
    if (!/^[0-9a-f]{32}$/.test(uid) || !(fim > inicio)) { console.error("uso: --uid <uid> --inicio <seg> --fim <seg>"); process.exit(1); }
    const palavras = semLegenda ? [] : palavrasLocais(uid, inicio, fim);
    const r = await cortar({ id: uid.slice(0, 8), uid, inicio, fim, titulo: opcao("--titulo", ""), legenda: "", palavras });
    console.log(Object.values(r).filter(Boolean).join("\n"));
  } else { console.error("uso: --uid ... | --fila <origem> --chave <chave>"); process.exit(1); }
}

await principal();
