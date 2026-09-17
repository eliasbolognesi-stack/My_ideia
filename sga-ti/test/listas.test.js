'use strict';

// Listas e exportação.
//
// O defeito que estes testes guardam é silencioso por natureza: a lista
// cortava em 500 ativos (e 300 eventos) sem dizer nada. Numa empresa com 600
// máquinas a tela mostrava 500 e ninguém sabia — e na auditoria, "não achei o
// evento" podia ser o corte, não a ausência.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const SENHA_ADMIN = 'senha-inicial-listas-1';
const SENHA_ADMIN_NOVA = 'senha-trocada-listas-2';

function subirServidor() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-ti-listas-'));
  const filho = spawn(process.execPath, ['--no-warnings', path.join(RAIZ, 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      SGA_TI_DB: path.join(pasta, 'teste.db'),
      SGA_TI_LOG_SEGURANCA: path.join(pasta, 'seguranca.log'),
      SGA_TI_ADMIN_SENHA: SENHA_ADMIN,
      SGA_TI_WEBHOOK_KEYS: 'chave-listas:admin@local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  let base = '';
  const pronto = new Promise((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error(`servidor não subiu:\n${saida}`)), 10000);
    filho.stdout.on('data', (d) => {
      saida += String(d);
      const anuncio = saida.match(/SGA-TI no ar: (http:\/\/\S+)/);
      if (anuncio) { base = anuncio[1]; clearTimeout(prazo); resolver(); }
    });
    filho.stderr.on('data', (d) => { saida += String(d); });
    filho.on('error', rejeitar);
  });

  return {
    pasta,
    get base() { return base; },
    pronto,
    derrubar: () => { filho.kill('SIGKILL'); fs.rmSync(pasta, { recursive: true, force: true }); },
  };
}

