'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./src/config');
const { abrirBanco } = require('./src/db');
const { garantirAdminInicial, limparSessoesExpiradas } = require('./src/auth');
const { despachar, ErroHttp, ErroDeValidacao } = require('./src/api');
const { seguranca } = require('./src/registro');

// ---------------------------------------------------------------------------
// Validação da configuração
//
// Em produção (NODE_ENV=production) uma combinação perigosa IMPEDE a subida,
// em vez de virar um aviso que ninguém lê no meio do log. Fora de produção,
// os mesmos pontos aparecem como aviso, para não atrapalhar o dia a dia.
// ---------------------------------------------------------------------------
function validarConfiguracao() {
  const erros = [];
  const avisos = [];

  if (!config.chavesWebhook.size && config.chaveWebhook) {
    erros.push({
      titulo: 'Webhook em modo legado (SGA_TI_WEBHOOK_KEY).',
      detalhe: 'Quem tiver a chave registra evento em nome de qualquer pessoa. Migre para '
        + 'SGA_TI_WEBHOOK_KEYS="chave:email", em que a chave define o autor.',
    });
  }

  const escutaExterna = config.host !== '127.0.0.1' && config.host !== 'localhost';
  if (escutaExterna && !config.forcarHttps) {
    erros.push({
      titulo: `Escutando em ${config.host} sem HTTPS.`,
      detalhe: 'Senha e credencial de sessão trafegariam abertas. Publique atrás de proxy reverso '
        + 'com TLS (SGA_TI_HOST=127.0.0.1) ou ligue SGA_TI_FORCAR_HTTPS.',
    });
  }
  if (escutaExterna && config.atrasDeProxy) {
    erros.push({
      titulo: `SGA_TI_ATRAS_PROXY ligado com escuta em ${config.host}.`,
      detalhe: 'Quem alcançar a porta direto forja o próprio endereço e escapa do limite de '
        + 'tentativas. Escute em 127.0.0.1 e deixe o proxy na frente.',
    });
  }

  if (!config.contatoDpo) {
    avisos.push('SGA_TI_CONTATO_DPO vazio: a LGPD exige um canal para o titular dos dados.');
  }
  if (!config.dominiosEvidencia.length) {
    avisos.push('SGA_TI_DOMINIOS_EVIDENCIA vazio: a evidência de descarte aceita link de qualquer domínio https.');
  }
  if (!config.chavesWebhook.size && !config.chaveWebhook) {
    avisos.push('Nenhuma chave de webhook: a entrada automática do n8n fica desabilitada.');
  }
  // Conteúdo completo indo para fora da máquina é transferência de dado
  // pessoal a terceiro. Avisar é o mínimo; bloquear seria decidir pelo dono.
  if (config.langfuseUrl && config.obsConteudo === 'completo') {
    const local = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i
      .test(config.langfuseUrl);
    if (!local) {
      avisos.push('SGA_TI_OBS_CONTEUDO=completo com Langfuse fora da rede local: o conteúdo dos '
        + 'eventos (com dado pessoal) vai sair da empresa. Use Langfuse próprio ou volte para '
        + '"metadados".');
    }
  }

  for (const aviso of avisos) console.warn(`AVISO: ${aviso}`);

  if (!erros.length) return;

  const traco = '='.repeat(70);
  console.error('');
  console.error(traco);
  console.error(config.producao
    ? 'CONFIGURACAO RECUSADA - o SGA-TI nao sobe com estes pontos em aberto:'
    : 'CONFIGURACAO PERIGOSA - com NODE_ENV=production isto impediria a subida:');
  for (const erro of erros) {
    console.error('');
    console.error(`  * ${erro.titulo}`);
    console.error(`    ${erro.detalhe}`);
  }
  console.error('');
  console.error('  Consulte .env.example e DEPLOY.md.');
  console.error(traco);
  console.error('');

  if (config.producao) process.exit(1);
}

validarConfiguracao();

