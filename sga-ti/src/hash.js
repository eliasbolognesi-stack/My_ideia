'use strict';

const { createHash } = require('node:crypto');

// Serialização canônica: chaves ordenadas em todos os níveis, para que o
// mesmo conteúdo produza sempre o mesmo hash.
function canonico(valor) {
  if (valor === null || valor === undefined) return 'null';
  if (Array.isArray(valor)) {
    return '[' + valor.map(canonico).join(',') + ']';
  }
  if (typeof valor === 'object') {
    const chaves = Object.keys(valor).sort();
    return '{' + chaves.map((c) => JSON.stringify(c) + ':' + canonico(valor[c])).join(',') + '}';
  }
  return JSON.stringify(valor);
}

// Hash de um evento, encadeado ao hash do evento anterior do mesmo ativo
// (seção 7 do prompt — cadeia verificável).
function hashEvento({ ativoId, tipo, dados, autorId, dataHora, statusAnterior, statusNovo, hashAnterior }) {
  const corpo = canonico({
    ativo_id: ativoId,
    tipo,
    dados,
    autor_id: autorId,
    data_hora: dataHora,
    status_anterior: statusAnterior ?? null,
    status_novo: statusNovo,
    hash_anterior: hashAnterior ?? null,
  });
  return createHash('sha256').update(corpo, 'utf8').digest('hex');
}

module.exports = { canonico, hashEvento };
