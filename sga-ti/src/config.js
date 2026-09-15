'use strict';

const path = require('node:path');

module.exports = {
  porta: Number(process.env.PORT || 3000),
  caminhoBanco: process.env.SGA_TI_DB || path.join(__dirname, '..', 'data', 'sga-ti.db'),
  // Chave exigida no header X-Api-Key do webhook /api/webhook/n8n.
  // Se vazia, o webhook fica desabilitado (nunca aceita chamadas sem autenticação).
  chaveWebhook: process.env.SGA_TI_WEBHOOK_KEY || '',
  empresa: process.env.SGA_TI_EMPRESA || 'Empresa',
  // Após este prazo (contado da baixa do ativo), os dados pessoais dos eventos
  // podem ser anonimizados — ver POST /api/lgpd/anonimizar.
  prazoRetencaoAnos: Number(process.env.SGA_TI_PRAZO_RETENCAO_ANOS || 5),
  duracaoSessaoHoras: Number(process.env.SGA_TI_SESSAO_HORAS || 12),
  // Senha inicial do usuário admin criado no primeiro boot. Se não definida,
  // uma senha aleatória é gerada e impressa uma única vez no console.
  senhaAdminInicial: process.env.SGA_TI_ADMIN_SENHA || '',
};
