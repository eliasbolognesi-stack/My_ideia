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

function criarUsuario(db, { nome, email, matricula, senha, papel }) {
  const resultado = db
    .prepare('INSERT INTO usuarios (nome, email, matricula, senha_hash, papel) VALUES (?, ?, ?, ?, ?)')
    .run(nome, email.toLowerCase().trim(), matricula || null, gerarHashSenha(senha), papel);
  return db.prepare('SELECT id, nome, email, matricula, papel FROM usuarios WHERE id = ?').get(Number(resultado.lastInsertRowid));
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
    usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel },
  };
}

function usuarioPorToken(db, token) {
  if (!token) return null;
  const linha = db
    .prepare(
      `SELECT u.id, u.nome, u.email, u.matricula, u.papel, s.expira_em
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token = ? AND u.ativo = 1`
    )
    .get(token);
  if (!linha) return null;
  if (new Date(linha.expira_em).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  return { id: linha.id, nome: linha.nome, email: linha.email, matricula: linha.matricula, papel: linha.papel };
}

function encerrarSessao(db, token) {
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
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
  criarUsuario,
  login,
  usuarioPorToken,
  encerrarSessao,
  garantirAdminInicial,
};
