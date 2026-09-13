// Classificação de títulos do Stream em módulos — compartilhada pelas quatro escolas.
//
// O título do vídeo no Cloudflare Stream é a única fonte: não há campo de módulo lá.
// Convenções aceitas, na ordem em que são testadas:
//
//   "[Sessão Prática] - Como precificar"      → módulo "Sessões Práticas"
//   "[Empreendedorismo] Engenhando Talks"     → módulo "Empreendedorismo" (prefixo genérico)
//   "Dados e Conceitos fundamentais [Parte 3]"→ módulo "Dados e Conceitos fundamentais", parte 3
//   uid presente em POR_UID                   → módulo fixado (testado antes de tudo)
//   título casando uma REGRA abaixo           → módulo da regra
//   título sem convenção, fora da lista       → MODULO_PADRAO (ex.: "Entrevistas: …")
//   qualquer outro                            → módulo = o próprio título
//
// A lista oficial é ORDEM_MODULOS; o padrão é MODULO_PADRAO (ambos no
// wrangler.jsonc). Com isso, palestra/talk avulsa cai no módulo padrão sem
// ninguém mexer em código. Para abrir um módulo NOVO, ou entra na
// ORDEM_MODULOS, ou o vídeo usa o prefixo [Módulo] no título.

// origem diz de onde veio o módulo. "titulo" é o caso sem convenção nenhuma
// (módulo = o próprio título): quem lê o banco deve preferir o que está
// gravado lá, porque pode ter sido curado à mão.
export type Origem = "uid" | "pratica" | "prefixo" | "parte" | "regra" | "padrao" | "titulo";

// Lista oficial + módulo padrão, lidos das vars do Worker.
export type Regras = { conhecidos: string[]; padrao: string | null };

// ORDEM_MODULOS é separada por "|" — nome de módulo pode ter vírgula
// ("Entrevistas: dados, IA e empreendedorismo"). Sem "|" na string, a
// vírgula ainda vale, para não quebrar um wrangler.jsonc antigo.
export function listaDeModulos(texto: string | undefined): string[] {
  const t = texto || "";
  return t.split(t.includes("|") ? "|" : ",").map((m) => m.trim()).filter(Boolean);
}

export function regrasDoEnv(env: { ORDEM_MODULOS?: string; MODULO_PADRAO?: string }): Regras {
  return {
    conhecidos: listaDeModulos(env.ORDEM_MODULOS),
    padrao: (env.MODULO_PADRAO || "").trim() || null,
  };
}
export type Classificacao = { modulo: string; parte: number; limpo: string; origem: Origem };

// uid do Stream → módulo. Sobrevive a renomeação do vídeo. "@padrao" resolve
// para MODULO_PADRAO, então renomear o módulo no wrangler.jsonc basta.
const PADRAO_SE_NAO_CONFIGURADO = "Entrevistas: dados, IA e empreendedorismo";
const POR_UID: Record<string, string> = {
  e941ea30385e64018e7d3e242ca116f4: "@padrao", // A história do empreendedor…
  "92a00a17492b40025d5f1b32a9f86307": "@padrao", // Engenhando Talks (no Stream: "Inteligência Artificial | Com Jhonata Emericke")
  d51066ccebdac36ea0a54c51d2ace7a7: "@padrao", // Sociedade do Amanhã - O ROBÔ VAI TE SUBSTITUIR?
};

const REGRAS: Array<{ modulo: string; casa: RegExp[] }> = [
  {
    modulo: "@padrao",
    casa: [
      /engenhando\s+talks/i,
      /hist[óo]ria\s+do\s+empreendedor/i,
    ],
  },
];

export function classificar(titulo: string, uid?: string, regras?: Regras): Classificacao {
  const t = titulo.trim();

  const fixo = uid && POR_UID[uid];
  if (fixo) {
    const modulo = fixo === "@padrao" ? (regras?.padrao ?? PADRAO_SE_NAO_CONFIGURADO) : fixo;
    return { modulo, parte: 0, limpo: t, origem: "uid" };
  }

  const pratica = t.match(/^\[\s*sess(?:ã|a)o\s+pr(?:á|a)tica\s*\]\s*-?\s*(.+)$/i);
  if (pratica) return { modulo: "Sessões Práticas", parte: 0, limpo: pratica[1].trim(), origem: "pratica" };

  // prefixo genérico "[Módulo] Título" — ignora "[Parte N]", que é sufixo
  const prefixo = t.match(/^\[\s*([^\]]+?)\s*\]\s*-?\s*(.+)$/);
  if (prefixo && !/^parte\s*\d+$/i.test(prefixo[1])) {
    return { modulo: prefixo[1].trim(), parte: 0, limpo: prefixo[2].trim(), origem: "prefixo" };
  }

  const parte = t.match(/^(.*?)\s*\[\s*parte\s*(\d+)\s*\]\s*$/i);
  if (parte) return { modulo: parte[1].trim(), parte: Number(parte[2]), limpo: t, origem: "parte" };

  for (const r of REGRAS) {
    if (r.casa.some((re) => re.test(t))) {
      const modulo = r.modulo === "@padrao" ? (regras?.padrao ?? PADRAO_SE_NAO_CONFIGURADO) : r.modulo;
      return { modulo, parte: 0, limpo: t, origem: "regra" };
    }
  }

  // sem convenção nenhuma: se não é um módulo oficial, é conteúdo avulso
  if (regras?.padrao && regras.conhecidos.length && !regras.conhecidos.includes(t)) {
    return { modulo: regras.padrao, parte: 0, limpo: t, origem: "padrao" };
  }
  return { modulo: t, parte: 0, limpo: t, origem: "titulo" };
}

// Para quem lê aulas já gravadas: aplica a classificação atual por cima do
// que está no banco, mas só quando ela vem de uma regra explícita. Sem
// convenção no título, vale o módulo gravado — que pode ter sido curado.
export function moduloNaLeitura(
  gravado: { titulo: string; uid: string; modulo: string; ordem: number },
  regras?: Regras,
): { modulo: string; ordem: number } {
  const k = classificar(gravado.titulo, gravado.uid, regras);
  if (k.origem === "titulo") return { modulo: gravado.modulo, ordem: gravado.ordem };
  // padrão só vale se o gravado também for avulso — um módulo oficial
  // gravado à mão (ex.: Sessões Práticas sem prefixo no título) fica
  if (k.origem === "padrao" && regras?.conhecidos.includes(gravado.modulo)) {
    return { modulo: gravado.modulo, ordem: gravado.ordem };
  }
  return { modulo: k.modulo, ordem: k.origem === "parte" ? k.parte : gravado.ordem };
}
