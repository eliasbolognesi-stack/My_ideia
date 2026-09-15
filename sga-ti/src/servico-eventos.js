'use strict';

const { emTransacao } = require('./db');
const { hashEvento } = require('./hash');
const { STATUS, VALIDADORES, efeitoDoEvento, vazio } = require('./regras');

class ErroDeValidacao extends Error {
  constructor(erros) {
    super(Array.isArray(erros) ? erros.join('; ') : String(erros));
    this.name = 'ErroDeValidacao';
    this.erros = Array.isArray(erros) ? erros : [String(erros)];
  }
}

function agoraISO() {
  return new Date().toISOString();
}

function buscarAtivo(db, dados, { incluirDescartados = false } = {}) {
  if (dados.ativo_id) {
    return db.prepare('SELECT * FROM ativos WHERE id = ?').get(Number(dados.ativo_id)) || null;
  }
  const chaves = [dados.identificador, dados.patrimonio, dados.numero_serie]
    .filter((v) => !vazio(v))
    .map((v) => String(v).trim());
  for (const chave of chaves) {
    const vivo = db
      .prepare("SELECT * FROM ativos WHERE (patrimonio = ? OR numero_serie = ?) AND status_atual != 'Descartado'")
      .get(chave, chave);
    if (vivo) return vivo;
  }
  if (incluirDescartados) {
    for (const chave of chaves) {
      const qualquer = db
        .prepare('SELECT * FROM ativos WHERE patrimonio = ? OR numero_serie = ? ORDER BY id DESC')
        .get(chave, chave);
      if (qualquer) return qualquer;
    }
  }
  return null;
}

// Insere um evento na trilha imutável, encadeado ao hash do evento anterior
// do mesmo ativo. Deve ser chamado dentro de uma transação.
function inserirEvento(db, { ativoId, tipo, dados, autor, dataHora, statusAnterior, statusNovo, eventoRef }) {
  // Round-trip por JSON: remove chaves undefined e garante que o objeto
  // usado no hash é byte a byte o mesmo que será gravado e depois relido
  // na verificação de integridade.
  dados = JSON.parse(JSON.stringify(dados ?? {}));
  const anterior = db
    .prepare('SELECT hash FROM eventos WHERE ativo_id = ? ORDER BY id DESC LIMIT 1')
    .get(ativoId);
  const hashAnterior = anterior ? anterior.hash : null;
  const hash = hashEvento({
    ativoId,
    tipo,
    dados,
    autorId: autor.id,
    dataHora,
    statusAnterior,
    statusNovo,
    hashAnterior,
  });
  const resultado = db
    .prepare(
      `INSERT INTO eventos
         (ativo_id, tipo, dados, autor_id, autor_nome, data_hora,
          status_anterior, status_novo, evento_ref, hash_anterior, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ativoId,
      tipo,
      JSON.stringify(dados),
      autor.id,
      autor.nome,
      dataHora,
      statusAnterior ?? null,
      statusNovo,
      eventoRef ?? null,
      hashAnterior,
      hash
    );
  return Number(resultado.lastInsertRowid);
}

function atualizarAtivo(db, ativoId, mudancas, statusNovo) {
  const colunas = ['status_atual = ?', "atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const valores = [statusNovo];
  for (const [coluna, valor] of Object.entries(mudancas)) {
    colunas.push(`${coluna} = ?`);
    valores.push(valor ?? null);
  }
  valores.push(ativoId);
  db.prepare(`UPDATE ativos SET ${colunas.join(', ')} WHERE id = ?`).run(...valores);
}

function registrarRecebimento(db, dados, autor) {
  const erros = VALIDADORES.Recebimento(dados);
  if (erros.length) throw new ErroDeValidacao(erros);

  const patrimonio = String(dados.patrimonio).trim();
  const numeroSerie = String(dados.numero_serie).trim();

  // Seção 6: nunca dois ativos vivos com o mesmo patrimônio ou S/N.
  const duplicado = db
    .prepare(
      "SELECT patrimonio, numero_serie FROM ativos WHERE (patrimonio = ? OR numero_serie = ?) AND status_atual != 'Descartado'"
    )
    .get(patrimonio, numeroSerie);
  if (duplicado) {
    throw new ErroDeValidacao([
      `já existe um ativo não baixado com patrimônio ${duplicado.patrimonio} / S/N ${duplicado.numero_serie}`,
    ]);
  }

  const dataHora = dados.data_hora || agoraISO();
  return emTransacao(db, () => {
    const resultado = db
      .prepare(
        `INSERT INTO ativos
           (patrimonio, numero_serie, fabricante, modelo, tipo_equipamento,
            status_atual, localizacao_atual, responsavel_atual, data_entrada, observacoes_gerais)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        patrimonio,
        numeroSerie,
        String(dados.fabricante).trim(),
        String(dados.modelo).trim(),
        String(dados.tipo_equipamento).trim(),
        STATUS.EM_ESTOQUE,
        dados.localizacao || 'Estoque TI',
        dados.data_entrada || dataHora.slice(0, 10),
        dados.observacoes || null
      );
    const ativoId = Number(resultado.lastInsertRowid);
    const eventoId = inserirEvento(db, {
      ativoId,
      tipo: 'Recebimento',
      dados,
      autor,
      dataHora,
      statusAnterior: null,
      statusNovo: STATUS.EM_ESTOQUE,
    });
    return { ativo_id: ativoId, evento_id: eventoId, status_novo: STATUS.EM_ESTOQUE };
  });
}

