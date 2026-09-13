// Tema CLÁSSICO — institucional, claro, leitura longa.
// Serifa nos títulos, azul acadêmico, numeração de aulas.

import { M, FONTES, FAMILIA, LOGO, PONTOS } from "../packages/identidade/marca";

export const CSS = `
:root{
  --bg:${M.papelFundo}; --papel:#FFFFFF; --linha:${M.linha}; --linha-forte:#BFBFBF;
  --texto:${M.tinta}; --muted:${M.tinta60}; --azul:${M.marca}; --azul-claro:#E9E8FD;
  --verde:${M.marca}; --raio:${M.raio};
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--texto);
  font-family:${FAMILIA};line-height:1.62;
  -webkit-font-smoothing:antialiased}
a{color:var(--azul);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}
h1,h2,h3{font-weight:600;margin:0;color:var(--texto);letter-spacing:-.02em}
h1{font-size:34px;line-height:1.2}
h2{font-size:22px}
h3{font-size:17px}
p{margin:0}
.mono{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted)}

/* cabeçalho institucional — azul fundo da marca com a textura de pontos */
.topo{background:${M.marcaFunda};${PONTOS("rgba(255,255,255,.13)")};color:#fff}
.topo a{color:#fff}
.topo-in{display:flex;align-items:center;justify-content:space-between;height:62px;
  max-width:1180px;margin:0 auto;padding:0 28px}
.marca{font-size:18px;font-weight:600;display:flex;align-items:center;gap:10px}
.brasao{width:26px;height:26px;border:2px solid #fff;border-radius:4px;
  display:grid;place-items:center;font-size:12px;font-family:'JetBrains Mono',monospace}
.topo .mono{color:#C7C5F7}

/* trilha de navegação — rótulo mono, como no design */
.migalha{background:#fff;border-bottom:1px solid var(--linha);padding:12px 0;
  font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted)}
.migalha b{color:var(--texto);font-weight:500}

/* layout com barra lateral */
.layout{display:grid;gap:22px;padding:24px 0}
.lateral h3{font-size:12px;text-transform:uppercase;letter-spacing:.12em;
  font-family:'JetBrains Mono',monospace;color:var(--muted);margin-bottom:10px}
.lateral ol{list-style:none;margin:0;padding:0}

/* mobile: faixa horizontal compacta, rolagem lateral — nada de sticky,
   que deslizava por cima do conteúdo */
.lateral{align-self:start;min-width:0}
.lateral ol{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch}
.lateral ol::-webkit-scrollbar{display:none}
.lateral li a{display:block;white-space:nowrap;font-size:13px;color:var(--texto);
  background:var(--papel);border:1px solid var(--linha);border-radius:999px;padding:7px 14px}
.lateral li a:hover{background:var(--azul-claro);text-decoration:none}

@media(min-width:900px){
  .layout{grid-template-columns:250px 1fr;gap:34px;padding:34px 0}
  .lateral{position:sticky;top:22px}
  .lateral h3{margin-bottom:12px}
  .lateral ol{display:block;overflow:visible;padding:0;
    border-left:2px solid var(--linha)}
  .lateral li a{white-space:normal;background:transparent;border:0;border-radius:0;
    border-left:2px solid transparent;margin-left:-2px;padding:8px 14px;font-size:14px}
  .lateral li a.ativo{border-left-color:var(--azul);color:var(--azul);font-weight:600}
}

/* cartões */
.card{background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);
  padding:22px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.grade{display:grid;gap:18px}
@media(min-width:760px){.grade-3{grid-template-columns:repeat(3,1fr)}}
.grade-4{grid-template-columns:repeat(2,1fr)}
@media(min-width:900px){.grade-4{grid-template-columns:repeat(4,1fr)}}
.stat .num{font-size:32px;line-height:1;margin-top:8px;color:var(--azul)}
.stat .num span{font-size:14px;color:var(--muted);font-family:'IBM Plex Sans',sans-serif}

/* botões */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer;
  font-family:inherit;font-size:14px;font-weight:600;padding:11px 22px;
  border-radius:var(--raio);transition:.15s}
.btn-primario{background:var(--azul);color:#fff}
.btn-primario:hover{background:${M.marcaFunda};text-decoration:none}
.btn-fantasma{background:var(--papel);color:var(--azul);border:1px solid var(--linha-forte)}
.btn-fantasma:hover{background:var(--azul-claro);text-decoration:none}

/* progresso */
.barra{height:8px;background:#EDEAE3;border-radius:4px;overflow:hidden}
.barra i{display:block;height:100%;background:var(--azul);border-radius:4px;transition:width .4s}

/* sumário de aulas — numerado, formal */
.modulo{margin-top:34px}
.modulo-topo{display:flex;align-items:baseline;justify-content:space-between;
  gap:16px;padding-bottom:10px;border-bottom:2px solid var(--linha);margin-bottom:4px}
.modulo-topo h2{font-size:clamp(18px,4.6vw,22px);min-width:0}
.modulo-topo .mono{white-space:nowrap;flex:0 0 auto}
.aula{display:flex;align-items:center;gap:16px;padding:13px 6px;
  border-bottom:1px solid var(--linha);transition:.14s}
.aula:hover{background:var(--papel);text-decoration:none}
.aula .num-aula{flex:0 0 34px;font-family:'JetBrains Mono',monospace;font-size:13px;
  color:var(--muted);text-align:right}
.check{flex:0 0 22px;height:22px;border-radius:3px;border:1.5px solid var(--linha-forte);
  display:grid;place-items:center;font-size:12px;color:transparent;background:#fff}
.aula.feita .check{background:var(--verde);border-color:var(--verde);color:#fff}
.aula-txt{flex:1;min-width:0}
.aula-txt b{display:block;font-weight:500;font-size:15px;color:var(--texto)}
.aula-meta{font-size:13px;color:var(--muted)}

/* player */
.player{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--raio);
  overflow:hidden;background:#000;border:1px solid var(--linha-forte)}
.player iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}

/* formulário */
.campo{width:100%;background:#fff;border:1px solid var(--linha-forte);color:var(--texto);
  font-family:inherit;font-size:15px;padding:12px 15px;border-radius:var(--raio);outline:none}
.campo:focus{border-color:var(--azul);box-shadow:0 0 0 3px var(--azul-claro)}
.aviso{background:var(--azul-claro);border:1px solid #C7C5F7;color:${M.marcaFunda};
  padding:13px 16px;border-radius:var(--raio);font-size:14px}
.erro{background:#FDECEA;border:1px solid #F5C6C0;color:#8B2A20;
  padding:13px 16px;border-radius:var(--raio);font-size:14px}
.centro{max-width:400px;margin:0 auto}
.vazio{text-align:center;padding:56px 20px;color:var(--muted)}
.diploma{background:${M.destaque};border:1px solid ${M.destaque}}

/* landing pública — acesso, professor, prova social, programa */
.entrada{padding:72px 28px 8px}
.faixa{border-top:1px solid var(--linha);margin-top:60px;padding-top:48px}
.faixa h2{font-size:clamp(22px,3.4vw,27px);margin-top:10px}
.faixa .lead{color:var(--muted);margin-top:14px;max-width:58ch}

/* professor: foto à esquerda, trajetória à direita */
.perfil{display:grid;gap:30px}
@media(min-width:900px){
  .perfil{grid-template-columns:1.15fr 1fr;gap:36px 52px;align-items:start}
  .perfil-topo{grid-column:1/-1}
}
.faixa .lead{color:#3A3A3A}
.retrato{margin:0}
.retrato img{display:block;width:100%;height:auto;border-radius:var(--raio);
  border:1px solid var(--linha)}
.retrato figcaption{font-size:13px;color:var(--muted);margin-top:10px;line-height:1.5}
@media(max-width:640px){.retrato img{aspect-ratio:4/3;object-fit:cover;object-position:52% 40%}}
.trajetoria{margin:0;display:grid;gap:0;border-top:1px solid var(--linha)}
.trajetoria div{display:grid;grid-template-columns:150px 1fr;gap:14px;padding:12px 0;
  border-bottom:1px solid var(--linha);font-size:15px}
.trajetoria dt{font-weight:600;color:var(--texto);margin:0}
.trajetoria dd{margin:0;color:#3A3A3A}
/* mobile: dt vira rótulo mono — trilho escaneável em vez de parede cinza */
@media(max-width:520px){
  .trajetoria div{grid-template-columns:1fr;gap:5px;padding:14px 0}
  .trajetoria dt{font-family:'JetBrains Mono',monospace;font-size:11px;
    letter-spacing:.08em;text-transform:uppercase;color:#4A4A4A;font-weight:500}
}

/* prova social */
.numeros{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--linha);
  border:1px solid var(--linha);border-radius:var(--raio);overflow:hidden;margin-top:28px}
@media(min-width:760px){.numeros{grid-template-columns:repeat(4,1fr)}}
.numeros div{background:var(--papel);padding:18px 20px}
.numeros b{display:block;font-size:26px;font-weight:600;color:var(--azul);letter-spacing:-.02em}
.numeros span{display:block;font-size:13px;color:var(--muted);margin-top:2px;line-height:1.45}
.logos{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:10px;
  margin-top:16px}
.logos div{background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);
  height:68px;display:grid;place-items:center;padding:0 16px}
.logos img{max-height:36px;max-width:118px;width:auto;height:auto;filter:grayscale(1) contrast(1.06)}
.logos img.simbolo{max-height:54px}
@media(max-width:520px){
  .logos{grid-template-columns:repeat(3,1fr);gap:8px}
  .logos div{height:58px;padding:0 10px}
  .logos img{max-height:30px;max-width:92px}
  .logos img.simbolo{max-height:44px}
}
.depoimentos{display:grid;gap:14px;margin-top:16px}
@media(min-width:800px){.depoimentos{grid-template-columns:repeat(2,1fr)}}
.dep{background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);
  padding:22px 24px;display:flex;flex-direction:column;gap:18px}
.dep blockquote{margin:0;font-size:15px;line-height:1.6;color:var(--texto);flex:1}
.dep footer{display:flex;align-items:center;gap:12px}
.dep img{width:44px;height:44px;border-radius:3px;object-fit:cover;flex:0 0 44px}
.dep b{display:block;font-size:14px;font-weight:600}
.dep span{display:block;font-size:12.5px;color:var(--muted);line-height:1.4}

/* programa */
.programa{list-style:none;margin:24px 0 0;padding:0;border-top:1px solid var(--linha)}
.programa li{display:flex;gap:16px;align-items:baseline;padding:14px 4px;
  border-bottom:1px solid var(--linha)}
.programa .n{flex:0 0 26px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted)}
.programa .t{font-size:15.5px}

/* leituras — visualizador de PDF em canvas */
.leitor{background:var(--papel);border:1px solid var(--linha-forte);border-radius:var(--raio);
  overflow:hidden}
.leitor-barra{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:9px 14px;border-bottom:1px solid var(--linha);background:#FAFAFA}
.leitor-zoom{display:flex;gap:6px}
.leitor-zoom button{width:32px;height:32px;border:1px solid var(--linha-forte);background:#fff;
  border-radius:var(--raio);font-size:18px;line-height:1;cursor:pointer;color:var(--texto)}
.leitor-zoom button:hover{background:var(--azul-claro)}
.leitor-paginas{background:#D9D9D9;padding:18px 12px;display:grid;gap:14px;justify-items:center;
  max-height:min(82vh,1100px);overflow:auto;-webkit-overflow-scrolling:touch}
.pagina-pdf{width:100%;max-width:980px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.14)}
.pagina-pdf canvas{display:block;max-width:100%;height:auto;margin:0 auto;
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
@media(max-width:640px){.leitor-paginas{padding:10px 6px;gap:10px}}

/* painel — abas, resumo clicável, ferramentas */
.painel{padding:40px 28px 20px}
.painel-topo{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px}
.painel-topo h1{margin-top:8px}
.abas{display:flex;gap:4px;border-bottom:2px solid var(--linha);margin-bottom:22px;overflow-x:auto;
  scrollbar-width:none}
.abas::-webkit-scrollbar{display:none}
.aba{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;margin-bottom:-2px;
  border-bottom:2px solid transparent;color:var(--muted);font-weight:600;font-size:14px;white-space:nowrap}
.aba:hover{color:var(--texto);text-decoration:none}
.aba.ativa{color:var(--azul);border-bottom-color:var(--azul)}
.aba-n{font-family:'JetBrains Mono',monospace;font-size:11px;background:var(--azul-claro);color:var(--azul);
  padding:2px 7px;border-radius:999px}
.aba.ativa .aba-n{background:var(--azul);color:#fff}
.resumo .filtro-card{text-align:left;cursor:pointer;font-family:inherit;color:inherit;
  transition:border-color .15s,box-shadow .15s}
.resumo .filtro-card:hover{border-color:var(--linha-forte)}
.resumo .filtro-card.ativa{border-color:var(--azul);box-shadow:0 0 0 3px var(--azul-claro)}
.ferramentas{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:22px 0 16px}
.ferramentas .busca{flex:1 1 220px;padding:9px 13px;font-size:14px}
.chips,.visao{display:flex;gap:6px;flex-wrap:wrap}
.visao{margin-left:auto}
.chip{font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);background:var(--papel);
  border:1px solid var(--linha);border-radius:999px;padding:7px 13px;cursor:pointer;transition:.15s}
.chip:hover{border-color:var(--linha-forte);color:var(--texto)}
.chip.ativa{background:var(--azul);border-color:var(--azul);color:#fff}
.painel textarea.campo{resize:vertical;min-height:80px;font-family:inherit;line-height:1.5}

.convite-massa{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;
  margin-bottom:14px;border-color:#E8D98A;background:#FFFBE6}

/* cartões de aluno — a visão de bater o olho */
.alunos-cartoes{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
/* display:grid/flex das classes venceria o [hidden] do navegador — reforça */
.alunos-cartoes[hidden],.painel-aba[hidden],.convite-massa[hidden]{display:none}
.cartao-aluno{display:grid;grid-template-columns:44px 1fr 56px;grid-template-rows:auto auto;gap:6px 12px;
  align-items:center;background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);
  padding:16px 16px 12px;color:var(--texto);transition:border-color .15s,box-shadow .15s,transform .15s}
.cartao-aluno:hover{text-decoration:none;border-color:var(--linha-forte);box-shadow:0 2px 8px rgba(0,0,0,.06);
  transform:translateY(-1px)}
.cartao-aluno[hidden]{display:none}
.avatar{width:44px;height:44px;border-radius:50%;background:var(--azul-claro);color:var(--azul);
  display:grid;place-items:center;font-weight:700;font-size:15px;letter-spacing:.02em}
.cartao-txt{min-width:0;display:grid;gap:2px}
.cartao-txt b{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cartao-txt .aula-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cartao-pe{grid-column:1/-1;padding-top:8px;border-top:1px solid var(--linha)}
.anel{flex:0 0 auto}
.etiqueta{display:inline-block;justify-self:start;font-size:11px;font-weight:600;letter-spacing:.02em;
  padding:2px 8px;border-radius:999px;margin-top:2px}
.etiqueta.ok{background:#E3F1E6;color:#1E6B34}
.etiqueta.neutro{background:#EEEEEE;color:#555}
.etiqueta.atencao{background:#FFF4C2;color:#7A5A00}
.etiqueta.alerta{background:#FDECEA;color:#8B2A20}
.kpis{display:flex;gap:12px;flex-wrap:wrap}
table.desempenho{width:100%;border-collapse:collapse;font-size:14px;min-width:760px}
table.desempenho th{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;padding:8px 6px;border-bottom:1px solid var(--linha-forte);white-space:nowrap}
table.desempenho td{padding:9px 6px;border-bottom:1px solid var(--linha);vertical-align:middle;white-space:nowrap}
table.desempenho td:first-child{white-space:normal;min-width:220px}
table.desempenho tr.alerta td{background:#FFF7F5}
table.desempenho svg{display:block}
/* provas de módulo */
.aula.trancada{opacity:.6}
.aula.prova{border-top:1px dashed var(--linha-forte);margin-top:4px}
.aula.prova .num-aula{color:var(--azul)}
.questao{margin-top:14px;border:1px solid var(--linha);padding:18px 20px}
.questao legend{padding:0 6px}
.questao .enunciado{font-size:17px;line-height:1.45;margin:6px 0 12px;font-weight:500}
.opcao{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border:1px solid var(--linha);border-radius:6px;margin-top:6px;cursor:pointer;line-height:1.4}
.opcao:hover{border-color:var(--linha-forte)}
.opcao input{margin-top:4px;flex:0 0 auto}
.resultado .opcao{cursor:default}
.resultado .opcao.gabarito{background:#E3F1E6;border-color:#B7DEC0}
.resultado .opcao.marcada{background:#FDECEA;border-color:#F5C6C0}
.questao.certa{border-color:#B7DEC0}
.questao.errada{border-color:#F5C6C0}
details.card summary{list-style:none}details.card summary::-webkit-details-marker{display:none}
details.card summary::before{content:"▸ ";color:var(--muted)}details.card[open] summary::before{content:"▾ "}
.aluno-linha[hidden]{display:none}

/* funil kanban — uma coluna por etapa; em tela estreita as colunas empilham */
.funil{display:grid;grid-template-columns:repeat(5,minmax(196px,1fr));gap:10px;align-items:start;overflow-x:auto;padding-bottom:6px}
.funil[hidden]{display:none}
.funil-col{background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);padding:14px 12px 12px;
  display:grid;gap:8px;align-content:start;min-height:180px}
.funil-topo{display:grid;gap:3px;padding-bottom:10px;margin-bottom:2px;border-bottom:1px solid var(--linha)}
.funil-topo .num{font-size:28px;line-height:1;color:var(--azul);margin:4px 0 2px}
.funil-topo .aula-meta{font-size:12px;line-height:1.35}
.funil-topo .dica{min-height:2.7em} /* duas linhas: as barras ficam alinhadas entre colunas */
.funil-barra{display:block;height:4px;background:#EDEAE3;border-radius:2px;overflow:hidden;margin-top:6px}
.funil-barra i{display:block;height:100%;background:var(--azul);border-radius:2px}
.cartao-funil{display:grid;grid-template-columns:32px minmax(0,1fr);gap:4px 10px;align-items:center;padding:9px 10px;
  border:1px solid var(--linha);border-radius:10px;background:var(--bg);color:var(--texto);transition:border-color .15s}
.cartao-funil:hover{text-decoration:none;border-color:var(--linha-forte)}
.cartao-funil[hidden]{display:none}
.cartao-funil .avatar{width:32px;height:32px;font-size:12px}
.cartao-funil .cartao-txt b{font-size:14px}
.cartao-funil .cartao-txt .aula-meta{font-size:12px;white-space:normal;line-height:1.35}
.cartao-funil .mini-barra{grid-column:2;margin:0;max-width:none}
.cartao-funil .etiqueta{grid-column:2;justify-self:start;margin:0}
.funil-vazio{text-align:center;padding:10px 0 4px;margin:0;opacity:.7}
.funil-acao{margin-top:4px}
.funil-acao .btn{width:100%;font-size:13px;padding:8px 10px}
@media(max-width:720px){.funil{grid-template-columns:1fr;overflow:visible}.funil-col{min-height:0}}

/* inteligência: busca na fala e transcrição embaixo do vídeo */
mark{background:#FFF1A8;color:inherit;padding:0 2px;border-radius:2px}
.transcricao summary{list-style:none}
.transcricao summary::-webkit-details-marker{display:none}
.transcricao summary:before{content:"▸ ";color:var(--muted)}
.transcricao[open] summary:before{content:"▾ "}
.transcricao a.mono:hover{text-decoration:none;color:var(--azul)}

/* funil de entrada (aba) — barras acumuladas, queda entre etapas, lista de quem parou */
.funil-filtros{display:grid;gap:8px;margin-bottom:18px}
.funil-filtros .chips{align-items:center}
.funil-filtros .chips .mono{margin-right:6px}
.funil-filtros .chip{text-decoration:none}
.funil-v{background:var(--papel);border:1px solid var(--linha);border-radius:var(--raio);padding:8px 18px 6px}
.funil-etapa{display:grid;grid-template-columns:30px 190px minmax(0,1fr) 56px 52px 118px;gap:0 14px;align-items:center;
  width:100%;padding:12px 4px;background:none;border:0;border-top:1px solid var(--linha);text-align:left;
  font-family:inherit;color:var(--texto);cursor:pointer;border-radius:6px}
.funil-etapa:first-child{border-top:0}
.funil-etapa:hover{background:var(--bg)}
.funil-etapa[aria-expanded="true"]{background:var(--azul-claro)}
.funil-etapa .nome{min-width:0}
.funil-etapa .nome b{display:block;font-weight:600;font-size:15px}
.funil-etapa .nome small{display:block;color:var(--muted);font-size:12px;line-height:1.3}
.fbarra{display:block;height:22px;background:#EDEAE3;border-radius:4px;overflow:hidden}
.fbarra i{display:block;height:100%;background:var(--azul);border-radius:4px}
.funil-etapa .num{font-size:19px;font-weight:700;text-align:right;color:var(--azul)}
.funil-etapa .pct{text-align:right;color:var(--muted);font-size:13px}
.funil-etapa .tempo{color:var(--muted);font-size:12px}
.queda{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:4px 10px 10px 48px;font-size:13px;color:#444;cursor:pointer}
.queda .seta{color:var(--muted)}
.queda .perdeu{color:#8B2A20}
.queda .acao{margin-left:auto;display:flex;gap:8px}
.queda .acao .btn{font-size:12.5px;padding:6px 12px}
.funil-lista{margin:0 0 10px 48px;border:1px solid var(--linha);border-radius:var(--raio);padding:4px 14px;background:var(--bg)}
.funil-lista[hidden]{display:none}
.funil-item{align-items:center}
.funil-item .avatar{width:34px;height:34px;font-size:12px;flex:0 0 34px}
.funil-item .acoes{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.funil-item .acoes .btn{font-size:12.5px;padding:6px 12px}
.funil-item:last-child{border-bottom:0}
@media(max-width:900px){
  .funil-v{padding:6px 10px}
  .funil-etapa{grid-template-columns:24px minmax(0,1fr) 48px 44px;grid-template-rows:auto auto;gap:6px 10px}
  .funil-etapa .fbarra{grid-column:2/-1;grid-row:2}
  .funil-etapa .tempo{display:none}
  .queda{padding-left:34px}
  .queda .acao{margin-left:0;width:100%}
  .funil-lista{margin-left:0}
  .funil-item{flex-wrap:wrap}
  .funil-item .acoes{flex:0 0 100%;justify-content:flex-start;margin-left:50px}
}

/* painel: linha de aluno com barra de progresso */
.aluno-linha{align-items:flex-start}
.aluno-linha .check{margin-top:12px}
.mini-barra{display:block;height:5px;background:#EDEAE3;border-radius:3px;overflow:hidden;
  margin:7px 0 4px;max-width:320px}
.mini-barra i{display:block;height:100%;background:var(--azul);border-radius:3px}
.aluno-linha .acoes{margin-top:10px}

/* ações por linha no painel */
.acoes{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.acoes .btn{padding:7px 12px;font-size:13px}
.check.oculto{border-style:dashed}
@media(max-width:640px){
  .aula:has(.acoes){flex-wrap:wrap}
  .aula .acoes{flex:0 0 calc(100% - 38px);margin-left:38px;margin-top:2px}
}

/* certificado — folha A4 paisagem, pronta para imprimir/salvar em PDF */
.folha{background:#fff;border:1px solid var(--linha);border-radius:var(--raio);
  max-width:1040px;margin:0 auto;padding:34px 24px;position:relative;
  box-shadow:0 2px 10px rgba(0,0,0,.06)}
@media(min-width:760px){.folha{padding:56px 60px}}
.folha::before{content:"";position:absolute;inset:14px;border:1.5px solid var(--azul);
  border-radius:3px;pointer-events:none;opacity:.5}
.folha-in{position:relative;text-align:center}
.folha .selo{width:60px;height:60px;margin:0 auto 20px;display:grid;place-items:center}
.folha .selo svg{display:block;width:60px;height:60px}
.folha h1{font-size:clamp(28px,4.4vw,44px);letter-spacing:-.03em;margin:0 0 6px}
.folha .nome{font-size:clamp(24px,3.6vw,34px);font-weight:600;color:var(--azul);
  margin:26px 0 6px;line-height:1.2}
.folha .texto{color:var(--muted);font-size:16px;max-width:640px;margin:0 auto}
.folha .rodape{display:grid;grid-template-columns:repeat(2,1fr);gap:16px 20px;
  margin-top:32px;padding-top:20px;border-top:1px solid var(--linha);text-align:left}
@media(min-width:760px){.folha .rodape{grid-template-columns:repeat(4,1fr);
  gap:20px;margin-top:44px}}
.folha .rodape div{min-width:0}
.folha .rodape b{display:block;font-size:14px;font-weight:600;margin-top:3px;
  overflow-wrap:anywhere}
.so-tela{margin:26px auto 0;max-width:1040px;display:flex;gap:12px;flex-wrap:wrap;
  justify-content:center}
@media print{
  @page{size:A4 landscape;margin:10mm}
  html,body{height:auto;background:#fff}
  .topo,.migalha,footer,.so-tela{display:none!important}
  .wrap{max-width:none;padding:0!important}
  main{display:flex;align-items:center;min-height:calc(100vh - 20mm);padding:0!important}
  .folha{width:100%;max-width:none;margin:0;padding:38px 44px;
    border:0;box-shadow:none;break-inside:avoid;
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .folha::before{inset:0}
  .folha h1{font-size:40px}
  .folha .nome{font-size:32px;margin:30px 0 8px}
  .folha .texto{font-size:15px}
  .folha .rodape{margin-top:40px}
}
`;

