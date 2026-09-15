'use strict';

// Tradução do JSON de saída do assistente SGA-TI (seção 10 do prompt de
// sistema) para os eventos internos do sistema. O n8n envia esse JSON no
// POST /api/webhook/n8n; aqui ele vira { tipo, dados } e passa pelas MESMAS
// validações da UI — o webhook nunca relaxa uma regra.

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// "Logistica Reversa" e "enviar para assistencia" aparecem no JSON da seção
// 10 mas não têm regras próprias nas seções 2/5 — aqui são tratados como
// movimentações com destino fornecedor/assistência, mantendo a rastreabilidade.
const MAPA_EVENTOS = {
  recebimento: 'Recebimento',
  formatacao: 'Formatacao',
  movimentacao: 'Movimentacao',
  manutencao: 'Manutencao',
  descarte: 'Descarte',
  retificacao: 'Retificacao',
  'logistica reversa': 'Movimentacao:fornecedor',
  'enviar para assistencia': 'Movimentacao:assistencia',
  'envio para assistencia': 'Movimentacao:assistencia',
};

function mapearEventoN8n(corpo) {
  const chave = normalizar(corpo.evento);
  const mapeado = MAPA_EVENTOS[chave];
  if (!mapeado) {
    return { erro: `evento desconhecido: "${corpo.evento}". Aceitos: ${Object.keys(MAPA_EVENTOS).join(', ')}` };
  }
  const [tipo, destinoForcado] = mapeado.split(':');
  const ativo = corpo.ativo || {};

  // Campos extras enviados no corpo (motivo, confirmacao_backup, tecnico,
  // problema_relatado, limpeza_dados etc.) são preservados: o prompt do n8n
  // pode ser estendido para incluí-los e o sistema os exige na validação.
  const extras = { ...corpo };
  delete extras.evento;
  delete extras.ativo;

  const base = {
    ...extras,
    patrimonio: ativo.patrimonio,
    numero_serie: ativo.numero_serie,
    data_hora: corpo.data_hora || undefined,
    observacoes: corpo.observacoes || undefined,
  };

  switch (tipo) {
    case 'Recebimento':
      return {
        tipo,
        dados: {
          ...base,
          fabricante: ativo.fabricante,
          modelo: ativo.modelo,
          tipo_equipamento: ativo.tipo_equipamento,
          quem_recebeu: corpo.responsavel_recebendo || corpo.responsavel_acao,
          fornecedor_origem: corpo.origem,
          evidencia: corpo.evidencia || undefined,
        },
      };

    case 'Formatacao':
      return {
        tipo,
        dados: {
          ...base,
          tecnico: corpo.tecnico || corpo.responsavel_acao,
          motivo: corpo.motivo,
          confirmacao_backup: corpo.confirmacao_backup === true || corpo.confirmacao_backup === 'true',
        },
      };

    case 'Movimentacao': {
      const tipoDestino = destinoForcado || corpo.tipo_destino || (corpo.responsavel_recebendo ? 'colaborador' : 'estoque');
      return {
        tipo,
        dados: {
          ...base,
          origem: corpo.origem,
          destino: corpo.destino,
          quem_entrega: corpo.quem_entrega || corpo.responsavel_acao,
          quem_recebe: corpo.quem_recebe || corpo.responsavel_recebendo,
          tipo_destino: tipoDestino,
        },
      };
    }

    case 'Manutencao':
      return {
        tipo,
        dados: {
          ...base,
          tecnico: corpo.tecnico || corpo.responsavel_acao,
          problema_relatado: corpo.problema_relatado,
          solucao_aplicada: corpo.solucao_aplicada,
        },
      };

    case 'Descarte':
      return {
        tipo,
        dados: {
          ...base,
          motivo: corpo.motivo,
          aprovador: corpo.aprovador,
          evidencia: corpo.evidencia,
          limpeza_dados: corpo.limpeza_dados,
          justificativa_dispensa: corpo.justificativa_dispensa,
          // No fluxo conversacional o operador já ditou patrimônio e S/N ao
          // assistente — o JSON os traz e eles são conferidos contra o cadastro.
          patrimonio_confirmado: ativo.patrimonio,
          numero_serie_confirmado: ativo.numero_serie,
        },
      };

    case 'Retificacao':
      return {
        tipo,
        dados: {
          ...base,
          evento_ref: corpo.evento_ref,
          descricao: corpo.descricao || corpo.observacoes,
        },
      };

    default:
      return { erro: `tipo não implementado: ${tipo}` };
  }
}

module.exports = { mapearEventoN8n };
