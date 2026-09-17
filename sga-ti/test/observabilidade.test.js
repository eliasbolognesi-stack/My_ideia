'use strict';

// Observabilidade: o que sai daqui para o Langfuse.
//
// Três coisas precisam ser verdade, e cada uma tem um teste:
//   1. desligado por padrão — sem configuração, nem uma chamada sai;
//   2. o sistema não depende do Langfuse: com ele fora do ar, a requisição
//      responde normalmente e sem atraso;
//   3. dado pessoal não vaza — no padrão saem nomes de campo, nunca conteúdo.
//
// O "Langfuse" aqui é um coletor falso: um servidor HTTP que recebe e guarda o
// que chegou, para conferir o formato OTLP/JSON sem precisar de instância real.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const SENHA = 'senha-inicial-obs-1';
const SENHA_NOVA = 'senha-trocada-obs-2';

// --- coletor falso -----------------------------------------------------------
function criarColetor({ responder = 200, atraso = 0 } = {}) {
  const recebidos = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (parte) => { corpo += parte; });
    req.on('end', () => {
      recebidos.push({
        caminho: req.url,
        autorizacao: req.headers.authorization,
        tipo: req.headers['content-type'],
        corpo: JSON.parse(corpo || '{}'),
      });
      setTimeout(() => { res.writeHead(responder); res.end('{}'); }, atraso);
    });
  });
  return {
    recebidos,
    ouvir: () => new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${servidor.address().port}`))),
    fechar: () => new Promise((ok) => servidor.close(ok)),
    limpar: () => { recebidos.length = 0; },
    // Os spans chegam depois da resposta ao cliente: esperar é parte do teste,
    // não um contorno — o envio é assíncrono de propósito.
    async esperarSpans(quantos = 1, prazoMs = 4000) {
      const limite = Date.now() + prazoMs;
      while (Date.now() < limite) {
        const total = recebidos.reduce((s, r) => s + contarSpans(r.corpo), 0);
        if (total >= quantos) return recebidos;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      return recebidos;
    },
  };
}

function contarSpans(corpo) {
  return (corpo.resourceSpans || [])
    .flatMap((r) => r.scopeSpans || [])
    .flatMap((e) => e.spans || []).length;
}

function todosOsSpans(recebidos) {
  return recebidos
    .flatMap((r) => r.corpo.resourceSpans || [])
    .flatMap((r) => r.scopeSpans || [])
    .flatMap((e) => e.spans || []);
}

function atributosDe(span) {
  return Object.fromEntries((span.attributes || []).map((a) => [
    a.key,
    a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue,
  ]));
}

// --- servidor sob teste ------------------------------------------------------
function subirServidor(extras = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-ti-obs-'));
  const filho = spawn(process.execPath, ['--no-warnings', path.join(RAIZ, 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      SGA_TI_DB: path.join(pasta, 'teste.db'),
      SGA_TI_LOG_SEGURANCA: path.join(pasta, 'seguranca.log'),
      SGA_TI_ADMIN_SENHA: SENHA,
      SGA_TI_WEBHOOK_KEYS: 'chave-obs:admin@local',
      ...extras,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  let base = '';
  const pronto = new Promise((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error(`não subiu:\n${saida}`)), 10000);
    filho.stdout.on('data', (d) => {
      saida += String(d);
      const m = saida.match(/SGA-TI no ar: (http:\/\/\S+)/);
      if (m) { base = m[1]; clearTimeout(prazo); resolver(); }
    });
    filho.stderr.on('data', (d) => { saida += String(d); });
    filho.on('error', rejeitar);
  });

  return {
    pasta,
    get base() { return base; },
    texto: () => saida,
    pronto,
    derrubar: () => { filho.kill('SIGKILL'); fs.rmSync(pasta, { recursive: true, force: true }); },
  };
}

async function entrarComoAdmin(base) {
  const entrada = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@local', senha: SENHA }),
  })).json();
  await fetch(`${base}/api/me/senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entrada.token}` },
    body: JSON.stringify({ senha_atual: SENHA, senha_nova: SENHA_NOVA }),
  });
  return entrada.token;
}

const recebimento = (patrimonio) => ({
  tipo: 'Recebimento',
  dados: {
    patrimonio,
    numero_serie: `SN-${patrimonio}`,
    fabricante: 'Dell',
    modelo: 'Latitude 5440',
    tipo_equipamento: 'Notebook',
    quem_recebeu: 'Maria Souza',
    fornecedor_origem: 'Dell Brasil',
  },
});

// ---------------------------------------------------------------------------
describe('desligado por padrão', () => {
  let servidor;
  let coletor;
  let endereco;

  before(async () => {
    coletor = criarColetor();
    endereco = await coletor.ouvir();
    // Endereço configurado, chaves ausentes: continua desligado. Meia
    // configuração não pode virar "meio ligado".
    servidor = subirServidor({ SGA_TI_LANGFUSE_URL: endereco });
    await servidor.pronto;
  });

  after(async () => { servidor.derrubar(); await coletor.fechar(); });

  test('sem as chaves, nada é enviado', async () => {
    const token = await entrarComoAdmin(servidor.base);
    await fetch(`${servidor.base}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(recebimento('SEM-OBS-1')),
    });
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(coletor.recebidos.length, 0, 'não pode sair requisição nenhuma');
  });
});