// Se uma migração falhar, o banco fica como estava (a transação desfaz) e o
// servidor NÃO sobe: melhor não atender do que atender com o esquema pela
// metade e gravar evento que depois ninguém consegue ler.
let db;
try {
  db = abrirBanco(config.caminhoBanco);
} catch (erro) {
  const traco = '='.repeat(70);
  console.error('');
  console.error(traco);
  console.error('BANCO DE DADOS NAO PODE SER ABERTO - o SGA-TI nao vai subir:');
  console.error('');
  console.error(`  ${erro.message}`);
  console.error('');
  console.error(`  Banco: ${config.caminhoBanco}`);
  console.error('  Nada foi alterado. Restaure a cópia mais recente se precisar (OPERACAO.md).');
  console.error(traco);
  console.error('');
  process.exit(1);
}

// Sessão vencida só saía do banco quando alguém tentava usá-la: quem fecha o
// navegador e não volta deixava a linha lá para sempre. Uma varredura na
// subida e outra por dia bastam — não há pressa, só não pode crescer sem fim.
const varridas = limparSessoesExpiradas(db);
if (varridas) console.log(`Sessões expiradas removidas: ${varridas}`);
const varreduraDiaria = setInterval(() => {
  try {
    limparSessoesExpiradas(db);
  } catch (erro) {
    console.error(`[sessoes] varredura falhou: ${erro.message}`);
  }
}, 24 * 3600 * 1000);
// unref: esta tarefa não pode segurar o processo no ar na hora de encerrar.
varreduraDiaria.unref();

const credenciais = garantirAdminInicial(db, config.senhaAdminInicial);
if (credenciais) {
  console.log('==============================================================');
  console.log('Primeiro boot: usuário administrador criado.');
  console.log(`  e-mail: ${credenciais.email}`);
  console.log(`  senha : ${credenciais.senha}${credenciais.gerada ? '  (gerada)' : ''}`);
  console.log('  Esta senha é PROVISÓRIA: o sistema exige a troca no primeiro acesso.');
  console.log('==============================================================');
}

const DIRETORIO_PUBLICO = path.join(__dirname, 'public');
const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Cabeçalhos de segurança aplicados a TODA resposta.
// A política de conteúdo é estrita: só carrega script, estilo e imagem da
// própria origem (mais `data:` para o ícone embutido), e proíbe que a página
// seja carregada dentro de outro site — o golpe em que o funcionário clica
// num botão invisível achando que está em outro lugar.
const CABECALHOS_SEGURANCA = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function cabecalhos(extras = {}) {
  const saida = { ...CABECALHOS_SEGURANCA, ...extras };
  if (config.forcarHttps) {
    saida['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return saida;
}

function responderJson(res, status, corpo) {
  res.writeHead(status, cabecalhos({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }));
  res.end(JSON.stringify(corpo));
}

function servirEstatico(req, res, url) {
  const caminhoPedido = url.pathname === '/' ? '/index.html' : url.pathname;
  const caminho = path.normalize(path.join(DIRETORIO_PUBLICO, caminhoPedido));
  if (!caminho.startsWith(DIRETORIO_PUBLICO + path.sep) && caminho !== DIRETORIO_PUBLICO) {
    seguranca('caminho_suspeito', { caminho: caminhoPedido.slice(0, 200) });
    responderJson(res, 403, { erro: 'caminho inválido' });
    return;
  }
  fs.readFile(caminho, (erro, conteudo) => {
    if (erro) {
      responderJson(res, 404, { erro: 'não encontrado' });
      return;
    }
    res.writeHead(200, cabecalhos({
      'Content-Type': TIPOS_MIME[path.extname(caminho)] || 'application/octet-stream',
    }));
    res.end(conteudo);
  });
}

function lerCorpo(req) {
  return new Promise((resolver, rejeitar) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > 1024 * 1024) {
        rejeitar(new ErroHttp(413, 'corpo da requisição excede 1 MB'));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      if (!partes.length) return resolver({});
      try {
        resolver(JSON.parse(Buffer.concat(partes).toString('utf8')));
      } catch {
        rejeitar(new ErroHttp(400, 'JSON inválido no corpo da requisição'));
      }
    });
    req.on('error', rejeitar);
  });
}