export function pagina(o: {
  titulo: string; corpo: string; escola: string;
  aluno?: { nome?: string | null; email: string } | null;
}) {
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.titulo)} · ${esc(o.escola)}</title>
<link rel="icon" href="https://comeca.ai/favicon.svg">
${FONTES}
<style>${CSS}</style></head><body>
<header class="topo"><div class="topo-in">
  <a class="marca" href="${o.aluno ? "/app" : "/"}">${LOGO(24, "#FFFFFF", M.marca)}${esc(o.escola)}</a>
  ${o.aluno ? `<div style="display:flex;align-items:center;gap:18px">
      <span class="mono">${esc(o.aluno.nome || o.aluno.email)}</span>
      <a href="/sair" style="font-size:13px">Sair</a></div>` : ""}
</div></header>
${o.aluno ? `<div class="migalha"><div class="wrap">AVA &nbsp;›&nbsp; <b>${esc(o.titulo)}</b></div></div>` : ""}
${o.corpo}
<footer class="wrap" style="padding:48px 28px;border-top:1px solid var(--linha);margin-top:50px">
  <p class="mono">${esc(o.escola)} · Ambiente Virtual de Aprendizagem</p>
</footer>
</body></html>`;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// texto dinâmico dentro de JS em atributo (onsubmit="return confirm(...)"):
// JSON.stringify escapa para o JS, esc() escapa para o HTML — esc sozinho
// deixaria uma aspa simples do nome fechar a string e injetar código
export const jsStr = (s: string) => esc(JSON.stringify(s));

export function duracao(seg: number): string {
  const m = Math.round(seg / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
