'use strict';

const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const autenticacao = require('./auth');
const servico = require('./servico-eventos');
const { mapearEventoN8n } = require('./n8n');
const { TIPOS_EVENTO, STATUS } = require('./regras');
const { ErroDeValidacao } = servico;

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Roteador minimalista: método + padrão com :parâmetros.
// ---------------------------------------------------------------------------
const rotas = [];

function rota(metodo, padrao, opcoes, tratador) {
  rotas.push({ metodo, segmentos: padrao.split('/').filter(Boolean), opcoes, tratador });
}

function casar(segmentosRota, segmentosUrl) {
  if (segmentosRota.length !== segmentosUrl.length) return null;
  const parametros = {};
  for (let i = 0; i < segmentosRota.length; i++) {
    const s = segmentosRota[i];
    if (s.startsWith(':')) parametros[s.slice(1)] = decodeURIComponent(segmentosUrl[i]);
    else if (s !== segmentosUrl[i]) return null;
  }
  return parametros;
}

// Controle simples de tentativas de login por IP.
const tentativasLogin = new Map();
function loginPermitido(ip) {
  const agora = Date.now();
  const registro = tentativasLogin.get(ip);
  if (!registro || agora > registro.zera) {
    tentativasLogin.set(ip, { contagem: 1, zera: agora + 10 * 60 * 1000 });
    return true;
  }
  registro.contagem += 1;
  return registro.contagem <= 20;
}

function extrairToken(req) {
  const cabecalho = req.headers['authorization'] || '';
  return cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
}

