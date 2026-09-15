'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { abrirBanco } = require('../src/db');
const auth = require('../src/auth');
const servico = require('../src/servico-eventos');
const { mapearEventoN8n } = require('../src/n8n');

let db;
let operador;
let aprovador;

function recebimentoPadrao(extra = {}) {
  return {
    patrimonio: '4521',
    numero_serie: 'ABC123XY',
    fabricante: 'Dell',
    modelo: 'Latitude 5440',
    tipo_equipamento: 'Notebook',
    quem_recebeu: 'João Silva',
    fornecedor_origem: 'Dell Brasil',
    ...extra,
  };
}

function receber(extra = {}) {
  return servico.registrarEvento(db, 'Recebimento', recebimentoPadrao(extra), operador);
}

function moverParaColaborador(patrimonio = '4521') {
  return servico.registrarEvento(
    db,
    'Movimentacao',
    {
      identificador: patrimonio,
      origem: 'Estoque TI',
      destino: 'Maria Souza — Financeiro',
      tipo_destino: 'colaborador',
      quem_entrega: 'João Silva',
      quem_recebe: 'Maria Souza',
    },
    operador
  );
}

function dadosDescarte(extra = {}) {
  return {
    identificador: '4521',
    patrimonio_confirmado: '4521',
    numero_serie_confirmado: 'ABC123XY',
    motivo: 'fim de vida útil',
    limpeza_dados: 'confirmada',
    aprovador: 'Ana Gerente',
    evidencia: 'termo-2026-014.pdf',
    ...extra,
  };
}

beforeEach(() => {
  db = abrirBanco(':memory:');
  operador = auth.criarUsuario(db, {
    nome: 'João Silva', email: 'joao@empresa.com', senha: 'senha-forte-1', papel: 'operador',
  });
  aprovador = auth.criarUsuario(db, {
    nome: 'Ana Gerente', email: 'ana@empresa.com', senha: 'senha-forte-2', papel: 'aprovador',
  });
});

// ---------------------------------------------------------------------------
// Recebimento e unicidade (seções 3 e 6)
// ---------------------------------------------------------------------------
test('recebimento cria ativo em estoque com evento inicial', () => {
  const resultado = receber();
  const ativo = db.prepare('SELECT * FROM ativos WHERE id = ?').get(resultado.ativo_id);
  assert.equal(ativo.status_atual, 'Em estoque');
  assert.equal(ativo.patrimonio, '4521');
  const evento = db.prepare('SELECT * FROM eventos WHERE id = ?').get(resultado.evento_id);
  assert.equal(evento.tipo, 'Recebimento');
  assert.equal(evento.status_anterior, null);
  assert.equal(evento.hash_anterior, null);
});

test('recebimento sem campo obrigatório é bloqueado', () => {
  assert.throws(
    () => receber({ fornecedor_origem: '' }),
    (erro) => erro.erros.some((e) => e.includes('fornecedor_origem'))
  );
});

test('patrimônio duplicado entre ativos vivos é bloqueado; reuso após baixa é permitido', () => {
  receber();
  assert.throws(() => receber({ numero_serie: 'OUTRO-SN' }), /já existe um ativo não baixado/);
  assert.throws(() => receber({ patrimonio: '9999' }), /já existe um ativo não baixado/);

  servico.registrarEvento(db, 'Descarte', dadosDescarte(), operador);
  // Depois da baixa, o número pode voltar a circular.
  const resultado = receber({ numero_serie: 'NOVO-SN-01' });
  assert.ok(resultado.ativo_id);
});

// ---------------------------------------------------------------------------
// Formatação (seção 5)
// ---------------------------------------------------------------------------
test('formatação exige confirmação de backup/limpeza', () => {
  receber();
  assert.throws(
    () => servico.registrarEvento(db, 'Formatacao', { identificador: '4521', tecnico: 'Carlos', motivo: 'reuso' }, operador),
    /confirmar o backup/
  );
});

