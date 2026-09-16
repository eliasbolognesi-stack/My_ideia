'use strict';

const { timingSafeEqual } = require('node:crypto');
const config = require('./config');
const autenticacao = require('./auth');
const servico = require('./servico-eventos');
const { mapearEventoN8n } = require('./n8n');
const { TIPOS_EVENTO, STATUS } = require('./regras');
const { criarLimitador } = require('./limite');
const { seguranca, resumirSegredo } = require('./registro');
const { limparProfundo } = require('./entrada');
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

// ---------------------------------------------------------------------------
// Limites de uso
// ---------------------------------------------------------------------------
const limiteLogin = criarLimitador({ janelaMs: 10 * 60 * 1000, maximo: config.limiteLogin, nome: 'login' });
const limiteEventos = criarLimitador({ janelaMs: 60 * 1000, maximo: config.limiteEventosPorMinuto, nome: 'eventos' });
const limiteWebhook = criarLimitador({ janelaMs: 60 * 1000, maximo: config.limiteWebhookPorMinuto, nome: 'webhook' });

function exigirDentroDoLimite(limitador, chave, contexto) {
  if (limitador.permitir(chave)) return;
  seguranca('limite_excedido', { limitador: limitador.nome, ...contexto });
  throw new ErroHttp(429, 'muitas requisições em pouco tempo, aguarde um instante');
}

// Endereço de origem. X-Forwarded-For só é aceito quando o servidor foi
// declarado como estando atrás de um proxy reverso — do contrário qualquer
// cliente forjaria o próprio endereço e escaparia do limite de uso.
function ipDoPedido(req) {
  if (config.atrasDeProxy) {
    const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (encaminhado) return encaminhado;
  }
  return req.socket.remoteAddress || 'desconhecido';
}

