'use strict';

// Observabilidade — envio de rastros para o Langfuse.
//
// POR QUE OpenTelemetry E NÃO A API DE INGESTÃO DO LANGFUSE
// A API `/api/public/ingestion` do Langfuse é desligada em 16/11/2026 (só
// eventos de `score` continuam). O caminho recomendado passou a ser o endpoint
// OpenTelemetry, que o Langfuse expõe em `/api/public/otel/v1/traces` e que
// aceita OTLP sobre HTTP **com JSON** — não só protobuf. É isso que permite
// exportar com o `fetch` embutido do Node e manter o "zero dependências" do
// projeto, que é o que blindou a auditoria de segurança.
//
// TRÊS REGRAS INEGOCIÁVEIS
// 1. Desligado por padrão: sem as variáveis de ambiente, não faz nada.
// 2. Nunca derruba nem atrasa uma requisição. Envio disparado e esquecido, com
//    prazo curto e `catch` em tudo. Observabilidade que derruba o sistema
//    observado é pior do que não ter observabilidade.
// 3. Privacidade primeiro. No padrão (`metadados`) saem apenas nomes de campo,
//    contagens e resultado — nunca nome, e-mail ou matrícula de ninguém.

const { randomBytes } = require('node:crypto');
const config = require('./config');
const { version: VERSAO } = require('../package.json');

const ligado = Boolean(config.langfuseUrl && config.langfuseChavePublica && config.langfuseChaveSecreta);
const mandaConteudo = config.obsConteudo === 'completo';
const PRAZO_MS = 3000;

let avisouFalha = false;

function avisarUmaVez(erro) {
  if (avisouFalha) return;
  avisouFalha = true;
  console.warn(`[observabilidade] envio ao Langfuse falhou (os próximos erros ficam em silêncio): ${erro.message}`);
}

// --- identificadores no formato do OpenTelemetry ----------------------------
const novoTraceId = () => randomBytes(16).toString('hex'); // 32 caracteres
const novoSpanId = () => randomBytes(8).toString('hex');   // 16 caracteres

// Cabeçalho `traceparent` do padrão W3C: "00-<trace 32>-<span 16>-<flags 2>".
// É por ele que o rastro aberto no n8n continua aqui dentro, em vez de virarem
// dois rastros soltos que ninguém consegue ligar depois.
function lerTraceparent(valor) {
  const casa = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(String(valor || '').trim());
  if (!casa) return null;
  const traceId = casa[1].toLowerCase();
  const spanId = casa[2].toLowerCase();
  // Tudo zero é o identificador nulo do padrão: vale como ausente.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanPai: spanId };
}

function montarTraceparent(traceId, spanId) {
  return `00-${traceId}-${spanId}-01`;
}

// --- atributos no formato OTLP/JSON -----------------------------------------
function atributo(chave, valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return Number.isInteger(valor)
      ? { key: chave, value: { intValue: String(valor) } }
      : { key: chave, value: { doubleValue: valor } };
  }
  if (typeof valor === 'boolean') return { key: chave, value: { boolValue: valor } };
  return { key: chave, value: { stringValue: String(valor) } };
}

function listaDeAtributos(objeto) {
  return Object.entries(objeto).map(([c, v]) => atributo(c, v)).filter(Boolean);
}

/**
 * Resume os dados de um evento para o rastro.
 *
 * No modo padrão sai apenas a ESTRUTURA — quais campos vieram e quantos —,
 * nunca o conteúdo. "quem_recebeu" é nome de campo; "Maria Souza" é dado
 * pessoal, e dado pessoal só sai daqui com decisão consciente
 * (SGA_TI_OBS_CONTEUDO=completo) e Langfuse próprio, porque mandá-lo para um
 * serviço em nuvem é transferência de dado pessoal a terceiro.
 */
function resumirDados(dados) {
  if (!dados || typeof dados !== 'object') return null;
  if (mandaConteudo) return JSON.stringify(dados);
  return JSON.stringify({
    campos: Object.keys(dados).sort(),
    total_de_campos: Object.keys(dados).length,
  });
}

// --- envio -------------------------------------------------------------------
function enviar(spans) {
  if (!ligado || !spans.length) return;

  const corpo = {
    resourceSpans: [{
      resource: {
        attributes: listaDeAtributos({
          'service.name': 'sga-ti',
          'service.version': VERSAO,
          'deployment.environment': config.producao ? 'producao' : 'desenvolvimento',
        }),
      },
      scopeSpans: [{ scope: { name: 'sga-ti', version: VERSAO }, spans }],
    }],
  };

  const credencial = Buffer
    .from(`${config.langfuseChavePublica}:${config.langfuseChaveSecreta}`)
    .toString('base64');

  // Sem `await`: a resposta ao usuário não espera o Langfuse. O prazo curto
  // evita deixar conexão pendurada quando o destino está fora do ar.
  fetch(`${config.langfuseUrl.replace(/\/$/, '')}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credencial}`,
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(PRAZO_MS),
  })
    .then((resposta) => {
      if (!resposta.ok) avisarUmaVez(new Error(`o Langfuse respondeu ${resposta.status}`));
      // O corpo precisa ser consumido, senão a conexão fica presa.
      return resposta.arrayBuffer().catch(() => null);
    })
    .catch(avisarUmaVez);
}

/**
 * Abre um rastro (ou continua o que veio no `traceparent`).
 *
 * Devolve sempre um objeto com a mesma forma, mesmo desligado, para quem chama
 * não precisar de `if` em volta.
 */
function iniciar(nome, { traceparent = null, usuario = null, atributos = {} } = {}) {
  if (!ligado) return { traceparent: null, concluir() {}, falhar() {} };

  const pai = lerTraceparent(traceparent);
  const traceId = pai ? pai.traceId : novoTraceId();
  const spanId = novoSpanId();
  const inicio = process.hrtime.bigint();
  const inicioRelogio = BigInt(Date.now()) * 1000000n;

  const finalizar = (status, extras) => {
    const decorrido = process.hrtime.bigint() - inicio;
    const span = {
      traceId,
      spanId,
      name: nome,
      kind: 2, // SERVER: este span atende um pedido que veio de fora.
      startTimeUnixNano: String(inicioRelogio),
      endTimeUnixNano: String(inicioRelogio + decorrido),
      attributes: listaDeAtributos({
        // Nomes que o Langfuse entende e usa para montar a tela.
        'langfuse.trace.name': nome,
        ...(usuario ? { 'user.id': usuario } : {}),
        ...atributos,
        ...extras,
        'sga_ti.duracao_ms': Number(decorrido / 1000000n),
      }),
      status,
    };
    if (pai) span.parentSpanId = pai.spanPai;
    enviar([span]);
  };

  return {
    // Para repassar adiante, se um dia houver outro salto na cadeia.
    traceparent: montarTraceparent(traceId, spanId),

    concluir(extras = {}) {
      finalizar({ code: 1 }, extras); // 1 = OK
    },

    // Erro de validação é resultado legítimo do sistema, não falha dele: o
    // rastro precisa distinguir "recusei porque faltou patrimônio" de "quebrei".
    falhar(erro, extras = {}) {
      finalizar(
        { code: 2, message: String(erro && erro.message ? erro.message : erro).slice(0, 300) },
        extras
      );
    },
  };
}

module.exports = {
  ligado,
  iniciar,
  resumirDados,
  lerTraceparent,
  montarTraceparent,
};