test('formatação pré-descarte reserva o ativo para baixa', () => {
  receber();
  const resultado = servico.registrarEvento(
    db,
    'Formatacao',
    { identificador: '4521', tecnico: 'Carlos', motivo: 'pré-descarte', confirmacao_backup: true },
    operador
  );
  assert.equal(resultado.status_novo, 'Reservado para descarte');
});

// ---------------------------------------------------------------------------
// Movimentação (seção 6: sempre as duas pontas)
// ---------------------------------------------------------------------------
test('movimentação sem quem recebe é bloqueada', () => {
  receber();
  assert.throws(
    () =>
      servico.registrarEvento(
        db,
        'Movimentacao',
        { identificador: '4521', origem: 'Estoque', destino: 'Financeiro', tipo_destino: 'colaborador', quem_entrega: 'João' },
        operador
      ),
    (erro) => erro.erros.some((e) => e.includes('quem_recebe'))
  );
});

test('movimentação para colaborador coloca o ativo em uso com responsável', () => {
  receber();
  const resultado = moverParaColaborador();
  assert.equal(resultado.status_novo, 'Em uso');
  const ativo = db.prepare('SELECT * FROM ativos WHERE id = ?').get(resultado.ativo_id);
  assert.equal(ativo.responsavel_atual, 'Maria Souza');
});

test('manutenção registra a intervenção sem alterar o status', () => {
  receber();
  moverParaColaborador();
  const resultado = servico.registrarEvento(
    db,
    'Manutencao',
    { identificador: '4521', tecnico: 'Carlos', problema_relatado: 'tela piscando', solucao_aplicada: 'troca do cabo flat' },
    operador
  );
  assert.equal(resultado.status_anterior, 'Em uso');
  assert.equal(resultado.status_novo, 'Em uso');
});

// ---------------------------------------------------------------------------
// Descarte (seções 5, 6 e 13)
// ---------------------------------------------------------------------------
test('descarte sem conferência de patrimônio e S/N é bloqueado', () => {
  receber();
  assert.throws(
    () => servico.registrarEvento(db, 'Descarte', dadosDescarte({ numero_serie_confirmado: '' }), operador),
    /conferência explícita/
  );
  assert.throws(
    () => servico.registrarEvento(db, 'Descarte', dadosDescarte({ numero_serie_confirmado: 'ERRADO' }), operador),
    /não confere com o cadastro/
  );
});

test('descarte exige limpeza de dados confirmada ou dispensa justificada', () => {
  receber();
  assert.throws(
    () => servico.registrarEvento(db, 'Descarte', dadosDescarte({ limpeza_dados: undefined }), operador),
    /limpeza_dados/
  );
  assert.throws(
    () => servico.registrarEvento(db, 'Descarte', dadosDescarte({ limpeza_dados: 'dispensada' }), operador),
    /justificativa_dispensa/
  );
});

test('descarte válido baixa o ativo em definitivo', () => {
  receber();
  const resultado = servico.registrarEvento(db, 'Descarte', dadosDescarte(), operador);
  assert.equal(resultado.status_novo, 'Descartado');
  // Status final: nenhum evento além de retificação é aceito.
  assert.throws(
    () =>
      servico.registrarEvento(
        db,
        'Formatacao',
        { identificador: '4521', tecnico: 'Carlos', motivo: 'reuso', confirmacao_backup: true },
        operador
      ),
    /ativo não encontrado|Descartado/
  );
});

test('descarte de ativo em uso vai para aprovação humana', () => {
  receber();
  moverParaColaborador();
  const pedido = servico.registrarEvento(db, 'Descarte', dadosDescarte(), operador);
  assert.equal(pedido.aprovacao_pendente, true);

  const ativoAntes = db.prepare("SELECT status_atual FROM ativos WHERE patrimonio = '4521'").get();
  assert.equal(ativoAntes.status_atual, 'Em uso');

  const decisao = servico.decidirAprovacao(db, pedido.aprovacao_id, 'aprovado', 'equipamento danificado', aprovador);
  assert.equal(decisao.status_novo, 'Descartado');
});

