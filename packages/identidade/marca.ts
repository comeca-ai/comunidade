// Identidade começa.ai — tokens extraídos do site oficial (comeca.ai)
export const M = {
  marca: "#1F1BE4",
  marcaFunda: "#14119C",
  ponto: "#3B37E9",
  destaque: "#FAE047",
  papel: "#F2F2F2",
  papelFundo: "#E6E6E6",
  caixa: "#DBDBDB",
  linha: "#D2D2D2",
  tinta: "#000000",
  tinta60: "#636363",
  tinta35: "#919191",
  raio: "5px",
};

export const FONTES = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

export const FAMILIA = `'Host Grotesk', ui-sans-serif, 'Helvetica Neue', Arial, sans-serif`;

// Marca oficial (favicon.svg do comeca.ai)
export const LOGO = (tamanho = 28, fundo = "#1F1BE4", simbolo = "#FFFFFF") =>
  `<svg width="${tamanho}" height="${tamanho}" viewBox="0 0 512 512" aria-hidden="true">
    <rect width="512" height="512" rx="112" fill="${fundo}"/>
    <g transform="translate(84.24 117.22) scale(2.7481)">
      <path d="M118.806 29.01C112.878 23.0848 105.053 20.0984 97.2287 20.0984C89.4039 20.0984 81.5791 23.0848 75.6513 29.01L42.3605 62.2862C39.2305 65.4148 35.1048 67.1212 30.6944 67.1212C26.2841 67.1212 22.1583 65.4148 19.0284 62.2862C12.5789 55.8395 12.5789 45.3637 19.0284 38.917C25.4779 32.4704 35.9584 32.4704 42.4079 38.917L45.0161 41.5241L55.0698 31.9015L52.1296 28.9626C40.2264 17.0647 20.8305 17.0647 8.92735 28.9626C-2.97578 40.8605 -2.97578 60.2479 8.92735 72.1458C14.7129 77.9289 22.348 81.1048 30.5047 81.1048C38.6615 81.1048 46.344 77.9289 52.1296 72.1458L85.4204 38.8696C91.8699 32.423 102.35 32.423 108.8 38.8696C115.249 45.3163 115.249 55.7921 108.8 62.2388C105.67 65.3673 101.544 67.0738 97.1338 67.0738C92.7235 67.0738 88.5503 65.3673 85.4678 62.2388L73.8018 50.5779L63.9853 60.3901L75.7461 72.1458C81.5317 77.9289 89.1668 81.1048 97.371 81.1048C105.575 81.1048 113.21 77.9289 118.948 72.1458C130.851 60.2479 130.851 40.8605 118.948 28.9626L118.806 29.01Z" fill="${simbolo}"/>
    </g>
  </svg>`;

// padrão de pontos do site
export const PONTOS = (cor = "rgba(255,255,255,.22)") =>
  `background-image:radial-gradient(${cor} 1.6px, transparent 1.6px);background-size:41px 41px`;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function duracao(seg: number): string {
  const m = Math.round(seg / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
