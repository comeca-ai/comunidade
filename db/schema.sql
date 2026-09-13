-- Área de membros começa.ai

CREATE TABLE IF NOT EXISTS alunos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  nome       TEXT,
  criado_em  INTEGER NOT NULL,
  ultimo_acesso INTEGER
);

CREATE TABLE IF NOT EXISTS sessoes (
  token      TEXT PRIMARY KEY,
  aluno_id   INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  expira_em  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessoes_aluno ON sessoes(aluno_id);

CREATE TABLE IF NOT EXISTS links_magicos (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expira_em  INTEGER NOT NULL,
  usado_em   INTEGER,
  tipo       TEXT,        -- entrada | convite | lembrete
  criado_em  INTEGER,
  aberto_em  INTEGER      -- pixel de abertura (sinal, não certeza)
);

CREATE TABLE IF NOT EXISTS aulas (
  uid         TEXT PRIMARY KEY,
  titulo      TEXT NOT NULL,
  modulo      TEXT NOT NULL,
  parte       INTEGER,
  ordem       INTEGER NOT NULL DEFAULT 0,
  duracao_seg INTEGER NOT NULL DEFAULT 0,
  thumbnail   TEXT,
  publicada   INTEGER NOT NULL DEFAULT 1,
  criada_em   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aulas_modulo ON aulas(modulo, ordem);

CREATE TABLE IF NOT EXISTS progresso (
  aluno_id     INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  aula_uid     TEXT NOT NULL REFERENCES aulas(uid) ON DELETE CASCADE,
  concluida_em INTEGER,
  PRIMARY KEY (aluno_id, aula_uid)
);

-- acervo unificado (aulas, slides, artigos, vídeos) e trilhas personalizadas
CREATE TABLE IF NOT EXISTS acervo (
  id           TEXT PRIMARY KEY,
  tipo         TEXT NOT NULL,
  titulo       TEXT NOT NULL,
  modulo       TEXT,
  url          TEXT,
  chave        TEXT,
  minutos      INTEGER NOT NULL DEFAULT 0,
  publicado_em TEXT,
  criado_em    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acervo_tipo ON acervo(tipo);

CREATE TABLE IF NOT EXISTS trilhas (
  aluno_id     INTEGER PRIMARY KEY REFERENCES alunos(id) ON DELETE CASCADE,
  objetivo     TEXT NOT NULL,
  tempo_semana INTEGER NOT NULL,
  nivel        TEXT NOT NULL,
  titulo       TEXT,
  resumo       TEXT,
  itens        TEXT NOT NULL,
  criada_em    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acervo_progresso (
  aluno_id     INTEGER NOT NULL,
  item_id      TEXT NOT NULL,
  concluido_em INTEGER,
  PRIMARY KEY (aluno_id, item_id)
);

-- separação de acesso por escola: um aluno só entra onde está matriculado
CREATE TABLE IF NOT EXISTS matriculas (
  aluno_id      INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  escola        TEXT NOT NULL,
  criada_em     INTEGER NOT NULL,
  turma         TEXT,           -- de onde veio (ex.: "Imersão 12/09")
  consentiu_em  INTEGER,        -- de acordo para receber o convite
  consentimento TEXT,           -- quero | painel | importacao | legado
  PRIMARY KEY (aluno_id, escola)
);

-- leituras em PDF (clássica): o arquivo fica no R2 em artigos/<chave>.pdf
CREATE TABLE IF NOT EXISTS artigos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo    TEXT NOT NULL,
  descricao TEXT,
  modulo    TEXT,
  chave     TEXT NOT NULL,
  paginas   INTEGER,
  ordem     INTEGER NOT NULL DEFAULT 0,
  publicado INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artigos_lidos (
  aluno_id  INTEGER NOT NULL,
  artigo_id INTEGER NOT NULL,
  lido_em   INTEGER NOT NULL,
  PRIMARY KEY (aluno_id, artigo_id)
);

-- funil de entrada (clássica): turma e de acordo na matrícula, tipo/abertura
-- nos links, um acesso por dia, e pedidos de convite feitos pelo /quero.
-- Em banco já existente estas colunas/tabelas entram sozinhas (garantirEsquemaFunil).
CREATE TABLE IF NOT EXISTS acessos (
  aluno_id INTEGER NOT NULL,
  dia      INTEGER NOT NULL,
  PRIMARY KEY (aluno_id, dia)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  email     TEXT NOT NULL UNIQUE,
  nome      TEXT,
  turma     TEXT,
  criado_em INTEGER NOT NULL
);
