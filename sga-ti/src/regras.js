'use strict';

// Regras de negócio do SGA-TI, espelhando as seções 4, 5 e 6 do prompt de
// sistema. Nenhuma função aqui grava nada: recebem dados e devolvem a lista
// de erros (vazia = evento válido) ou o novo estado calculado do ativo.

const STATUS = {
  EM_ESTOQUE: 'Em estoque',
  EM_FORMATACAO: 'Em formatação',
  EM_USO: 'Em uso',
  EM_MANUTENCAO: 'Em manutenção',
  RESERVADO_DESCARTE: 'Reservado para descarte',
  DESCARTADO: 'Descartado',
};

const TIPOS_EVENTO = ['Recebimento', 'Formatacao', 'Movimentacao', 'Manutencao', 'Descarte', 'Retificacao'];

const TIPOS_DESTINO = ['colaborador', 'estoque', 'assistencia', 'fornecedor'];

const TIPOS_EQUIPAMENTO = ['Notebook', 'Desktop', 'Monitor', 'Periférico'];

function vazio(valor) {
  return valor === undefined || valor === null || String(valor).trim() === '';
}

function exigir(dados, campos, erros) {
  for (const campo of campos) {
    if (vazio(dados[campo])) erros.push(`campo obrigatório ausente: ${campo}`);
  }
}

function validarRecebimento(dados) {
  const erros = [];
  exigir(dados, ['patrimonio', 'numero_serie', 'fabricante', 'modelo', 'tipo_equipamento', 'quem_recebeu', 'fornecedor_origem'], erros);
  return erros;
}

function validarFormatacao(dados) {
  const erros = [];
  exigir(dados, ['tecnico', 'motivo'], erros);
  // "confirmação de backup/limpeza de dados anteriores" é obrigatória (seção 5)
  if (dados.confirmacao_backup !== true && dados.confirmacao_backup !== 'true') {
    erros.push('é obrigatório confirmar o backup/limpeza de dados anteriores (confirmacao_backup)');
  }
  return erros;
}

function validarMovimentacao(dados) {
  const erros = [];
  // Seção 6: toda movimentação exige quem entrega E quem recebe.
  exigir(dados, ['origem', 'destino', 'quem_entrega', 'quem_recebe', 'tipo_destino'], erros);
  if (!vazio(dados.tipo_destino) && !TIPOS_DESTINO.includes(dados.tipo_destino)) {
    erros.push(`tipo_destino inválido: use ${TIPOS_DESTINO.join(', ')}`);
  }
  return erros;
}

function validarManutencao(dados) {
  const erros = [];
  exigir(dados, ['tecnico', 'problema_relatado', 'solucao_aplicada'], erros);
  return erros;
}

function validarDescarte(dados, ativo) {
  const erros = [];
  exigir(dados, ['motivo', 'aprovador', 'evidencia'], erros);

  // Seção 6/13: nunca descartar sem patrimônio e S/N preenchidos E conferidos.
  // A conferência exige redigitar os dois valores, que precisam bater com o
  // cadastro do ativo.
  if (vazio(dados.patrimonio_confirmado) || vazio(dados.numero_serie_confirmado)) {
    erros.push('descarte exige a conferência explícita de patrimonio_confirmado e numero_serie_confirmado');
  } else if (ativo) {
    if (String(dados.patrimonio_confirmado).trim() !== String(ativo.patrimonio)) {
      erros.push(`patrimonio_confirmado não confere com o cadastro (${ativo.patrimonio})`);
    }
    if (String(dados.numero_serie_confirmado).trim() !== String(ativo.numero_serie)) {
      erros.push(`numero_serie_confirmado não confere com o cadastro (${ativo.numero_serie})`);
    }
  }

  // Seção 6: baixa só após limpeza segura de dados, ou registro formal da
  // dispensa (equipamento sem mídia de dados, por exemplo).
  if (dados.limpeza_dados === 'confirmada') {
    // ok — evidência já é obrigatória acima
  } else if (dados.limpeza_dados === 'dispensada') {
    if (vazio(dados.justificativa_dispensa)) {
      erros.push('dispensa de limpeza de dados exige justificativa_dispensa');
    }
  } else {
    erros.push("limpeza_dados deve ser 'confirmada' ou 'dispensada'");
  }
  return erros;
}

function validarRetificacao(dados) {
  const erros = [];
  exigir(dados, ['evento_ref', 'descricao'], erros);
  return erros;
}

const VALIDADORES = {
  Recebimento: validarRecebimento,
  Formatacao: validarFormatacao,
  Movimentacao: validarMovimentacao,
  Manutencao: validarManutencao,
  Descarte: validarDescarte,
  Retificacao: validarRetificacao,
};

// Calcula o efeito de cada evento sobre o ativo (status/localização/
// responsável). Retorna { statusNovo, mudancas } — mudancas são colunas do
// ativo a atualizar.
function efeitoDoEvento(tipo, dados, ativo) {
  switch (tipo) {
    case 'Recebimento':
      return { statusNovo: STATUS.EM_ESTOQUE, mudancas: {} };

    case 'Formatacao': {
      // Formatação registrada como ação concluída: pré-descarte reserva o
      // ativo para baixa; demais motivos devolvem ao estoque, pronto para uso.
      const preDescarte = String(dados.motivo || '').toLowerCase().includes('descarte');
      return {
        statusNovo: preDescarte ? STATUS.RESERVADO_DESCARTE : STATUS.EM_ESTOQUE,
        mudancas: { responsavel_atual: null },
      };
    }

    case 'Movimentacao': {
      switch (dados.tipo_destino) {
        case 'colaborador':
          return {
            statusNovo: STATUS.EM_USO,
            mudancas: { responsavel_atual: dados.quem_recebe, localizacao_atual: dados.destino },
          };
        case 'estoque':
          return {
            statusNovo: STATUS.EM_ESTOQUE,
            mudancas: { responsavel_atual: null, localizacao_atual: dados.destino },
          };
        case 'assistencia':
          return {
            statusNovo: STATUS.EM_MANUTENCAO,
            mudancas: { localizacao_atual: dados.destino },
          };
        case 'fornecedor':
          // Logística reversa: o equipamento sai fisicamente, mas a baixa
          // definitiva continua exigindo um evento de Descarte (seção 2).
          return {
            statusNovo: STATUS.RESERVADO_DESCARTE,
            mudancas: { responsavel_atual: null, localizacao_atual: dados.destino },
          };
        default:
          return { statusNovo: ativo.status_atual, mudancas: {} };
      }
    }

    case 'Manutencao':
      // Intervenção técnica sem troca de responsável (seção 2): o registro é
      // da ação concluída, o status não muda.
      return { statusNovo: ativo.status_atual, mudancas: {} };

    case 'Descarte':
      return {
        statusNovo: STATUS.DESCARTADO,
        mudancas: { responsavel_atual: null },
      };

    case 'Retificacao':
      return { statusNovo: ativo.status_atual, mudancas: {} };

    default:
      throw new Error(`tipo de evento desconhecido: ${tipo}`);
  }
}

module.exports = {
  STATUS,
  TIPOS_EVENTO,
  TIPOS_DESTINO,
  TIPOS_EQUIPAMENTO,
  VALIDADORES,
  efeitoDoEvento,
  vazio,
};