describe('rastro enviado ao Langfuse', () => {
  let servidor;
  let coletor;
  let token;
  let enderecoColetor;

  before(async () => {
    coletor = criarColetor();
    enderecoColetor = await coletor.ouvir();
    const endereco = enderecoColetor;
    servidor = subirServidor({
      SGA_TI_LANGFUSE_URL: endereco,
      SGA_TI_LANGFUSE_CHAVE_PUBLICA: 'pk-teste',
      SGA_TI_LANGFUSE_CHAVE_SECRETA: 'sk-teste',
    });
    await servidor.pronto;
    token = await entrarComoAdmin(servidor.base);
  });

  after(async () => { servidor.derrubar(); await coletor.fechar(); });
  beforeEach(() => coletor.limpar());

  async function registrar(patrimonio, cabecalhos = {}) {
    return fetch(`${servidor.base}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...cabecalhos },
      body: JSON.stringify(recebimento(patrimonio)),
    });
  }

  test('vai para o endereço OTel, com autenticação básica e JSON', async () => {
    await registrar('OBS-001');
    await coletor.esperarSpans(1);

    assert.equal(coletor.recebidos.length, 1);
    const [pedido] = coletor.recebidos;
    assert.equal(pedido.caminho, '/api/public/otel/v1/traces');
    assert.match(pedido.tipo, /application\/json/);
    assert.match(pedido.autorizacao, /^Basic /);
    const decodificado = Buffer.from(pedido.autorizacao.slice(6), 'base64').toString();
    assert.equal(decodificado, 'pk-teste:sk-teste');
  });

  test('o formato é OTLP válido: identificadores em hexadecimal e tempo em nanossegundos', async () => {
    await registrar('OBS-002');
    await coletor.esperarSpans(1);
    const [span] = todosOsSpans(coletor.recebidos);

    assert.match(span.traceId, /^[0-9a-f]{32}$/, 'traceId tem 16 bytes em hexadecimal');
    assert.match(span.spanId, /^[0-9a-f]{16}$/, 'spanId tem 8 bytes em hexadecimal');
    assert.match(span.startTimeUnixNano, /^\d+$/);
    assert.match(span.endTimeUnixNano, /^\d+$/);
    assert.ok(BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano), 'terminou depois de começar');
    assert.equal(span.name, 'registrar_evento');
    assert.equal(span.status.code, 1, 'registro aceito = status OK');

    // A tela do Langfuse é montada a partir destes nomes.
    const atributos = atributosDe(span);
    assert.equal(atributos['langfuse.trace.name'], 'registrar_evento');
    assert.equal(atributos['user.id'], 'admin@local');
    assert.ok(Number(atributos['sga_ti.duracao_ms']) >= 0);

    const recurso = coletor.recebidos[0].corpo.resourceSpans[0].resource;
    const atributosRecurso = Object.fromEntries(
      recurso.attributes.map((a) => [a.key, a.value.stringValue])
    );
    assert.equal(atributosRecurso['service.name'], 'sga-ti');
  });

  test('no padrão, nomes de campo saem e dado pessoal não', async () => {
    await registrar('OBS-003');
    await coletor.esperarSpans(1);
    const atributos = atributosDe(todosOsSpans(coletor.recebidos)[0]);

    const entrada = atributos['langfuse.observation.input'];
    assert.match(entrada, /quem_recebeu/, 'o nome do campo ajuda a investigar e não identifica ninguém');
    assert.doesNotMatch(entrada, /Maria Souza/, 'o conteúdo do campo é dado pessoal e não pode sair');
    assert.doesNotMatch(entrada, /OBS-003/, 'nem o patrimônio, que identifica o equipamento da pessoa');

    // Conferência ampla: nada do corpo enviado pode aparecer no pacote inteiro.
    const pacote = JSON.stringify(coletor.recebidos[0].corpo);
    assert.doesNotMatch(pacote, /Maria Souza/);
    assert.doesNotMatch(pacote, /Dell Brasil/);
  });

  test('continua o rastro aberto no n8n em vez de abrir outro', async () => {
    const traceId = 'a'.repeat(32);
    const spanPai = 'b'.repeat(16);
    await registrar('OBS-004', { traceparent: `00-${traceId}-${spanPai}-01` });
    await coletor.esperarSpans(1);

    const [span] = todosOsSpans(coletor.recebidos);
    assert.equal(span.traceId, traceId, 'mesmo rastro da mensagem que chegou no n8n');
    assert.equal(span.parentSpanId, spanPai, 'pendurado no passo anterior');
  });

  test('traceparent malformado não quebra nada: abre rastro novo', async () => {
    const resposta = await registrar('OBS-005', { traceparent: 'lixo-que-alguem-mandou' });
    assert.equal(resposta.status, 200, 'a requisição não pode falhar por causa do rastro');
    await coletor.esperarSpans(1);
    const [span] = todosOsSpans(coletor.recebidos);
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.equal(span.parentSpanId, undefined);
  });

  test('evento recusado também vira rastro, com o motivo', async () => {
    const resposta = await fetch(`${servidor.base}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Faltam campos obrigatórios de propósito.
      body: JSON.stringify({ tipo: 'Recebimento', dados: { patrimonio: 'OBS-006' } }),
    });
    assert.equal(resposta.status, 422);
    await coletor.esperarSpans(1);

    const [span] = todosOsSpans(coletor.recebidos);
    assert.equal(span.status.code, 2, 'status de erro');
    const atributos = atributosDe(span);
    assert.equal(atributos['sga_ti.recusado_por'], 'validacao',
      'recusa por regra é resultado do sistema, não falha dele');
    assert.match(atributos['sga_ti.detalhes'], /campo obrigatório/);
  });

  test('o webhook do n8n também é rastreado, ligado ao mesmo rastro', async () => {
    const traceId = 'c'.repeat(32);
    await fetch(`${servidor.base}/api/webhook/n8n`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': 'chave-obs',
        traceparent: `00-${traceId}-${'d'.repeat(16)}-01`,
      },
      body: JSON.stringify({
        evento: 'Recebimento',
        ativo: {
          patrimonio: 'OBS-007', numero_serie: 'SN-OBS-007', fabricante: 'Dell',
          modelo: 'Latitude 5440', tipo_equipamento: 'Notebook',
        },
        responsavel_recebendo: 'João Silva',
        origem: 'Dell Brasil',
      }),
    });
    await coletor.esperarSpans(1);

    const [span] = todosOsSpans(coletor.recebidos);
    assert.equal(span.name, 'webhook_n8n');
    assert.equal(span.traceId, traceId, 'mesmo rastro da conversa que originou o pedido');
    const atributos = atributosDe(span);
    assert.equal(atributos['sga_ti.origem'], 'n8n');
    assert.equal(atributos['user.id'], 'admin@local', 'o autor vem da chave, e aparece no rastro');
  });

  test('com SGA_TI_OBS_CONTEUDO=completo o conteúdo vai junto — decisão consciente', async () => {
    const outro = subirServidor({
      SGA_TI_LANGFUSE_URL: enderecoColetor,
      SGA_TI_LANGFUSE_CHAVE_PUBLICA: 'pk-teste',
      SGA_TI_LANGFUSE_CHAVE_SECRETA: 'sk-teste',
      SGA_TI_OBS_CONTEUDO: 'completo',
    });
    try {
      await outro.pronto;
      coletor.limpar();
      const tokenOutro = await entrarComoAdmin(outro.base);
      await fetch(`${outro.base}/api/eventos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOutro}` },
        body: JSON.stringify(recebimento('OBS-008')),
      });
      await coletor.esperarSpans(1);
      const atributos = atributosDe(todosOsSpans(coletor.recebidos)[0]);
      assert.match(atributos['langfuse.observation.input'], /Maria Souza/,
        'neste modo o conteúdo sai — por isso o Langfuse precisa ser próprio');
    } finally {
      outro.derrubar();
    }
  });
});

