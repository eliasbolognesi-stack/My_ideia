'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  matricula TEXT,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('operador', 'tecnico', 'aprovador', 'admin')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ativos (
  id INTEGER PRIMARY KEY,
  patrimonio TEXT NOT NULL,
  numero_serie TEXT NOT NULL,
  fabricante TEXT NOT NULL,
  modelo TEXT NOT NULL,
  tipo_equipamento TEXT NOT NULL,
  status_atual TEXT NOT NULL CHECK (status_atual IN (
    'Em estoque', 'Em formatação', 'Em uso', 'Em manutenção',
    'Reservado para descarte', 'Descartado'
  )),
  localizacao_atual TEXT NOT NULL,
  responsavel_atual TEXT,
  data_entrada TEXT NOT NULL,
  observacoes_gerais TEXT,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Regra da secao 6 do prompt: patrimonio e S/N sao unicos ENQUANTO o ativo
-- nao estiver baixado. Depois de 'Descartado' o numero pode ser reutilizado.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ativos_patrimonio_vivo
  ON ativos(patrimonio) WHERE status_atual != 'Descartado';
CREATE UNIQUE INDEX IF NOT EXISTS ux_ativos_serie_vivo
  ON ativos(numero_serie) WHERE status_atual != 'Descartado';

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY,
  ativo_id INTEGER NOT NULL REFERENCES ativos(id),
  tipo TEXT NOT NULL CHECK (tipo IN (
    'Recebimento', 'Formatacao', 'Movimentacao', 'Manutencao',
    'Descarte', 'Retificacao'
  )),
  dados TEXT NOT NULL,
  autor_id INTEGER NOT NULL REFERENCES usuarios(id),
  autor_nome TEXT NOT NULL,
  data_hora TEXT NOT NULL,
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  evento_ref INTEGER REFERENCES eventos(id),
  hash_anterior TEXT,
  hash TEXT NOT NULL,
  anonimizado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS ix_eventos_ativo ON eventos(ativo_id, id);

-- Trilha imutavel (secao 7): nenhum UPDATE e permitido, exceto o padrao
-- estrito de anonimizacao LGPD (marca anonimizado=1 sem tocar na estrutura
-- do evento nem na cadeia de hashes). DELETE nunca e permitido.
CREATE TRIGGER IF NOT EXISTS trg_eventos_imutavel
BEFORE UPDATE ON eventos
WHEN NOT (
  NEW.anonimizado = 1
  AND OLD.hash = NEW.hash
  AND OLD.tipo = NEW.tipo
  AND OLD.ativo_id = NEW.ativo_id
  AND OLD.autor_id = NEW.autor_id
  AND OLD.data_hora = NEW.data_hora
  AND OLD.status_novo = NEW.status_novo
  AND OLD.status_anterior IS NEW.status_anterior
  AND OLD.hash_anterior IS NEW.hash_anterior
  AND OLD.evento_ref IS NEW.evento_ref
  AND OLD.criado_em = NEW.criado_em
)
BEGIN
  SELECT RAISE(ABORT, 'trilha de auditoria e imutavel: registre uma Retificacao');
END;

CREATE TRIGGER IF NOT EXISTS trg_eventos_sem_delete
BEFORE DELETE ON eventos
BEGIN
  SELECT RAISE(ABORT, 'trilha de auditoria e imutavel: eventos nunca sao apagados');
END;

CREATE TABLE IF NOT EXISTS aprovacoes (
  id INTEGER PRIMARY KEY,
  ativo_id INTEGER NOT NULL REFERENCES ativos(id),
  payload TEXT NOT NULL,
  solicitante_id INTEGER NOT NULL REFERENCES usuarios(id),
  solicitante_nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'rejeitado')),
  aprovador_id INTEGER REFERENCES usuarios(id),
  justificativa TEXT,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decidido_em TEXT
);
`;

function abrirBanco(caminho) {
  if (caminho !== ':memory:') {
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
  }
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function emTransacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}

module.exports = { abrirBanco, emTransacao };
