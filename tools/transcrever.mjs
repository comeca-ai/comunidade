#!/usr/bin/env node
// Transcreve aulas do Stream com o Deepgram, a partir de qualquer máquina com
// ffmpeg (Mac, CI, sandbox). Baixa só a faixa de áudio do HLS, manda para a
// API pré-gravada e grava o formato compacto em transcricoes/.
//
//   DEEPGRAM_API_KEY=... node tools/transcrever.mjs <uid> [<uid> ...]
//   node tools/transcrever.mjs --lista aulas.json      # [{uid,titulo,duracao_seg}] (saída do wrangler d1 --json)
//   node tools/transcrever.mjs --forcar <uid>          # refaz a transcrição (reusa o áudio baixado)
//   node tools/transcrever.mjs --reaudio <uid>         # baixa o áudio de novo também
//
// A chave vem de DEEPGRAM_API_KEY ou de ~/.deepgram_key. O JSON bruto do
// Deepgram fica em /tmp/transcricoes/<uid>.raw.json (não versionado).
// O Worker também transcreve sozinho vídeo novo (src/transcricao.ts)
// quando o segredo DEEPGRAM_API_KEY existe — este script é o caminho manual.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compactar, KEYTERMS } from "../packages/conteudo/transcricao.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAIDA = join(RAIZ, "transcricoes");
const BRUTO = "/tmp/transcricoes";
const SUBDOMINIO = process.env.STREAM_SUBDOMINIO || "customer-0b8qbusp05k8f01y.cloudflarestream.com";
// sem smart_format: em português ele troca o artigo "um" por "1". Os keyterms
// corrigem nomes que o modelo erra (testado: "Jonathan" → "Jhonata").
export const PARAMS = "model=nova-3&language=pt-BR&punctuate=true&diarize=true&paragraphs=true&" +
  KEYTERMS.map((k) => `keyterm=${encodeURIComponent(k)}`).join("&");

const chave = process.env.DEEPGRAM_API_KEY || (existsSync(join(homedir(), ".deepgram_key")) ? readFileSync(join(homedir(), ".deepgram_key"), "utf8").trim() : "");
if (!chave) { console.error("sem DEEPGRAM_API_KEY"); process.exit(1); }

const args = process.argv.slice(2);
const forcar = args.includes("--forcar") || args.includes("--reaudio");
const reaudio = args.includes("--reaudio");
let uids = args.filter((a) => /^[0-9a-f]{32}$/.test(a));
const iLista = args.indexOf("--lista");
if (iLista > -1) {
  const dados = JSON.parse(readFileSync(args[iLista + 1], "utf8"));
  const linhas = Array.isArray(dados) ? (dados[0]?.results ?? dados) : (dados.results ?? []);
  uids = [...uids, ...linhas.map((l) => l.uid).filter((u) => /^[0-9a-f]{32}$/.test(u))];
}
uids = [...new Set(uids)];
if (!uids.length) { console.error("nenhum uid"); process.exit(1); }
mkdirSync(SAIDA, { recursive: true }); mkdirSync(BRUTO, { recursive: true });

// faixa de áudio do HLS: o master aponta para uma playlist só de áudio
async function urlAudio(uid) {
  const master = `https://${SUBDOMINIO}/${uid}/manifest/video.m3u8`;
  const txt = await (await fetch(master)).text();
  const m = txt.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/);
  return m ? new URL(m[1], master).toString() : master;
}

const rodar = (cmd, argv) => new Promise((res, rej) => {
  const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} saiu com ${c}`))));
});

async function transcrever(uid) {
  const destino = join(SAIDA, `${uid}.json`);
  if (existsSync(destino) && !forcar) { console.log(`= ${uid} já transcrita`); return; }
  const mp3 = join(BRUTO, `${uid}.mp3`);
  if (!existsSync(mp3) || reaudio) {
    const url = await urlAudio(uid);
    console.log(`↓ ${uid} áudio`);
    await rodar("ffmpeg", ["-loglevel", "error", "-y", "-i", url, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3]);
  }
  console.log(`→ ${uid} deepgram`);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${PARAMS}`, {
    method: "POST", headers: { Authorization: `Token ${chave}`, "Content-Type": "audio/mpeg" },
    body: readFileSync(mp3),
  });
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const bruto = await r.json();
  writeFileSync(join(BRUTO, `${uid}.raw.json`), JSON.stringify(bruto));
  const t = compactar(uid, bruto, Math.floor(Date.now() / 1000));
  writeFileSync(destino, JSON.stringify(t));
  console.log(`✓ ${uid} ${Math.round(t.duracao / 60)} min · ${t.paragrafos.length} parágrafos · ${t.falantes} falante(s) · ${t.paragrafos.reduce((s, p) => s + p.p.length, 0)} palavras`);
}

// índice importado pelo Worker: um mapa uid → transcrição, gerado do diretório
export function gerarIndice() {
  const arquivos = readdirSync(SAIDA).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).sort();
  const linhas = [
    "// gerado por tools/transcrever.mjs — não edite à mão",
    "import type { Transcricao } from \"../packages/conteudo/transcricao\";",
    ...arquivos.map((f, i) => `import t${i} from "./${f}";`),
    "",
    `export const TRANSCRICOES: Record<string, Transcricao> = {`,
    ...arquivos.map((f, i) => `  "${f.slice(0, 32)}": t${i} as unknown as Transcricao,`),
    "};",
    "",
  ];
  writeFileSync(join(SAIDA, "index.ts"), linhas.join("\n"));
  return arquivos.length;
}

let falhas = 0;
for (const uid of uids) {
  try { await transcrever(uid); } catch (e) { falhas++; console.error(`✗ ${uid}: ${e.message}`); }
}
console.log(`índice: ${gerarIndice()} transcrição(ões) em transcricoes/`);
process.exit(falhas ? 1 : 0);