const PAGINA_MANUTENCAO = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>SGA-TI — em manutenção</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1116;color:#e6e8ec;
font:16px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;text-align:center;padding:24px}
h1{color:#5b8cff;font-size:20px;letter-spacing:2px;margin:0 0 8px}p{color:#9aa3b2;margin:0}</style>
</head><body><div><h1>SGA-TI</h1><p>Sistema em manutenção. Tente novamente em alguns minutos.</p></div></body></html>`;

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // Modo manutenção: recusa tudo sem derrubar o processo nem perder o banco.
    if (config.manutencao) {
      if (url.pathname.startsWith('/api/')) {
        responderJson(res, 503, { erro: 'sistema em manutenção' });
      } else {
        res.writeHead(503, cabecalhos({ 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '300' }));
        res.end(PAGINA_MANUTENCAO);
      }
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new ErroHttp(405, 'método não permitido');
      servirEstatico(req, res, url);
      return;
    }
    const corpo = req.method === 'GET' ? {} : await lerCorpo(req);
    const resultado = despachar(db, req, res, url, corpo);
    // Uma rota que responde por conta própria (a exportação CSV escreve o
    // arquivo direto) já mandou os cabeçalhos; responder de novo aqui
    // derrubaria a requisição no meio.
    if (!res.headersSent) responderJson(res, 200, resultado);
  } catch (erro) {
    if (res.headersSent) {
      // Resposta já começou a sair: não dá para trocar o código de status.
      console.error(`[erro] ${req.method} ${url.pathname} depois de responder:`, erro);
      res.end();
    } else if (erro instanceof ErroDeValidacao) {
      responderJson(res, 422, { erro: 'validação falhou', detalhes: erro.erros });
    } else if (erro instanceof ErroHttp) {
      responderJson(res, erro.status, { erro: erro.message });
    } else {
      // O detalhe técnico fica no servidor; o visitante recebe só o genérico.
      console.error(`[erro] ${req.method} ${url.pathname}:`, erro);
      responderJson(res, 500, { erro: 'erro interno' });
    }
  }
});

function encerrar(sinal) {
  console.log(`\n[${sinal}] encerrando o SGA-TI...`);
  servidor.close(() => {
    try { db.close(); } catch { /* já fechado */ }
    process.exit(0);
  });
  // Não deixa conexão pendurada segurar o desligamento numa emergência.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

servidor.listen(config.porta, config.host, () => {
  // A porta vem do socket, e não da configuração: com PORT=0 (porta escolhida
  // pelo sistema) a configuração diria "0", que não serve para ninguém.
  const { port: portaReal } = servidor.address();
  console.log(`SGA-TI no ar: http://${config.host}:${portaReal}`);
  console.log(`Banco de dados: ${config.caminhoBanco}`);
  console.log(`Registro de segurança: ${config.arquivoRegistroSeguranca}`);

  if (config.manutencao) {
    console.log('MODO MANUTENÇÃO ATIVO: todas as requisições recebem 503.');
  }
  if (config.chavesWebhook.size) {
    console.log(`Webhook n8n: habilitado com ${config.chavesWebhook.size} chave(s) por origem`);
  } else if (config.chaveWebhook) {
    console.warn('AVISO: webhook em modo legado (SGA_TI_WEBHOOK_KEY). Quem tiver a chave pode');
    console.warn('       registrar eventos em nome de qualquer usuário. Migre para');
    console.warn('       SGA_TI_WEBHOOK_KEYS="chave:email" para a chave definir o autor.');
  } else {
    console.log('Webhook n8n: desabilitado (defina SGA_TI_WEBHOOK_KEYS)');
  }
});
