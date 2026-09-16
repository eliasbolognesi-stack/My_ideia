'use strict';

// Testes das proteções de segurança. Os de unidade cobrem limpeza de entrada
// e limite de uso; os de integração sobem o servidor de verdade como processo
// filho e conversam com ele por HTTP, para validar também os cabeçalhos e o
// comportamento do webhook ponta a ponta.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { limparTexto, contemInvisiveis, limparProfundo, validarEvidencia } = require('../src/entrada');
const { criarLimitador } = require('../src/limite');

const ZERO_WIDTH = String.fromCharCode(0x200b);
const OVERRIDE_DIREITA = String.fromCharCode(0x202e);
const BOM = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// Limpeza de entrada
// ---------------------------------------------------------------------------
describe('limpeza de entrada', () => {
  test('remove caracteres invisíveis usados para esconder texto', () => {
    const disfarcado = `Latitude${ZERO_WIDTH} 5440${OVERRIDE_DIREITA}${BOM}`;
    assert.equal(contemInvisiveis(disfarcado), true);
    assert.equal(limparTexto(disfarcado), 'Latitude 5440');
  });

  test('texto normal com acento e quebra de linha passa intacto', () => {
    assert.equal(contemInvisiveis('Manutenção\nrealizada'), false);
    assert.equal(limparTexto('  Manutenção\nrealizada  '), 'Manutenção\nrealizada');
  });

  test('limita o tamanho do campo', () => {
    assert.equal(limparTexto('a'.repeat(5000), 100).length, 100);
  });

  test('limpa o objeto inteiro e conta os campos suspeitos', () => {
    const relatorio = { suspeitos: 0 };
    const limpo = limparProfundo({
      tipo: 'Descarte',
      dados: { motivo: `fim de vida${ZERO_WIDTH}`, aninhado: { nota: `ok${BOM}` } },
    }, relatorio);
    assert.equal(relatorio.suspeitos, 2);
    assert.equal(limpo.dados.motivo, 'fim de vida');
    assert.equal(limpo.dados.aninhado.nota, 'ok');
  });

  test('não entra em laço infinito com objeto muito aninhado', () => {
    let profundo = { fim: 'valor' };
    for (let i = 0; i < 30; i++) profundo = { dentro: profundo };
    assert.doesNotThrow(() => limparProfundo(profundo));
  });
});

// ---------------------------------------------------------------------------
// Evidência de descarte
// ---------------------------------------------------------------------------
describe('evidência de descarte', () => {
  test('número de termo e nome de arquivo continuam válidos', () => {
    assert.equal(validarEvidencia('termo-2026-014.pdf'), null);
    assert.equal(validarEvidencia('Termo 4521/2026'), null);
  });

  test('endereço sem https é recusado', () => {
    assert.match(validarEvidencia('http://exemplo.com/t.pdf', []), /https/);
    assert.match(validarEvidencia('javascript:alert(1)//x', []), /https/);
  });

  test('respeita a lista de domínios autorizados', () => {
    assert.equal(validarEvidencia('https://docs.empresa.com/t.pdf', ['empresa.com']), null);
    assert.match(validarEvidencia('https://empresa.com.invasor.net/t.pdf', ['empresa.com']), /domínio autorizado/);
  });
});

// ---------------------------------------------------------------------------
// Limite de uso
// ---------------------------------------------------------------------------
describe('limite de uso', () => {
  test('bloqueia ao passar do máximo e libera na janela seguinte', () => {
    const limitador = criarLimitador({ janelaMs: 50, maximo: 2, nome: 'teste' });
    assert.deepEqual([1, 2, 3].map(() => limitador.permitir('ip')), [true, true, false]);
    assert.equal(limitador.permitir('outro-ip'), true, 'outra origem não é afetada');
    return new Promise((ok) => setTimeout(() => {
      assert.equal(limitador.permitir('ip'), true, 'libera depois da janela');
      ok();
    }, 60));
  });

  test('a varredura remove as chaves expiradas (sem vazamento de memória)', () => {
    const limitador = criarLimitador({ janelaMs: 10, maximo: 5, nome: 'limpeza' });
    for (let i = 0; i < 100; i++) limitador.permitir(`ip-${i}`);
    assert.equal(limitador.tamanho, 100);
    limitador.limpar(Date.now() + 1000);
    assert.equal(limitador.tamanho, 0);
  });
});

// ---------------------------------------------------------------------------
// Integração: servidor real
// ---------------------------------------------------------------------------
const SENHA_ADMIN = 'senha-de-teste-123';
const CHAVE_ESTOQUE = 'chave-do-estoque-para-teste';

