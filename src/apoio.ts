// Pequenos ajudantes de apresentação usados pelo painel e pelo funil.

export const DIA = 86400;

// "hoje", "ontem", "há 3 dias", "há 2 semanas", "há 3 meses" — ou "nunca"
export function haQuanto(seg: number | null | undefined, agora: number): string {
  if (!seg) return "nunca";
  const d = Math.floor((agora - seg) / DIA);
  if (d <= 0) return "hoje";
  if (d === 1) return "ontem";
  if (d < 14) return `há ${d} dias`;
  if (d < 60) return `há ${Math.round(d / 7)} semanas`;
  if (d < 365) return `há ${Math.round(d / 30)} meses`;
  return `há ${Math.round(d / 365)} ano${d >= 730 ? "s" : ""}`;
}

export const dataCurta = (seg: number) =>
  new Date(seg * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });

export const nomeOu = (a: { nome: string | null; email: string }) => a.nome || a.email.split("@")[0];

export const iniciais = (a: { nome: string | null; email: string }) => {
  const partes = (a.nome || a.email.split("@")[0]).replace(/[._-]+/g, " ").trim().split(/\s+/);
  return (partes.length > 1 ? partes[0][0] + partes[partes.length - 1][0] : partes[0].slice(0, 2)).toUpperCase();
};

// dia local (Brasília, sem horário de verão) — chave da tabela acessos
export const diaLocal = (seg: number) => Math.floor((seg - 3 * 3600) / DIA);

// e-mails válidos de um texto colado: vírgula, ponto e vírgula, espaço ou linha
export const emailsDe = (texto: string) =>
  [...new Set(texto.split(/[,\n;\s]+/).map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];

// contatos de um texto colado ou de um CSV: cada linha pode ter só o e-mail,
// "Nome <email>", ou colunas separadas por tab/vírgula/ponto e vírgula (duas
// colunas copiadas de uma planilha). Cabeçalho e colunas sem letras (telefone,
// data) são ignorados; linha com vários e-mails vira vários contatos sem nome.
export type Contato = { email: string; nome: string | null };
export function contatosDe(texto: string): Contato[] {
  const vistos = new Map<string, string | null>();
  const RE = /[^\s<>,;"'()\[\]]+@[^\s<>,;"'()\[\]]+\.[^\s<>,;"'()\[\]]+/g;
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    const achados = [...linha.matchAll(RE)].map((m) => m[0]);
    if (!achados.length) continue;
    if (achados.length > 1) { for (const e of achados) if (!vistos.has(e.toLowerCase())) vistos.set(e.toLowerCase(), null); continue; }
    const email = achados[0].toLowerCase();
    const nome = linha.replace(achados[0], "").split(/[\t;,]+/)
      .map((s) => s.replace(/[<>"']/g, "").trim())
      .find((s) => /\p{L}{2,}/u.test(s) && (s.replace(/\D/g, "").length < s.length / 2) && !/^(nome|name|e-?mail|aluno|participante)$/i.test(s)) || null;
    if (!vistos.has(email) || (nome && !vistos.get(email))) vistos.set(email, nome ? nome.slice(0, 80) : vistos.get(email) ?? null);
  }
  return [...vistos].map(([email, nome]) => ({ email, nome }));
}

// texto de um CSV enviado: UTF-8, ou Windows-1252 quando o Excel salvou assim
export function textoDoCsv(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder().decode(bytes);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("windows-1252").decode(bytes); } catch { return utf8; }
}

// roda em segundo plano no Worker; nos testes (sem ExecutionContext) espera
export async function emSegundoPlano(c: any, p: Promise<unknown>) {
  let ctx: any = null;
  try { ctx = c.executionCtx; } catch { /* sem contexto */ }
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p.catch(() => {}));
  else await p.catch(() => {});
}
