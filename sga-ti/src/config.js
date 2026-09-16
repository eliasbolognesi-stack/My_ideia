'use strict';

const path = require('node:path');

function booleano(valor, padrao = false) {
  if (valor === undefined || valor === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(String(valor).toLowerCase());
}

function lista(valor) {
  return String(valor || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// SGA_TI_WEBHOOK_KEYS no formato "chave:email,outra:email". A chave determina
// QUEM é o autor do evento — a requisição não declara mais a própria autoria.
function mapaChavesWebhook(valor) {
  const mapa = new Map();
  for (const par of lista(valor)) {
    const separador = par.indexOf(':');
    if (separador <= 0) continue;
    const chave = par.slice(0, separador).trim();
    const email = par.slice(separador + 1).trim().toLowerCase();
    if (chave && email) mapa.set(chave, email);
  }
  return mapa;
}

const raiz = path.join(__dirname, '..');

module.exports = {
  porta: Number(process.env.PORT || 3000),
  // Escuta só em localhost por padrão: o acesso externo deve passar por um
  // proxy reverso com TLS (ver README). Use 0.0.0.0 apenas conscientemente.
  host: process.env.SGA_TI_HOST || '127.0.0.1',
  caminhoBanco: process.env.SGA_TI_DB || path.join(raiz, 'data', 'sga-ti.db'),

  // --- Webhook do n8n -------------------------------------------------------
  // Modo recomendado: cada origem tem a própria chave, e a chave define o autor.
  chavesWebhook: mapaChavesWebhook(process.env.SGA_TI_WEBHOOK_KEYS),
  // Modo legado (chave única, autor declarado no corpo). Mantido para não
  // quebrar instalações existentes; o servidor avisa no boot que é inseguro.
  chaveWebhook: process.env.SGA_TI_WEBHOOK_KEY || '',

  empresa: process.env.SGA_TI_EMPRESA || 'Empresa',
  // Após este prazo (contado da baixa do ativo), os dados pessoais dos eventos
  // podem ser anonimizados — ver POST /api/lgpd/anonimizar.
  prazoRetencaoAnos: Number(process.env.SGA_TI_PRAZO_RETENCAO_ANOS || 5),
  duracaoSessaoHoras: Number(process.env.SGA_TI_SESSAO_HORAS || 12),
  // Senha inicial do usuário admin criado no primeiro boot. Se não definida,
  // uma senha aleatória é gerada e impressa uma única vez no console.
  senhaAdminInicial: process.env.SGA_TI_ADMIN_SENHA || '',

  // --- Segurança ------------------------------------------------------------
  // Registro de eventos de segurança, separado do banco do sistema.
  arquivoRegistroSeguranca: process.env.SGA_TI_LOG_SEGURANCA || path.join(raiz, 'data', 'seguranca.log'),
  // Confia no cabeçalho X-Forwarded-For (ligue APENAS atrás de proxy reverso;
  // caso contrário o cliente forja o próprio endereço e burla o limite de uso).
  atrasDeProxy: booleano(process.env.SGA_TI_ATRAS_PROXY),
  // Envia Strict-Transport-Security (só faz sentido quando servido por HTTPS).
  forcarHttps: booleano(process.env.SGA_TI_FORCAR_HTTPS),
  // Limites de uso por janela de tempo.
  limiteLogin: Number(process.env.SGA_TI_LIMITE_LOGIN || 20),
  limiteEventosPorMinuto: Number(process.env.SGA_TI_LIMITE_EVENTOS || 60),
  limiteWebhookPorMinuto: Number(process.env.SGA_TI_LIMITE_WEBHOOK || 120),
  // Tamanho máximo de cada campo de texto recebido.
  tamanhoMaximoCampo: Number(process.env.SGA_TI_TAMANHO_CAMPO || 2000),
  // Domínios aceitos quando a evidência de descarte é um endereço da internet.
  // Vazio = sem restrição de domínio (apenas o protocolo é validado).
  dominiosEvidencia: lista(process.env.SGA_TI_DOMINIOS_EVIDENCIA),
  // Exige aprovação humana para TODO descarte, não só o de ativo 'Em uso'.
  aprovacaoTodoDescarte: booleano(process.env.SGA_TI_APROVACAO_TODO_DESCARTE),
  // Modo manutenção: responde 503 a tudo, sem derrubar o processo.
  manutencao: booleano(process.env.SGA_TI_MANUTENCAO),

  // --- Privacidade (LGPD) ---------------------------------------------------
  contatoDpo: process.env.SGA_TI_CONTATO_DPO || '',
};
