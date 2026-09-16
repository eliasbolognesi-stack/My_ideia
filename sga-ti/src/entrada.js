'use strict';

// Limpeza da entrada, antes de qualquer validação de negócio.
//
// Motivo: caracteres invisíveis e de controle são usados para esconder texto
// (inclusive instruções destinadas a um agente de IA) dentro de um campo que,
// na tela, parece inofensivo. Aqui eles são removidos e o tamanho é limitado.

const config = require('./config');

// Controles C0/C1 (menos tabulação, nova linha e retorno), marcas de direção
// de texto, espaços de largura zero e a marca de ordem de bytes.
const INVISIVEIS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
  + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]',
  'g'
);

function limparTexto(valor, tamanhoMaximo = config.tamanhoMaximoCampo) {
  const limpo = String(valor)
    .normalize('NFC')
    .replace(INVISIVEIS, '')
    .trim();
  return limpo.length > tamanhoMaximo ? limpo.slice(0, tamanhoMaximo) : limpo;
}

function contemInvisiveis(valor) {
  INVISIVEIS.lastIndex = 0;
  return INVISIVEIS.test(String(valor));
}

// Percorre o corpo da requisição inteiro limpando todo texto. Devolve também
// quantos campos traziam caracteres escondidos, para o registro de segurança.
function limparProfundo(valor, relatorio = { suspeitos: 0 }, profundidade = 0) {
  if (profundidade > 8) return null;
  if (typeof valor === 'string') {
    if (contemInvisiveis(valor)) relatorio.suspeitos += 1;
    return limparTexto(valor);
  }
  if (Array.isArray(valor)) {
    return valor.slice(0, 200).map((item) => limparProfundo(item, relatorio, profundidade + 1));
  }
  if (valor && typeof valor === 'object') {
    const saida = {};
    for (const [chave, item] of Object.entries(valor)) {
      saida[limparTexto(chave, 100)] = limparProfundo(item, relatorio, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

// Esquemas que nunca fazem sentido como evidência e que viram execução de
// código se alguém transformar o campo em link mais adiante.
const ESQUEMAS_PROIBIDOS = /^\s*(javascript|data|vbscript|file|blob):/i;

// Evidência de descarte: quando for um endereço da internet, só aceita https
// e, se houver lista de domínios configurada, só os domínios da empresa.
// Número de termo e nome de arquivo continuam valendo normalmente.
function validarEvidencia(evidencia, dominiosPermitidos = config.dominiosEvidencia) {
  const texto = String(evidencia || '').trim();
  if (ESQUEMAS_PROIBIDOS.test(texto)) {
    return 'evidencia usa um esquema não permitido: informe nº do termo, nome do arquivo ou link https';
  }
  // Sem "://" não é endereço: é nº de termo ou nome de arquivo, e isso vale.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) return null;

  let endereco;
  try {
    endereco = new URL(texto);
  } catch {
    return 'evidencia parece um endereço da internet, mas é inválida';
  }
  if (endereco.protocol !== 'https:') {
    return 'evidencia em endereço da internet deve usar https';
  }
  if (dominiosPermitidos.length) {
    const host = endereco.hostname.toLowerCase();
    const permitido = dominiosPermitidos.some((dominio) => {
      const alvo = dominio.toLowerCase();
      return host === alvo || host.endsWith(`.${alvo}`);
    });
    if (!permitido) {
      return `evidencia deve apontar para um domínio autorizado (${dominiosPermitidos.join(', ')})`;
    }
  }
  return null;
}

module.exports = { limparTexto, contemInvisiveis, limparProfundo, validarEvidencia };