test('rejeição da aprovação mantém o ativo intacto', () => {
  receber();
  moverParaColaborador();
  const pedido = servico.registrarEvento(db, 'Descarte', dadosDescarte(), operador);
  servico.decidirAprovacao(db, pedido.aprovacao_id, 'rejeitado', 'ainda em condições de uso', aprovador);
  const ativo = db.prepare("SELECT status_atual FROM ativos WHERE patrimonio = '4521'").get();
  assert.equal(ativo.status_atual, 'Em uso');
});

// ---------------------------------------------------------------------------
// Trilha imutável e cadeia de hashes (seções 6 e 7)
// ---------------------------------------------------------------------------
test('eventos não podem ser alterados nem apagados', () => {
  const { evento_id } = receber();
  assert.throws(
    () => db.prepare("UPDATE eventos SET autor_nome = 'Fulano' WHERE id = ?").run(evento_id),
    /imutavel/
  );
  assert.throws(() => db.prepare('DELETE FROM eventos WHERE id = ?').run(evento_id), /imutavel/);
});

test('retificação referencia o original sem alterá-lo', () => {
  const { ativo_id, evento_id } = receber();
  const original = db.prepare('SELECT dados, hash FROM eventos WHERE id = ?').get(evento_id);
  const resultado = servico.registrarEvento(
    db,
    'Retificacao',
    { identificador: '4521', evento_ref: evento_id, descricao: 'fornecedor correto é Dell México' },
    operador
  );
  const retificacao = db.prepare('SELECT evento_ref FROM eventos WHERE id = ?').get(resultado.evento_id);
  assert.equal(retificacao.evento_ref, evento_id);
  const originalDepois = db.prepare('SELECT dados, hash FROM eventos WHERE id = ?').get(evento_id);
  assert.deepEqual(originalDepois, original);
  assert.equal(resultado.ativo_id, ativo_id);
});

test('retificação não aceita evento de outro ativo', () => {
  const primeiro = receber();
  receber({ patrimonio: '4522', numero_serie: 'SN-4522' });
  assert.throws(
    () =>
      servico.registrarEvento(
        db,
        'Retificacao',
        { identificador: '4522', evento_ref: primeiro.evento_id, descricao: 'x' },
        operador
      ),
    /não pertence ao ativo/
  );
});

test('cadeia de hashes fecha do primeiro ao último evento', () => {
  const { ativo_id } = receber();
  moverParaColaborador();
  servico.registrarEvento(
    db,
    'Manutencao',
    { identificador: '4521', tecnico: 'Carlos', problema_relatado: 'lentidão', solucao_aplicada: 'upgrade de RAM' },
    operador
  );
  const verificacao = servico.verificarIntegridade(db, ativo_id);
  assert.equal(verificacao.valida, true);
  assert.equal(verificacao.eventos_verificados, 3);
});

// ---------------------------------------------------------------------------
// LGPD (seção 8)
// ---------------------------------------------------------------------------
test('anonimização remove dados pessoais após o prazo e preserva a cadeia', () => {
  const antigo = '2015-03-10T12:00:00.000Z';
  const { ativo_id } = receber({ data_hora: antigo });
  servico.registrarEvento(db, 'Descarte', dadosDescarte({ data_hora: antigo }), operador);

  const resultado = servico.anonimizarLGPD(db, 5, aprovador);
  assert.equal(resultado.ativos_processados, 1);
  assert.ok(resultado.eventos_anonimizados >= 2);

  const eventos = db.prepare('SELECT * FROM eventos WHERE ativo_id = ? ORDER BY id').all(ativo_id);
  const recebimento = JSON.parse(eventos[0].dados);
  assert.equal(recebimento.quem_recebeu, 'ANONIMIZADO');
  assert.equal(recebimento.patrimonio, '4521'); // histórico patrimonial preservado
  assert.equal(eventos[0].autor_nome, 'ANONIMIZADO');

  const verificacao = servico.verificarIntegridade(db, ativo_id);
  assert.equal(verificacao.valida, true);

  // Nova execução não reprocessa o mesmo ativo.
  const segunda = servico.anonimizarLGPD(db, 5, aprovador);
  assert.equal(segunda.ativos_processados, 0);
});