describe('o Langfuse fora do ar não afeta o sistema', () => {
  let servidor;
  let coletor;

  before(async () => {
    // Endereço que não responde: porta fechada.
    servidor = subirServidor({
      SGA_TI_LANGFUSE_URL: 'http://127.0.0.1:1',
      SGA_TI_LANGFUSE_CHAVE_PUBLICA: 'pk-teste',
      SGA_TI_LANGFUSE_CHAVE_SECRETA: 'sk-teste',
    });
    await servidor.pronto;
  });

  after(() => { servidor.derrubar(); if (coletor) coletor.fechar(); });

  test('a requisição responde normalmente e sem atraso perceptível', async () => {
    const token = await entrarComoAdmin(servidor.base);

    const comeco = Date.now();
    const resposta = await fetch(`${servidor.base}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(recebimento('FORA-001')),
    });
    const decorrido = Date.now() - comeco;

    assert.equal(resposta.status, 200, 'o evento foi registrado mesmo com o Langfuse fora');
    assert.ok(decorrido < 1000,
      `a resposta levou ${decorrido}ms: o envio do rastro não pode ser esperado pela requisição`);

    const { ativo_id: ativoId } = await resposta.json();
    assert.ok(ativoId, 'o dado foi gravado normalmente');
  });

  test('avisa no log uma única vez, sem encher o registro', async () => {
    const token = await entrarComoAdmin(servidor.base);
    for (let i = 0; i < 3; i++) {
      await fetch(`${servidor.base}/api/eventos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(recebimento(`FORA-00${i + 2}`)),
      });
    }
    await new Promise((ok) => setTimeout(ok, 1200));
    const avisos = (servidor.texto().match(/\[observabilidade\]/g) || []).length;
    assert.equal(avisos, 1, `esperava um aviso, apareceram ${avisos}`);
  });
});

describe('o Langfuse lento não segura a resposta', () => {
  let servidor;
  let coletor;

  before(async () => {
    coletor = criarColetor({ atraso: 5000 }); // mais lento que o prazo de 3s
    const endereco = await coletor.ouvir();
    servidor = subirServidor({
      SGA_TI_LANGFUSE_URL: endereco,
      SGA_TI_LANGFUSE_CHAVE_PUBLICA: 'pk-teste',
      SGA_TI_LANGFUSE_CHAVE_SECRETA: 'sk-teste',
    });
    await servidor.pronto;
  });

  after(async () => { servidor.derrubar(); await coletor.fechar(); });

  test('responde na hora mesmo com o destino arrastado', async () => {
    const token = await entrarComoAdmin(servidor.base);
    const comeco = Date.now();
    const resposta = await fetch(`${servidor.base}/api/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(recebimento('LENTO-001')),
    });
    const decorrido = Date.now() - comeco;
    assert.equal(resposta.status, 200);
    assert.ok(decorrido < 1000, `a resposta levou ${decorrido}ms`);
  });
});
