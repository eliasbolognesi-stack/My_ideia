'use strict';

// Ciclo de vida de conta e migrações de esquema.
//
// O que se prova aqui é o que o manual de operação manda fazer e antes não
// existia: trocar a senha, redefinir a senha de alguém, desativar quem saiu da
// empresa e derrubar sessões — com efeito imediato, não na próxima expiração.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const { abrirBanco } = require('../src/db');
const auth = require('../src/auth');
const { aplicarMigracoes, versaoAtual } = require('../src/migracoes');

const RAIZ = path.join(__dirname, '..');
const SENHA_ADMIN = 'senha-inicial-do-admin-1';
const SENHA_ADMIN_NOVA = 'senha-trocada-do-admin-2';

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sga-ti-contas-'));
}

// ---------------------------------------------------------------------------
// Migrações
// ---------------------------------------------------------------------------
describe('migrações de esquema', () => {
  test('aplica uma vez e não repete no boot seguinte', () => {
    const pasta = pastaTemporaria();
    try {
      const caminho = path.join(pasta, 'teste.db');
      let db = abrirBanco(caminho);
      assert.ok(versaoAtual(db) >= 1, 'a migração 001 foi aplicada no primeiro boot');
      const colunas = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
      assert.ok(colunas.includes('senha_provisoria'));
      const versaoDepoisDoPrimeiro = versaoAtual(db);
      db.close();

      // Reabrir é o que acontece a cada reinício do serviço: nada pode rodar
      // de novo, ou um ALTER TABLE repetido derrubaria o boot.
      db = abrirBanco(caminho);
      assert.equal(versaoAtual(db), versaoDepoisDoPrimeiro);
      db.close();
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('migração que falha desfaz tudo e não avança a versão', () => {
    const pasta = pastaTemporaria();
    try {
      const migracoes = path.join(pasta, 'migracoes');
      fs.mkdirSync(migracoes);
      fs.writeFileSync(path.join(migracoes, '001-cria.sql'), 'CREATE TABLE teste_ok (id INTEGER);');
      fs.writeFileSync(path.join(migracoes, '002-quebrada.sql'),
        'CREATE TABLE meio (id INTEGER);\nISTO NAO E SQL;');

      const db = new DatabaseSync(path.join(pasta, 'teste.db'));
      assert.throws(() => aplicarMigracoes(db, migracoes), /002-quebrada\.sql falhou e foi desfeita/);

      // A 001 valeu; da 002 não pode ter sobrado nada pela metade.
      const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((l) => l.name);
      assert.ok(tabelas.includes('teste_ok'), 'a migração boa continua aplicada');
      assert.ok(!tabelas.includes('meio'), 'a parte que rodou antes do erro foi desfeita');
      assert.equal(versaoAtual(db), 1, 'a versão parou na última que deu certo');
      db.close();
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('nome de arquivo fora do padrão é recusado em vez de ignorado', () => {
    const pasta = pastaTemporaria();
    try {
      const migracoes = path.join(pasta, 'migracoes');
      fs.mkdirSync(migracoes);
      // Sem isto, a migração seria pulada em silêncio — e migração que ninguém
      // aplicou é pior do que um erro no boot.
      fs.writeFileSync(path.join(migracoes, 'corrige-coluna.sql'), 'SELECT 1;');
      const db = new DatabaseSync(path.join(pasta, 'teste.db'));
      assert.throws(() => aplicarMigracoes(db, migracoes), /nome inválido/);
      db.close();
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('dois arquivos com o mesmo número são recusados', () => {
    const pasta = pastaTemporaria();
    try {
      const migracoes = path.join(pasta, 'migracoes');
      fs.mkdirSync(migracoes);
      fs.writeFileSync(path.join(migracoes, '002-um.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(migracoes, '002-outro.sql'), 'SELECT 1;');
      const db = new DatabaseSync(path.join(pasta, 'teste.db'));
      assert.throws(() => aplicarMigracoes(db, migracoes), /mesmo número|número 2/);
      db.close();
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sessões expiradas (unidade)
// ---------------------------------------------------------------------------
describe('varredura de sessões expiradas', () => {
  test('apaga só o que já venceu', () => {
    const db = abrirBanco(':memory:');
    try {
      auth.garantirAdminInicial(db, SENHA_ADMIN);
      const { id } = db.prepare('SELECT id FROM usuarios LIMIT 1').get();

      const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run('velha', id, ontem);
      db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run('viva', id, amanha);

      assert.equal(auth.limparSessoesExpiradas(db), 1);
      const restantes = db.prepare('SELECT token FROM sessoes').all().map((l) => l.token);
      assert.deepEqual(restantes, ['viva']);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integração: servidor real
// ---------------------------------------------------------------------------
function subirServidor(extras = {}) {
  const pasta = pastaTemporaria();
  const filho = spawn(process.execPath, ['--no-warnings', path.join(RAIZ, 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      SGA_TI_DB: path.join(pasta, 'teste.db'),
      SGA_TI_LOG_SEGURANCA: path.join(pasta, 'seguranca.log'),
      SGA_TI_ADMIN_SENHA: SENHA_ADMIN,
      SGA_TI_WEBHOOK_KEYS: 'chave-de-teste:admin@local',
      ...extras,
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
    filho,
    pasta,
    get base() { return base; },
    pronto,
    derrubar: () => { filho.kill('SIGKILL'); fs.rmSync(pasta, { recursive: true, force: true }); },
  };
}

async function pedir(base, caminho, opcoes = {}) {
  const resposta = await fetch(base + caminho, {
    method: opcoes.metodo || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opcoes.cabecalhos || {}) },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  return { status: resposta.status, corpo: await resposta.json().catch(() => ({})) };
}

const comToken = (token) => ({ Authorization: `Bearer ${token}` });

describe('contas pelo servidor', () => {
  let servidor;
  let tokenAdmin;

  async function entrar(email, senha) {
    const r = await pedir(servidor.base, '/api/auth/login', { metodo: 'POST', corpo: { email, senha } });
    return r;
  }

  // Cria alguém, entra com a senha provisória e já troca — o caminho normal.
  async function criarPessoaPronta(email, papel = 'operador') {
    const senhaInicial = 'senha-dada-pelo-admin-1';
    const senhaPropria = `propria-${email.replace(/\W/g, '')}`;
    const criacao = await pedir(servidor.base, '/api/usuarios', {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin),
      corpo: { nome: `Pessoa ${email}`, email, senha: senhaInicial, papel },
    });
    assert.equal(criacao.status, 200, JSON.stringify(criacao.corpo));

    const entrada = await entrar(email, senhaInicial);
    const troca = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(entrada.corpo.token),
      corpo: { senha_atual: senhaInicial, senha_nova: senhaPropria },
    });
    assert.equal(troca.status, 200, JSON.stringify(troca.corpo));
    return { id: criacao.corpo.usuario.id, email, senha: senhaPropria, token: entrada.corpo.token };
  }

  before(async () => {
    servidor = subirServidor();
    await servidor.pronto;
    const entrada = await entrar('admin@local', SENHA_ADMIN);
    tokenAdmin = entrada.corpo.token;
    await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin),
      corpo: { senha_atual: SENHA_ADMIN, senha_nova: SENHA_ADMIN_NOVA },
    });
  });

  after(() => servidor.derrubar());

  // --- senha provisória ----------------------------------------------------
  test('senha provisória tranca o sistema até ser trocada', async () => {
    const pessoa = 'trancado@empresa.com';
    await pedir(servidor.base, '/api/usuarios', {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin),
      corpo: { nome: 'Pessoa Trancada', email: pessoa, senha: 'senha-do-admin-11', papel: 'operador' },
    });
    const entrada = await entrar(pessoa, 'senha-do-admin-11');
    assert.equal(entrada.status, 200, 'entrar funciona: o que trava é o resto');
    assert.equal(entrada.corpo.usuario.senha_provisoria, true);
    const token = entrada.corpo.token;

    // Trancado para o trabalho...
    const ativos = await pedir(servidor.base, '/api/ativos', { cabecalhos: comToken(token) });
    assert.equal(ativos.status, 428);
    assert.match(ativos.corpo.erro, /troque a senha/i);

    const evento = await pedir(servidor.base, '/api/eventos', {
      metodo: 'POST', cabecalhos: comToken(token), corpo: { tipo: 'Recebimento', dados: {} },
    });
    assert.equal(evento.status, 428, 'não registra evento com senha que outra pessoa conhece');

    // ...mas não para o que é preciso fazer para destravar.
    assert.equal((await pedir(servidor.base, '/api/me', { cabecalhos: comToken(token) })).status, 200);

    const troca = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(token),
      corpo: { senha_atual: 'senha-do-admin-11', senha_nova: 'agora-e-so-minha-22' },
    });
    assert.equal(troca.status, 200);
    assert.equal((await pedir(servidor.base, '/api/ativos', { cabecalhos: comToken(token) })).status, 200,
      'destravou sem precisar entrar de novo');
  });

  // --- troca da própria senha ---------------------------------------------
  test('trocar a senha derruba as OUTRAS sessões e mantém a atual', async () => {
    const pessoa = await criarPessoaPronta('duas-sessoes@empresa.com');

    // Duas sessões abertas, como quem entra no computador e no celular.
    const outra = await entrar(pessoa.email, pessoa.senha);
    const tokenOutra = outra.corpo.token;
    const tokenAtual = (await entrar(pessoa.email, pessoa.senha)).corpo.token;

    const troca = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(tokenAtual),
      corpo: { senha_atual: pessoa.senha, senha_nova: 'depois-do-vazamento-33' },
    });
    assert.equal(troca.status, 200);
    assert.ok(troca.corpo.sessoes_encerradas >= 1);

    // É isto que faz a troca resolver um vazamento: quem tinha a sessão sai.
    assert.equal((await pedir(servidor.base, '/api/me', { cabecalhos: comToken(tokenOutra) })).status, 401);
    assert.equal((await pedir(servidor.base, '/api/me', { cabecalhos: comToken(tokenAtual) })).status, 200);
  });

  test('recusa senha curta, senha atual errada e senha igual à anterior', async () => {
    const pessoa = await criarPessoaPronta('recusas@empresa.com');
    const token = (await entrar(pessoa.email, pessoa.senha)).corpo.token;

    const curta = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(token),
      corpo: { senha_atual: pessoa.senha, senha_nova: 'abc' },
    });
    assert.equal(curta.status, 422);
    assert.match(curta.corpo.erro, /8 caracteres/);

    const errada = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(token),
      corpo: { senha_atual: 'nao-e-essa-99', senha_nova: 'uma-senha-valida-44' },
    });
    assert.equal(errada.status, 422);
    assert.match(errada.corpo.erro, /não confere/);

    // Senão, "trocar" a senha provisória pela mesma senha limparia a pendência
    // sem trocar nada.
    const igual = await pedir(servidor.base, '/api/me/senha', {
      metodo: 'POST', cabecalhos: comToken(token),
      corpo: { senha_atual: pessoa.senha, senha_nova: pessoa.senha },
    });
    assert.equal(igual.status, 422);
    assert.match(igual.corpo.erro, /diferente da atual/);
  });

  // --- ações do administrador ---------------------------------------------
  test('admin redefine a senha: sessões caem e a nova nasce provisória', async () => {
    const pessoa = await criarPessoaPronta('esqueceu@empresa.com');
    const tokenDela = (await entrar(pessoa.email, pessoa.senha)).corpo.token;

    const reset = await pedir(servidor.base, `/api/usuarios/${pessoa.id}/senha`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin),
      corpo: { senha_nova: 'senha-temporaria-do-suporte-55' },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.corpo));
    assert.ok(reset.corpo.sessoes_encerradas >= 1);

    assert.equal((await pedir(servidor.base, '/api/me', { cabecalhos: comToken(tokenDela) })).status, 401);

    const novaEntrada = await entrar(pessoa.email, 'senha-temporaria-do-suporte-55');
    assert.equal(novaEntrada.status, 200);
    assert.equal(novaEntrada.corpo.usuario.senha_provisoria, true,
      'a senha que o suporte digitou tem de ser trocada pela pessoa');
  });

  test('desativar tira o acesso na hora, sem esperar a sessão expirar', async () => {
    const pessoa = await criarPessoaPronta('saiu-da-empresa@empresa.com');
    const tokenDela = (await entrar(pessoa.email, pessoa.senha)).corpo.token;
    assert.equal((await pedir(servidor.base, '/api/ativos', { cabecalhos: comToken(tokenDela) })).status, 200);

    const desativa = await pedir(servidor.base, `/api/usuarios/${pessoa.id}/situacao`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin), corpo: { ativo: false },
    });
    assert.equal(desativa.status, 200);

    assert.equal((await pedir(servidor.base, '/api/ativos', { cabecalhos: comToken(tokenDela) })).status, 401);
    assert.equal((await entrar(pessoa.email, pessoa.senha)).status, 401, 'nem entrando de novo');

    // E volta quando é reativada.
    await pedir(servidor.base, `/api/usuarios/${pessoa.id}/situacao`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin), corpo: { ativo: true },
    });
    assert.equal((await entrar(pessoa.email, pessoa.senha)).status, 200);
  });

  test('admin encerra as sessões de alguém sem mexer na senha', async () => {
    const pessoa = await criarPessoaPronta('sessao-roubada@empresa.com');
    const tokenDela = (await entrar(pessoa.email, pessoa.senha)).corpo.token;

    const corte = await pedir(servidor.base, `/api/usuarios/${pessoa.id}/sessoes`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin),
    });
    assert.equal(corte.status, 200);
    assert.ok(corte.corpo.sessoes_encerradas >= 1);

    assert.equal((await pedir(servidor.base, '/api/me', { cabecalhos: comToken(tokenDela) })).status, 401);
    assert.equal((await entrar(pessoa.email, pessoa.senha)).status, 200, 'a senha continua valendo');
  });

  // --- travas contra o sistema ficar sem dono ------------------------------
  test('admin não desativa a própria conta nem o último administrador', async () => {
    const meuId = (await pedir(servidor.base, '/api/me', { cabecalhos: comToken(tokenAdmin) })).corpo.usuario.id;

    const aPropria = await pedir(servidor.base, `/api/usuarios/${meuId}/situacao`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin), corpo: { ativo: false },
    });
    assert.equal(aPropria.status, 422);
    assert.match(aPropria.corpo.erro, /própria conta/);

    // Com um segundo admin, o primeiro deixa de ser o último — mas continua
    // sem poder desativar a si mesmo.
    const outroAdmin = await criarPessoaPronta('outro-admin@empresa.com', 'admin');
    const desativaOutro = await pedir(servidor.base, `/api/usuarios/${outroAdmin.id}/situacao`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin), corpo: { ativo: false },
    });
    assert.equal(desativaOutro.status, 200, 'dá para desativar outro admin quando não é o último');

    const ultimo = await pedir(servidor.base, `/api/usuarios/${meuId}/situacao`, {
      metodo: 'POST', cabecalhos: comToken(tokenAdmin), corpo: { ativo: false },
    });
    assert.equal(ultimo.status, 422);
  });

  test('quem não é admin não redefine senha, não desativa e não corta sessão', async () => {
    const pessoa = await criarPessoaPronta('curioso@empresa.com');
    const token = (await entrar(pessoa.email, pessoa.senha)).corpo.token;
    const alvo = await criarPessoaPronta('alvo@empresa.com');

    for (const caminho of [`/api/usuarios/${alvo.id}/senha`, `/api/usuarios/${alvo.id}/situacao`,
      `/api/usuarios/${alvo.id}/sessoes`]) {
      const r = await pedir(servidor.base, caminho, {
        metodo: 'POST', cabecalhos: comToken(token), corpo: { senha_nova: 'tentativa-de-golpe-88', ativo: false },
      });
      assert.equal(r.status, 403, `${caminho} deveria ser restrita a admin`);
    }
  });

  test('a lista de usuários mostra situação e sessões abertas', async () => {
    const lista = await pedir(servidor.base, '/api/usuarios', { cabecalhos: comToken(tokenAdmin) });
    assert.equal(lista.status, 200);
    const admin = lista.corpo.usuarios.find((u) => u.email === 'admin@local');
    assert.equal(admin.ativo, 1);
    assert.equal(admin.senha_provisoria, 0);
    assert.ok(admin.sessoes_ativas >= 1, 'a tela precisa disto para saber quem está dentro');
  });

  test('cada ação de conta deixa rastro no registro de segurança', async () => {
    const conteudo = fs.readFileSync(path.join(servidor.pasta, 'seguranca.log'), 'utf8');
    for (const tipo of ['senha_trocada', 'senha_redefinida_por_admin', 'usuario_desativado',
      'sessoes_encerradas_por_admin']) {
      assert.match(conteudo, new RegExp(tipo), `faltou registrar ${tipo}`);
    }
    // E nenhuma senha aparece no registro.
    assert.doesNotMatch(conteudo, /senha-temporaria-do-suporte-55|agora-e-so-minha-22/);
  });
});
