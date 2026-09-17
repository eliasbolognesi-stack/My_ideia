'use strict';

const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

function gerarHashSenha(senha) {
  const sal = randomBytes(16).toString('hex');
  const hash = scryptSync(senha, sal, 32).toString('hex');
  return `${sal}:${hash}`;
}

function verificarSenha(senha, armazenado) {
  const [sal, hash] = String(armazenado).split(':');
  if (!sal || !hash) return false;
  const candidato = scryptSync(senha, sal, 32);
  const esperado = Buffer.from(hash, 'hex');
  return candidato.length === esperado.length && timingSafeEqual(candidato, esperado);
}

const TAMANHO_MINIMO_SENHA = 8;

// Uma única definição de "senha aceitável", usada na criação, na troca e na
// redefinição — regra repetida em três lugares vira três regras diferentes.
function validarSenha(senha) {
  const texto = String(senha || '');
  if (texto.length < TAMANHO_MINIMO_SENHA) {
    return `a senha precisa de pelo menos ${TAMANHO_MINIMO_SENHA} caracteres`;
  }
  return null;
}

// `provisoria` nasce ligada de propósito: a senha que um administrador digita
// para outra pessoa é conhecida por ele. Enquanto não for trocada, não dá para
// afirmar quem registrou um evento — que é justamente o que a trilha imutável
// existe para provar.
function criarUsuario(db, { nome, email, matricula, senha, papel }, { provisoria = true } = {}) {
  const resultado = db
    .prepare(`INSERT INTO usuarios (nome, email, matricula, senha_hash, papel, senha_provisoria)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nome, email.toLowerCase().trim(), matricula || null, gerarHashSenha(senha), papel, provisoria ? 1 : 0);
  return db
    .prepare('SELECT id, nome, email, matricula, papel, senha_provisoria FROM usuarios WHERE id = ?')
    .get(Number(resultado.lastInsertRowid));
}

function login(db, email, senha, duracaoHoras) {
  const usuario = db
    .prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1')
    .get(String(email || '').toLowerCase().trim());
  if (!usuario || !verificarSenha(String(senha || ''), usuario.senha_hash)) return null;

  const token = randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + duracaoHoras * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, usuario.id, expira);
  return {
    token,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      // A tela precisa saber disto para levar direto à troca de senha.
      senha_provisoria: Boolean(usuario.senha_provisoria),
    },
  };
}

function usuarioPorToken(db, token) {
  if (!token) return null;
  const linha = db
    .prepare(
      `SELECT u.id, u.nome, u.email, u.matricula, u.papel, u.senha_provisoria, s.expira_em
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token = ? AND u.ativo = 1`
    )
    .get(token);
  if (!linha) return null;
  if (new Date(linha.expira_em).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  return {
    id: linha.id,
    nome: linha.nome,
    email: linha.email,
    matricula: linha.matricula,
    papel: linha.papel,
    // Mesmo nome em toda resposta da API (login, /api/me e lista de usuários):
    // dois nomes para o mesmo campo fizeram a tela de conta não mostrar o
    // aviso de senha provisória.
    senha_provisoria: Boolean(linha.senha_provisoria),
  };
}

function encerrarSessao(db, token) {
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

function encerrarSessoesDoUsuario(db, usuarioId, { exceto } = {}) {
  const resultado = exceto
    ? db.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token != ?').run(usuarioId, exceto)
    : db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuarioId);
  return Number(resultado.changes);
}

// Sessão expirada só era apagada quando alguém tentava usá-la: quem fecha o
// navegador e não volta deixava a linha no banco para sempre.
function limparSessoesExpiradas(db) {
  const resultado = db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(new Date().toISOString());
  return Number(resultado.changes);
}

/**
 * Troca feita pela própria pessoa: exige a senha atual.
 * Derruba as OUTRAS sessões — é isso que faz a troca resolver um vazamento;
 * sem isso, quem roubou a sessão continua dentro com a senha nova.
 * @returns {{ok: true, sessoesEncerradas: number} | {ok: false, erro: string}}
 */
function trocarSenha(db, usuarioId, senhaAtual, senhaNova, { manterSessao } = {}) {
  const usuario = db.prepare('SELECT id, senha_hash FROM usuarios WHERE id = ? AND ativo = 1').get(usuarioId);
  if (!usuario) return { ok: false, erro: 'usuário não encontrado' };
  if (!verificarSenha(String(senhaAtual || ''), usuario.senha_hash)) {
    return { ok: false, erro: 'a senha atual não confere' };
  }
  const problema = validarSenha(senhaNova);
  if (problema) return { ok: false, erro: problema };
  if (verificarSenha(String(senhaNova), usuario.senha_hash)) {
    // Sem isto, trocar a senha provisória pela mesma senha "resolveria" a
    // pendência sem trocar nada.
    return { ok: false, erro: 'a senha nova precisa ser diferente da atual' };
  }

  db.prepare('UPDATE usuarios SET senha_hash = ?, senha_provisoria = 0 WHERE id = ?')
    .run(gerarHashSenha(String(senhaNova)), usuarioId);
  const sessoesEncerradas = encerrarSessoesDoUsuario(db, usuarioId, { exceto: manterSessao });
  return { ok: true, sessoesEncerradas };
}

/**
 * Redefinição feita por um administrador: não exige a senha atual (quem
 * esqueceu a senha não a tem), marca a nova como provisória e derruba TODAS
 * as sessões daquela pessoa.
 */
function definirSenha(db, usuarioId, senhaNova, { provisoria = true } = {}) {
  const problema = validarSenha(senhaNova);
  if (problema) return { ok: false, erro: problema };
  const usuario = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(usuarioId);
  if (!usuario) return { ok: false, erro: 'usuário não encontrado' };

  db.prepare('UPDATE usuarios SET senha_hash = ?, senha_provisoria = ? WHERE id = ?')
    .run(gerarHashSenha(String(senhaNova)), provisoria ? 1 : 0, usuarioId);
  const sessoesEncerradas = encerrarSessoesDoUsuario(db, usuarioId);
  return { ok: true, sessoesEncerradas };
}

/**
 * Ativa ou desativa. Desativar derruba as sessões na hora: esperar a expiração
 * deixaria a pessoa desligada usando o sistema por até 12 horas.
 */
function definirSituacao(db, usuarioId, ativo) {
  const usuario = db.prepare('SELECT id, ativo FROM usuarios WHERE id = ?').get(usuarioId);
  if (!usuario) return { ok: false, erro: 'usuário não encontrado' };

  db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, usuarioId);
  const sessoesEncerradas = ativo ? 0 : encerrarSessoesDoUsuario(db, usuarioId);
  return { ok: true, sessoesEncerradas };
}

// Quantos administradores ativos existem — para impedir que o último seja
// desativado ou rebaixado e o sistema fique sem dono.
function totalDeAdminsAtivos(db) {
  return db.prepare("SELECT COUNT(*) AS total FROM usuarios WHERE papel = 'admin' AND ativo = 1").get().total;
}

// Garante um usuário admin no primeiro boot. Retorna as credenciais geradas
// (para impressão única no console) ou null se já havia usuários.
function garantirAdminInicial(db, senhaConfigurada) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM usuarios').get();
  if (total > 0) return null;
  const senha = senhaConfigurada || randomBytes(9).toString('base64url');
  criarUsuario(db, {
    nome: 'Administrador',
    email: 'admin@local',
    matricula: null,
    senha,
    papel: 'admin',
  });
  return { email: 'admin@local', senha, gerada: !senhaConfigurada };
}

module.exports = {
  gerarHashSenha,
  verificarSenha,
  validarSenha,
  criarUsuario,
  login,
  usuarioPorToken,
  encerrarSessao,
  encerrarSessoesDoUsuario,
  limparSessoesExpiradas,
  trocarSenha,
  definirSenha,
  definirSituacao,
  totalDeAdminsAtivos,
  garantirAdminInicial,
  TAMANHO_MINIMO_SENHA,
};
