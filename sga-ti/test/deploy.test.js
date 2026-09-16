'use strict';

// Testes do que o sistema precisa para viver em produção: a rota que responde
// "estou vivo", a rotação do registro de segurança (senão o disco enche) e a
// checagem de configuração que impede subir com combinação perigosa.
//
// Todos sobem processo de verdade, porque é exatamente o comportamento no
// boot e sob carga que está sendo verificado — nada disso aparece chamando a
// função direto no mesmo processo.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const SERVIDOR = path.join(RAIZ, 'server.js');
const SENHA_ADMIN = 'senha-de-teste-123';

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sga-ti-deploy-'));
}

// Sobe o servidor e devolve tudo o que ele escreveu, mais o código de saída.
// `aguardarSubida` resolve quando o servidor anuncia que está no ar; se ele
// morrer antes, resolve mesmo assim, para o teste poder conferir a mensagem.
function subirServidor(extras = {}) {
  const pasta = pastaTemporaria();
  // PORT=0 deixa o sistema escolher uma porta livre. Sortear número dá
  // colisão entre os servidores dos testes de vez em quando, e um teste que
  // falha "às vezes" ensina o time a ignorar teste vermelho.
  const filho = spawn(process.execPath, ['--no-warnings', SERVIDOR], {
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
  filho.stdout.on('data', (d) => { saida += String(d); });
  filho.stderr.on('data', (d) => { saida += String(d); });

  const encerrou = new Promise((resolver) => {
    filho.on('close', (codigo) => resolver(codigo));
  });

  const aguardarSubida = new Promise((resolver, rejeitar) => {
    const prazo = setTimeout(() => rejeitar(new Error(`servidor não respondeu a tempo:\n${saida}`)), 10000);
    const conferir = () => {
      const anuncio = saida.match(/SGA-TI no ar: (http:\/\/\S+)/);
      if (anuncio) {
        base = anuncio[1];
        clearTimeout(prazo);
        resolver('no ar');
      }
    };
    filho.stdout.on('data', conferir);
    filho.on('close', () => { clearTimeout(prazo); resolver('morreu'); });
    filho.on('error', rejeitar);
  });

  return {
    filho,
    pasta,
    get base() { return base; },
    aguardarSubida,
    encerrou,
    texto: () => saida,
    derrubar: () => { filho.kill('SIGKILL'); fs.rmSync(pasta, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Rota de saúde
// ---------------------------------------------------------------------------
describe('rota de saúde', () => {
  let servidor;

  before(async () => {
    servidor = subirServidor();
    await servidor.aguardarSubida;
  });

  after(() => servidor.derrubar());

  test('responde 200 sem precisar de login, com versão e estado do banco', async () => {
    const resposta = await fetch(`${servidor.base}/api/saude`);
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.ok, true);
    assert.equal(corpo.banco, 'ok');
    assert.equal(corpo.manutencao, false);
    assert.equal(corpo.versao, require('../package.json').version);
    assert.ok(Date.parse(corpo.momento), 'traz o momento da resposta em formato de data');
  });

  test('não vaza nada que sirva para um atacante', async () => {
    const texto = await (await fetch(`${servidor.base}/api/saude`)).text();
    // Nem caminho de arquivo, nem versão do Node, nem contagem de usuários:
    // a rota é pública por natureza, então só pode dizer "vivo" ou "doente".
    assert.doesNotMatch(texto, /\/(home|opt|var|tmp)\//);
    assert.doesNotMatch(texto, /node|sqlite|email|senha|token/i);
  });

  test('em manutenção a rota também responde 503, como o resto', async () => {
    const emManutencao = subirServidor({ SGA_TI_MANUTENCAO: '1' });
    try {
      await emManutencao.aguardarSubida;
      const resposta = await fetch(`${emManutencao.base}/api/saude`);
      // 503 é a resposta certa: o monitor de uptime PRECISA acusar a janela de
      // manutenção, senão ninguém percebe que ela ficou ligada por engano.
      assert.equal(resposta.status, 503);
    } finally {
      emManutencao.derrubar();
    }
  });
});

// ---------------------------------------------------------------------------
// Rotação do registro de segurança
// ---------------------------------------------------------------------------
describe('rotação do registro de segurança', () => {
  // O registro lê a configuração uma vez, quando é carregado — então cada
  // cenário precisa de um processo novo com o ambiente já ajustado.
  function escrever(pasta, quantidade, extras = {}) {
    const script = `
      const { seguranca } = require(${JSON.stringify(path.join(RAIZ, 'src', 'registro'))});
      for (let i = 0; i < ${quantidade}; i++) seguranca('teste', { numero: i, enchendo: 'x'.repeat(200) });
    `;
    const saida = spawn(process.execPath, ['--no-warnings', '-e', script], {
      env: {
        ...process.env,
        SGA_TI_LOG_SEGURANCA: path.join(pasta, 'seguranca.log'),
        SGA_TI_LOG_TAMANHO_MB: '0.01', // 10 kB — o piso permitido
        SGA_TI_LOG_ARQUIVOS: '3',
        ...extras,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return new Promise((resolver, rejeitar) => {
      let erro = '';
      saida.stderr.on('data', (d) => { erro += String(d); });
      saida.on('close', (codigo) => (codigo === 0
        ? resolver()
        : rejeitar(new Error(`escrita falhou (${codigo}):\n${erro}`))));
    });
  }

  test('parte o arquivo ao passar do tamanho e guarda só os últimos', async () => {
    const pasta = pastaTemporaria();
    try {
      await escrever(pasta, 150);

      const arquivos = fs.readdirSync(pasta).sort();
      assert.deepEqual(arquivos, ['seguranca.log', 'seguranca.log.1', 'seguranca.log.2', 'seguranca.log.3'],
        'mantém o atual mais os 3 anteriores, e nada além disso');

      const limite = 0.01 * 1024 * 1024;
      for (const arquivo of arquivos) {
        const tamanho = fs.statSync(path.join(pasta, arquivo)).size;
        assert.ok(tamanho <= limite, `${arquivo} tem ${tamanho} bytes, acima do limite de ${limite}`);
      }

      // Cada linha continua sendo um JSON válido: rotação que corta linha no
      // meio estraga o registro justamente quando ele seria necessário.
      const linhas = fs.readFileSync(path.join(pasta, 'seguranca.log'), 'utf8').trim().split('\n');
      for (const linha of linhas) assert.doesNotThrow(() => JSON.parse(linha));
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('continua de onde parou depois de o processo reiniciar', async () => {
    const pasta = pastaTemporaria();
    try {
      // Três processos separados, como três reinícios do servidor. O tamanho
      // é lido do disco, não de um contador em memória — é isto que se checa.
      await escrever(pasta, 40);
      await escrever(pasta, 40);
      await escrever(pasta, 40);

      assert.ok(fs.existsSync(path.join(pasta, 'seguranca.log.1')),
        'a rotação aconteceu mesmo tendo sido em processos diferentes');
      const limite = 0.01 * 1024 * 1024;
      for (const arquivo of fs.readdirSync(pasta)) {
        assert.ok(fs.statSync(path.join(pasta, arquivo)).size <= limite, `${arquivo} passou do limite`);
      }
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('sem pasta criada ainda, cria sozinho em vez de derrubar o processo', async () => {
    const pasta = pastaTemporaria();
    try {
      const aninhada = path.join(pasta, 'que', 'nao', 'existe');
      await escrever(aninhada, 3);
      assert.ok(fs.existsSync(path.join(aninhada, 'seguranca.log')));
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Configuração numérica escrita errado
// ---------------------------------------------------------------------------
describe('valor numérico inválido na configuração', () => {
  function lerConfig(extras) {
    const script = `
      const c = require(${JSON.stringify(path.join(RAIZ, 'src', 'config'))});
      process.stdout.write(JSON.stringify({
        limiteLogin: c.limiteLogin,
        tamanhoMaximoLogMB: c.tamanhoMaximoLogMB,
        arquivosLogMantidos: c.arquivosLogMantidos,
        tamanhoMaximoCampo: c.tamanhoMaximoCampo,
      }));
    `;
    const saida = spawn(process.execPath, ['--no-warnings', '-e', script], {
      env: { ...process.env, ...extras },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolver) => {
      let json = '';
      let aviso = '';
      saida.stdout.on('data', (d) => { json += String(d); });
      saida.stderr.on('data', (d) => { aviso += String(d); });
      saida.on('close', () => resolver({ config: JSON.parse(json), aviso }));
    });
  }

  test('cai no padrão e avisa, em vez de desligar a proteção em silêncio', async () => {
    // "vinte" viraria NaN, e toda comparação com NaN é falsa: o limite de
    // tentativas de login deixaria de existir sem ninguém perceber.
    const { config, aviso } = await lerConfig({
      SGA_TI_LIMITE_LOGIN: 'vinte',
      SGA_TI_LOG_TAMANHO_MB: '-3',
      SGA_TI_LOG_ARQUIVOS: '0',
      SGA_TI_TAMANHO_CAMPO: '',
    });

    assert.equal(config.limiteLogin, 20);
    assert.equal(config.tamanhoMaximoLogMB, 5);
    assert.equal(config.arquivosLogMantidos, 5);
    assert.equal(config.tamanhoMaximoCampo, 2000, 'vazio também cai no padrão');
    assert.match(aviso, /valor inválido "vinte"/);
    assert.match(aviso, /valor inválido "-3"/);
  });

  test('valor válido continua sendo respeitado', async () => {
    const { config } = await lerConfig({ SGA_TI_LIMITE_LOGIN: '3', SGA_TI_LOG_TAMANHO_MB: '0.5' });
    assert.equal(config.limiteLogin, 3);
    assert.equal(config.tamanhoMaximoLogMB, 0.5);
  });
});

// ---------------------------------------------------------------------------
// Checagem de configuração no boot
// ---------------------------------------------------------------------------
describe('checagem de configuração no boot', () => {
  const perigoso = {
    NODE_ENV: 'production',
    SGA_TI_HOST: '0.0.0.0',
    SGA_TI_ATRAS_PROXY: '1',
  };

  test('em produção, recusa subir atrás de proxy escutando para fora', async () => {
    const servidor = subirServidor(perigoso);
    try {
      const desfecho = await servidor.aguardarSubida;
      assert.equal(desfecho, 'morreu', 'o servidor não pode ficar no ar assim');
      assert.equal(await servidor.encerrou, 1, 'sai com código de erro, para o systemd acusar falha');

      const texto = servidor.texto();
      assert.match(texto, /CONFIGURACAO RECUSADA/);
      // A mensagem tem de dizer O QUE corrigir, não só que está errado.
      assert.match(texto, /SGA_TI_ATRAS_PROXY/);
      assert.match(texto, /127\.0\.0\.1/);
      assert.match(texto, /DEPLOY\.md/);
    } finally {
      servidor.derrubar();
    }
  });

  test('em produção, recusa escuta externa sem HTTPS', async () => {
    const servidor = subirServidor({ NODE_ENV: 'production', SGA_TI_HOST: '0.0.0.0' });
    try {
      assert.equal(await servidor.aguardarSubida, 'morreu');
      assert.equal(await servidor.encerrou, 1);
      assert.match(servidor.texto(), /sem HTTPS/i);
      assert.match(servidor.texto(), /SGA_TI_FORCAR_HTTPS/);
    } finally {
      servidor.derrubar();
    }
  });

  test('em produção, recusa o webhook em modo legado', async () => {
    const servidor = subirServidor({
      NODE_ENV: 'production',
      SGA_TI_WEBHOOK_KEYS: '',
      SGA_TI_WEBHOOK_KEY: 'chave-antiga-sem-dono',
    });
    try {
      assert.equal(await servidor.aguardarSubida, 'morreu');
      assert.match(servidor.texto(), /SGA_TI_WEBHOOK_KEYS/);
    } finally {
      servidor.derrubar();
    }
  });

  test('fora de produção avisa, mas deixa subir — senão trava o dia de quem desenvolve', async () => {
    const servidor = subirServidor({ ...perigoso, NODE_ENV: 'development' });
    try {
      assert.equal(await servidor.aguardarSubida, 'no ar');
      assert.match(servidor.texto(), /CONFIGURACAO PERIGOSA/);
      assert.match(servidor.texto(), /com NODE_ENV=production isto impediria a subida/);
    } finally {
      servidor.derrubar();
    }
  });

  test('configuração correta de produção sobe e responde', async () => {
    const servidor = subirServidor({ NODE_ENV: 'production', SGA_TI_HOST: '127.0.0.1' });
    try {
      assert.equal(await servidor.aguardarSubida, 'no ar');
      assert.doesNotMatch(servidor.texto(), /CONFIGURACAO RECUSADA/);
      assert.equal((await fetch(`${servidor.base}/api/saude`)).status, 200);
    } finally {
      servidor.derrubar();
    }
  });
});
