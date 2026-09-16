'use strict';

// Registro de eventos de SEGURANÇA — separado da trilha de auditoria de
// negócio, que vive no banco. Fica em arquivo próprio para sobreviver a um
// comprometimento do banco e para poder ser copiado para fora do servidor.
//
// Uma linha JSON por evento (formato "JSON Lines"), pronto para ser lido por
// qualquer coletor de logs.
//
// A escrita é SÍNCRONA de propósito. Registro de segurança que se perde numa
// queda do processo não serve como prova, e fluxo assíncrono ainda tornava a
// rotação incorreta: num lote de eventos seguidos o arquivo sequer existia em
// disco na hora de rotacionar. O volume aqui é de poucos eventos por minuto,
// então o custo de bloquear é irrelevante perto da garantia.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

let avisouFalha = false;
let pastaPronta = false;

// Piso de 10 kB apenas para barrar zero ou valor negativo — não para impor um
// tamanho grande, senão a configuração perde o sentido.
const tamanhoMaximo = Math.max(0.01, config.tamanhoMaximoLogMB) * 1024 * 1024;
const arquivosMantidos = Math.max(1, config.arquivosLogMantidos);

function avisarUmaVez(mensagem, erro) {
  if (avisouFalha) return;
  console.error(`[seguranca] ${mensagem}: ${erro.message}`);
  avisouFalha = true;
}

// seguranca.log -> .1 -> .2 ... descartando o mais antigo. Nomes numerados (e
// não datados) para o coletor de logs saber sempre onde olhar.
function rotacionar() {
  const base = config.arquivoRegistroSeguranca;
  const maisAntigo = `${base}.${arquivosMantidos}`;
  if (fs.existsSync(maisAntigo)) fs.unlinkSync(maisAntigo);
  for (let i = arquivosMantidos - 1; i >= 1; i--) {
    const origem = `${base}.${i}`;
    if (fs.existsSync(origem)) fs.renameSync(origem, `${base}.${i + 1}`);
  }
  if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
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
  const linha = `${JSON.stringify({ momento: new Date().toISOString(), tipo, ...detalhes })}\n`;
  const arquivo = config.arquivoRegistroSeguranca;

  if (arquivo) {
    try {
      if (!pastaPronta) {
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        pastaPronta = true;
      }
      // O tamanho vem do disco, não de um contador em memória: assim a
      // rotação continua certa depois de um reinício do processo.
      const tamanhoAtual = fs.existsSync(arquivo) ? fs.statSync(arquivo).size : 0;
      if (tamanhoAtual > 0 && tamanhoAtual + Buffer.byteLength(linha) > tamanhoMaximo) rotacionar();
      fs.appendFileSync(arquivo, linha);
    } catch (erro) {
      avisarUmaVez('não foi possível escrever o registro', erro);
    }
  }

  // Espelha na saída padrão para quem coleta log de container.
  console.warn(`[seguranca] ${linha.trimEnd()}`);
}

module.exports = { seguranca, resumirSegredo, rotacionar };