// Registra qualquer evento sobre um ativo existente. Para Descarte de um
// ativo 'Em uso', cria uma pendência de aprovação em vez de executar
// (seção 13), a menos que viaAprovacao=true (chamado por decidirAprovacao).
function registrarEvento(db, tipo, dados, autor, { viaAprovacao = false } = {}) {
  if (tipo === 'Recebimento') return registrarRecebimento(db, dados, autor);

  const validador = VALIDADORES[tipo];
  if (!validador) throw new ErroDeValidacao([`tipo de evento desconhecido: ${tipo}`]);

  const ativo = buscarAtivo(db, dados, { incluirDescartados: tipo === 'Retificacao' });
  if (!ativo) {
    throw new ErroDeValidacao(['ativo não encontrado: informe patrimônio ou número de série de um ativo cadastrado']);
  }
  if (ativo.status_atual === STATUS.DESCARTADO && tipo !== 'Retificacao') {
    throw new ErroDeValidacao([`ativo ${ativo.patrimonio} já está Descartado — status final, apenas Retificação é permitida`]);
  }

  const erros = tipo === 'Descarte' ? validador(dados, ativo) : validador(dados);
  if (erros.length) throw new ErroDeValidacao(erros);

  let eventoRef = null;
  if (tipo === 'Retificacao') {
    const original = db.prepare('SELECT id, ativo_id FROM eventos WHERE id = ?').get(Number(dados.evento_ref));
    if (!original) throw new ErroDeValidacao([`evento original ${dados.evento_ref} não existe`]);
    if (original.ativo_id !== ativo.id) {
      throw new ErroDeValidacao([`evento ${dados.evento_ref} não pertence ao ativo ${ativo.patrimonio}`]);
    }
    eventoRef = original.id;
  }

  // Seção 13: descarte de equipamento 'Em uso' vai para aprovação humana.
  if (tipo === 'Descarte' && ativo.status_atual === STATUS.EM_USO && !viaAprovacao) {
    const resultado = db
      .prepare(
        `INSERT INTO aprovacoes (ativo_id, payload, solicitante_id, solicitante_nome)
         VALUES (?, ?, ?, ?)`
      )
      .run(ativo.id, JSON.stringify(dados), autor.id, autor.nome);
    return {
      aprovacao_pendente: true,
      aprovacao_id: Number(resultado.lastInsertRowid),
      mensagem: `ativo ${ativo.patrimonio} consta como 'Em uso': o descarte foi encaminhado para aprovação humana`,
    };
  }

  const dataHora = dados.data_hora || agoraISO();
  const { statusNovo, mudancas } = efeitoDoEvento(tipo, dados, ativo);

  return emTransacao(db, () => {
    const eventoId = inserirEvento(db, {
      ativoId: ativo.id,
      tipo,
      dados,
      autor,
      dataHora,
      statusAnterior: ativo.status_atual,
      statusNovo,
      eventoRef,
    });
    if (statusNovo !== ativo.status_atual || Object.keys(mudancas).length) {
      atualizarAtivo(db, ativo.id, mudancas, statusNovo);
    }
    return {
      ativo_id: ativo.id,
      evento_id: eventoId,
      status_anterior: ativo.status_atual,
      status_novo: statusNovo,
    };
  });
}

function decidirAprovacao(db, aprovacaoId, decisao, justificativa, decisor) {
  if (!['aprovado', 'rejeitado'].includes(decisao)) {
    throw new ErroDeValidacao(["decisao deve ser 'aprovado' ou 'rejeitado'"]);
  }
  const aprovacao = db.prepare("SELECT * FROM aprovacoes WHERE id = ? AND status = 'pendente'").get(Number(aprovacaoId));
  if (!aprovacao) throw new ErroDeValidacao(['aprovação pendente não encontrada']);

  db.prepare(
    `UPDATE aprovacoes SET status = ?, aprovador_id = ?, justificativa = ?,
            decidido_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`
  ).run(decisao, decisor.id, justificativa || null, aprovacao.id);

  if (decisao === 'rejeitado') {
    return { aprovacao_id: aprovacao.id, decisao };
  }

  const dados = JSON.parse(aprovacao.payload);
  dados.aprovacao_id = aprovacao.id;
  dados.aprovador = decisor.nome; // quem de fato aprovou fica registrado no evento
  try {
    const resultado = registrarEvento(db, 'Descarte', dados, decisor, { viaAprovacao: true });
    return { aprovacao_id: aprovacao.id, decisao, ...resultado };
  } catch (erro) {
    // O descarte não se concretizou: devolve a pendência para nova análise.
    db.prepare(
      "UPDATE aprovacoes SET status = 'pendente', aprovador_id = NULL, justificativa = NULL, decidido_em = NULL WHERE id = ?"
    ).run(aprovacao.id);
    throw erro;
  }
}