function subirServidor(extras = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-ti-teste-'));
  const porta = 3400 + Math.floor(Math.random() * 500);
  const filho = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(porta),
      SGA_TI_DB: path.join(pasta, 'teste.db'),
      SGA_TI_LOG_SEGURANCA: path.join(pasta, 'seguranca.log'),
      SGA_TI_ADMIN_SENHA: SENHA_ADMIN,
      SGA_TI_WEBHOOK_KEYS: `${CHAVE_ESTOQUE}:admin@local`,
      ...extras,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pronto = new Promise((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error('servidor não subiu a tempo')), 10000);
    filho.stdout.on('data', (dado) => {
      if (String(dado).includes('SGA-TI no ar')) {
        clearTimeout(prazo);
        resolver();
      }
    });
    filho.on('error', rejeitar);
  });

  return { filho, pasta, base: `http://127.0.0.1:${porta}`, pronto };
}

async function pedir(base, caminho, opcoes = {}) {
  const resposta = await fetch(base + caminho, {
    method: opcoes.metodo || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opcoes.cabecalhos || {}) },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const corpo = await resposta.json().catch(() => ({}));
  return { status: resposta.status, corpo, cabecalhos: resposta.headers };
}

describe('servidor', () => {
  let servidor;
  let tokenAdmin;

  before(async () => {
    servidor = subirServidor();
    await servidor.pronto;
    const login = await pedir(servidor.base, '/api/auth/login', {
      metodo: 'POST',
      corpo: { email: 'admin@local', senha: SENHA_ADMIN },
    });
    assert.equal(login.status, 200);
    tokenAdmin = login.corpo.token;
  });

  after(() => {
    servidor.filho.kill('SIGKILL');
    fs.rmSync(servidor.pasta, { recursive: true, force: true });
  });

  const comoAdmin = () => ({ Authorization: `Bearer ${tokenAdmin}` });

  test('envia os cabeçalhos de segurança em toda resposta', async () => {
    const pagina = await fetch(`${servidor.base}/`);
    assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(pagina.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(pagina.headers.get('content-security-policy'), /unsafe-inline/);
    assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(pagina.headers.get('x-frame-options'), 'DENY');
    assert.equal(pagina.headers.get('referrer-policy'), 'no-referrer');

    const api = await pedir(servidor.base, '/api/me', { cabecalhos: comoAdmin() });
    assert.equal(api.cabecalhos.get('x-frame-options'), 'DENY');
    assert.equal(api.cabecalhos.get('cache-control'), 'no-store');
  });

  test('a página não depende de script embutido (compatível com a política estrita)', async () => {
    const html = await (await fetch(`${servidor.base}/`)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    assert.match(html, /<script src="\/tema-inicial\.js">/);
  });

  test('login com senha errada é recusado e registrado', async () => {
    const resposta = await pedir(servidor.base, '/api/auth/login', {
      metodo: 'POST', corpo: { email: 'admin@local', senha: 'errada' },
    });
    assert.equal(resposta.status, 401);
    assert.equal(resposta.corpo.erro, 'e-mail ou senha inválidos');
  });

  test('rota protegida recusa quem não está autenticado', async () => {
    const semToken = await pedir(servidor.base, '/api/ativos');
    assert.equal(semToken.status, 401);
    const tokenFalso = await pedir(servidor.base, '/api/ativos', {
      cabecalhos: { Authorization: 'Bearer token-inventado' },
    });
    assert.equal(tokenFalso.status, 401);
  });

  test('a chave do webhook define o autor — o corpo não pode declarar outro', async () => {
    // O corpo tenta se passar por "Fulano Impostor"; o autor registrado tem de
    // ser o dono da chave (admin@local).
    const resposta = await pedir(servidor.base, '/api/webhook/n8n', {
      metodo: 'POST',
      cabecalhos: { 'X-Api-Key': CHAVE_ESTOQUE },
      corpo: {
        evento: 'Recebimento',
        ativo: {
          patrimonio: '8001', numero_serie: 'SN-8001', fabricante: 'Dell',
          modelo: 'Latitude 5440', tipo_equipamento: 'Notebook',
        },
        responsavel_acao: 'Fulano Impostor',
        responsavel_recebendo: 'João Silva',
        origem: 'Dell Brasil',
      },
    });
    assert.equal(resposta.status, 200);

    const ativo = await pedir(servidor.base, `/api/ativos/${resposta.corpo.ativo_id}`, { cabecalhos: comoAdmin() });
    assert.equal(ativo.corpo.eventos[0].autor_nome, 'Administrador');
    assert.notEqual(ativo.corpo.eventos[0].autor_nome, 'Fulano Impostor');
  });

  test('webhook recusa chave inválida e chave ausente', async () => {
    const corpo = { evento: 'Recebimento', ativo: {}, responsavel_acao: 'admin@local' };
    assert.equal((await pedir(servidor.base, '/api/webhook/n8n', { metodo: 'POST', corpo })).status, 401);
    assert.equal((await pedir(servidor.base, '/api/webhook/n8n', {
      metodo: 'POST', corpo, cabecalhos: { 'X-Api-Key': 'chave-errada' },
    })).status, 401);
  });

  test('caracteres invisíveis são removidos antes de gravar', async () => {
    const resposta = await pedir(servidor.base, '/api/eventos', {
      metodo: 'POST',
      cabecalhos: comoAdmin(),
      corpo: {
        tipo: 'Recebimento',
        dados: {
          patrimonio: '8002', numero_serie: 'SN-8002', fabricante: 'Dell',
          modelo: `Latitude${ZERO_WIDTH} 5440`, tipo_equipamento: 'Notebook',
          quem_recebeu: 'João Silva', fornecedor_origem: 'Dell Brasil',
        },
      },
    });
    assert.equal(resposta.status, 200);
    const ativo = await pedir(servidor.base, `/api/ativos/${resposta.corpo.ativo_id}`, { cabecalhos: comoAdmin() });
    assert.equal(ativo.corpo.ativo.modelo, 'Latitude 5440');
  });

  test('operador só vê o próprio histórico na auditoria; admin vê tudo', async () => {
    await pedir(servidor.base, '/api/usuarios', {
      metodo: 'POST',
      cabecalhos: comoAdmin(),
      corpo: { nome: 'Pedro Operador', email: 'pedro@empresa.com', senha: 'senha-forte-99', papel: 'operador' },
    });
    const login = await pedir(servidor.base, '/api/auth/login', {
      metodo: 'POST',
      corpo: { email: 'pedro@empresa.com', senha: 'senha-forte-99' },
    });
    const comoPedro = { Authorization: `Bearer ${login.corpo.token}` };

    // Mesmo pedindo explicitamente o histórico de outra pessoa, o escopo é forçado.
    const doOperador = await pedir(servidor.base, '/api/auditoria/eventos?colaborador=Administrador', { cabecalhos: comoPedro });
    assert.equal(doOperador.corpo.escopo, 'proprio');
    assert.equal(doOperador.corpo.colaborador, 'Pedro Operador');
    assert.equal(doOperador.corpo.eventos.length, 0, 'não vê evento de outro colaborador');

    const doAdmin = await pedir(servidor.base, '/api/auditoria/eventos', { cabecalhos: comoAdmin() });
    assert.equal(doAdmin.corpo.escopo, 'completo');
    assert.ok(doAdmin.corpo.eventos.length > 0);

    // E continua sem poder criar usuário nem decidir descarte.
    const tentaCriar = await pedir(servidor.base, '/api/usuarios', {
      metodo: 'POST', cabecalhos: comoPedro,
      corpo: { nome: 'x', email: 'x@y.com', senha: 'senha-forte-77', papel: 'admin' },
    });
    assert.equal(tentaCriar.status, 403);
  });

  test('curinga digitado na busca não devolve a base inteira', async () => {
    // "%" e "_" são curingas do banco: digitados por quem procura, precisam
    // valer como texto literal.
    const todos = await pedir(servidor.base, '/api/ativos', { cabecalhos: comoAdmin() });
    assert.ok(todos.corpo.ativos.length > 0, 'há ativos cadastrados para o teste valer');

    const comPorcento = await pedir(servidor.base, '/api/ativos?q=%25', { cabecalhos: comoAdmin() });
    assert.equal(comPorcento.corpo.ativos.length, 0, '"%" não pode devolver todos');

    const comSublinhado = await pedir(servidor.base, '/api/ativos?q=_', { cabecalhos: comoAdmin() });
    assert.equal(comSublinhado.corpo.ativos.length, 0, '"_" não pode casar com qualquer caractere');

    // Busca normal segue funcionando, sem diferenciar maiúsculas.
    const normal = await pedir(servidor.base, '/api/ativos?q=latitude', { cabecalhos: comoAdmin() });
    assert.ok(normal.corpo.ativos.length > 0, 'busca comum continua encontrando');

    const naAuditoria = await pedir(servidor.base, '/api/auditoria/eventos?colaborador=%25', { cabecalhos: comoAdmin() });
    assert.equal(naAuditoria.corpo.eventos.length, 0, 'o mesmo vale para a auditoria');
  });

  test('erro inesperado não vaza detalhe técnico', async () => {
    const resposta = await pedir(servidor.base, '/api/ativos/999999', { cabecalhos: comoAdmin() });
    assert.equal(resposta.status, 404);
    assert.equal(resposta.corpo.erro, 'ativo não encontrado');
    assert.equal(resposta.corpo.stack, undefined);
  });

  test('o registro de segurança grava as tentativas em arquivo separado', async () => {
    const arquivo = path.join(servidor.pasta, 'seguranca.log');
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    assert.match(conteudo, /login_falho/);
    assert.match(conteudo, /webhook_chave_invalida/);
    assert.match(conteudo, /texto_com_caracteres_ocultos/);
    assert.match(conteudo, /webhook_autor_divergente/);
    assert.match(conteudo, /acesso_negado/);
    // A chave recusada nunca é gravada por extenso.
    assert.doesNotMatch(conteudo, /chave-errada/);
    // Cada linha é um JSON válido, com momento e tipo.
    for (const linha of conteudo.trim().split('\n')) {
      const evento = JSON.parse(linha);
      assert.ok(evento.momento && evento.tipo);
    }
  });
});

describe('limite de tentativas de login', () => {
  let servidor;

  before(async () => {
    // Servidor próprio: um limite baixo aqui não atrapalha os outros testes.
    servidor = subirServidor({ SGA_TI_LIMITE_LOGIN: '3' });
    await servidor.pronto;
  });

  after(() => {
    servidor.filho.kill('SIGKILL');
    fs.rmSync(servidor.pasta, { recursive: true, force: true });
  });

  test('entrar corretamente não consome o limite (escritório atrás de um endereço só)', async () => {
    // Com o limite em 3, dez entradas corretas seguidas precisam passar: o
    // limite existe contra tentativa às cegas, não contra uso normal.
    const certo = { metodo: 'POST', corpo: { email: 'admin@local', senha: SENHA_ADMIN } };
    for (let i = 0; i < 10; i++) {
      const r = await pedir(servidor.base, '/api/auth/login', certo);
      assert.equal(r.status, 200, `entrada ${i + 1} deveria passar`);
    }

    // E uma entrada bem-sucedida limpa o histórico de falhas daquela origem.
    const errado = { metodo: 'POST', corpo: { email: 'admin@local', senha: 'errada' } };
    await pedir(servidor.base, '/api/auth/login', errado);
    await pedir(servidor.base, '/api/auth/login', errado);
    assert.equal((await pedir(servidor.base, '/api/auth/login', certo)).status, 200);
    assert.equal((await pedir(servidor.base, '/api/auth/login', errado)).status, 401,
      'depois de entrar, a contagem de falhas recomeça');
  });

  test('bloqueia o excesso de tentativas e registra o bloqueio', async () => {
    const errado = { metodo: 'POST', corpo: { email: 'admin@local', senha: 'errada' } };
    const respostas = [];
    for (let i = 0; i < 5; i++) {
      respostas.push((await pedir(servidor.base, '/api/auth/login', errado)).status);
    }
    assert.ok(respostas.includes(401), 'as primeiras tentativas respondem 401');
    assert.ok(respostas.includes(429), 'o excesso é bloqueado com 429');

    // Bloqueado é bloqueado: nem com a senha certa passa dentro da janela.
    const comSenhaCerta = await pedir(servidor.base, '/api/auth/login', {
      metodo: 'POST', corpo: { email: 'admin@local', senha: SENHA_ADMIN },
    });
    assert.equal(comSenhaCerta.status, 429);

    const conteudo = fs.readFileSync(path.join(servidor.pasta, 'seguranca.log'), 'utf8');
    assert.match(conteudo, /limite_excedido/);
    // A senha tentada nunca aparece no registro.
    assert.doesNotMatch(conteudo, /errada/);
  });
});

describe('modo manutenção', () => {
  let servidor;

  before(async () => {
    servidor = subirServidor({ SGA_TI_MANUTENCAO: '1' });
    await servidor.pronto;
  });

  after(() => {
    servidor.filho.kill('SIGKILL');
    fs.rmSync(servidor.pasta, { recursive: true, force: true });
  });

  test('responde 503 em tudo, sem derrubar o processo', async () => {
    const pagina = await fetch(`${servidor.base}/`);
    assert.equal(pagina.status, 503);
    assert.match(await pagina.text(), /manutenção/i);

    const login = await pedir(servidor.base, '/api/auth/login', {
      metodo: 'POST', corpo: { email: 'admin@local', senha: SENHA_ADMIN },
    });
    assert.equal(login.status, 503);
  });
});
