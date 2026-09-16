'use strict';

// Registro de eventos de SEGURANÇA — separado da trilha de auditoria de
// negócio, que vive no banco. Fica em arquivo próprio para sobreviver a um
// comprometimento do banco e para poder ser copiado para fora do servidor.
//
// Uma linha JSON por evento (formato "JSON Lines"), pronto para ser lido por
// qualquer coletor de logs.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

let fluxo = null;
let avisouFalha = false;

function abrirFluxo() {
  if (fluxo || !config.arquivoRegistroSeguranca) return fluxo;
  try {
    fs.mkdirSync(path.dirname(config.arquivoRegistroSeguranca), { recursive: true });
    fluxo = fs.createWriteStream(config.arquivoRegistroSeguranca, { flags: 'a' });
    fluxo.on('error', (erro) => {
      if (!avisouFalha) {
        console.error('[seguranca] não foi possível escrever o registro:', erro.message);
        avisouFalha = true;
      }
      fluxo = null;
    });
  } catch (erro) {
    if (!avisouFalha) {
      console.error('[seguranca] não foi possível abrir o registro:', erro.message);
      avisouFalha = true;
    }
    fluxo = null;
  }
  return fluxo;
}

// Nunca registrar o conteúdo de um segredo: só o suficiente para investigar.
function resumirSegredo(valor) {
  const texto = String(valor || '');
  if (!texto) return 'ausente';
  return `${texto.length} caracteres, começa com "${texto.slice(0, 3)}"`;
}

/**
 * @param {string} tipo  ex.: 'login_falho', 'acesso_negado', 'limite_excedido'
 * @param {object} detalhes  campos livres (sem dados sensíveis)
 */
function seguranca(tipo, detalhes = {}) {
  const linha = JSON.stringify({ momento: new Date().toISOString(), tipo, ...detalhes });
  const destino = abrirFluxo();
  if (destino) destino.write(`${linha}\n`);
  // Espelha na saída padrão para quem coleta log de container.
  console.warn(`[seguranca] ${linha}`);
}

module.exports = { seguranca, resumirSegredo };