// Recalcula a cadeia de hashes de um ativo (seção 7). Eventos anonimizados
// pela rotina LGPD têm o conteúdo pessoal substituído, então apenas o elo da
// cadeia é verificado para eles (o hash armazenado é preservado na
// anonimização, garantida pelo trigger de imutabilidade).
function verificarIntegridade(db, ativoId) {
  const eventos = db.prepare('SELECT * FROM eventos WHERE ativo_id = ? ORDER BY id').all(ativoId);
  const falhas = [];
  let hashAnterior = null;
  for (const evento of eventos) {
    if ((evento.hash_anterior ?? null) !== hashAnterior) {
      falhas.push(`evento ${evento.id}: elo da cadeia quebrado (hash_anterior não confere)`);
    }
    if (!evento.anonimizado) {
      const recalculado = hashEvento({
        ativoId: evento.ativo_id,
        tipo: evento.tipo,
        dados: JSON.parse(evento.dados),
        autorId: evento.autor_id,
        dataHora: evento.data_hora,
        statusAnterior: evento.status_anterior,
        statusNovo: evento.status_novo,
        hashAnterior: evento.hash_anterior,
      });
      if (recalculado !== evento.hash) {
        falhas.push(`evento ${evento.id}: conteúdo não confere com o hash registrado`);
      }
    }
    hashAnterior = evento.hash;
  }
  return { valida: falhas.length === 0, eventos_verificados: eventos.length, falhas };
}

const CAMPOS_PESSOAIS = [
  'quem_recebeu', 'quem_entrega', 'quem_recebe', 'tecnico', 'aprovador',
  'responsavel', 'responsavel_acao', 'responsavel_recebendo', 'solicitante',
];

// Anonimização LGPD (seção 8): para ativos baixados há mais de `prazoAnos`,
// substitui os dados pessoais dos eventos por 'ANONIMIZADO', mantendo o
// histórico patrimonial. O hash original é preservado e o evento é marcado
// como anonimizado — a verificação de integridade passa a validar apenas o
// elo da cadeia para esses eventos.
function anonimizarLGPD(db, prazoAnos, autor) {
  const limite = new Date();
  limite.setFullYear(limite.getFullYear() - prazoAnos);
  const limiteISO = limite.toISOString();

  const ativos = db
    .prepare(
      `SELECT a.id, a.patrimonio FROM ativos a
        WHERE a.status_atual = 'Descartado'
          AND (SELECT MAX(e.data_hora) FROM eventos e WHERE e.ativo_id = a.id AND e.tipo != 'Retificacao') <= ?
          AND EXISTS (SELECT 1 FROM eventos e WHERE e.ativo_id = a.id AND e.anonimizado = 0)`
    )
    .all(limiteISO);

  let eventosAnonimizados = 0;
  for (const ativo of ativos) {
    emTransacao(db, () => {
      const eventos = db
        .prepare('SELECT id, dados FROM eventos WHERE ativo_id = ? AND anonimizado = 0')
        .all(ativo.id);
      for (const evento of eventos) {
        const dados = JSON.parse(evento.dados);
        for (const campo of CAMPOS_PESSOAIS) {
          if (dados[campo] !== undefined && dados[campo] !== null) dados[campo] = 'ANONIMIZADO';
        }
        db.prepare('UPDATE eventos SET dados = ?, autor_nome = ?, anonimizado = 1 WHERE id = ?').run(
          JSON.stringify(dados),
          'ANONIMIZADO',
          evento.id
        );
        eventosAnonimizados += 1;
      }
      db.prepare('UPDATE ativos SET responsavel_atual = NULL WHERE id = ?').run(ativo.id);
      // A anonimização em si entra na trilha, com autoria e data. O registro
      // já nasce marcado como anonimizado para que uma nova execução da
      // rotina não reprocesse o ativo.
      const logId = inserirEvento(db, {
        ativoId: ativo.id,
        tipo: 'Retificacao',
        dados: {
          descricao: `anonimização LGPD após prazo de retenção de ${prazoAnos} anos`,
          evento_ref: null,
        },
        autor,
        dataHora: agoraISO(),
        statusAnterior: STATUS.DESCARTADO,
        statusNovo: STATUS.DESCARTADO,
      });
      db.prepare('UPDATE eventos SET anonimizado = 1 WHERE id = ?').run(logId);
    });
  }
  return { ativos_processados: ativos.length, eventos_anonimizados: eventosAnonimizados };
}

module.exports = {
  ErroDeValidacao,
  buscarAtivo,
  registrarEvento,
  decidirAprovacao,
  verificarIntegridade,
  anonimizarLGPD,
};
