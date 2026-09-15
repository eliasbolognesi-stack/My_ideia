'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./src/config');
const { abrirBanco } = require('./src/db');
const { garantirAdminInicial } = require('./src/auth');
const { despachar, ErroHttp, ErroDeValidacao } = require('./src/api');

const db = abrirBanco(config.caminhoBanco);

const credenciais = garantirAdminInicial(db, config.senhaAdminInicial);
if (credenciais) {
  console.log('==============================================================');
  console.log('Primeiro boot: usuário administrador criado.');
  console.log(`  e-mail: ${credenciais.email}`);
  console.log(`  senha : ${credenciais.senha}${credenciais.gerada ? '  (gerada — troque após o primeiro acesso)' : ''}`);
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

function responderJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(texto);
}

function servirEstatico(req, res, url) {
  const caminhoPedido = url.pathname === '/' ? '/index.html' : url.pathname;
  const caminho = path.normalize(path.join(DIRETORIO_PUBLICO, caminhoPedido));
  if (!caminho.startsWith(DIRETORIO_PUBLICO + path.sep) && caminho !== DIRETORIO_PUBLICO) {
    responderJson(res, 403, { erro: 'caminho inválido' });
    return;
  }
  fs.readFile(caminho, (erro, conteudo) => {
    if (erro) {
      responderJson(res, 404, { erro: 'não encontrado' });
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS_MIME[path.extname(caminho)] || 'application/octet-stream' });
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

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new ErroHttp(405, 'método não permitido');
      servirEstatico(req, res, url);
      return;
    }
    const corpo = req.method === 'GET' ? {} : await lerCorpo(req);
    const resultado = despachar(db, req, res, url, corpo);
    responderJson(res, 200, resultado);
  } catch (erro) {
    if (erro instanceof ErroDeValidacao) {
      responderJson(res, 422, { erro: 'validação falhou', detalhes: erro.erros });
    } else if (erro instanceof ErroHttp) {
      responderJson(res, erro.status, { erro: erro.message });
    } else {
      console.error(`[erro] ${req.method} ${url.pathname}:`, erro);
      responderJson(res, 500, { erro: 'erro interno' });
    }
  }
});

servidor.listen(config.porta, () => {
  console.log(`SGA-TI no ar: http://localhost:${config.porta}`);
  console.log(`Banco de dados: ${config.caminhoBanco}`);
  console.log(`Webhook n8n: ${config.chaveWebhook ? 'habilitado (POST /api/webhook/n8n)' : 'desabilitado (defina SGA_TI_WEBHOOK_KEY)'}`);
});
