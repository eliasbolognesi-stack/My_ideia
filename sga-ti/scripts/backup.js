#!/usr/bin/env node
'use strict';

// Cópia de segurança do banco do SGA-TI.
//
// Usa o comando VACUUM INTO do SQLite: ele gera um arquivo novo, já compactado
// e internamente consistente, mesmo com o sistema no ar e gravando. Copiar o
// arquivo .db "na mão" enquanto o servidor escreve pode gerar uma cópia
// corrompida — por isso este script existe.
//
// Uso:
//   node scripts/backup.js                  # grava em data/backups/
//   node scripts/backup.js /mnt/backup      # grava na pasta indicada
//   SGA_TI_BACKUP_MANTER_DIAS=30 node scripts/backup.js
//
// Agende uma vez por dia (cron/systemd) e guarde uma cópia FORA deste servidor:
// backup no mesmo disco não protege contra perda do disco.
//   0 2 * * *  cd /opt/sga-ti && node scripts/backup.js >> data/backup.log 2>&1

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

const destino = process.argv[2] || path.join(path.dirname(config.caminhoBanco), 'backups');
const manterDias = Number(process.env.SGA_TI_BACKUP_MANTER_DIAS || 30);
const PREFIXO = 'sga-ti-';

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function tamanhoLegivel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function removerAntigos() {
  const limite = Date.now() - manterDias * 24 * 3600 * 1000;
  let removidos = 0;
  for (const arquivo of fs.readdirSync(destino)) {
    if (!arquivo.startsWith(PREFIXO) || !arquivo.endsWith('.db')) continue;
    const caminho = path.join(destino, arquivo);
    if (fs.statSync(caminho).mtimeMs < limite) {
      fs.unlinkSync(caminho);
      removidos += 1;
    }
  }
  return removidos;
}

function principal() {
  if (!fs.existsSync(config.caminhoBanco)) {
    console.error(`Banco não encontrado: ${config.caminhoBanco}`);
    process.exit(1);
  }
  fs.mkdirSync(destino, { recursive: true });

  const arquivo = path.join(destino, `${PREFIXO}${carimbo()}.db`);
  if (fs.existsSync(arquivo)) {
    console.error(`Já existe uma cópia com este nome: ${arquivo}`);
    process.exit(1);
  }

  const db = new DatabaseSync(config.caminhoBanco, { readOnly: true });
  try {
    // Aspas simples duplicadas: é assim que o SQLite escapa aspas em literal.
    db.exec(`VACUUM INTO '${arquivo.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // Confere que a cópia abre e que a trilha veio junto — cópia que não
  // restaura não é cópia.
  const copia = new DatabaseSync(arquivo, { readOnly: true });
  let eventos = 0;
  let ativos = 0;
  try {
    const integridade = copia.prepare('PRAGMA integrity_check').get();
    const resultado = Object.values(integridade)[0];
    if (resultado !== 'ok') throw new Error(`verificação do SQLite falhou: ${resultado}`);
    eventos = copia.prepare('SELECT COUNT(*) AS total FROM eventos').get().total;
    ativos = copia.prepare('SELECT COUNT(*) AS total FROM ativos').get().total;
  } finally {
    copia.close();
  }

  const bytes = fs.statSync(arquivo).size;
  const removidos = removerAntigos();
  console.log(`[${new Date().toISOString()}] cópia gerada: ${arquivo}`);
  console.log(`  ${tamanhoLegivel(bytes)} · ${ativos} ativo(s) · ${eventos} evento(s) · verificação do SQLite: ok`);
  if (removidos) console.log(`  ${removidos} cópia(s) com mais de ${manterDias} dias removida(s)`);
}

principal();