test('anonimização não atinge ativos dentro do prazo de retenção', () => {
  receber();
  servico.registrarEvento(db, 'Descarte', dadosDescarte(), operador);
  const resultado = servico.anonimizarLGPD(db, 5, aprovador);
  assert.equal(resultado.ativos_processados, 0);
});

// ---------------------------------------------------------------------------
// Webhook n8n (seção 10)
// ---------------------------------------------------------------------------
test('mapeador n8n traduz o JSON da seção 10 para eventos internos', () => {
  const recebimento = mapearEventoN8n({
    evento: 'Recebimento',
    ativo: { patrimonio: '4521', numero_serie: 'ABC123XY', fabricante: 'Dell', modelo: 'Latitude 5440', tipo_equipamento: 'Notebook' },
    responsavel_acao: 'joao@empresa.com',
    responsavel_recebendo: 'João Silva',
    origem: 'Dell Brasil',
  });
  assert.equal(recebimento.tipo, 'Recebimento');
  assert.equal(recebimento.dados.quem_recebeu, 'João Silva');
  assert.equal(recebimento.dados.fornecedor_origem, 'Dell Brasil');

  const reversa = mapearEventoN8n({ evento: 'Logistica Reversa', ativo: {}, responsavel_acao: 'x' });
  assert.equal(reversa.tipo, 'Movimentacao');
  assert.equal(reversa.dados.tipo_destino, 'fornecedor');

  const assistencia = mapearEventoN8n({ evento: 'enviar para assistencia ', ativo: {}, responsavel_acao: 'x' });
  assert.equal(assistencia.tipo, 'Movimentacao');
  assert.equal(assistencia.dados.tipo_destino, 'assistencia');

  const desconhecido = mapearEventoN8n({ evento: 'Inventario' });
  assert.ok(desconhecido.erro);
});

test('evento vindo do n8n com campos opcionais ausentes mantém a cadeia íntegra', () => {
  // Regressão: chaves com valor undefined eram descartadas na gravação mas
  // contavam como null no hash, quebrando a verificação de integridade.
  const mapeado = mapearEventoN8n({
    evento: 'Recebimento',
    ativo: { patrimonio: '7001', numero_serie: 'SN-7001', fabricante: 'Lenovo', modelo: 'ThinkPad T14', tipo_equipamento: 'Notebook' },
    responsavel_acao: 'joao@empresa.com',
    responsavel_recebendo: 'João Silva',
    origem: 'Lenovo Brasil',
    destino: '',
    // evidencia/observacoes/data_hora ausentes de propósito
  });
  const resultado = servico.registrarEvento(db, mapeado.tipo, mapeado.dados, operador);
  const verificacao = servico.verificarIntegridade(db, resultado.ativo_id);
  assert.deepEqual(verificacao.falhas, []);
  assert.equal(verificacao.valida, true);
});

test('descarte vindo do n8n é validado com as mesmas regras', () => {
  receber();
  const mapeado = mapearEventoN8n({
    evento: 'Descarte',
    ativo: { patrimonio: '4521', numero_serie: 'ABC123XY' },
    responsavel_acao: 'joao@empresa.com',
    motivo: 'fim de vida útil',
    limpeza_dados: 'confirmada',
    aprovador: 'Ana Gerente',
    evidencia: 'termo-2026-015.pdf',
  });
  const resultado = servico.registrarEvento(db, mapeado.tipo, mapeado.dados, operador);
  assert.equal(resultado.status_novo, 'Descartado');

  // Sem evidência, o mesmo caminho é bloqueado.
  receber({ patrimonio: '4522', numero_serie: 'SN-4522' });
  const incompleto = mapearEventoN8n({
    evento: 'Descarte',
    ativo: { patrimonio: '4522', numero_serie: 'SN-4522' },
    responsavel_acao: 'joao@empresa.com',
    motivo: 'quebrado',
    limpeza_dados: 'confirmada',
    aprovador: 'Ana Gerente',
  });
  assert.throws(
    () => servico.registrarEvento(db, incompleto.tipo, incompleto.dados, operador),
    (erro) => erro.erros.some((e) => e.includes('evidencia'))
  );
});