function chaveWebhookConfere(recebida) {
  if (!config.chaveWebhook || !recebida) return false;
  const a = Buffer.from(String(recebida));
  const b = Buffer.from(config.chaveWebhook);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

rota('POST', '/api/auth/login', { publica: true }, ({ db, corpo, ip }) => {
  if (!loginPermitido(ip)) throw new ErroHttp(429, 'muitas tentativas de login, aguarde alguns minutos');
  const sessao = autenticacao.login(db, corpo.email, corpo.senha, config.duracaoSessaoHoras);
  if (!sessao) throw new ErroHttp(401, 'e-mail ou senha inválidos');
  return sessao;
});

rota('POST', '/api/auth/logout', {}, ({ db, token }) => {
  autenticacao.encerrarSessao(db, token);
  return { ok: true };
});

rota('GET', '/api/me', {}, ({ usuario }) => ({ usuario, empresa: config.empresa }));

rota('GET', '/api/dashboard', {}, ({ db }) => {
  const porStatus = {};
  for (const s of Object.values(STATUS)) porStatus[s] = 0;
  for (const linha of db.prepare('SELECT status_atual, COUNT(*) AS total FROM ativos GROUP BY status_atual').all()) {
    porStatus[linha.status_atual] = linha.total;
  }
  const pendencias = db.prepare("SELECT COUNT(*) AS total FROM aprovacoes WHERE status = 'pendente'").get().total;
  const ultimosEventos = db
    .prepare(
      `SELECT e.id, e.tipo, e.autor_nome, e.data_hora, e.status_anterior, e.status_novo,
              a.patrimonio, a.modelo
         FROM eventos e JOIN ativos a ON a.id = e.ativo_id
        ORDER BY e.id DESC LIMIT 10`
    )
    .all();
  return { por_status: porStatus, aprovacoes_pendentes: pendencias, ultimos_eventos: ultimosEventos };
});

rota('GET', '/api/ativos', {}, ({ db, consulta }) => {
  const clausulas = [];
  const valores = [];
  if (consulta.status) {
    clausulas.push('status_atual = ?');
    valores.push(consulta.status);
  }
  if (consulta.q) {
    clausulas.push('(patrimonio LIKE ? OR numero_serie LIKE ? OR modelo LIKE ? OR responsavel_atual LIKE ? OR localizacao_atual LIKE ?)');
    const termo = `%${consulta.q}%`;
    valores.push(termo, termo, termo, termo, termo);
  }
  const onde = clausulas.length ? `WHERE ${clausulas.join(' AND ')}` : '';
  return {
    ativos: db.prepare(`SELECT * FROM ativos ${onde} ORDER BY atualizado_em DESC LIMIT 500`).all(...valores),
  };
});

rota('GET', '/api/ativos/:id', {}, ({ db, parametros }) => {
  const ativo = db.prepare('SELECT * FROM ativos WHERE id = ?').get(Number(parametros.id));
  if (!ativo) throw new ErroHttp(404, 'ativo não encontrado');
  const eventos = db
    .prepare('SELECT * FROM eventos WHERE ativo_id = ? ORDER BY id DESC')
    .all(ativo.id)
    .map((e) => ({ ...e, dados: JSON.parse(e.dados) }));
  return { ativo, eventos };
});

rota('GET', '/api/ativos/:id/integridade', {}, ({ db, parametros }) => {
  const ativo = db.prepare('SELECT id, patrimonio FROM ativos WHERE id = ?').get(Number(parametros.id));
  if (!ativo) throw new ErroHttp(404, 'ativo não encontrado');
  return { patrimonio: ativo.patrimonio, ...servico.verificarIntegridade(db, ativo.id) };
});

rota('POST', '/api/eventos', {}, ({ db, corpo, usuario }) => {
  const tipo = corpo.tipo;
  if (!TIPOS_EVENTO.includes(tipo)) {
    throw new ErroHttp(422, `tipo inválido: aceitos ${TIPOS_EVENTO.join(', ')}`);
  }
  return servico.registrarEvento(db, tipo, corpo.dados || {}, usuario);
});

rota('GET', '/api/aprovacoes', {}, ({ db, consulta }) => {
  const status = consulta.status || 'pendente';
  return {
    aprovacoes: db
      .prepare(
        `SELECT ap.*, a.patrimonio, a.numero_serie, a.modelo, a.status_atual
           FROM aprovacoes ap JOIN ativos a ON a.id = ap.ativo_id
          WHERE ap.status = ? ORDER BY ap.id DESC LIMIT 200`
      )
      .all(status)
      .map((ap) => ({ ...ap, payload: JSON.parse(ap.payload) })),
  };
});

rota('POST', '/api/aprovacoes/:id/decisao', { papeis: ['aprovador', 'admin'] }, ({ db, parametros, corpo, usuario }) =>
  servico.decidirAprovacao(db, parametros.id, corpo.decisao, corpo.justificativa, usuario)
);

// Auditoria / direitos do titular (LGPD art. 18): histórico de eventos por
// colaborador ou filtros gerais.
rota('GET', '/api/auditoria/eventos', {}, ({ db, consulta }) => {
  const clausulas = [];
  const valores = [];
  if (consulta.colaborador) {
    const termo = `%${consulta.colaborador}%`;
    clausulas.push('(e.autor_nome LIKE ? OR e.dados LIKE ?)');
    valores.push(termo, termo);
  }
  if (consulta.tipo) {
    clausulas.push('e.tipo = ?');
    valores.push(consulta.tipo);
  }
  if (consulta.ativo_id) {
    clausulas.push('e.ativo_id = ?');
    valores.push(Number(consulta.ativo_id));
  }
  const onde = clausulas.length ? `WHERE ${clausulas.join(' AND ')}` : '';
  return {
    eventos: db
      .prepare(
        `SELECT e.*, a.patrimonio, a.modelo FROM eventos e
           JOIN ativos a ON a.id = e.ativo_id ${onde}
          ORDER BY e.id DESC LIMIT 300`
      )
      .all(...valores)
      .map((e) => ({ ...e, dados: JSON.parse(e.dados) })),
  };
});

rota('GET', '/api/usuarios', { papeis: ['admin'] }, ({ db }) => ({
  usuarios: db.prepare('SELECT id, nome, email, matricula, papel, ativo, criado_em FROM usuarios ORDER BY nome').all(),
}));

rota('POST', '/api/usuarios', { papeis: ['admin'] }, ({ db, corpo }) => {
  for (const campo of ['nome', 'email', 'senha', 'papel']) {
    if (!corpo[campo] || !String(corpo[campo]).trim()) throw new ErroHttp(422, `campo obrigatório: ${campo}`);
  }
  if (String(corpo.senha).length < 8) throw new ErroHttp(422, 'senha deve ter ao menos 8 caracteres');
  try {
    return { usuario: autenticacao.criarUsuario(db, corpo) };
  } catch (erro) {
    if (String(erro.message).includes('UNIQUE')) throw new ErroHttp(409, 'já existe usuário com esse e-mail');
    throw erro;
  }
});

rota('POST', '/api/lgpd/anonimizar', { papeis: ['admin'] }, ({ db, usuario }) => ({
  prazo_retencao_anos: config.prazoRetencaoAnos,
  ...servico.anonimizarLGPD(db, config.prazoRetencaoAnos, usuario),
}));

// Webhook para o n8n: recebe o JSON da seção 10 do prompt. Exige a chave de
// API e um responsavel_acao que corresponda a um usuário cadastrado — o
// sistema não aceita registros anônimos (seção 8).
rota('POST', '/api/webhook/n8n', { publica: true }, ({ db, corpo, req }) => {
  if (!config.chaveWebhook) {
    throw new ErroHttp(503, 'webhook desabilitado: defina SGA_TI_WEBHOOK_KEY no servidor');
  }
  if (!chaveWebhookConfere(req.headers['x-api-key'])) {
    throw new ErroHttp(401, 'X-Api-Key ausente ou inválida');
  }
  const identificacao = String(corpo.responsavel_acao || '').trim();
  if (!identificacao) throw new ErroHttp(422, 'responsavel_acao é obrigatório: registros anônimos não são aceitos');
  const autor = db
    .prepare('SELECT id, nome, email, papel FROM usuarios WHERE ativo = 1 AND (lower(email) = lower(?) OR lower(nome) = lower(?))')
    .get(identificacao, identificacao);
  if (!autor) {
    throw new ErroHttp(422, `responsavel_acao "${identificacao}" não corresponde a nenhum usuário cadastrado`);
  }

  const mapeado = mapearEventoN8n(corpo);
  if (mapeado.erro) throw new ErroHttp(422, mapeado.erro);
  return servico.registrarEvento(db, mapeado.tipo, mapeado.dados, autor);
});

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------
function despachar(db, req, res, url, corpo) {
  const segmentosUrl = url.pathname.split('/').filter(Boolean);
  const candidatas = rotas.filter((r) => r.metodo === req.method);
  for (const r of candidatas) {
    const parametros = casar(r.segmentos, segmentosUrl);
    if (!parametros) continue;

    const token = extrairToken(req);
    let usuario = null;
    if (!r.opcoes.publica) {
      usuario = autenticacao.usuarioPorToken(db, token);
      if (!usuario) throw new ErroHttp(401, 'autenticação necessária');
      if (r.opcoes.papeis && !r.opcoes.papeis.includes(usuario.papel)) {
        throw new ErroHttp(403, `ação restrita aos papéis: ${r.opcoes.papeis.join(', ')}`);
      }
    }

    const consulta = Object.fromEntries(url.searchParams);
    const ip = req.socket.remoteAddress || 'desconhecido';
    return r.tratador({ db, req, res, corpo, consulta, parametros, usuario, token, ip });
  }
  throw new ErroHttp(404, 'rota não encontrada');
}

module.exports = { despachar, ErroHttp, ErroDeValidacao };