// Na busca, "%" e "_" são curingas do banco: digitados por quem procura, eles
// devolveriam tudo. Aqui viram texto literal, com ESCAPE declarado na consulta.
function termoBusca(texto) {
  const limpo = String(texto).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${limpo}%`;
}

function extrairToken(req) {
  const cabecalho = req.headers['authorization'] || '';
  return cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
}

function comparaSegura(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Resolve a chave recebida no webhook. No modo recomendado, a chave determina
// o autor; o modo legado (chave única) aceita o autor declarado no corpo.
function autorizarWebhook(chaveRecebida) {
  if (!chaveRecebida) return null;
  for (const [chave, email] of config.chavesWebhook) {
    if (comparaSegura(chaveRecebida, chave)) return { emailAutor: email, legado: false };
  }
  if (config.chaveWebhook && comparaSegura(chaveRecebida, config.chaveWebhook)) {
    return { emailAutor: null, legado: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

rota('POST', '/api/auth/login', { publica: true }, ({ db, corpo, ip }) => {
  // O limite pune tentativa ERRADA, não uso normal: um escritório inteiro
  // costuma sair por um endereço de rede só, e bloquear entrada bem-sucedida
  // derrubaria o time sem incomodar quem ataca.
  if (limiteLogin.excedeu(ip)) {
    seguranca('limite_excedido', { limitador: limiteLogin.nome, ip, rota: 'login' });
    throw new ErroHttp(429, 'muitas tentativas sem sucesso, aguarde alguns minutos');
  }
  const sessao = autenticacao.login(db, corpo.email, corpo.senha, config.duracaoSessaoHoras);
  if (!sessao) {
    limiteLogin.registrar(ip);
    seguranca('login_falho', { ip, email: String(corpo.email || '').slice(0, 120) });
    throw new ErroHttp(401, 'e-mail ou senha inválidos');
  }
  limiteLogin.perdoar(ip);
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
    clausulas.push(
      `(patrimonio LIKE ? ESCAPE '\\' OR numero_serie LIKE ? ESCAPE '\\' OR modelo LIKE ? ESCAPE '\\'
        OR responsavel_atual LIKE ? ESCAPE '\\' OR localizacao_atual LIKE ? ESCAPE '\\')`
    );
    const termo = termoBusca(consulta.q);
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

rota('POST', '/api/eventos', {}, ({ db, corpo, usuario, ip }) => {
  exigirDentroDoLimite(limiteEventos, `u${usuario.id}`, { ip, usuario: usuario.email, rota: 'eventos' });
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

rota('POST', '/api/aprovacoes/:id/decisao', { papeis: ['aprovador', 'admin'] }, ({ db, parametros, corpo, usuario }) => {
  const resultado = servico.decidirAprovacao(db, parametros.id, corpo.decisao, corpo.justificativa, usuario);
  seguranca('decisao_descarte', {
    usuario: usuario.email,
    aprovacao: Number(parametros.id),
    decisao: corpo.decisao,
  });
  return resultado;
});

// Auditoria / direitos do titular (LGPD art. 18). A consulta ampla — que
// mostra o histórico de todos os colaboradores — fica restrita a aprovador e
// admin; operador e técnico veem apenas o próprio histórico (minimização de
// acesso, LGPD art. 6º).
rota('GET', '/api/auditoria/eventos', {}, ({ db, consulta, usuario }) => {
  const podeVerTodos = ['aprovador', 'admin'].includes(usuario.papel);
  const clausulas = [];
  const valores = [];

  const colaborador = podeVerTodos ? consulta.colaborador : usuario.nome;
  if (colaborador) {
    const termo = termoBusca(colaborador);
    clausulas.push(`(e.autor_nome LIKE ? ESCAPE '\\' OR e.dados LIKE ? ESCAPE '\\')`);
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
    escopo: podeVerTodos ? 'completo' : 'proprio',
    colaborador,
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

rota('POST', '/api/usuarios', { papeis: ['admin'] }, ({ db, corpo, usuario }) => {
  for (const campo of ['nome', 'email', 'senha', 'papel']) {
    if (!corpo[campo] || !String(corpo[campo]).trim()) throw new ErroHttp(422, `campo obrigatório: ${campo}`);
  }
  if (String(corpo.senha).length < 8) throw new ErroHttp(422, 'senha deve ter ao menos 8 caracteres');
  try {
    const criado = autenticacao.criarUsuario(db, corpo);
    seguranca('usuario_criado', { por: usuario.email, novo: criado.email, papel: criado.papel });
    return { usuario: criado };
  } catch (erro) {
    if (String(erro.message).includes('UNIQUE')) throw new ErroHttp(409, 'já existe usuário com esse e-mail');
    throw erro;
  }
});

rota('POST', '/api/lgpd/anonimizar', { papeis: ['admin'] }, ({ db, usuario }) => {
  const resultado = servico.anonimizarLGPD(db, config.prazoRetencaoAnos, usuario);
  seguranca('anonimizacao_lgpd', { por: usuario.email, ...resultado });
  return { prazo_retencao_anos: config.prazoRetencaoAnos, ...resultado };
});

// Webhook para o n8n: recebe o JSON da seção 10 do prompt.
// No modo recomendado (SGA_TI_WEBHOOK_KEYS) a CHAVE define o autor, de modo
// que ninguém possa registrar eventos em nome de outra pessoa apenas
// escrevendo o nome dela no corpo da requisição.
rota('POST', '/api/webhook/n8n', { publica: true }, ({ db, corpo, req, ip }) => {
  if (!config.chavesWebhook.size && !config.chaveWebhook) {
    throw new ErroHttp(503, 'webhook desabilitado: defina SGA_TI_WEBHOOK_KEYS no servidor');
  }
  const chaveRecebida = req.headers['x-api-key'];
  exigirDentroDoLimite(limiteWebhook, `k${String(chaveRecebida || 'sem-chave').slice(0, 12)}`, { ip, rota: 'webhook' });

  const autorizacao = autorizarWebhook(chaveRecebida);
  if (!autorizacao) {
    seguranca('webhook_chave_invalida', { ip, chave: resumirSegredo(chaveRecebida) });
    throw new ErroHttp(401, 'X-Api-Key ausente ou inválida');
  }

  // Modo recomendado: o autor vem da chave. Modo legado: vem do corpo.
  const identificacao = autorizacao.legado
    ? String(corpo.responsavel_acao || '').trim()
    : autorizacao.emailAutor;

  if (!identificacao) {
    throw new ErroHttp(422, 'responsavel_acao é obrigatório: registros anônimos não são aceitos');
  }
  const autor = db
    .prepare('SELECT id, nome, email, papel FROM usuarios WHERE ativo = 1 AND (lower(email) = lower(?) OR lower(nome) = lower(?))')
    .get(identificacao, identificacao);
  if (!autor) {
    seguranca('webhook_autor_desconhecido', { ip, identificacao: identificacao.slice(0, 120), legado: autorizacao.legado });
    throw new ErroHttp(422, `responsavel_acao "${identificacao}" não corresponde a nenhum usuário cadastrado`);
  }
  // No modo com chave por origem, um corpo que tenta declarar outro autor é
  // sinal de tentativa de personificação: registra e ignora a declaração.
  if (!autorizacao.legado && corpo.responsavel_acao
      && String(corpo.responsavel_acao).toLowerCase() !== autor.email.toLowerCase()
      && String(corpo.responsavel_acao).toLowerCase() !== autor.nome.toLowerCase()) {
    seguranca('webhook_autor_divergente', {
      ip,
      declarado: String(corpo.responsavel_acao).slice(0, 120),
      real: autor.email,
    });
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
  const ip = ipDoPedido(req);

  for (const r of candidatas) {
    const parametros = casar(r.segmentos, segmentosUrl);
    if (!parametros) continue;

    const token = extrairToken(req);
    let usuario = null;
    if (!r.opcoes.publica) {
      usuario = autenticacao.usuarioPorToken(db, token);
      if (!usuario) {
        seguranca('acesso_sem_credencial', { ip, rota: url.pathname, metodo: req.method });
        throw new ErroHttp(401, 'autenticação necessária');
      }
      if (r.opcoes.papeis && !r.opcoes.papeis.includes(usuario.papel)) {
        seguranca('acesso_negado', {
          ip, rota: url.pathname, usuario: usuario.email, papel: usuario.papel,
          exigido: r.opcoes.papeis.join('|'),
        });
        throw new ErroHttp(403, `ação restrita aos papéis: ${r.opcoes.papeis.join(', ')}`);
      }
    }

    // Limpeza da entrada: remove caracteres invisíveis e limita o tamanho de
    // cada campo antes de qualquer validação. A senha fica de fora para não
    // alterar silenciosamente o que a pessoa digitou.
    const senhaOriginal = corpo && typeof corpo === 'object' ? corpo.senha : undefined;
    const relatorio = { suspeitos: 0 };
    const corpoLimpo = limparProfundo(corpo, relatorio) || {};
    if (senhaOriginal !== undefined) corpoLimpo.senha = senhaOriginal;
    if (relatorio.suspeitos > 0) {
      seguranca('texto_com_caracteres_ocultos', {
        ip, rota: url.pathname, campos: relatorio.suspeitos,
        usuario: usuario ? usuario.email : null,
      });
    }

    const consulta = Object.fromEntries(url.searchParams);
    return r.tratador({ db, req, res, corpo: corpoLimpo, consulta, parametros, usuario, token, ip });
  }
  throw new ErroHttp(404, 'rota não encontrada');
}

module.exports = { despachar, ErroHttp, ErroDeValidacao, ipDoPedido, autorizarWebhook, termoBusca };