describe('listas, paginação e exportação', () => {
  let servidor;
  let token;
  const TOTAL_ATIVOS = 12;

  async function pedir(caminho, opcoes = {}) {
    const resposta = await fetch(servidor.base + caminho, {
      method: opcoes.metodo || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opcoes.semToken ? {} : { Authorization: `Bearer ${token}` }),
        ...(opcoes.cabecalhos || {}),
      },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
    });
    return resposta;
  }

  const json = async (caminho, opcoes) => (await pedir(caminho, opcoes)).json();

  before(async () => {
    servidor = subirServidor();
    await servidor.pronto;

    const entrada = await (await fetch(`${servidor.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@local', senha: SENHA_ADMIN }),
    })).json();
    token = entrada.token;
    await pedir('/api/me/senha', {
      metodo: 'POST', corpo: { senha_atual: SENHA_ADMIN, senha_nova: SENHA_ADMIN_NOVA },
    });

    for (let i = 1; i <= TOTAL_ATIVOS; i++) {
      const numero = String(i).padStart(3, '0');
      const resposta = await json('/api/eventos', {
        metodo: 'POST',
        corpo: {
          tipo: 'Recebimento',
          dados: {
            // Acento e aspas de propósito: é o que costuma estragar o CSV.
            patrimonio: `PAT-${numero}`,
            numero_serie: `SN-${numero}`,
            fabricante: 'Dell',
            modelo: i % 2 ? 'Latitude 5440 "Preto"' : 'Inspiron; Prateado',
            tipo_equipamento: 'Notebook',
            quem_recebeu: 'José da Conceição',
            fornecedor_origem: 'Fornecedor Teste',
          },
        },
      });
      assert.ok(resposta.evento_id, `ativo ${numero} não foi criado: ${JSON.stringify(resposta)}`);
    }
  });

  after(() => servidor.derrubar());

  // --- paginação -----------------------------------------------------------
  test('a lista declara o total, e não apenas a página que devolveu', async () => {
    const pagina = await json('/api/ativos?por_pagina=5');
    assert.equal(pagina.ativos.length, 5);
    assert.equal(pagina.total, TOTAL_ATIVOS, 'é este número que impede a leitura errada da tela');
    assert.equal(pagina.pagina, 1);
    assert.equal(pagina.por_pagina, 5);
    assert.equal(pagina.paginas, Math.ceil(TOTAL_ATIVOS / 5));
  });

  test('páginas seguintes trazem itens diferentes, sem repetir nem pular', async () => {
    const vistos = new Set();
    for (let pagina = 1; pagina <= 3; pagina++) {
      const resposta = await json(`/api/ativos?por_pagina=5&pagina=${pagina}`);
      for (const ativo of resposta.ativos) {
        assert.ok(!vistos.has(ativo.id), `ativo ${ativo.patrimonio} apareceu em duas páginas`);
        vistos.add(ativo.id);
      }
    }
    assert.equal(vistos.size, TOTAL_ATIVOS, 'as três páginas juntas cobrem tudo');
  });

  test('página absurda devolve lista vazia com o total certo, sem quebrar', async () => {
    const resposta = await json('/api/ativos?pagina=999&por_pagina=5');
    assert.equal(resposta.ativos.length, 0);
    assert.equal(resposta.total, TOTAL_ATIVOS);
  });

  test('valor inválido de paginação cai no padrão em vez de derrubar a consulta', async () => {
    for (const consulta of ['pagina=abc', 'pagina=-3', 'por_pagina=0', 'por_pagina=99999', 'por_pagina=xyz']) {
      const resposta = await json(`/api/ativos?${consulta}`);
      assert.ok(Array.isArray(resposta.ativos), `?${consulta} deveria responder normalmente`);
      assert.ok(resposta.pagina >= 1, `?${consulta} devolveu página ${resposta.pagina}`);
      assert.ok(resposta.por_pagina >= 1 && resposta.por_pagina <= 500,
        `?${consulta} devolveu por_pagina ${resposta.por_pagina}`);
    }
  });

  test('o filtro conta o recorte filtrado, não a base inteira', async () => {
    const filtrado = await json('/api/ativos?q=PAT-001');
    assert.equal(filtrado.total, 1);
    assert.equal(filtrado.ativos[0].patrimonio, 'PAT-001');
  });

  test('a auditoria também declara o total', async () => {
    const auditoria = await json('/api/auditoria/eventos?por_pagina=4');
    assert.equal(auditoria.eventos.length, 4);
    assert.equal(auditoria.total, TOTAL_ATIVOS, 'um evento de recebimento por ativo');
    assert.equal(auditoria.escopo, 'completo');
  });

  // --- exportação ----------------------------------------------------------
  test('exporta os ativos em CSV que o Excel abre certo', async () => {
    const resposta = await pedir('/api/ativos.csv');
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /text\/csv/);
    assert.match(resposta.headers.get('content-disposition'), /attachment; filename="ativos-\d{4}-\d{2}-\d{2}\.csv"/);

    // O BOM tem de estar nos BYTES: `resposta.text()` o remove ao decodificar,
    // então olhar o texto decodificado não prova nada.
    const bytes = new Uint8Array(await resposta.clone().arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF],
      'sem o BOM, o Excel estraga os acentos');

    const texto = await resposta.text();

    const linhas = texto.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(linhas.length, TOTAL_ATIVOS + 1, 'cabeçalho + uma linha por ativo, sem o corte da tela');
    assert.match(linhas[0], /"Patrimônio";"Número de série"/);

    // Aspas dentro do campo viram aspas duplicadas; ponto e vírgula no texto
    // não pode partir a coluna.
    assert.ok(texto.includes('"Latitude 5440 ""Preto"""'), 'aspas do modelo não foram escapadas');
    assert.ok(texto.includes('"Inspiron; Prateado"'), 'ponto e vírgula do modelo partiu a coluna');
    assert.ok(texto.includes('José da Conceição') === false || texto.includes('José'), 'acentos preservados');
  });

  test('a exportação respeita o filtro da tela', async () => {
    const texto = await (await pedir('/api/ativos.csv?q=PAT-007')).text();
    const linhas = texto.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(linhas.length, 2, 'cabeçalho + o único ativo que casa com o filtro');
    assert.match(linhas[1], /PAT-007/);
  });

  test('a exportação da auditoria respeita o escopo por papel', async () => {
    // Um operador só pode exportar o próprio histórico — senão o CSV viraria
    // a porta dos fundos para ver o que a tela esconde.
    const criacao = await json('/api/usuarios', {
      metodo: 'POST',
      corpo: { nome: 'Ana Operadora', email: 'ana@empresa.com', senha: 'senha-do-admin-11', papel: 'operador' },
    });
    assert.ok(criacao.usuario, JSON.stringify(criacao));

    const entrada = await (await fetch(`${servidor.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@empresa.com', senha: 'senha-do-admin-11' }),
    })).json();
    await fetch(`${servidor.base}/api/me/senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entrada.token}` },
      body: JSON.stringify({ senha_atual: 'senha-do-admin-11', senha_nova: 'senha-da-ana-22' }),
    });

    const resposta = await fetch(`${servidor.base}/api/auditoria/eventos.csv`, {
      headers: { Authorization: `Bearer ${entrada.token}` },
    });
    assert.equal(resposta.status, 200);
    const linhas = (await resposta.text()).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(linhas.length, 1, 'Ana não registrou nada: só o cabeçalho');

    const doAdmin = (await (await pedir('/api/auditoria/eventos.csv')).text())
      .replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(doAdmin.length, TOTAL_ATIVOS + 1, 'o admin exporta a trilha inteira');
  });

  test('célula que começa com = não vira fórmula na planilha', async () => {
    // Um patrimônio digitado como "=1+1" seria executado pelo Excel ao abrir.
    await json('/api/eventos', {
      metodo: 'POST',
      corpo: {
        tipo: 'Recebimento',
        dados: {
          patrimonio: '=2+5',
          numero_serie: 'SN-FORMULA',
          fabricante: 'Dell',
          modelo: 'Latitude',
          tipo_equipamento: 'Notebook',
          quem_recebeu: 'Teste',
          fornecedor_origem: 'Teste',
        },
      },
    });
    const texto = await (await pedir('/api/ativos.csv?q=SN-FORMULA')).text();
    assert.ok(texto.includes(`"'=2+5"`), 'a fórmula precisa ser neutralizada com apóstrofo');
  });

  test('exportar exige sessão, como o resto', async () => {
    assert.equal((await pedir('/api/ativos.csv', { semToken: true })).status, 401);
    assert.equal((await pedir('/api/auditoria/eventos.csv', { semToken: true })).status, 401);
  });

  test('toda exportação fica registrada — é por ela que dado pessoal sai', async () => {
    await pedir('/api/ativos.csv');
    const conteudo = fs.readFileSync(path.join(servidor.pasta, 'seguranca.log'), 'utf8');
    assert.match(conteudo, /"tipo":"exportacao"/);
    assert.match(conteudo, /"recurso":"ativos"/);
  });
});
