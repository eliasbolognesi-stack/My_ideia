'use strict';

// Migrações de esquema.
//
// O esquema base (db.js) usa CREATE TABLE IF NOT EXISTS, o que resolve o
// primeiro boot e só ele: a partir da segunda mudança, com dados em produção,
// é preciso um caminho que saiba o que já foi aplicado. É isso aqui.
//
// O número da última migração aplicada mora no próprio banco, em
// `PRAGMA user_version` — não numa tabela de controle. É um inteiro que o
// SQLite guarda no cabeçalho do arquivo: viaja junto com a cópia de segurança
// e não depende de nenhuma tabela nossa existir.
//
// Regras:
//   - um arquivo por migração, nomeado NNN-descricao.sql, aplicado em ordem;
//   - cada arquivo roda UMA vez, dentro de transação;
//   - se um falhar, a transação desfaz e o erro sobe — o servidor não sobe
//     com o banco pela metade;
//   - migração aplicada nunca é editada. Corrige-se com uma nova.

const fs = require('node:fs');
const path = require('node:path');

const PASTA_PADRAO = path.join(__dirname, '..', 'migracoes');
const NOME_VALIDO = /^(\d{3})-([a-z0-9-]+)\.sql$/;

function listarMigracoes(pasta) {
  if (!fs.existsSync(pasta)) return [];

  const arquivos = fs.readdirSync(pasta).filter((nome) => nome.endsWith('.sql'));
  const migracoes = [];

  for (const nome of arquivos) {
    const casa = NOME_VALIDO.exec(nome);
    if (!casa) {
      // Arquivo com nome fora do padrão seria pulado em silêncio, e uma
      // migração que ninguém aplicou é pior do que um erro no boot.
      throw new Error(
        `migração com nome inválido: "${nome}". Use NNN-descricao.sql, `
        + 'por exemplo 002-indice-de-busca.sql'
      );
    }
    migracoes.push({ numero: Number(casa[1]), nome, caminho: path.join(pasta, nome) });
  }

  migracoes.sort((a, b) => a.numero - b.numero);

  for (let i = 1; i < migracoes.length; i++) {
    if (migracoes[i].numero === migracoes[i - 1].numero) {
      throw new Error(
        `duas migrações com o número ${migracoes[i].numero}: `
        + `"${migracoes[i - 1].nome}" e "${migracoes[i].nome}". A ordem ficaria indefinida.`
      );
    }
  }

  return migracoes;
}

function versaoAtual(db) {
  const { user_version: versao } = db.prepare('PRAGMA user_version').get();
  return Number(versao) || 0;
}

/**
 * Aplica o que ainda falta e devolve o relatório do que foi feito.
 * @returns {{de: number, para: number, aplicadas: string[]}}
 */
function aplicarMigracoes(db, pasta = PASTA_PADRAO) {
  const migracoes = listarMigracoes(pasta);
  const de = versaoAtual(db);
  const pendentes = migracoes.filter((m) => m.numero > de);
  const aplicadas = [];

  for (const migracao of pendentes) {
    const sql = fs.readFileSync(migracao.caminho, 'utf8');

    // BEGIN IMMEDIATE pega a trava de escrita já na abertura: se outro
    // processo estiver subindo ao mesmo tempo, um dos dois falha aqui em vez
    // de os dois aplicarem a mesma migração.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      // PRAGMA não aceita parâmetro; o número vem do nome do arquivo, que já
      // passou pela expressão regular e é só dígito.
      db.exec(`PRAGMA user_version = ${migracao.numero}`);
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw new Error(`migração ${migracao.nome} falhou e foi desfeita: ${erro.message}`);
    }
    aplicadas.push(migracao.nome);
  }

  return { de, para: versaoAtual(db), aplicadas };
}

module.exports = { aplicarMigracoes, listarMigracoes, versaoAtual, PASTA_PADRAO };
